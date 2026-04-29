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
import { UploadPlugin } from '../plugins/UploadPlugin';
import { SafeGuardPlugin } from '../plugins/SafeGuardPlugin';
import { detectPlatform } from '../platform/detect';
import { PluginPriority } from '../types';
import type { LogEntry, LogLevel, LogOptions } from '../types';

// 全局单例
let globalLogger: AemeathLogger | null = null;

const LOG_LEVEL_ORDER: Record<string, number> = {
  debug: 0,
  info: 1,
  track: 1,
  warn: 2,
  error: 3,
};

export interface BrowserLoggerOptions {
  /** 上报函数 */
  upload?: (log: LogEntry) => void | Promise<void>;
  /** 是否启用错误捕获 @default true */
  errorCapture?: boolean;
  /** 是否启用浏览器 API 回调增强捕获 @default true */
  browserApiErrors?: boolean;
  /** 是否启用安全保护 @default true */
  safeGuard?: boolean;
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

  // 上报
  if (options.upload) {
    const uploadFn = options.upload;
    logger.use(
      new UploadPlugin({
        onUpload: async (log) => {
          try {
            await uploadFn(log);
            return { success: true };
          } catch (err) {
            return { success: false, shouldRetry: true, error: String(err) };
          }
        },
      }),
    );
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

  platform.earlyCapture.flush((errors) => {
    if (errors.length === 0) return;
    errors.forEach((err) => {
      const context: Record<string, unknown> = {
        errorType: err.type,
        message: err.message,
        stack: err.stack,
        filename: err.filename,
        lineno: err.lineno,
        colno: err.colno,
        source: err.source,
        timestamp: err.timestamp,
        device: err.device,
      };
      if (err.type === 'error' || err.type === 'unhandledrejection') {
        logger.error(err.message || 'Unknown error', {
          tags: { source: 'early-error' },
          context,
        });
      } else if (err.type === 'resource') {
        logger.warn('Resource loading failed', {
          tags: { source: 'early-error' },
          context,
        });
      }
    });
  });
}

function destroy(): void {
  if (globalLogger) {
    globalLogger.destroy();
    globalLogger = null;
  }
}

export { init, getAemeath, destroy, AemeathLogger, ErrorCapturePlugin, BrowserApiErrorsPlugin, UploadPlugin, SafeGuardPlugin };
