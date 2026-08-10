/**
 * XHR 上报自忽略、onDrop 配置项、业务请求仍被监控、cache TTL
 */
import { test, expect, openPage, ORIGIN } from './fixture';
import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

test('onUpload 用 XHR 上报时也不能自我记录', async ({ page, collected }) => {
  await openPage(page);
  await page.evaluate(() => {
    window.__aemeath__.initAemeath({
      enableConsole: false,
      // 默认开 NetworkPlugin
      upload: async (log: unknown) => {
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', '/collect');
          xhr.setRequestHeader('content-type', 'application/json');
          xhr.onload = () =>
            xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(String(xhr.status)));
          xhr.onerror = () => reject(new Error('xhr error'));
          xhr.send(JSON.stringify(log));
        });
        return { success: true };
      },
    });
    window.__aemeath__.getAemeath().error('via xhr');
  });

  await expect
    .poll(() => collected.uploads.some((u) => u.message === 'via xhr'), { timeout: 10000 })
    .toBe(true);

  await page.waitForTimeout(3000);
  const selfLogs = collected.uploads.filter((u) => String(u.message).includes('/collect'));
  expect(selfLogs.length).toBe(0);
});

test('initAemeath 的 onDrop 配置项能收到丢弃回调', async ({ page, collected }) => {
  void collected;
  const drops: Array<{ reason?: string; message?: string }> = [];
  await page.exposeFunction('__onDropOpt', (reason: string, message: string) => {
    drops.push({ reason, message });
  });

  await openPage(page);
  await page.evaluate(() => {
    window.__aemeath__.initAemeath({
      enableConsole: false,
      upload: async () => ({
        success: false,
        shouldRetry: false,
        error: 'rejected by design',
      }),
      queue: { uploadInterval: 200, deduplicationDelay: 0 },
      network: { enabled: false },
      cache: { enabled: false },
      onDrop: (log: { message: string }, info: { reason: string }) => {
        (window as unknown as { __onDropOpt: (r: string, m: string) => void }).__onDropOpt(
          info.reason,
          log.message
        );
      },
    });
    window.__aemeath__.getAemeath().error('dropped via onDrop option');
  });

  await expect
    .poll(() => drops.some((d) => d.message === 'dropped via onDrop option'), {
      timeout: 10000,
    })
    .toBe(true);
  expect(drops.find((d) => d.message === 'dropped via onDrop option')?.reason).toBe('no-retry');
});

test('业务 fetch 仍会被 NetworkPlugin 记录（自忽略的正对照）', async ({ page, collected }) => {
  await page.route(`${ORIGIN}/api/business`, async (route) => {
    await route.fulfill({ status: 200, body: '{"ok":true}' });
  });

  await openPage(page);
  await page.evaluate(async () => {
    window.__aemeath__.initAemeath({
      enableConsole: false,
      upload: async (log: unknown) => {
        await fetch('/collect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(log),
        });
        return { success: true };
      },
      queue: { uploadInterval: 200, deduplicationDelay: 0 },
    });
    await fetch('/api/business');
  });

  await expect
    .poll(
      () => collected.uploads.some((u) => String(u.message).includes('/api/business')),
      { timeout: 10000 }
    )
    .toBe(true);
});

test('超过 cache.ttl 的缓存条目启动后不再恢复上报', async ({ page, context, collected }) => {
  await openPage(page);
  await context.setOffline(true);
  await page.evaluate(() => {
    // offlinePersistence:false 现在是完整的“不落盘”总开关，会连 Upload cache
    // 一起关闭。本用例只测 UploadPlugin 自身的镜像 TTL，因此直接安装该插件，
    // 避免标准入口的 OfflinePersistence 层改变被测边界。
    const Logger = window.__aemeath__.AemeathLogger as new (options?: unknown) => {
      use(plugin: unknown): void;
      error(message: string): void;
    };
    const Upload = window.__aemeath__.UploadPlugin as new (options?: unknown) => unknown;
    const logger = new Logger({ enableConsole: false });
    logger.use(new Upload({
      onUpload: async (log: unknown) => {
        await fetch('/collect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(log),
        });
        return { success: true };
      },
      queue: { uploadInterval: 200, deduplicationDelay: 0 },
      cache: { enabled: true, ttl: 60_000 },
    }));
    logger.error('stale cache entry');
  });
  await page.waitForTimeout(500);

  const cached = await page.evaluate(() => {
    window.dispatchEvent(new Event('beforeunload'));
    return window.localStorage.getItem('__logger_upload_queue__');
  });
  expect(cached, '断网卸载后应有缓存').toBeTruthy();
  expect(cached!).toContain('stale cache entry');

  // 先关页丢掉内存。真实 close 会再次触发 beforeunload 并刷新 cachedAt，
  // 所以必须在下一页的 SDK 脚本执行前把缓存改旧，才能真正验证恢复时 TTL。
  await page.close();
  await context.setOffline(false);

  const harness = (
    await build({
      entryPoints: [resolve(HERE, 'harness/entry.ts')],
      bundle: true,
      format: 'iife',
      target: 'es2019',
      write: false,
    })
  ).outputFiles[0].text;

  const page2 = await context.newPage();
  await page2.route(`${ORIGIN}/`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body><script src="/harness.js"></script></body></html>`,
    })
  );
  await page2.route(`${ORIGIN}/harness.js`, (route) =>
    route.fulfill({ contentType: 'application/javascript', body: harness })
  );
  await page2.route(`${ORIGIN}/collect`, async (route) => {
    try {
      collected.uploads.push(route.request().postDataJSON() as Record<string, unknown>);
    } catch {
      /* ignore */
    }
    await route.fulfill({ status: 200, body: '{}' });
  });
  await page2.addInitScript(() => {
    const key = '__logger_upload_queue__';
    const data = JSON.parse(localStorage.getItem(key)!) as Array<{
      timestamp?: number;
      cachedAt?: number;
    }>;
    const ancient = Date.now() - 24 * 60 * 60 * 1000;
    for (const item of data) {
      item.timestamp = ancient;
      item.cachedAt = ancient;
    }
    localStorage.setItem(key, JSON.stringify(data));
  });

  await page2.goto(`${ORIGIN}/`);
  await page2.waitForFunction(() => typeof window.__aemeath__ !== 'undefined');
  await page2.evaluate(() => {
    const Logger = window.__aemeath__.AemeathLogger as new (options?: unknown) => {
      use(plugin: unknown): void;
    };
    const Upload = window.__aemeath__.UploadPlugin as new (options?: unknown) => unknown;
    const logger = new Logger({ enableConsole: false });
    logger.use(new Upload({
      onUpload: async (log: unknown) => {
        await fetch('/collect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(log),
        });
        return { success: true };
      },
      queue: { uploadInterval: 200, deduplicationDelay: 0 },
      cache: { enabled: true, ttl: 60_000 },
    }));
  });

  await page2.waitForTimeout(3000);
  expect(collected.uploads.some((u) => u.message === 'stale cache entry')).toBe(false);
});
