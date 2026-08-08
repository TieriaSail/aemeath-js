/**
 * CDN IIFE 产物冒烟
 *
 * npm 入口和 IIFE 装载的插件集不完全一样（IIFE 不带 OfflinePersistence /
 * NetworkPlugin）。这里只验：产物能加载、能上报、默认清洗在。
 */
import { test as base, expect, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://aemeath-iife.test';
const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = resolve(HERE, '../dist/aemeath-js.global.js');

interface Collected {
  uploads: Array<Record<string, unknown>>;
}

const test = base.extend<{ collected: Collected }>({
  collected: [
    async ({ page }, use) => {
      const collected: Collected = { uploads: [] };
      let bundle: string;
      try {
        bundle = readFileSync(BUNDLE, 'utf-8');
      } catch {
        throw new Error('缺少 dist/aemeath-js.global.js，请先 npm run build');
      }

      await page.route(`${ORIGIN}/`, (route: Route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><body><script src="/aemeath.js"></script></body></html>`,
        })
      );
      await page.route(`${ORIGIN}/aemeath.js`, (route: Route) =>
        route.fulfill({ contentType: 'application/javascript', body: bundle })
      );
      await page.route(`${ORIGIN}/collect`, async (route: Route) => {
        try {
          collected.uploads.push(route.request().postDataJSON() as Record<string, unknown>);
        } catch {
          /* ignore */
        }
        await route.fulfill({ status: 200, body: '{}' });
      });

      await use(collected);
    },
    { auto: true },
  ],
});

test('IIFE 全局 API 可 init 并上报', async ({ page, collected }) => {
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(
    () => typeof (window as unknown as { AemeathJs?: { init: unknown } }).AemeathJs?.init === 'function'
  );

  await page.evaluate(() => {
    const sdk = (window as unknown as {
      AemeathJs: {
        init: (o: Record<string, unknown>) => void;
        getAemeath: () => { error: (m: string, o?: unknown) => void };
      };
    }).AemeathJs;

    sdk.init({
      enableConsole: false,
      upload: async (log: unknown) => {
        await fetch('/collect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(log),
        });
      },
    });
    sdk.getAemeath().error('hello from iife');
  });

  await expect
    .poll(() => collected.uploads.map((u) => u.message), { timeout: 10000 })
    .toContain('hello from iife');
});

test('IIFE 默认清洗会替换超大 Data URL', async ({ page, collected }) => {
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(
    () => typeof (window as unknown as { AemeathJs?: { init: unknown } }).AemeathJs?.init === 'function'
  );

  const dataUrl = 'data:image/png;base64,' + 'B'.repeat(800);
  await page.evaluate((url) => {
    const sdk = (window as unknown as {
      AemeathJs: {
        init: (o: Record<string, unknown>) => void;
        getAemeath: () => { error: (m: string, o?: unknown) => void };
      };
    }).AemeathJs;

    sdk.init({
      enableConsole: false,
      upload: async (log: unknown) => {
        await fetch('/collect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(log),
        });
      },
    });
    sdk.getAemeath().error('iife dataurl', { context: { img: url } });
  }, dataUrl);

  await expect
    .poll(() => collected.uploads.find((u) => u.message === 'iife dataurl'), {
      timeout: 10000,
    })
    .toBeTruthy();

  const entry = collected.uploads.find((u) => u.message === 'iife dataurl')!;
  expect(String((entry.context as Record<string, unknown>).img)).toMatch(/omitted:data-url/i);
});
