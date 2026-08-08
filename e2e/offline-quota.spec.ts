/**
 * 离线持久化配额 / 淘汰在真实 IndexedDB 下的行为
 *
 * 重要语义：`maxEntries` 管的是**磁盘**容量，不是 UploadPlugin 的内存队列。
 * 同一次页面生命周期里断网→恢复，内存队列里的日志仍会全部上报；
 * 配额淘汰只在「页面关掉、只剩磁盘」之后才决定能补传哪些。
 */
import { test, expect, initSdk, ORIGIN } from './fixture';
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

async function openFreshPage(
  context: import('@playwright/test').BrowserContext,
  collected: { uploads: Array<Record<string, unknown>> },
  harness: string
): Promise<import('@playwright/test').Page> {
  const page = await context.newPage();
  await page.route(`${ORIGIN}/`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body><script src="/harness.js"></script></body></html>`,
    })
  );
  await page.route(`${ORIGIN}/harness.js`, (route) =>
    route.fulfill({ contentType: 'application/javascript', body: harness })
  );
  await page.route(`${ORIGIN}/collect`, async (route) => {
    try {
      collected.uploads.push(route.request().postDataJSON() as Record<string, unknown>);
    } catch {
      /* ignore */
    }
    await route.fulfill({ status: 200, body: '{}' });
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => typeof window.__aemeath__ !== 'undefined');
  return page;
}

async function initQuota(page: import('@playwright/test').Page, maxEntries: number): Promise<void> {
  await page.evaluate((max) => {
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
      offlinePersistence: { maxEntries: max },
    });
  }, maxEntries);
}

test('同页断网恢复：磁盘淘汰了，内存队列仍会把旧日志发出去（当前语义）', async ({
  page,
  context,
  collected,
}) => {
  const quotaDrops: Array<{ reason?: string }> = [];
  await page.exposeFunction('__quotaDropObs', (p: unknown) => {
    const parsed = JSON.parse(JSON.stringify(p)) as { reason?: string };
    quotaDrops.push(parsed);
  });

  await initSdk(page, {
    offlinePersistence: { maxEntries: 3 },
    cache: { enabled: false },
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    window.__aemeath__.getAemeath().on('upload:drop', (p: unknown) => {
      (window as unknown as { __quotaDropObs: (x: unknown) => void }).__quotaDropObs(p);
    });
  });

  await context.setOffline(true);
  for (let i = 0; i < 5; i++) {
    await page.evaluate((n) => {
      window.__aemeath__.getAemeath().error(`same-session-${n}`);
    }, i);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(1200);

  const status = await page.evaluate(() => {
    const plugin = window.__aemeath__
      .getAemeath()
      .getPluginInstance('offline-persistence') as {
      getStatus: () => { pending: number; quotaDrops: number };
    };
    return plugin.getStatus();
  });
  expect(status.pending).toBeLessThanOrEqual(3);
  expect(status.quotaDrops).toBeGreaterThanOrEqual(2);
  // 磁盘淘汰必须可观测：走 upload:drop / storage-quota，但不踢内存队列
  expect(quotaDrops.some((d) => d.reason === 'storage-quota')).toBe(true);

  await context.setOffline(false);
  await expect
    .poll(
      () =>
        collected.uploads.filter((u) => String(u.message).startsWith('same-session-'))
          .length,
      { timeout: 25000 }
    )
    .toBe(5);

  expect(collected.uploads.map((u) => u.message)).toContain('same-session-0');
});

test('跨页面后只剩磁盘：maxEntries 淘汰生效，最早的补不回来', async ({
  page,
  context,
  collected,
}) => {
  const harness = await bundleHarness();

  await initSdk(page, {
    offlinePersistence: { maxEntries: 3 },
    cache: { enabled: false },
  });
  await page.waitForTimeout(500);

  await context.setOffline(true);
  for (let i = 0; i < 5; i++) {
    await page.evaluate((n) => {
      window.__aemeath__.getAemeath().error(`cross-nav-${n}`);
    }, i);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(1500);

  // 关掉旧页丢掉内存队列。WebKit 在 setOffline(true) 时连 newPage.goto 都会
  // 内部报错，所以这里先恢复网络再开新页——此时内存已空，只会从磁盘 hydrate。
  await page.close();
  await context.setOffline(false);
  const page2 = await openFreshPage(context, collected, harness);
  await initQuota(page2, 3);
  await page2.waitForTimeout(1000);

  const pending = await page2.evaluate(() => {
    const plugin = window.__aemeath__
      .getAemeath()
      .getPluginInstance('offline-persistence') as {
      getStatus: () => { pending: number };
    };
    return plugin.getStatus().pending;
  });
  // hydrate 可能已经开始补传，pending 会往下走；关键是上报条数
  void pending;

  await expect
    .poll(
      () =>
        collected.uploads.filter((u) => String(u.message).startsWith('cross-nav-')).length,
      { timeout: 25000 }
    )
    .toBeGreaterThan(0);

  await page2.waitForTimeout(5000);
  const messages = collected.uploads
    .map((u) => String(u.message))
    .filter((m) => m.startsWith('cross-nav-'));

  expect(messages.length).toBeLessThanOrEqual(3);
  expect(messages).not.toContain('cross-nav-0');
  expect(messages).toContain('cross-nav-4');
});

test('getStatus 在真 IndexedDB 下能反映 pending 变化', async ({ page, context, collected }) => {
  void collected;
  await initSdk(page, { offlinePersistence: true, cache: { enabled: false } });
  await page.waitForTimeout(500);

  await context.setOffline(true);
  await page.evaluate(() => {
    window.__aemeath__.getAemeath().error('status-probe');
  });
  await page.waitForTimeout(1000);

  const pendingOffline = await page.evaluate(() => {
    const plugin = window.__aemeath__
      .getAemeath()
      .getPluginInstance('offline-persistence') as {
      getStatus: () => { pending: number; backend: string };
    };
    return plugin.getStatus();
  });
  expect(pendingOffline.backend).toBe('indexeddb');
  expect(pendingOffline.pending).toBeGreaterThanOrEqual(1);

  await context.setOffline(false);
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const plugin = window.__aemeath__
          .getAemeath()
          .getPluginInstance('offline-persistence') as {
          getStatus: () => { pending: number };
        };
        return plugin.getStatus().pending;
      });
    }, { timeout: 25000 })
    .toBe(0);
});
