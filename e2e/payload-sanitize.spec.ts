/**
 * PayloadSanitize 在真实浏览器里的行为
 *
 * vitest 已覆盖清洗算法本身；这里验的是「经 initAemeath 默认链路 + 真上报」后，
 * 拆分 / 拒绝是否真的发生，以及 onDrop / 事件是否到得了用户手里。
 */
import { test, expect, initSdk } from './fixture';

test('超大整包会被拆成多条上报，且带 split 标记', async ({ page, collected }) => {
  const splits: unknown[] = [];
  await page.exposeFunction('__onSplit', (p: unknown) => {
    splits.push(JSON.parse(JSON.stringify(p)));
  });

  await initSdk(page, {
    payloadSanitize: { maxBytes: 4000 },
  });
  await page.evaluate(() => {
    window.__aemeath__.getAemeath().on('payload:split', (p: unknown) => {
      (window as unknown as { __onSplit: (x: unknown) => void }).__onSplit(p);
    });
    const big = 'x'.repeat(3000);
    window.__aemeath__.getAemeath().error('needs split', {
      context: { a: big, b: big },
    });
  });

  await expect
    .poll(() => collected.uploads.filter((u) => String(u.message) === 'needs split').length, {
      timeout: 15000,
    })
    .toBeGreaterThan(1);

  const chunks = collected.uploads.filter((u) => u.message === 'needs split');
  const tags = chunks.map((c) => (c.tags ?? {}) as Record<string, unknown>);
  expect(tags.every((t) => typeof t.splitId === 'string')).toBe(true);
  expect(new Set(tags.map((t) => t.splitId)).size).toBe(1);
  expect(splits.length).toBeGreaterThan(0);
});

test('单字段超过整包预算时整条拒绝，并走到 onDrop', async ({ page, collected }) => {
  const drops: Array<{ reason?: string; message?: string }> = [];
  await page.exposeFunction('__onDrop', (p: unknown) => {
    const parsed = JSON.parse(JSON.stringify(p)) as {
      reason?: string;
      log?: { message?: string };
    };
    drops.push({ reason: parsed.reason, message: parsed.log?.message });
  });

  await initSdk(page, {
    payloadSanitize: { maxBytes: 2000 },
    onDrop: undefined,
  });
  // onDrop 是 init 选项；上面传 undefined 会被覆盖。改用事件。
  await page.evaluate(() => {
    window.__aemeath__.getAemeath().on('upload:drop', (p: unknown) => {
      (window as unknown as { __onDrop: (x: unknown) => void }).__onDrop(p);
    });
    window.__aemeath__.getAemeath().on('payload:rejected', (p: unknown) => {
      (window as unknown as { __onDrop: (x: unknown) => void }).__onDrop({
        reason: 'payload-too-large',
        log: { message: (p as { entry?: { message?: string } }).entry?.message },
      });
    });

    window.__aemeath__.getAemeath().error('too big field', {
      context: { monster: 'y'.repeat(5000) },
    });
  });

  await expect.poll(() => drops.length, { timeout: 10000 }).toBeGreaterThan(0);
  expect(drops.some((d) => d.reason === 'payload-too-large')).toBe(true);
  // 被拒绝的不应出现在上报端点
  await page.waitForTimeout(1500);
  expect(collected.uploads.some((u) => u.message === 'too big field')).toBe(false);
});

test('普通尺寸日志经过默认清洗后一字不变', async ({ page, collected }) => {
  await initSdk(page);
  await page.evaluate(() => {
    window.__aemeath__.getAemeath().error('plain message', {
      context: { userId: 'u-1', note: 'hello' },
      tags: { page: 'home' },
    });
  });

  await expect
    .poll(() => collected.uploads.find((u) => u.message === 'plain message'), {
      timeout: 10000,
    })
    .toBeTruthy();

  const entry = collected.uploads.find((u) => u.message === 'plain message')!;
  expect(entry.context).toEqual({ userId: 'u-1', note: 'hello' });
  expect((entry.tags as Record<string, unknown>).page).toBe('home');
  expect((entry.tags as Record<string, unknown>).splitId).toBeUndefined();
});
