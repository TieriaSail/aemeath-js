/**
 * forwardEarlyError helper — schema 一致性 regression
 *
 * 这个测试套件的核心使命：保证「同一份 EarlyError 输入」无论从哪个入口
 * （singleton/index.ts via EarlyErrorCapturePlugin、browser/index.ts via 内联
 * flushEarlyErrors）转发，最终产出的 LogEntry 在所有可观测字段上**完全一致**。
 *
 * 历史问题：v2.4.0-beta.2 之前，两个入口各写各的转发逻辑，schema 显著分歧
 * （level / message / tags / context / error 五个维度都不同），导致服务端聚合
 * 不到一起。详见 src/utils/forwardEarlyError.ts 头部「历史背景」表格。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { ErrorCapturePlugin } from '../src/plugins/ErrorCapturePlugin';
import { EarlyErrorCapturePlugin } from '../src/plugins/EarlyErrorCapturePlugin';
import { detectPlatform } from '../src/platform/detect';
import { ErrorCategory, type LogEntry } from '../src/types';
import { forwardEarlyError } from '../src/utils/forwardEarlyError';
import type { EarlyError } from '../src/platform/types';

function captureEntries(): { logger: AemeathLogger; entries: LogEntry[]; teardown: () => void } {
  const entries: LogEntry[] = [];
  const logger = new AemeathLogger({
    enableConsole: false,
    platform: detectPlatform(),
  });
  // 装 ErrorCapturePlugin 不是必须的（forwardEarlyError 直接 logger.error），
  // 但保留更接近真实 pipeline。
  logger.use(new ErrorCapturePlugin());
  const listener = (entry: LogEntry): void => {
    entries.push(entry);
  };
  logger.on('log', listener as unknown as (...args: unknown[]) => void);
  return {
    logger,
    entries,
    teardown: () => {
      logger.off('log', listener as unknown as (...args: unknown[]) => void);
      logger.destroy();
    },
  };
}

const baseDevice = {
  ua: 'jsdom',
  lang: 'zh-CN',
  screen: '1920x1080',
  url: 'https://example.test/path',
  time: 1700000000000,
};

function makeEarlyError(overrides: Partial<EarlyError> = {}): EarlyError {
  return {
    type: 'error',
    message: 'TypeError: foo is undefined',
    stack: 'Error: TypeError: foo is undefined\n    at <anonymous>:1:1',
    filename: 'https://example.test/app.js',
    lineno: 42,
    colno: 7,
    source: 'window.onerror',
    timestamp: 1700000000123,
    device: { ...baseDevice },
    ...overrides,
  };
}

describe('forwardEarlyError — canonical schema', () => {
  it('error 类型：level=error、message="Early error error"、tags.source 与 errorCategory 都注入', () => {
    const { logger, entries, teardown } = captureEntries();
    forwardEarlyError(logger, makeEarlyError());
    teardown();

    expect(entries).toHaveLength(1);
    const entry = entries[0];

    expect(entry.level).toBe('error');
    expect(entry.message).toBe('Early error error');

    expect(entry.tags?.source).toBe('early-error');
    // errorCategory 必须由 Logger.identifyErrorCategory 自动识别为 'early'
    // （因为 err.earlyError === true）— 这是把 schema 接入既有错误类别报表的关键。
    expect(entry.tags?.errorCategory).toBe(ErrorCategory.EARLY);

    // entry.error 必须存在，且承载所有原始字段
    expect(entry.error).toBeDefined();
    expect(entry.error?.value).toBe('TypeError: foo is undefined');
    expect(entry.error?.stack).toContain('TypeError: foo is undefined');
    // entry.error.type 被 normalizeError 的 for...of 循环用 err.type 覆盖，
    // 最终是 EarlyError 的类型 discriminator（'error'），而不是 Error 类名。
    // 这是好事 —— 按 entry.error.type 直接过滤早期错误的子类型。
    expect(entry.error?.type).toBe('error');

    const ext = entry.error as Record<string, unknown>;
    expect(ext.filename).toBe('https://example.test/app.js');
    expect(ext.lineno).toBe(42);
    expect(ext.colno).toBe(7);
    expect(ext.source).toBe('window.onerror');
    expect(ext.earlyError).toBe(true);
    expect(ext.captureTimestamp).toBe(1700000000123);
    expect(ext.device).toEqual(baseDevice);
  });

  it('resource 类型：level=error（与 error 一致，不再降级 warn）', () => {
    const { logger, entries, teardown } = captureEntries();
    forwardEarlyError(logger, makeEarlyError({
      type: 'resource',
      message: 'Failed to load script: https://cdn.test/foo.js',
      stack: null,
    }));
    teardown();

    expect(entries).toHaveLength(1);
    const entry = entries[0];

    // 关键：resource 错误**不是** warn。旧 browser bundle 把它降为 warn，
    // 新 schema 对齐到 singleton 行为统一为 error。如果用户希望 warn 级别，
    // 可在 beforeSend 中改写。
    expect(entry.level).toBe('error');
    expect(entry.message).toBe('Early resource error');
    expect(entry.error?.value).toBe('Failed to load script: https://cdn.test/foo.js');
    // resource 没有 stack，不应该捏造一个 'null' 字符串
    expect(entry.error?.stack).toBeUndefined();
  });

  it('unhandledrejection 类型：message 模板正确', () => {
    const { logger, entries, teardown } = captureEntries();
    forwardEarlyError(logger, makeEarlyError({
      type: 'unhandledrejection',
      message: 'Promise rejection: foo bar',
    }));
    teardown();

    expect(entries[0].message).toBe('Early unhandledrejection error');
    expect(entries[0].error?.value).toBe('Promise rejection: foo bar');
    expect((entries[0].error as Record<string, unknown>).type).toBe('unhandledrejection');
  });

  it('compatibility 类型：与 singleton 一致也会被转发上报', () => {
    const { logger, entries, teardown } = captureEntries();
    forwardEarlyError(logger, makeEarlyError({
      type: 'compatibility',
      message: 'Browser compatibility issues: IndexedDB, fetch',
      stack: null,
    }));
    teardown();

    // 旧 browser bundle 路径会丢弃 compatibility，新 schema 对齐：转发上报。
    // 用户可在 beforeSend 中按 entry.error?.type === 'compatibility' 过滤掉。
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe('Early compatibility error');
    expect((entries[0].error as Record<string, unknown>).type).toBe('compatibility');
  });

  it('空 message 兜底：使用 "Early error" 而不是空串', () => {
    const { logger, entries, teardown } = captureEntries();
    forwardEarlyError(logger, makeEarlyError({ message: '' }));
    teardown();

    // err.message 为空时用兜底文本，避免 entry.error.value 也是空串
    expect(entries[0].error?.value).toBe('Early error');
  });

  it('null stack 不会被转成字符串 "null"', () => {
    const { logger, entries, teardown } = captureEntries();
    forwardEarlyError(logger, makeEarlyError({ stack: null }));
    teardown();
    expect(entries[0].error?.stack).toBeUndefined();
  });
});

describe('forwardEarlyError — 入口 parity（真实 install 路径）', () => {
  // 这是 #4 真正的护栏：分别走真实的 EarlyErrorCapturePlugin.install() 链路
  // 与 browser/index.ts init() 链路，对比两边产出的 LogEntry。
  //
  // 如果未来某天某一侧重新 inline 自己的转发逻辑（绕过 helper），
  // schema 立即偏离，本测试 fail。

  // 用到的字段集合：所有 LogEntry 上对外可见的字段（除 logId / timestamp 外，
  // 这两个是每条日志独立生成的随机/瞬时值，不参与 schema 一致性校验）。
  function projectSchema(entry: LogEntry): Record<string, unknown> {
    return {
      level: entry.level,
      message: entry.message,
      tags: entry.tags,
      context: entry.context,
      error: entry.error,
      environment: entry.environment,
      release: entry.release,
    };
  }

  function setupEarlyScript(earlyErrors: EarlyError[], opts: { deferred?: boolean } = {}): void {
    (window as unknown as { __EARLY_ERRORS__: EarlyError[] }).__EARLY_ERRORS__ = earlyErrors;
    (window as unknown as { __flushEarlyErrors__: (cb: (errs: EarlyError[]) => void) => void })
      .__flushEarlyErrors__ = (cb) => {
        const fire = (): void => {
          cb(earlyErrors);
          (window as unknown as { __LOGGER_INITIALIZED__: boolean }).__LOGGER_INITIALIZED__ = true;
        };
        // deferred 模式：让 cb 在微任务里执行，方便 init 后再挂 listener
        if (opts.deferred) {
          Promise.resolve().then(fire);
        } else {
          fire();
        }
      };
  }

  function teardownEarlyScript(): void {
    delete (window as unknown as { __EARLY_ERRORS__?: unknown }).__EARLY_ERRORS__;
    delete (window as unknown as { __flushEarlyErrors__?: unknown }).__flushEarlyErrors__;
    delete (window as unknown as { __LOGGER_INITIALIZED__?: unknown }).__LOGGER_INITIALIZED__;
  }

  beforeEach(() => {
    teardownEarlyScript();
  });
  afterEach(() => {
    teardownEarlyScript();
    vi.resetModules();
  });

  async function entryViaSingletonPlugin(earlyError: EarlyError): Promise<LogEntry> {
    setupEarlyScript([earlyError], { deferred: true });
    const { logger, entries, teardown } = captureEntries();
    logger.use(new EarlyErrorCapturePlugin());
    // 等微任务里的 cb 触发 → forwardEarlyError → listener 同步追加到 entries
    await new Promise((r) => setTimeout(r, 0));
    teardown();
    expect(entries).toHaveLength(1);
    return entries[0];
  }

  async function entryViaBrowserInit(earlyError: EarlyError): Promise<LogEntry> {
    setupEarlyScript([earlyError], { deferred: true });

    vi.resetModules();
    const mod = await import('../src/browser/index');
    const logger = mod.init({ errorCapture: false, safeGuard: false });
    const captured: LogEntry[] = [];
    logger.on('log', ((entry: LogEntry) => {
      captured.push(entry);
    }) as unknown as (...args: unknown[]) => void);
    await new Promise((r) => setTimeout(r, 0));
    mod.destroy();
    expect(captured).toHaveLength(1);
    return captured[0];
  }

  it.each([
    makeEarlyError(),
    makeEarlyError({ type: 'resource', message: 'Failed to load <img>: /logo.png', stack: null }),
    makeEarlyError({ type: 'unhandledrejection', message: 'rejection foo' }),
    makeEarlyError({ type: 'compatibility', message: 'no IndexedDB', stack: null }),
  ])('singleton plugin 与 browser init 真实链路输出完全一致：type=$type', async (earlyError) => {
    const fromPlugin = await entryViaSingletonPlugin(earlyError);
    teardownEarlyScript();
    const fromBrowser = await entryViaBrowserInit(earlyError);

    expect(projectSchema(fromBrowser)).toEqual(projectSchema(fromPlugin));
  });
});
