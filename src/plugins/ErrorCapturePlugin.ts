/**
 * 错误捕获插件 - 自动捕获全局错误
 */

import type { AemeathPlugin, AemeathInterface, LogOptions } from '../types';
import { PluginPriority } from '../types';
import type { PlatformAdapter } from '../platform/types';
import { normalizeCapturedError } from '../utils/errorEvidence';
import { runCapture } from '../utils/captureGuard';
import type { ErrorInfo } from '../types';
import { isConsoleCaptureSuppressed } from '../utils/consoleCaptureGuard';
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
  readonly version = '2.0.1';
  readonly priority: number = PluginPriority.EARLY;
  readonly description = '自动错误捕获';

  private readonly config: {
    captureUnhandledRejection: boolean;
    captureResourceError: boolean;
    captureConsoleError: boolean;
    debug: boolean;
    errorFilter?: (error: Error) => boolean;
  };
  private routeMatcher!: RouteMatcher;
  private readonly pluginRouteMatch: RouteMatchConfig | undefined;
  private readonly debugEnabled: boolean;
  private logger: AemeathInterface | null = null;
  private originalConsoleError: typeof console.error | null = null;
  private consoleErrorHandler: typeof console.error | null = null;
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

    if (this.originalConsoleError && console.error === this.consoleErrorHandler) {
      console.error = this.originalConsoleError;
      this.originalConsoleError = null;
      this.consoleErrorHandler = null;
    }

    this.log('Uninstalled');
    this.logger = null;
  }

  private captureGlobalError(): void {
    this.unregisterGlobalError = this.platform.errorCapture.onGlobalError((info) => {
      const original = info.error;
      this.capture('Global error', () => {
        const error = normalizeCapturedError(original, {
          channel: 'global',
          message: typeof info.message === 'string' ? info.message : 'Unknown error event',
          source: info.source, line: info.lineno, column: info.colno,
        });
        // Compatibility: category stays in type until the consumer migration.
        error.type = 'global';
        error.source = info.source;
        error.lineno = info.lineno;
        error.colno = info.colno;
        return error;
      }, original);
    });
  }

  private captureUnhandledRejection(): void {
    this.unregisterRejection = this.platform.errorCapture.onUnhandledRejection((info) => {
      const original = info.reason;
      this.capture('Unhandled promise rejection', () => {
        const error = normalizeCapturedError(original, { channel: 'unhandledrejection' });
        error.type = 'unhandledrejection';
        return error;
      }, original);
    });
  }

  private captureResourceError(): void {
    const { onResourceError } = this.platform.errorCapture;
    if (!onResourceError) return;
    this.unregisterResourceError = onResourceError.call(this.platform.errorCapture, (event) => {
      if (typeof HTMLElement === 'undefined' || !(event.target instanceof HTMLElement)) return;
      const target = event.target;
      this.capture('Resource load error', () => {
        const tagName = target.tagName.toLowerCase();
        const src = 'src' in target ? target.src : 'href' in target ? target.href : undefined;
        const error = normalizeCapturedError(undefined, {
          channel: 'resource', message: `Failed to load ${tagName}: ${src}`,
        });
        error.type = 'resource';
        error.tagName = tagName;
        error.src = src;
        error.outerHTML = target.outerHTML?.substring(0, 200);
        return error;
      });
    });
  }

  private captureConsoleError(): void {
    const original = console.error;
    this.originalConsoleError = original;
    const handler = (...args: unknown[]): void => {
      original.apply(console, args);
      if (!this.logger || isConsoleCaptureSuppressed()) return;
      runCapture('console', () => {
        const reason = args.find((arg) => {
          if (!arg || typeof arg !== 'object') return false;
          try { return arg instanceof Error ||
            (typeof (arg as Error).message === 'string' && typeof (arg as Error).name === 'string'); }
          catch { return false; }
        });
        if (reason) {
          this.capture('Console error',
            () => normalizeCapturedError(reason, { channel: 'console' }), reason,
            error => ({ tags: { source: 'console' },
              context: { consoleArgs: args.map(arg => arg === reason ? error : arg) } }));
        }
      });
    };
    this.consoleErrorHandler = handler;
    console.error = handler;
  }

  /** Preserve predicate configurations using identity, subclasses or private fields. */
  private originalFilterError(input: unknown): Error | undefined {
    if (!input || typeof input !== 'object') return undefined;
    try {
      if (input instanceof Error) return input;
      let prototype = Object.getPrototypeOf(input);
      const nativeError = Function.prototype.toString.call(Error);
      for (let depth = 0; prototype && depth < 32; depth++) {
        const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
        if (typeof constructor?.value === 'function' &&
          Function.prototype.toString.call(constructor.value) === nativeError) return input as Error;
        prototype = Object.getPrototypeOf(prototype);
      }
    } catch { /* Host objects and revoked proxies use the safe Error view. */ }
    return undefined;
  }

  private capture(message: string, buildError: () => ErrorInfo, original?: unknown,
    buildOptions?: (error: ErrorInfo) => Pick<LogOptions, 'tags' | 'context'>): void {
    if (!this.logger) return;
    if (!this.routeMatcher.shouldCapture(this.platform.getCurrentPath())) return;
    const originalError = this.config.errorFilter ? this.originalFilterError(original) : undefined;
    if (originalError) {
      // Filter the original identity before taking its only snapshot. A second
      // snapshot can consume a lazy getter twice and lose its original stack.
      try { if ((originalError as Error & { _isAemeathInternalError?: boolean })._isAemeathInternalError === true) return; }
      catch { /* The normalizer records unreadable properties safely. */ }
      try { if (!this.config.errorFilter!(originalError)) return; }
      catch { /* Preserve the legacy fail-open behavior of a broken filter. */ }
    }
    let error = buildError();
    if (error._isAemeathInternalError === true) return;
    if (this.config.errorFilter && !originalError) {
      const view = Object.assign(new Error(error.value), error);
      view.name = error.evidence?.originalName || 'Error';
      try { if (!this.config.errorFilter(view)) return; }
      catch { /* Preserve the legacy fail-open behavior of a broken filter. */ }
      // Snapshot all accepted fields, including deletions, without letting the
      // pre-filter value or a filter-only synthetic stack override redaction.
      const fields: Record<string, PropertyDescriptor> = Object.create(null);
      for (const key of Object.getOwnPropertyNames(view)) {
        // On older V8 versions even reading the stack descriptor realizes the
        // lazy stack and calls message getters. Skip filter-only stacks first.
        if (key === 'stack' && error.stack === undefined) continue;
        const field = Object.getOwnPropertyDescriptor(view, key);
        if (!field) continue;
        if (field.get) field.get = field.get.bind(view);
        fields[key] = field;
      }
      fields.value = fields.message || { value: '', enumerable: true };
      delete fields.message;
      if (error.stack === undefined) delete fields.stack;
      error = normalizeCapturedError(Object.create(null, fields));
    }
    // Preserve occurrences; errorObjectId links channels without dropping them.
    this.logger?.error(message, { ...buildOptions?.(error), error });
  }
}
