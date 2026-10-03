/**
 * SafeGuard × 拆分（真浏览器）
 *
 * SafeGuard 在 beforeLog（拆分之前），所以限流按「逻辑日志」计数；
 * 发出去的分片组必须完整，不能只剩半组。
 */
import { test, expect, openPage } from './fixture';

test('限流丢弃时，拆分组要么整组发出要么整组不发', async ({ page, collected }) => {
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
      queue: { uploadInterval: 100, deduplicationDelay: 0 },
      network: { enabled: false },
      payloadSanitize: { maxBytes: 2000 },
      // 极低限流，逼出丢弃
      safeGuard: { rateLimit: 2, mergeWindow: 5000 },
    });

    const fat = {
      a: 'x'.repeat(1200),
      b: 'y'.repeat(1200),
      c: 'z'.repeat(1200),
    };
    for (let i = 0; i < 12; i++) {
      window.__aemeath__.getAemeath().error('hot loop message', { context: fat });
    }
  });

  await page.waitForTimeout(4000);

  const chunks = collected.uploads.filter(
    (u) => u.message === 'hot loop message' && (u.tags as Record<string, unknown>)?.splitId
  );

  // 限流必须真的丢了一部分，否则用例没有验证力
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.length).toBeLessThan(12 * 3);

  const groups = new Map<string, Set<number>>();
  const totals = new Map<string, number>();
  for (const c of chunks) {
    const tags = c.tags as Record<string, unknown>;
    const id = String(tags.splitId);
    const idx = Number(tags.splitIndex);
    const total = Number(tags.splitTotal);
    if (!groups.has(id)) groups.set(id, new Set());
    groups.get(id)!.add(idx);
    totals.set(id, total);
  }

  for (const [id, seen] of groups) {
    expect(seen.size, `拆分组 ${id} 出现碎片：${[...seen]}`).toBe(totals.get(id));
  }
});

test('SafeGuard 限流按逻辑日志计，不按分片数计', async ({ page, collected }) => {
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
      queue: { uploadInterval: 100, deduplicationDelay: 0 },
      network: { enabled: false },
      payloadSanitize: { maxBytes: 2000 },
      // rateLimit=1：若按分片计，第一条拆成 3 片后第 2、3 片会被毙
      safeGuard: { rateLimit: 1, mergeWindow: 0 },
    });

    window.__aemeath__.getAemeath().error('one logical', {
      context: {
        a: 'x'.repeat(1200),
        b: 'y'.repeat(1200),
        c: 'z'.repeat(1200),
      },
    });
  });

  await expect
    .poll(
      () => collected.uploads.filter((u) => u.message === 'one logical').length,
      { timeout: 10000 }
    )
    .toBeGreaterThanOrEqual(2);

  const chunks = collected.uploads.filter((u) => u.message === 'one logical');
  const tags = chunks.map((c) => c.tags as Record<string, unknown>);
  const splitId = tags[0]?.splitId;
  expect(typeof splitId).toBe('string');
  expect(tags.every((t) => t.splitId === splitId)).toBe(true);
  expect(chunks.length).toBe(Number(tags[0]?.splitTotal));
});
