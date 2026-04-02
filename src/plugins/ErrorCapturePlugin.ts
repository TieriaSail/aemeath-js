/**
 * 错误捕获插件 - 自动捕获全局错误
 */

import type { AemeathPlugin, AemeathInterface } from '../types';
import type { PlatformAdapter } from '../platform/types';
import { SYNTHETIC_STACK } from '../platform/constants';
import { ErrorDeduplicator } from '../utils/errorDeduplicator';
import { shouldIgnoreOnError } from '../utils/wrap';
import {
  RouteMatcher,
  type RouteMatchConfig,
} from '../utils/routeMatcher';

interface ErrorWithExtras extends Error {
  source?: string;
  lineno?: number;
  colno?: number;
  type?: string;
  tagName?: string;
  src?: string;
  outerHTML?: string;
  [SYNTHETIC_STACK]?: boolean;
}

// 重新导出 RouteMatchConfig 以保持向后兼容
export type { RouteMatchConfig } from '../utils/routeMatcher';

export interface ErrorCapturePluginOptions {
  captureUnhandledRejection?: boolean;
  captureResourceError?: boolean;
  captureConsoleError?: boolean;
  errorFilter?: (error: Error) => boolean;

  /**
   * 路由匹配配置
   * 控制在哪些路由下启用错误监控
   */
  routeMatch?: RouteMatchConfig;

  /**
   * 是否启用调试模式（输出详细日志）
   * @default false
   */
  debug?: boolean;
}

export class ErrorCapturePlugin implements AemeathPlugin {
  readonly name = 'error-capture';
  readonly version = '2.0.0';
  readonly description = '自动错误捕获';

  private readonly config: {
    captureUnhandledRejection: boolean;
    captureResourceError: boolean;
    captureConsoleError: boolean;
    debug: boolean;
    errorFilter?: (error: Error) => boolean;
  };
  private readonly deduplicator: ErrorDeduplicator;
  private routeMatcher!: RouteMatcher;
  private readonly pluginRouteMatch: RouteMatchConfig | undefined;
  private readonly debugEnabled: boolean;
  private logger: AemeathInterface | null = null;
  private originalConsoleError: typeof console.error | null = null;
  private platform!: PlatformAdapter;
  private unregisterGlobalError: (() => void) | null = null;
  private unregisterRejection: (() => void) | null = null;
  private unregisterResourceError: (() => void) | null = null;

  constructor(options: ErrorCapturePluginOptions = {}) {
    this.debugEnabled = options.debug ?? false;
    this.config = {
      captureUnhandledRejection: options.captureUnhandledRejection ?? true,
      captureResourceError: options.captureResourceError ?? true,
      captureConsoleError: options.captureConsoleError ?? false,
      debug: options.debug ?? false,
      errorFilter: options.errorFilter,
    };

    this.deduplicator = new ErrorDeduplicator({
      enabled: true,
      timeWindow: 5000,
      maxCacheSize: 100,
    });

    this.pluginRouteMatch = options.routeMatch;
  }

  /** 调试日志 */
  private log(...args: unknown[]): void {
    if (this.debugEnabled) {
      console.log('[ErrorCapture]', ...args);
    }
  }

  /** 警告日志 */
  private warn(...args: unknown[]): void {
    if (this.debugEnabled) {
      console.warn('[ErrorCapture]', ...args);
    }
  }

  install(logger: AemeathInterface): void {
    this.logger = logger;
    this.platform = logger.platform;

    // Compose global matcher with plugin-level routeMatch
    this.routeMatcher = RouteMatcher.compose(
      logger.routeMatcher,
      this.pluginRouteMatch,
      { debug: this.debugEnabled, debugPrefix: '[ErrorCapture]' },
    );

    try {
      this.captureGlobalError();
    } catch (e) {
      this.warn('Failed to set up global error capture:', e);
    }

    if (this.config.captureUnhandledRejection) {
      try {
        this.captureUnhandledRejection();
      } catch (e) {
        this.warn('Failed to set up unhandled rejection capture:', e);
      }
    }

    if (this.config.captureResourceError) {
      try {
        this.captureResourceError();
      } catch (e) {
        this.warn('Failed to set up resource error capture:', e);
      }
    }

    if (this.config.captureConsoleError) {
      try {
        this.captureConsoleError();
      } catch (e) {
        this.warn('Failed to set up console error capture:', e);
      }
    }

    this.log('Installed');
  }

  uninstall(): void {
    if (this.unregisterGlobalError) {
      this.unregisterGlobalError();
      this.unregisterGlobalError = null;
    }

    if (this.unregisterRejection) {
      this.unregisterRejection();
      this.unregisterRejection = null;
    }

    if (this.unregisterResourceError) {
      this.unregisterResourceError();
      this.unregisterResourceError = null;
    }

    if (this.originalConsoleError) {
      console.error = this.originalConsoleError;
      this.originalConsoleError = null;
    }

    this.deduplicator.stop();
    this.log('Uninstalled');
    this.logger = null;
  }

