/**
 * 浏览器直接引入版本
 *
 * 用法：
 * <script src="https://unpkg.com/aemeath-js/dist/aemeath-js.global.js"></script>
 * <script>
 *   AemeathJs.init({
 *     upload: function(log) {
 *       fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
 *     }
 *   });
 * </script>
 */

import { AemeathLogger } from '../core/Logger';
import { ErrorCapturePlugin } from '../plugins/ErrorCapturePlugin';
import { BrowserApiErrorsPlugin } from '../plugins/BrowserApiErrorsPlugin';
import {
  UploadPlugin,
  parseRetryAfter,
  classifyHttpUploadResponse,
  type UploadResult,
} from '../plugins/UploadPlugin';
import {
  OfflinePersistencePlugin,
  purgeOfflinePersistenceStorage,
  type OfflinePersistencePluginOptions,
} from '../plugins/OfflinePersistencePlugin';
import { PayloadSanitizePlugin } from '../plugins/PayloadSanitizePlugin';
import { SafeGuardPlugin } from '../plugins/SafeGuardPlugin';
import { detectPlatform } from '../platform/detect';
import { PluginPriority } from '../types';
import type { LogEntry, LogLevel, LogOptions } from '../types';
import { forwardEarlyError } from '../utils/forwardEarlyError';

// 全局单例
let globalLogger: AemeathLogger | null = null;
const knownOfflinePersistenceOptions = new Map<string, OfflinePersistencePluginOptions>();

function rememberOfflinePersistenceOptions(options: OfflinePersistencePluginOptions): void {
  const key = [
    options.storage ?? 'auto',
    options.dbName ?? 'aemeath-offline',
    options.key ?? '__aemeath_offline__',
  ].join('|');
  knownOfflinePersistenceOptions.set(key, options);
}

async function purgeKnownOfflinePersistence(
  platform: AemeathLogger['platform'],
): Promise<void> {
  const targets = knownOfflinePersistenceOptions.size > 0
    ? [...knownOfflinePersistenceOptions.values()]
    : [{}];
  await Promise.all(targets.map((options) => purgeOfflinePersistenceStorage(platform, options)));
  knownOfflinePersistenceOptions.clear();
}

const LOG_LEVEL_ORDER: Record<string, number> = {
  debug: 0,
  info: 1,
  track: 1,
  warn: 2,
  error: 3,
};

export interface BrowserLoggerOptions {
  /** 上报函数 */
  upload?: (log: LogEntry) => UploadResult | void | Promise<UploadResult | void>;
  /** 断网续传；配置 upload 时默认开启，可显式传 `false` 关闭 */
  offlinePersistence?: boolean | OfflinePersistencePluginOptions;
  /** 是否启用错误捕获 @default true */
  errorCapture?: boolean;
  /** 是否启用浏览器 API 回调增强捕获 @default true */
  browserApiErrors?: boolean;
  /** 是否启用安全保护 @default true */
  safeGuard?: boolean;
  /**
   * 是否启用载荷清洗 @default true
   *
   * 关掉之后 Data URL、Blob、超大字段会原样进入上报，可能被服务端 413 拒绝
   * 或撑爆数据库字段。除非你在 upload 里自己做了同等处理，否则别关。
   */
  payloadSanitize?: boolean;
  /** 是否启用控制台输出 @default true */
  enableConsole?: boolean;
  /** 最低日志级别 @default 'info' */
  level?: 'debug' | 'info' | 'track' | 'warn' | 'error';
}

/**
 * 初始化 Logger
 */
