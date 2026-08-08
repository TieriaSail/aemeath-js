/**
 * 补传元数据 + beforeSend 整组丢弃 + Data URL 清洗（真浏览器）
 */
import { test, expect, initSdk, openPage, ORIGIN } from './fixture';
import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

async function bundleHarness(): Promise<string> {
  const result = await build({
    entryPoints: [resolve(HERE, 'harness/entry.ts')],
    bundle: true,
    format: 'iife',
    target: 'es2019',
    write: false,
  });
  return result.outputFiles[0].text;
}

test('跨页补传带 offlineReplay；uploadedAt 存在且不早于 timestamp', async ({
  page,
  context,
  collected,
}) => {
  const harness = await bundleHarness();
  await initSdk(page, { offlinePersistence: true, cache: { enabled: false } });
  await page.waitForTimeout(500);

  await context.setOffline(true);
  const before = Date.now();
  await page.evaluate(() => {
    window.__aemeath__.getAemeath().error('replay meta');
  });
  await page.waitForTimeout(1000);
  const afterCapture = Date.now();

  // 关页丢内存，只留磁盘 → 补传路径会打 offlineReplay
  await page.close();
  await context.setOffline(false);

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
  await page2.goto(`${ORIGIN}/`);
  await page2.waitForFunction(() => typeof window.__aemeath__ !== 'undefined');
  await page2.evaluate(() => {
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
      cache: { enabled: false },
      offlinePersistence: true,
    });
  });

  await expect
    .poll(() => collected.uploads.find((u) => u.message === 'replay meta'), {
      timeout: 25000,
    })
    .toBeTruthy();

  const entry = collected.uploads.find((u) => u.message === 'replay meta')!;
  const tags = (entry.tags ?? {}) as Record<string, unknown>;
  const ts = Number(entry.timestamp);

  expect(ts).toBeGreaterThanOrEqual(before - 1000);
  expect(ts).toBeLessThanOrEqual(afterCapture + 1000);
  expect(tags.offlineReplay).toBe(true);
  expect(typeof tags.uploadedAt).toBe('number');
  expect(Number(tags.uploadedAt)).toBeGreaterThanOrEqual(ts);
});

test('默认清洗会替换超大 Data URL，普通字段保留', async ({ page, collected }) => {
  await initSdk(page);
  const dataUrl = 'data:image/png;base64,' + 'A'.repeat(800);
  await page.evaluate((url) => {
    window.__aemeath__.getAemeath().error('has data url', {
      context: { thumb: url, userId: 'u-9' },
    });
  }, dataUrl);

  await expect
    .poll(() => collected.uploads.find((u) => u.message === 'has data url'), {
      timeout: 10000,
    })
    .toBeTruthy();

  const entry = collected.uploads.find((u) => u.message === 'has data url')!;
  const ctx = entry.context as Record<string, unknown>;
  expect(ctx.userId).toBe('u-9');
  expect(String(ctx.thumb)).not.toContain('AAAA');
  expect(String(ctx.thumb)).toMatch(/omitted:data-url|\[omitted/i);
});

test('beforeSend 拦掉一个分片时，同组其余分片也不能发出去', async ({ page, collected }) => {
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
      payloadSanitize: { maxBytes: 4000 },
      beforeSend: (entry: { tags?: Record<string, unknown> }) => {
        const tags = entry.tags ?? {};
        // splitIndex 从 1 起算；拦第一片（返回 null，不是 false）
        if (typeof tags.splitId === 'string' && tags.splitIndex === 1) {
          return null;
        }
        return entry;
      },
    });

    const big = 'z'.repeat(3000);
    window.__aemeath__.getAemeath().error('split suppress', {
      context: { a: big, b: big },
    });
  });

  await page.waitForTimeout(5000);
  const related = collected.uploads.filter((u) => u.message === 'split suppress');
  expect(related, `不应有任何分片发出，实际 ${related.length} 条`).toHaveLength(0);
});
