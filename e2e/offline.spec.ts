/**
 * 真实断网 / 恢复
 *
 * context.setOffline 是浏览器层面的真断网：navigator.onLine 真的翻牌，
 * online/offline 事件真的派发，fetch 真的抛 TypeError。单测里这些全是 mock
 * 出来的，抛的错误类型、事件时序都跟真实环境对不上。
 */
import { test, expect, initSdk } from './fixture';

test('断网期间的日志不丢，恢复后补发', async ({ page, context, collected }) => {
  await initSdk(page);

  await context.setOffline(true);
  await page.evaluate(() => {
    window.__aemeath__.getAemeath().error('logged while offline');
  });
  await page.waitForTimeout(2000);

  expect(
    collected.uploads.some((u) => u.message === 'logged while offline'),
    '断网时不应该有东西发出去'
  ).toBe(false);

  await context.setOffline(false);

  await expect
    .poll(() => collected.uploads.map((u) => u.message), { timeout: 20000 })
    .toContain('logged while offline');
});

test('断网不会烧光重试预算', async ({ page, context, collected }) => {
  const drops: unknown[] = [];
  await page.exposeFunction('__recordDrop', (info: unknown) => {
    drops.push(info);
  });

  await initSdk(page, {
    onDrop: undefined,
  });
  await page.evaluate(() => {
    window.__aemeath__.getAemeath().on('upload:drop', (payload: unknown) => {
      (window as unknown as { __recordDrop: (p: unknown) => void }).__recordDrop(
        JSON.parse(JSON.stringify(payload))
      );
    });
  });

  await context.setOffline(true);
  await page.evaluate(() => {
    window.__aemeath__.getAemeath().error('must survive a long outage');
  });

  // 断网 15 秒。按 2.5 的 offlinePolicy=pause，这段时间队列应该是暂停的，
  // 不应该反复重试直到耗尽 maxRetries 然后丢弃。
  await page.waitForTimeout(15000);
  expect(drops, `断网期间丢了日志：${JSON.stringify(drops)}`).toHaveLength(0);

  await context.setOffline(false);
  await expect
    .poll(() => collected.uploads.map((u) => u.message), { timeout: 20000 })
    .toContain('must survive a long outage');
});

test('反复抖动不会让队列卡死', async ({ page, context, collected }) => {
  await initSdk(page);

  for (let i = 0; i < 5; i++) {
    await context.setOffline(true);
    await page.evaluate((n) => {
      window.__aemeath__.getAemeath().error(`flap-${n}`);
    }, i);
    await page.waitForTimeout(300);
    await context.setOffline(false);
    await page.waitForTimeout(300);
  }

  await expect
    .poll(() => collected.uploads.map((u) => u.message), { timeout: 30000 })
    .toEqual(expect.arrayContaining(['flap-0', 'flap-1', 'flap-2', 'flap-3', 'flap-4']));
});

test('断网时 navigator.onLine 真的翻牌，SDK 能看到', async ({ page, context, collected }) => {
  void collected;
  await initSdk(page);

  await context.setOffline(true);
  const offlineSeen = await page.evaluate(() => navigator.onLine);
  await context.setOffline(false);
  const onlineSeen = await page.evaluate(() => navigator.onLine);

  expect(offlineSeen).toBe(false);
  expect(onlineSeen).toBe(true);
});