function init(options: BrowserLoggerOptions = {}): AemeathLogger {
  if (globalLogger) {
    return globalLogger;
  }

  const logger = new AemeathLogger({
    enableConsole: options.enableConsole ?? true,
    platform: detectPlatform(),
  });

  const minLevel = options.level ?? 'info';
  const minOrder = LOG_LEVEL_ORDER[minLevel] ?? 1;

  if (minOrder > 0) {
    logger.use({
      name: 'level-filter',
      // 必须比 SafeGuard(EARLY=-100) 更早，保持 v1.x/v2.3 的语义：
      // 低于阈值的 debug 日志在进入 SafeGuard 速率窗 / 去重表之前就被丢弃。
      priority: PluginPriority.EARLIEST,
      install() {},
      beforeLog(level: LogLevel, _message: string, _options: LogOptions) {
        const order = LOG_LEVEL_ORDER[level as string] ?? 0;
        if (order < minOrder) return false;
        return undefined;
      },
    });
  }

  // Browser API callback wrapping (before error capture)
  if (options.browserApiErrors !== false) {
    logger.use(new BrowserApiErrorsPlugin());
  }

  // 错误捕获
  if (options.errorCapture !== false) {
    logger.use(new ErrorCapturePlugin());
  }

  // 安全保护
  if (options.safeGuard !== false) {
    logger.use(new SafeGuardPlugin());
  }

  // 载荷清洗（与 npm 入口 initAemeath 保持一致：默认启用）
  if (options.payloadSanitize !== false) {
    logger.use(new PayloadSanitizePlugin());
  }

  // 上报
  if (options.upload) {
    const uploadFn = options.upload;
    logger.use(
      new UploadPlugin({
          // 故意不 catch：异常要原样交给 UploadPlugin 去分类。fetch 断网抛的
          // TypeError 会被判为传输层失败（暂停等网络），而 axios 之类对 5xx 抛的
          // 异常带着 response，会被判为服务端失败（照常消耗重试预算）。
          // 在这里吞掉换成统一结果，两种情况就再也分不开了。
        onUpload: async (log) => {
          const result = await uploadFn(log);
          if (
            result != null &&
            typeof result === 'object' &&
            typeof (result as Partial<UploadResult>).success === 'boolean'
          ) {
            return result as UploadResult;
          }

          // IIFE upload 一直允许返回 void；纯 JS 用户也常直接返回 fetch() 的
          // Response。保留 void 兼容语义，但对 Response-like 值按 HTTP 状态分类，
          // 否则 4xx/5xx 会被当作没有 success 字段的永久失败直接丢弃。
          if (
            result != null &&
            typeof result === 'object' &&
            typeof (result as { ok?: unknown }).ok === 'boolean' &&
            typeof (result as { status?: unknown }).status === 'number'
          ) {
            const response = result as unknown as {
              status: number;
              headers?: { get?: (name: string) => string | null };
            };
            let retryAfter: string | null | undefined;
            try {
              retryAfter = response.headers?.get?.('Retry-After');
            } catch {
              retryAfter = undefined;
            }
            return classifyHttpUploadResponse(response.status, retryAfter);
          }

          // 只有 null/undefined 才是旧版 void 成功语义；畸形返回值不能伪装成送达。
          return result == null ? { success: true } : result as UploadResult;
        },
        localPersistence: options.offlinePersistence !== false,
      }),
    );
    if (options.offlinePersistence !== false) {
      const persistenceOptions = typeof options.offlinePersistence === 'object'
        ? options.offlinePersistence
        : {};
      rememberOfflinePersistenceOptions(persistenceOptions);
      logger.use(
        new OfflinePersistencePlugin(persistenceOptions),
      );
    } else {
      void purgeKnownOfflinePersistence(logger.platform).catch((error) => {
        console.warn('[Aemeath] Failed to purge offline persistence:', error);
      });
    }
  }

  globalLogger = logger;

  try {
    flushEarlyErrors(logger);
  } catch {
    // early error flush 失败不影响 logger 正常工作
  }

  return logger;
}

/**
 * 获取 Logger 实例
 */
function getAemeath(): AemeathLogger {
  if (!globalLogger) {
    throw new Error(
      '[AemeathJs] Not initialized. Call AemeathJs.init() first.',
    );
  }
  return globalLogger;
}

function flushEarlyErrors(logger: AemeathLogger): void {
  const platform = logger.platform;
  // 不变量：只要早期脚本已被注入（isInstalled() === true），就**必须**调用一次 flush()。
  // flush() 内部会:
  //   1. 把 window.__LOGGER_INITIALIZED__ 翻为 true（让早期脚本所有 listener 让位）
  //   2. 清掉 __FALLBACK_TIMER__（避免 doFallback 重复上报）
  //   3. 把累计的 __EARLY_ERRORS__ 通过 callback 交给主 Logger
  // 上报与否（错误数量）是 callback 内部的决定，**不能**用来跳过 flush 本身。
  // 旧实现用 hasEarlyErrors()（length > 0）早 return，导致绝大多数无错误的健康加载下
  // __LOGGER_INITIALIZED__ 永远不被翻牌、fallback 定时器到点开火，造成与模块化插件
  // 双轨重复上报。详见 v2.2.0-beta.1 early-handoff-bug-report Bug 1+2。
  if (!platform.earlyCapture.isInstalled()) return;

  // R17（v2.4.0-beta.3）：转发逻辑统一使用 src/utils/forwardEarlyError.ts，
  // 与 npm 单例入口（singleton/index.ts via EarlyErrorCapturePlugin）共用同一份
  // helper，输出完全相同的 LogEntry。
  //
  // ⚠️ 行为变更（仅影响 IIFE bundle 用户）：
  //   - resource 错误的 `level` 由 `warn` → `error`
  //   - `entry.message` 由 `err.message` → `"Early ${type} error"`
  //     （原始文本仍保留在 `entry.error.value`）
  //   - `entry.context` 不再被预填，扁平字段统一在 `entry.error.{...}`
  //   - `compatibility` 类型现在也会被转发上报（与 singleton 行为对齐）
  //     用户可通过 beforeSend 钩子过滤掉，例如：
  //     `(entry) => entry.error?.type === 'compatibility' ? null : entry`
  //
  // 详见 helper 文档头部「历史背景 / 统一方案」与 v2.4.0-beta.3 changelog。
  platform.earlyCapture.flush((errors) => {
    if (errors.length === 0) return;
    errors.forEach((earlyError) => {
      forwardEarlyError(logger, earlyError);
    });
  });
}

function destroy(): void {
  if (globalLogger) {
    globalLogger.destroy();
    globalLogger = null;
  }
}

export {
  init,
  getAemeath,
  destroy,
  AemeathLogger,
  ErrorCapturePlugin,
  BrowserApiErrorsPlugin,
  UploadPlugin,
  parseRetryAfter,
  classifyHttpUploadResponse,
  OfflinePersistencePlugin,
  SafeGuardPlugin,
};
