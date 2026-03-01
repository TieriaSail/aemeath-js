/**
 * 错误捕获插件 - 自动捕获全局错误
 */

import type { AemeathPlugin, AemeathInterface } from '../types';
import { ErrorDeduplicator } from '../utils/errorDeduplicator';
import {
  RouteMatcher,
  type RouteMatchConfig,
} from '../utils/routeMatcher';

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
  readonly version = '1.1.0';
  readonly description = '自动错误捕获';

  private readonly config: {
    captureUnhandledRejection: boolean;
    captureResourceError: boolean;
    captureConsoleError: boolean;
    debug: boolean;
    errorFilter?: (error: Error) => boolean;
  };
  private readonly deduplicator: ErrorDeduplicator;
  private readonly routeMatcher: RouteMatcher;
  private readonly debugEnabled: boolean;
  private logger: AemeathInterface | null = null;
  private originalErrorHandler: OnErrorEventHandler | null = null;
  private originalRejectionHandler:
    | ((event: PromiseRejectionEvent) => void)
    | null = null;
  private originalConsoleError: typeof console.error | null = null;

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

    // 使用共享的路由匹配器
    this.routeMatcher = new RouteMatcher({
      config: options.routeMatch,
      debug: options.debug,
      debugPrefix: '[ErrorCapture]',
    });
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

    this.captureGlobalError();

    if (this.config.captureUnhandledRejection) {
      this.captureUnhandledRejection();
    }

    if (this.config.captureResourceError) {
      this.captureResourceError();
    }

    if (this.config.captureConsoleError) {
      this.captureConsoleError();
    }

    this.log('Installed');
  }

  uninstall(): void {
    if (this.originalErrorHandler) {
      window.onerror = this.originalErrorHandler;
    }

    if (this.originalRejectionHandler) {
      window.removeEventListener(
        'unhandledrejection',
        this.originalRejectionHandler,
      );
    }

    if (this.originalConsoleError) {
      console.error = this.originalConsoleError;
    }

    this.deduplicator.stop();
    this.log('Uninstalled');
  }

  private captureGlobalError(): void {
    this.originalErrorHandler = window.onerror;

    window.onerror = (message, source, lineno, colno, error) => {
      if (this.originalErrorHandler) {
        this.originalErrorHandler.call(
          window,
          message,
          source,
          lineno,
          colno,
          error,
        );
      }

      const err = error || new Error(String(message));

      if (this.shouldCaptureError(err)) {
        // 附加错误位置信息（用于 SourceMap 还原和自动分类）
        (err as any).source = source;
        (err as any).lineno = lineno;
        (err as any).colno = colno;
        (err as any).type = 'global';

        const errorInfo = {
          message: err.message,
          stack: err.stack,
          type: 'global',
          filename: source,
          lineno,
          colno,
        };

        if (this.deduplicator.check(errorInfo)) {
          this.logger?.error('Global error', { error: err });
        }
      }

      return true;
    };
  }

  private captureUnhandledRejection(): void {
    const handler = (event: PromiseRejectionEvent): void => {
      let error: Error;

      if (event.reason instanceof Error) {
        // ✅ reason 是 Error，直接使用
        error = event.reason;
      } else {
        // ✅ reason 不是 Error，转换为 Error
        // 优化 message：如果是对象，使用 JSON.stringify 保留信息
        if (typeof event.reason === 'object' && event.reason !== null) {
          try {
            error = new Error(JSON.stringify(event.reason));
          } catch {
            error = new Error(String(event.reason));
          }
        } else {
          error = new Error(String(event.reason));
        }
      }

      if (this.shouldCaptureError(error)) {
        (error as any).type = 'unhandledrejection';

        const errorInfo = {
          message: error.message,
          stack: error.stack,
          type: 'unhandledrejection',
        };

        if (this.deduplicator.check(errorInfo)) {
          this.logger?.error('Unhandled promise rejection', { error });
        }
      }
    };

    this.originalRejectionHandler = handler;
    window.addEventListener('unhandledrejection', handler);
  }

  private captureResourceError(): void {
    window.addEventListener(
      'error',
      (event) => {
        if (event.target !== window && event.target instanceof HTMLElement) {
          const target = event.target;
          const tagName = target.tagName?.toLowerCase();
          const src =
            'src' in target
              ? (target.src as string)
              : 'href' in target
                ? (target.href as string)
                : undefined;

          // 🛡️ 关键：排除日志系统自身的资源加载错误
          if (
            src &&
            (src.includes('aemeath-js') ||
              src.includes('aemeath-js') ||
              src.includes('browser.global.js'))
          ) {
            this.warn('忽略日志系统资源加载错误:', src);
            return;
          }

          const error = new Error(`Failed to load ${tagName}: ${src}`);
          (error as any).type = 'resource';
          (error as any).tagName = tagName;
          (error as any).src = src;
          (error as any).outerHTML = target.outerHTML?.substring(0, 200);

          this.logger?.error('Resource load error', { error });
        }
      },
      true,
    );
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
        'aemeath-js',  // npm 安装路径
        'aemeath-js',       // 本地开发路径
        'browser.global.js', // IIFE 构建产物
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
    if (!this.routeMatcher.shouldCapture()) {
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