  private captureGlobalError(): void {
    this.unregisterGlobalError = this.platform.errorCapture.onGlobalError(
      (info) => {
        // Skip if the error was already captured by a wrapped callback
        if (shouldIgnoreOnError()) {
          this.log('Skipped duplicate (already captured by wrapped callback)');
          return;
        }

        const msgStr = typeof info.message === 'string'
          ? info.message
          : (typeof Event !== 'undefined' && info.message instanceof Event)
            ? (info.message.type || 'Unknown error event')
            : 'Unknown error event';
        const err = info.error || new Error(msgStr);

        if (this.shouldCaptureError(err)) {
          try {
            const ext = err as ErrorWithExtras;
            ext.source = info.source;
            ext.lineno = info.lineno;
            ext.colno = info.colno;
            ext.type = 'global';
          } catch {
            // err may be frozen or non-extensible
          }

          const hasMeaningfulStack = err.stack && !(err as ErrorWithExtras)[SYNTHETIC_STACK];

          const errorInfo = {
            message: err.message,
            stack: hasMeaningfulStack ? err.stack : undefined,
            type: 'global',
            filename: info.source,
            lineno: info.lineno,
            colno: info.colno,
          };

          if (this.deduplicator.check(errorInfo)) {
            this.logger?.error('Global error', { error: err });
          }
        }
      },
    );
  }

  private captureUnhandledRejection(): void {
    this.unregisterRejection = this.platform.errorCapture.onUnhandledRejection(
      (info) => {
        let error: Error;
        const reason = info.reason;

        if (reason instanceof Error) {
          error = reason;
        } else {
          if (typeof reason === 'object' && reason !== null) {
            try {
              error = new Error(JSON.stringify(reason));
            } catch {
              error = new Error(String(reason));
            }
          } else {
            error = new Error(String(reason));
          }
        }

        if (this.shouldCaptureError(error)) {
          (error as ErrorWithExtras).type = 'unhandledrejection';

          const errorInfo = {
            message: error.message,
            stack: error.stack,
            type: 'unhandledrejection',
          };

          if (this.deduplicator.check(errorInfo)) {
            this.logger?.error('Unhandled promise rejection', { error });
          }
        }
      },
    );
  }

  private captureResourceError(): void {
    const { onResourceError } = this.platform.errorCapture;
    if (!onResourceError) return;

    const boundOnResourceError = onResourceError.bind(this.platform.errorCapture);
    this.unregisterResourceError = boundOnResourceError((event: Event) => {
      if (
        typeof HTMLElement !== 'undefined' &&
        event.target !== window &&
        event.target instanceof HTMLElement
      ) {
        const target = event.target;
        const tagName = target.tagName?.toLowerCase();
        const src =
          'src' in target
            ? (target.src as string)
            : 'href' in target
              ? (target.href as string)
              : undefined;

        if (
          src &&
          (src.includes('aemeath-js') ||
            src.includes('aemeath-js.global.js'))
        ) {
          this.warn('忽略日志系统资源加载错误:', src);
          return;
        }

        const error = new Error(`Failed to load ${tagName}: ${src}`) as ErrorWithExtras;
        error.type = 'resource';
        error.tagName = tagName;
        error.src = src;
        error.outerHTML = target.outerHTML?.substring(0, 200);

        this.logger?.error('Resource load error', { error });
      }
    });
  }

  private captureConsoleError(): void {
    this.originalConsoleError = console.error;

    console.error = (...args: unknown[]): void => {
      this.originalConsoleError!.apply(console, args);

      const error = args.find((arg) => arg instanceof Error) as
        | Error
        | undefined;

      if (error && this.shouldCaptureError(error)) {
        const errorInfo = {
          message: error.message,
          stack: error.stack,
          type: 'console',
        };

        if (this.deduplicator.check(errorInfo)) {
          this.logger?.error('Console error', {
            error,
            tags: { source: 'console' },
            context: { consoleArgs: args },
          });
        }
      }
    };
  }

  /**
   * 检查错误是否来自日志系统自身
   * 医者不能自医：日志系统的错误不应该被自己捕获
   *
   * @param error - 错误对象
   * @returns true 表示是日志系统内部错误，应该被排除
   */
  private isLoggerInternalError(error: Error | any): boolean {
    // 1. 检查特殊标记（由 Logger 内部主动标记的错误）
    if (error && error._isAemeathInternalError === true) {
      return true;
    }

    // 2. 检查错误信息前缀（Logger 内部日志都以特定前缀开头）
    if (error && error.message) {
      const message = error.message.toString();
      const loggerMessages = [
        '[Logger]',
        '[UploadPlugin]',
        '[SafeGuard]',
        '[ErrorCapture]',
        '[EarlyError]',
        '[EarlyErrorCapture]',
        '[Performance]',
        '[NetworkPlugin]',
        '[BrowserApiErrors]',
        '[AemeathJs]',
      ];

      if (loggerMessages.some((pattern) => message.includes(pattern))) {
        return true;
      }
    }

    // 3. 检查错误堆栈中是否包含 aemeath-js 相关路径
    if (error && error.stack) {
      const stack = error.stack.toString();
      const loggerPatterns = [
        'aemeath-js',
        'aemeath-js.global.js',
      ];

      if (loggerPatterns.some((pattern) => stack.includes(pattern))) {
        return true;
      }
    }

    return false;
  }

  private shouldCaptureError(error: Error): boolean {
    // 🛡️ 1. 主动排除日志系统自身的错误（医者不能自医）
    if (this.isLoggerInternalError(error)) {
      this.warn('忽略日志系统内部错误，避免自我报告:', error.message);
      return false;
    }

    // 🎯 2. 检查路由匹配（使用共享的路由匹配器）
    if (!this.routeMatcher.shouldCapture(this.platform.getCurrentPath())) {
      return false;
    }

    // 🔍 3. 自定义过滤器
    if (!this.config.errorFilter) {
      return true;
    }

    try {
      return this.config.errorFilter(error);
    } catch (err) {
      this.warn('Error filter threw:', err);
      return true;
    }
  }
}
