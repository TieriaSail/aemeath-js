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
import { BrowserApiErrorsPlugin } from '../plugins/BrowserApiErrorsPlugin';
import { ErrorCapturePlugin } from '../plugins/ErrorCapturePlugin';
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
import { SafeGuardPlugin } from '../plugins/SafeGuardPlugin';
import type { LogEntry } from '../types';

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

async function purgeKnownOfflinePersistence(): Promise<void> {
  const targets = knownOfflinePersistenceOptions.size > 0
    ? [...knownOfflinePersistenceOptions.values()]
    : [{}];
  await Promise.all(targets.map((options) => purgeOfflinePersistenceStorage(options)));
  knownOfflinePersistenceOptions.clear();
}

/**
 * 日志级别顺序（用于过滤）
 */
const LOG_LEVEL_ORDER: Record<string, number> = {
  debug: 0,
  info: 1,
  track: 1,
  warn: 2,
  error: 3,
};

export interface BrowserLoggerOptions {
  /**
   * 上报函数
   */
  upload?: (log: LogEntry) => UploadResult | void | Promise<UploadResult | void>;

  /** 断网续传；配置 upload 时默认开启，可显式传 `false` 关闭 */
  offlinePersistence?: boolean | OfflinePersistencePluginOptions;

  /**
   * 是否启用浏览器 API 回调增强捕获
   * @default true
   */
  browserApiErrors?: boolean;

  /**
   * 是否启用错误捕获
   * @default true
   */
  errorCapture?: boolean;

  /**
   * 是否启用安全保护
   * @default true
   */
  safeGuard?: boolean;

  /**
   * 是否启用控制台输出
   * @default true
   */
  enableConsole?: boolean;

  /**
   * 最低日志级别（低于此级别的日志不会被记录和上报）
   * @default 'info'
   */
  level?: 'debug' | 'info' | 'track' | 'warn' | 'error';
}

// ==================== 无操作函数 ====================

const noop = (): void => {
  /* 被级别过滤 */
};

/**
 * 初始化 Logger
 */
function init(options: BrowserLoggerOptions = {}): AemeathLogger {
  if (globalLogger) {
    console.warn('[AemeathJs] Already initialized');
    return globalLogger;
  }

  const logger = new AemeathLogger({
    enableConsole: options.enableConsole ?? true,
  });

  // 日志级别过滤：低于 minLevel 的方法替换为 noop
  const minLevel = options.level ?? 'info';
  const minOrder = LOG_LEVEL_ORDER[minLevel] ?? 1;

  if (minOrder > 0) logger.debug = noop;
  if (minOrder > 1) logger.info = noop;
  if (minOrder > 1) logger.track = noop;
  if (minOrder > 2) logger.warn = noop;
  // error 永远不过滤

  // 浏览器 API 回调增强捕获（必须在 ErrorCapturePlugin 之前）
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

  // 上报
  if (options.upload) {
    const uploadFn = options.upload;
    logger.use(
      new UploadPlugin({
        onUpload: async (log) => {
          const result = await uploadFn(log);
          if (
            result != null &&
            typeof result === 'object' &&
            typeof (result as Partial<UploadResult>).success === 'boolean'
          ) {
            return result as UploadResult;
          }

          // 1.10.0 的 IIFE upload 允许返回 void；很多纯 JS 用户会直接写
          // `upload: (log) => fetch(...)`，这会把 Response 隐式返回。既要保留旧用法，
          // 又不能把真实 HTTP 失败一律当成功：对 Response-like 值按状态分类。
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

          // 只有 null/undefined 才是旧版 void 成功语义。其它畸形返回值交给
          // UploadPlugin 按失败处理，不能把回调契约错误伪装成送达成功。
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
      void purgeKnownOfflinePersistence().catch((error) => {
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

/**
 * 刷新早期错误
 */
function flushEarlyErrors(logger: AemeathLogger): void {
  if (typeof window === 'undefined') return;

  const win = window as Window & {
    __flushEarlyErrors__?: (callback: (errors: unknown[]) => void) => void;
    __EARLY_ERRORS__?: unknown[];
  };

  if (typeof win.__flushEarlyErrors__ === 'function') {
    win.__flushEarlyErrors__((errors) => {
      errors.forEach((err) => {
        const errorObj = err as Record<string, unknown>;
        if (errorObj.type === 'error') {
          logger.error(String(errorObj.message || 'Unknown error'), {
            tags: { source: 'early-error' },
            context: errorObj,
          });
        } else if (errorObj.type === 'unhandledrejection') {
          logger.error('Unhandled Promise rejection', {
            tags: { source: 'early-error' },
            context: errorObj,
          });
        } else if (errorObj.type === 'resource') {
          logger.warn('Resource loading failed', {
            tags: { source: 'early-error' },
            context: errorObj,
          });
        }
      });
    });
  }
}

/** 销毁 IIFE 全局实例并释放事件监听、定时器与持久化资源。 */
function destroy(): void {
  if (!globalLogger) return;
  globalLogger.destroy();
  globalLogger = null;
}

// 导出 API（仅使用 named export，避免 IIFE 构建警告）
export {
  init,
  getAemeath,
  destroy,
  AemeathLogger,
  BrowserApiErrorsPlugin,
  ErrorCapturePlugin,
  UploadPlugin,
  parseRetryAfter,
  classifyHttpUploadResponse,
  OfflinePersistencePlugin,
  SafeGuardPlugin,
};
