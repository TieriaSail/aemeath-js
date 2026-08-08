/**
 * 同页多实例 / 多标签页抢存储槽
 *
 * 模块级 CLAIMED_* 只在同一 JS 上下文有效。多标签页互不可见是文档声明的限制，
 * 这里用真浏览器把「同页让位」和「跨 tab 覆盖」都跑一遍。
 */
import { test, expect, openPage, ORIGIN } from './fixture';

test('同页两个 UploadPlugin 撞默认 cache.key：第二个让位并告警', async ({ page, collected }) => {
  void collected; // 触发夹具挂路由，否则 https://aemeath.test 真的去连网
  await openPage(page);

  const result = await page.evaluate(async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    const Logger = window.__aemeath__.AemeathLogger as new (o?: unknown) => {
      use: (p: unknown) => void;
      error: (m: string) => void;
      destroy: () => void;
    };
    const Upload = window.__aemeath__.UploadPlugin as new (o?: unknown) => {
      uninstall: (l?: unknown) => void;
    };

    const hang = async () => {
      throw new TypeError('Failed to fetch');
    };

    const loggerA = new Logger({ enableConsole: false });
    const loggerB = new Logger({ enableConsole: false });
    const pluginA = new Upload({
      onUpload: hang,
      queue: { deduplicationDelay: 0, uploadInterval: 100000 },
      saveOnUnload: false,
    });
    const pluginB = new Upload({
      onUpload: hang,
      queue: { deduplicationDelay: 0, uploadInterval: 100000 },
      saveOnUnload: false,
    });

    loggerA.use(pluginA);
    loggerB.use(pluginB);
    loggerA.error('from-A');
    loggerB.error('from-B');
    await new Promise((r) => setTimeout(r, 400));

    pluginA.uninstall(loggerA);
    pluginB.uninstall(loggerB);
    loggerA.destroy();
    loggerB.destroy();
    console.warn = originalWarn;

    return {
      warnings,
      cached: localStorage.getItem('__logger_upload_queue__') ?? '',
    };
  });

  expect(
    result.warnings.some((w) => w.includes('share the cache key')),
    `期望撞 key 告警，实际：${JSON.stringify(result.warnings)}`
  ).toBe(true);
  // 先到的保住缓存；后到的让位，绝不能把先到的抹掉
  expect(result.cached).toContain('from-A');
  expect(result.cached).not.toContain('from-B');
});

test('同页两个 OfflinePersistence 撞默认 dbName：第二个 backend=noop', async ({ page, collected }) => {
  void collected;
  await openPage(page);

  const result = await page.evaluate(async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    const Logger = window.__aemeath__.AemeathLogger as new (o?: unknown) => {
      use: (p: unknown) => void;
      destroy: () => void;
    };
    const Offline = window.__aemeath__.OfflinePersistencePlugin as new (o?: unknown) => {
      uninstall: (l?: unknown) => void;
      getStatus: () => { backend: string };
    };
    const Upload = window.__aemeath__.UploadPlugin as new (o?: unknown) => {
      uninstall: (l?: unknown) => void;
    };

    const loggerA = new Logger({ enableConsole: false });
    const loggerB = new Logger({ enableConsole: false });

    // Offline 需要 UploadPlugin 在场才会真正干活；这里只要装上触发认领
    const uploadA = new Upload({
      onUpload: async () => ({ success: true }),
      queue: { uploadInterval: 100000 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const uploadB = new Upload({
      onUpload: async () => ({ success: true }),
      queue: { uploadInterval: 100000 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offlineA = new Offline();
    const offlineB = new Offline();

    loggerA.use(uploadA);
    loggerA.use(offlineA);
    await new Promise((r) => setTimeout(r, 400));

    loggerB.use(uploadB);
    loggerB.use(offlineB);
    await new Promise((r) => setTimeout(r, 400));

    const statusB = offlineB.getStatus();

    offlineA.uninstall(loggerA);
    offlineB.uninstall(loggerB);
    uploadA.uninstall(loggerA);
    uploadB.uninstall(loggerB);
    loggerA.destroy();
    loggerB.destroy();
    console.warn = originalWarn;

    return { warnings, backendB: statusB.backend };
  });

  expect(result.backendB).toBe('noop');
  expect(result.warnings.some((w) => w.includes('share the store'))).toBe(true);
});

test('两个标签页共用默认 cache.key：后写覆盖先写（文档声明的限制）', async ({ browser }) => {
  const context = await browser.newContext();
  const pageA = await context.newPage();
  const pageB = await context.newPage();

  const { build } = await import('esbuild');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const bundle = (
    await build({
      entryPoints: [resolve(here, 'harness/entry.ts')],
      bundle: true,
      format: 'iife',
      target: 'es2019',
      write: false,
    })
  ).outputFiles[0].text;

  for (const page of [pageA, pageB]) {
    await page.route(`${ORIGIN}/`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><body><script src="/harness.js"></script></body></html>`,
      })
    );
    await page.route(`${ORIGIN}/harness.js`, (route) =>
      route.fulfill({ contentType: 'application/javascript', body: bundle })
    );
    await page.route(`${ORIGIN}/collect`, async (route) => {
      await route.fulfill({ status: 200, body: '{}' });
    });
  }

  async function writeWhileOffline(
    page: import('@playwright/test').Page,
    message: string
  ): Promise<void> {
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(() => typeof window.__aemeath__ !== 'undefined');
    await context.setOffline(true);
    await page.evaluate((msg) => {
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
        network: { enabled: false },
      });
      window.__aemeath__.getAemeath().error(msg);
    }, message);
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('beforeunload'));
      window.dispatchEvent(new Event('pagehide'));
    });
  }

  await writeWhileOffline(pageA, 'from-tab-A');
  // B 写入前恢复 online 再断，避免 A 的页面状态干扰；缓存 key 是同源共享的
  await context.setOffline(false);
  await writeWhileOffline(pageB, 'from-tab-B');

  const cached = await pageB.evaluate(() =>
    localStorage.getItem('__logger_upload_queue__')
  );

  const hasA = cached?.includes('from-tab-A') ?? false;
  const hasB = cached?.includes('from-tab-B') ?? false;

  // 无跨 tab 锁：后写赢。若两边都在，说明做了合并（应改文档/断言）。
  expect(hasA && hasB).toBe(false);
  expect(hasA || hasB).toBe(true);

  await context.close();
});
