/**
 * 真实页面卸载时机
 *
 * beforeunload / pagehide 下的同步落盘，以及飞行中请求被截断后能不能
 * 被下次启动捡回来，是 jsdom 里最难模拟准的一块。
 */
import { test, expect, initSdk, openPage, ORIGIN } from './fixture';

const CACHE_KEY = '__logger_upload_queue__';

async function reinitAfterReload(page: import('@playwright/test').Page): Promise<void> {
  await openPage(page);
  await page.evaluate(() => {
    window.__aemeath__.initAemeath({
      enableConsole: false,
      upload: async (log: unknown) => {
        const res = await fetch('/collect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(log),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { success: true };
      },
      queue: { uploadInterval: 200, deduplicationDelay: 0 },
      network: { enabled: false },
    });
  });
}

test('断网时刷新：队列里的日志下次启动要能补传', async ({ page, context, collected }) => {
  await initSdk(page);
  await context.setOffline(true);
  await page.evaluate(() => {
    window.__aemeath__.getAemeath().error('queued across unload');
  });
  // 给 pause + 落盘一点时间（cache 默认开）
  await page.waitForTimeout(800);

  // WebKit 离线态 reload 会内部报错；先恢复网络再 goto，localStorage 仍在
  await context.setOffline(false);
  await page.goto(`${ORIGIN}/`);
  await reinitAfterReload(page);

  await expect
    .poll(() => collected.uploads.map((u) => u.message), { timeout: 20000 })
    .toContain('queued across unload');
});

test('飞行中被截断的日志下次启动要能捡回来', async ({ page, collected }) => {
  collected.hang = true;
  await initSdk(page, {
    queue: { uploadInterval: 50, deduplicationDelay: 0, maxConcurrent: 1 },
  });

  await page.evaluate(() => {
    window.__aemeath__.getAemeath().error('in-flight across unload');
  });

  // 等上报真正飞出去（挂住不响应）
  await expect
    .poll(() => collected.uploads.some((u) => u.message === 'in-flight across unload'), {
      timeout: 10000,
    })
    .toBe(true);

  // 此时请求还在飞：刷新会触发 beforeunload → saveToCache({ includeInFlight: true })
  await page.reload();
  collected.hang = false;
  collected.uploads = [];
  await reinitAfterReload(page);

  await expect
    .poll(() => collected.uploads.map((u) => u.message), { timeout: 20000 })
    .toContain('in-flight across unload');
});

test('beforeunload 必须把队列写进 localStorage', async ({ page, context, collected }) => {
  void collected;
  await initSdk(page);
  await context.setOffline(true);
  await page.evaluate(() => {
    window.__aemeath__.getAemeath().error('must be in cache on unload');
  });
  await page.waitForTimeout(500);

  // 主动触发 beforeunload，再读 localStorage
  const cached = await page.evaluate((key) => {
    window.dispatchEvent(new Event('beforeunload'));
    window.dispatchEvent(new Event('pagehide'));
    return window.localStorage.getItem(key);
  }, CACHE_KEY);

  expect(cached, 'beforeunload 后 localStorage 应该有缓存').toBeTruthy();
  expect(cached!).toContain('must be in cache on unload');
});

test('关闭缓存时，卸载不会把队列写进 localStorage', async ({ page, context, collected }) => {
  void collected;
  await initSdk(page, {
    cache: { enabled: false },
  });
  await context.setOffline(true);
  await page.evaluate(() => {
    window.__aemeath__.getAemeath().error('expected loss without cache');
  });
  await page.waitForTimeout(500);

  const cached = await page.evaluate(() => {
    window.dispatchEvent(new Event('beforeunload'));
    window.dispatchEvent(new Event('pagehide'));
    return window.localStorage.getItem('__logger_upload_queue__');
  });

  expect(
    cached?.includes('expected loss without cache') ?? false,
    '关了 cache 却写进了 localStorage，刷新后就会被捡回来'
  ).toBe(false);
});
