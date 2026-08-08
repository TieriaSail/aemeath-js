/**
 * 敌对环境：存储 API 抛错时 SDK 仍能上报，且不把自己的存储错误当业务错误刷出去
 */
import { test, expect, openPage } from './fixture';

test('localStorage 全抛错时，上报主链路仍通', async ({ page, collected }) => {
  await openPage(page);

  await page.evaluate(() => {
    const boom = () => {
      throw new Error('localStorage blocked');
    };
    const proto = Object.getPrototypeOf(window.localStorage);
    for (const key of ['getItem', 'setItem', 'removeItem', 'clear', 'key'] as const) {
      Object.defineProperty(window.localStorage, key, {
        configurable: true,
        value: boom,
      });
    }
    // 有的实现挂在 Storage.prototype 上
    try {
      Object.defineProperty(proto, 'getItem', { configurable: true, value: boom });
      Object.defineProperty(proto, 'setItem', { configurable: true, value: boom });
      Object.defineProperty(proto, 'removeItem', { configurable: true, value: boom });
    } catch {
      /* ignore */
    }

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
      queue: { uploadInterval: 150, deduplicationDelay: 0 },
      network: { enabled: false },
      // 缓存会碰 localStorage；坏了也不该拖垮上报
      cache: { enabled: true },
    });

    window.__aemeath__.getAemeath().error('survives hostile localStorage');
  });

  await expect
    .poll(() => collected.uploads.map((u) => u.message), { timeout: 10000 })
    .toContain('survives hostile localStorage');

  // 不应把 localStorage 抛错当成业务错误刷一堆
  const storageNoise = collected.uploads.filter((u) =>
    String(u.message).includes('localStorage blocked')
  );
  expect(storageNoise.length).toBe(0);
});

test('IndexedDB 不可用时 OfflinePersistence 降级，上报仍通', async ({ page, collected }) => {
  await openPage(page);

  await page.evaluate(() => {
    // 拆掉 IndexedDB：open 直接失败
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      get() {
        throw new Error('indexedDB blocked');
      },
    });

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
      queue: { uploadInterval: 150, deduplicationDelay: 0 },
      network: { enabled: false },
      cache: { enabled: false },
      offlinePersistence: true,
    });
  });

  // 等插件 init 降级
  await page.waitForTimeout(800);

  const status = await page.evaluate(() => {
    const plugin = window.__aemeath__
      .getAemeath()
      .getPluginInstance('offline-persistence') as {
      getStatus: () => { backend: string };
    } | null;
    return plugin?.getStatus?.() ?? null;
  });

  // 应落到 localstorage 或 noop，不能卡在 initializing，也不能把页面弄挂
  expect(status).not.toBeNull();
  expect(['localstorage', 'noop', 'indexeddb']).toContain(status!.backend);
  // indexedDB getter 抛错时不太可能真用上 indexeddb
  expect(status!.backend).not.toBe('initializing');

  await page.evaluate(() => {
    window.__aemeath__.getAemeath().error('survives without idb');
  });

  await expect
    .poll(() => collected.uploads.map((u) => u.message), { timeout: 10000 })
    .toContain('survives without idb');
});

test('beforeunload 时 localStorage 抛错不能打断其它清理', async ({ page, collected }) => {
  void collected;
  await openPage(page);

  const result = await page.evaluate(async () => {
    window.__aemeath__.initAemeath({
      enableConsole: false,
      upload: async () => ({ success: true }),
      queue: { uploadInterval: 60000 },
      network: { enabled: false },
      cache: { enabled: true },
    });

    window.__aemeath__.getAemeath().error('pending on unload');
    await new Promise((r) => setTimeout(r, 100));

    // 卸载瞬间让存储炸掉
    Object.defineProperty(window.localStorage, 'setItem', {
      configurable: true,
      value: () => {
        throw new Error('setItem blocked on unload');
      },
    });

    let threw = false;
    try {
      window.dispatchEvent(new Event('beforeunload'));
      window.dispatchEvent(new Event('pagehide'));
    } catch {
      threw = true;
    }

    // 还能继续调 API，说明页面没被存储错误打挂
    let stillAlive = false;
    try {
      window.__aemeath__.getAemeath().error('after unload handler');
      stillAlive = true;
    } catch {
      stillAlive = false;
    }

    return { threw, stillAlive };
  });

  expect(result.threw).toBe(false);
  expect(result.stillAlive).toBe(true);
});
