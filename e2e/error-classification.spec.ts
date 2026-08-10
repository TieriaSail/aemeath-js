/**
 * 错误分类：服务端 5xx ≠ 断网
 *
 * 5xx 应消耗热重试预算并进入 parked；断网应暂停、不烧预算，恢复后补发。
 */
import { test, expect, openPage } from './fixture';

test('服务端 5xx 消耗热重试预算并 parked，不会永久暂停', async ({ page, collected }) => {
  const parked: Array<{ reason?: string; message?: string; retryCount?: number }> = [];
  await page.exposeFunction('__park5xx', (p: unknown) => {
    const parsed = JSON.parse(JSON.stringify(p)) as {
      reason?: string;
      retryCount?: number;
      log?: { message?: string };
    };
    parked.push({
      reason: parsed.reason,
      message: parsed.log?.message,
      retryCount: parsed.retryCount,
    });
  });

  // 一直 500
  collected.failNext = 999;

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
        if (!res.ok) {
          return {
            success: false,
            shouldRetry: true,
            retryReason: 'server',
            error: `HTTP ${res.status}`,
          };
        }
        return { success: true };
      },
      queue: {
        uploadInterval: 200,
        deduplicationDelay: 0,
        maxRetries: 2,
        // 加快重试，测得动
        retryBackoff: { baseMs: 50, maxMs: 100 },
      },
      network: { enabled: false },
      cache: { enabled: false },
    });
    window.__aemeath__.getAemeath().on('upload:parked', (p: unknown) => {
      (window as unknown as { __park5xx: (x: unknown) => void }).__park5xx(p);
    });
    window.__aemeath__.getAemeath().error('server is down');
  });

  await expect
    .poll(() => parked.some((item) => item.message === 'server is down'), { timeout: 15000 })
    .toBe(true);

  const parkedItem = parked.find((item) => item.message === 'server is down');
  expect(parkedItem).toMatchObject({ reason: 'server', retryCount: 2 });

  // 恢复服务后新日志应能发出（队列没被永久 pause）
  collected.failNext = 0;
  await page.evaluate(() => {
    window.__aemeath__.getAemeath().error('server recovered');
  });
  await expect
    .poll(() => collected.uploads.map((u) => u.message), { timeout: 10000 })
    .toContain('server recovered');
});

test('真断网暂停不烧预算，恢复后补发', async ({ page, context, collected }) => {
  const drops: unknown[] = [];
  await page.exposeFunction('__dropNet', (p: unknown) => drops.push(p));

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
      queue: {
        uploadInterval: 200,
        deduplicationDelay: 0,
        maxRetries: 2,
      },
      network: { enabled: false },
      cache: { enabled: false },
    });
    window.__aemeath__.getAemeath().on('upload:drop', (p: unknown) => {
      (window as unknown as { __dropNet: (x: unknown) => void }).__dropNet(p);
    });
  });

  await context.setOffline(true);
  await page.evaluate(() => {
    window.__aemeath__.getAemeath().error('offline budget check');
  });
  await page.waitForTimeout(8000);
  expect(drops).toHaveLength(0);

  await context.setOffline(false);
  await expect
    .poll(() => collected.uploads.map((u) => u.message), { timeout: 20000 })
    .toContain('offline budget check');
});
