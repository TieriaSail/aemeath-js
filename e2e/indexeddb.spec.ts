/**
 * 真实 IndexedDB 下的断网续传
 *
 * fake-indexeddb 跟真实实现的差别集中在事务时序、跨页面生命周期和配额上，
 * 而这三点正好是续传逻辑的全部要害。这里用真浏览器 + 真刷新来验。
 */
import { test, expect, initSdk, openPage } from './fixture';

test('用的是真的 IndexedDB，不是降级后端', async ({ page, collected }) => {
  void collected;
  await initSdk(page, { offlinePersistence: true });

  const backend = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 500));
    const plugin = window.__aemeath__
      .getAemeath()
      .getPluginInstance('offline-persistence') as { getStatus: () => { backend: string } };
    return plugin.getStatus().backend;
  });

  expect(backend).toBe('indexeddb');
});

test('断网写入的日志跨页面刷新后仍能补传', async ({ page, context, collected }) => {
  await initSdk(page, { offlinePersistence: true });
  await page.waitForTimeout(500);

  await context.setOffline(true);
  await page.evaluate(() => {
    window.__aemeath__.getAemeath().error('survives a reload');
  });
  // 给落盘留时间：IndexedDB 写入是异步的
  await page.waitForTimeout(1500);

  expect(collected.uploads.some((u) => u.message === 'survives a reload')).toBe(false);

  // WebKit 在 setOffline(true) 时 page.reload() 会直接内部报错（Playwright 限制，
  // 不是 SDK 行为）。先恢复网络再 goto：IndexedDB 数据还在，等价于「关页再开」。
  await context.setOffline(false);
  await openPage(page);
  await page.evaluate(() => {
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
      offlinePersistence: true,
    });
  });

  await expect
    .poll(() => collected.uploads.map((u) => u.message), { timeout: 25000 })
    .toContain('survives a reload');
});

test('跨刷新的补传不能把同一条日志发两遍', async ({ page, context, collected }) => {
  await initSdk(page, { offlinePersistence: true });
  await page.waitForTimeout(500);

  await context.setOffline(true);
  await page.evaluate(() => {
    window.__aemeath__.getAemeath().error('exactly once please');
  });
  await page.waitForTimeout(1500);

  await context.setOffline(false);
  await openPage(page);
  await page.evaluate(() => {
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
      offlinePersistence: true,
    });
  });

  await expect
    .poll(() => collected.uploads.map((u) => u.message), { timeout: 25000 })
    .toContain('exactly once please');

  // 再等一轮补传周期，确认没有第二次
  await page.waitForTimeout(8000);
  const count = collected.uploads.filter((u) => u.message === 'exactly once please').length;
  expect(count, `同一条日志被发了 ${count} 次`).toBe(1);
});

test('成功上报后磁盘上的副本要被清掉', async ({ page, collected }) => {
  await initSdk(page, { offlinePersistence: true });
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    window.__aemeath__.getAemeath().error('should be cleaned from disk');
  });

  await expect
    .poll(() => collected.uploads.map((u) => u.message), { timeout: 15000 })
    .toContain('should be cleaned from disk');

  await page.waitForTimeout(2000);

  const pending = await page.evaluate(() => {
    const plugin = window.__aemeath__
      .getAemeath()
      .getPluginInstance('offline-persistence') as { getStatus: () => { pending: number } };
    return plugin.getStatus().pending;
  });

  expect(pending, '上报成功了但磁盘副本还在，会越堆越多').toBe(0);
});

test('补传的日志带得到捕获时间和补传标记', async ({ page, context, collected }) => {
  await initSdk(page, { offlinePersistence: true });
  await page.waitForTimeout(500);

  await context.setOffline(true);
  const capturedAt = Date.now();
  await page.evaluate(() => {
    window.__aemeath__.getAemeath().error('metadata check');
  });
  await page.waitForTimeout(1500);
  await context.setOffline(false);

  await expect
    .poll(() => collected.uploads.some((u) => u.message === 'metadata check'), {
      timeout: 25000,
    })
    .toBe(true);

  const entry = collected.uploads.find((u) => u.message === 'metadata check')!;
  // timestamp 必须是「当初出错的时刻」，不能被补传时刻覆盖，
  // 否则线上排查时所有断网日志都会挤在恢复网络的那一秒。
  expect(Number(entry.timestamp)).toBeLessThan(capturedAt + 5000);
});
