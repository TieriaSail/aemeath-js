/**
 * 冒烟：SDK 在真实浏览器里能不能跑起来、能不能把日志发出去
 *
 * 这是整套 e2e 的地基。它一红，后面所有用例都不用看了。
 */
import { test, expect, initSdk, openPage } from './fixture';

test('npm 入口在真实浏览器里可以初始化', async ({ page, collected }) => {
  void collected;
  await openPage(page);
  const ok = await page.evaluate(() => {
    window.__aemeath__.initAemeath({ enableConsole: false });
    return window.__aemeath__.isAemeathInitialized();
  });
  expect(ok).toBe(true);
});

test('一条错误日志能真的发到上报端点', async ({ page, collected }) => {
  await initSdk(page);
  await page.evaluate(() => {
    window.__aemeath__.getAemeath().error('hello from a real browser');
  });

  await expect
    .poll(() => collected.uploads.map((u) => u.message), { timeout: 10000 })
    .toContain('hello from a real browser');
});

test('未捕获异常会被自动抓到并上报', async ({ page, collected }) => {
  await initSdk(page);
  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error('uncaught in a real browser');
    }, 0);
  });

  // 断言整包而不是 message 字段：setTimeout 抛出的异常会被 BrowserApiErrors
  // 先一步抓到，message 是「Caught error in wrapped callback」，原始信息在
  // error/context 里。这里只关心异常有没有完整上报。
  await expect
    .poll(
      () =>
        collected.uploads.some((u) =>
          JSON.stringify(u).includes('uncaught in a real browser')
        ),
      { timeout: 10000 }
    )
    .toBe(true);
});
