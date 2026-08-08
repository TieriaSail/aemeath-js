/**
 * 真实浏览器夹具
 *
 * 两个刻意的选择：
 *
 * 1. 不起 HTTP 服务器，用路由拦截给一个真实的 https 源。必须是真实源而不是
 *    `file://` —— localStorage 和 IndexedDB 在 file 源下行为不一致甚至直接
 *    不可用，那样测的就不是生产环境了。
 * 2. 加载的是现打的 npm 入口，不是 dist 里的 IIFE。IIFE 不导出
 *    OfflinePersistencePlugin，而真实浏览器测试要验的正是它。
 */
import { test as base, type Page, type Route } from '@playwright/test';
import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ORIGIN = 'https://aemeath.test';

const HERE = dirname(fileURLToPath(import.meta.url));

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>aemeath e2e</title></head>
<body><script src="/harness.js"></script></body></html>`;

/** 整个测试进程只打一次包 */
let bundlePromise: Promise<string> | undefined;

function getBundle(): Promise<string> {
  bundlePromise ??= build({
    entryPoints: [resolve(HERE, 'harness/entry.ts')],
    bundle: true,
    format: 'iife',
    target: 'es2019',
    write: false,
    sourcemap: 'inline',
  }).then((result) => result.outputFiles[0].text);
  return bundlePromise;
}

/** 上报端点收到的日志 */
export interface Collected {
  /** 每次 onUpload 收到的日志 */
  uploads: Array<Record<string, unknown>>;
  /** 页面里 console.error/warn 的内容，用来抓 SDK 自己的告警 */
  consoleErrors: string[];
  /** 让接下来 N 次上报返回 500（模拟服务端挂了） */
  failNext: number;
  /** 让上报端点挂住不响应（模拟请求飞行中），用于卸载时机的用例 */
  hang: boolean;
}

export const test = base.extend<{ collected: Collected }>({
  // auto: 不写进用例参数也会挂路由。否则 openPage 会真的去连 https://aemeath.test
  collected: [
    async ({ page }, use) => {
      const collected: Collected = {
        uploads: [],
        consoleErrors: [],
        failNext: 0,
        hang: false,
      };

      page.on('console', (msg) => {
        if (msg.type() === 'error' || msg.type() === 'warning') {
          collected.consoleErrors.push(msg.text());
        }
      });

      const bundle = await getBundle();

      await page.route(`${ORIGIN}/`, (route: Route) =>
        route.fulfill({ contentType: 'text/html', body: PAGE_HTML })
      );

      await page.route(`${ORIGIN}/harness.js`, (route: Route) =>
        route.fulfill({ contentType: 'application/javascript', body: bundle })
      );

      await page.route(`${ORIGIN}/collect`, async (route: Route) => {
        if (collected.hang) {
          // 记下载荷但永不响应：请求就停在飞行中
          try {
            collected.uploads.push({
              __inFlight: true,
              ...(route.request().postDataJSON() as Record<string, unknown>),
            });
          } catch {
            /* 载荷不可解析时忽略 */
          }
          return;
        }
        if (collected.failNext > 0) {
          collected.failNext -= 1;
          await route.fulfill({ status: 500, body: 'boom' });
          return;
        }
        try {
          collected.uploads.push(route.request().postDataJSON() as Record<string, unknown>);
        } catch {
          collected.uploads.push({ __unparsable: route.request().postData() });
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      });

      await use(collected);
    },
    { auto: true },
  ],
});

export const expect = base.expect;

/** 打开页面，等 harness 就绪 */
export async function openPage(page: Page): Promise<void> {
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => typeof window.__aemeath__ !== 'undefined');
}

/**
 * 初始化 SDK，上报走 fetch 到 /collect
 *
 * `overrides` 浅合并进 initAemeath 的选项。注意 initAemeath 的 `upload`
 * 是一个扁平函数，`queue` / `cache` 是并列的顶层选项，不是嵌在 upload 里的。
 */
export async function initSdk(
  page: Page,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  await openPage(page);
  await page.evaluate((opts) => {
    window.__aemeath__.initAemeath({
      enableConsole: false,
      upload: async (log: unknown) => {
        const res = await fetch('/collect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(log),
        });
        // 抛出去而不是返回 failure：让 UploadPlugin 自己按传输层/服务端分类
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { success: true };
      },
      queue: { uploadInterval: 200, deduplicationDelay: 0 },
      // 默认关掉网络监控。开着的话每次上报都会被记成一条 network.success 日志，
      // 这条日志又触发一次上报，源源不断的自产流量会淹掉所有断言。
      // 这个环本身是 self-traffic.spec.ts 的被测对象，那里会显式打开。
      network: { enabled: false },
      ...(opts as Record<string, unknown>),
    });
  }, overrides);
}

declare global {
  interface Window {
    __aemeath__: {
      initAemeath: (o: Record<string, unknown>) => unknown;
      getAemeath: () => {
        error: (m: string, o?: unknown) => void;
        info: (m: string, o?: unknown) => void;
        getPluginInstance: (n: string) => unknown;
        on: (e: string, fn: (p: unknown) => void) => void;
      };
      resetAemeath: () => void;
      isAemeathInitialized: () => boolean;
      setBeforeSend: (fn: unknown) => void;
      AemeathLogger: new (o?: unknown) => unknown;
      OfflinePersistencePlugin: new (o?: unknown) => unknown;
      UploadPlugin: new (o?: unknown) => unknown;
      PayloadSanitizePlugin: new (o?: unknown) => unknown;
    };
  }
}
