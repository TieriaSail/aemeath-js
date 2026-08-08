/**
 * SDK 自身产生的流量不能再被 SDK 记录
 *
 * 这类问题在 jsdom 里结构性测不出来：单测把 onUpload mock 掉了，不产生真实
 * fetch，插桩层根本看不到上报流量。只有真浏览器 + 真 fetch 才会暴露。
 */
import { test, expect, openPage } from './fixture';

/** 用默认配置初始化，网络监控保持默认（开启） */
async function initWithNetworkMonitoring(
  page: import('@playwright/test').Page,
  endpoint = '/collect'
): Promise<void> {
  await openPage(page);
  await page.evaluate((url) => {
    window.__aemeath__.initAemeath({
      enableConsole: false,
      upload: async (log: unknown) => {
        await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(log),
        });
        return { success: true };
      },
    });
  }, endpoint);
}

test('一条业务日志不能滚成无限次上报', async ({ page, collected }) => {
  await initWithNetworkMonitoring(page);
  await page.evaluate(() => {
    window.__aemeath__.getAemeath().error('single business error');
  });

  await page.waitForTimeout(8000);
  const after8s = collected.uploads.length;
  await page.waitForTimeout(8000);
  const after16s = collected.uploads.length;

  // 一条业务日志顶多带出个位数的伴生日志，且必须停下来。
  // 后 8 秒还在稳定增长 = 自反馈环没有收敛。
  expect(
    after16s - after8s,
    `上报量在持续增长（8s=${after8s} → 16s=${after16s}），说明 SDK 在给自己刷流量`
  ).toBe(0);
  expect(after16s).toBeLessThan(10);
});

test('SDK 自己的上报请求不能被记成一条网络日志', async ({ page, collected }) => {
  await initWithNetworkMonitoring(page);
  await page.evaluate(() => {
    window.__aemeath__.getAemeath().error('business error');
  });

  await page.waitForTimeout(5000);

  const selfLogs = collected.uploads.filter((u) =>
    String(u.message).includes('/collect')
  );
  expect(
    selfLogs.length,
    `有 ${selfLogs.length} 条日志是在描述 SDK 自己的上报请求`
  ).toBe(0);
});

test('上报地址不含内置排除片段时同样不能自我记录', async ({ page, collected }) => {
  // '/api/logs' 这类片段在 NetworkPlugin 里是硬编码排除的。用一个普通业务路径
  // 验证排除机制不是只对那几个特定后端有效。
  await page.route('https://aemeath.test/v2/telemetry', async (route) => {
    collected.uploads.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await initWithNetworkMonitoring(page, '/v2/telemetry');
  await page.evaluate(() => {
    window.__aemeath__.getAemeath().error('business error');
  });

  await page.waitForTimeout(5000);

  const selfLogs = collected.uploads.filter((u) =>
    String(u.message).includes('/v2/telemetry')
  );
  expect(selfLogs.length).toBe(0);
});
