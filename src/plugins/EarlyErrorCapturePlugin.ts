/**
 * 早期错误捕获插件
 *
 * 功能：在 React 挂载前捕获错误，与主 Logger 无缝集成
 * 使用：通过构建插件自动注入到 HTML
 */

import type { AemeathInterface, AemeathPlugin } from '../types';
import { RouteMatcher, type RouteMatchConfig } from '../utils/routeMatcher';
import { getEarlyErrorCaptureScript } from '../build-plugins/early-error-script';

// 重新导出 RouteMatchConfig 以保持向后兼容
export type { RouteMatchConfig } from '../utils/routeMatcher';

export type { EarlyErrorScriptOptions } from '../build-plugins/early-error-script';

export interface EarlyError {
  type: 'error' | 'resource' | 'unhandledrejection' | 'compatibility';
  message: string;
  stack: string | null;
  filename?: string;
  lineno?: number;
  colno?: number;
  source?: string;
  timestamp: number;
  device: {
    ua: string;
    lang: string;
    screen: string;
    url: string;
    time: number;
  };
}

export interface EarlyErrorCaptureOptions {
  enabled?: boolean;
  maxErrors?: number;
  fallbackEndpoint?: string;
  fallbackTimeout?: number;
  autoRefreshOnChunkError?: boolean;
  checkCompatibility?: boolean;

  /**
   * 路由匹配配置
   * 控制在哪些路由下启用早期错误监控
   */
  routeMatch?: RouteMatchConfig;

  /**
   * 发送方式偏好
   *
   * - 'auto'：sendBeacon 优先，失败降级到 XHR（默认）
   * - 'xhr'：只用 XHR（需要自定义 header 或确保 Content-Type 时使用）
   * - 'beacon'：只用 sendBeacon（页面卸载场景更可靠，但不支持自定义 header）
   */
  fallbackTransport?: 'auto' | 'xhr' | 'beacon';

  /**
   * 自定义请求头（仅 XHR 模式生效，sendBeacon 不支持自定义 header）
   *
   * Content-Type 默认为 application/json，可覆盖。
   *
   * WARNING: 值会被 JSON.stringify 序列化到内联脚本，必须是字面量。
   */
  fallbackHeaders?: Record<string, string>;

  /**
   * 自定义 payload 格式化函数
   *
   * 接收早期错误数组和设备元信息，返回要发送的数据：
   * - 返回单个对象 → 一次请求发送（适合批量接口）
   * - 返回数组 → 每个元素分别发一次请求（适合单条接口）
   * - 不提供 → 使用默认格式
   *
   * WARNING: 此函数会被 .toString() 序列化注入到 HTML 内联脚本，
   * 不能引用外部变量、闭包或 ES Module。函数体必须是纯 ES5 语法。
   */
  formatPayload?: (errors: unknown[], meta: unknown) => unknown;
}

export class EarlyErrorCapturePlugin implements AemeathPlugin {
  public name = 'EarlyErrorCapture';
  public version = '1.3.0';
  public description = 'Capture errors before React mounts';

  private options: Omit<Required<EarlyErrorCaptureOptions>, 'routeMatch' | 'fallbackHeaders' | 'formatPayload' | 'fallbackTransport'> & {
    fallbackTransport: 'auto' | 'xhr' | 'beacon';
    fallbackHeaders?: Record<string, string>;
    formatPayload?: (errors: unknown[], meta: unknown) => unknown;
  };
  private routeMatcher!: RouteMatcher;
  private readonly pluginRouteMatch: RouteMatchConfig | undefined;
  private logger: AemeathInterface | null = null;

  constructor(options: EarlyErrorCaptureOptions = {}) {
    this.options = {
      enabled: options.enabled !== false,
      maxErrors: options.maxErrors ?? 50,
      fallbackEndpoint: options.fallbackEndpoint ?? '',
      fallbackTimeout: options.fallbackTimeout ?? 30000,
      autoRefreshOnChunkError: options.autoRefreshOnChunkError !== false,
      checkCompatibility: options.checkCompatibility !== false,
      fallbackTransport: options.fallbackTransport ?? 'auto',
      fallbackHeaders: options.fallbackHeaders,
      formatPayload: options.formatPayload,
    };

    this.pluginRouteMatch = options.routeMatch;
  }

  public install(logger: AemeathInterface): void {
    if (!this.options.enabled) {
      return;
    }

    this.logger = logger;
    this.routeMatcher = RouteMatcher.compose(
      logger.routeMatcher,
      this.pluginRouteMatch,
      { debugPrefix: '[EarlyErrorCapture]' },
    );
    this.flushEarlyErrors();
  }

  public uninstall(): void {
    this.logger = null;
  }

  private flushEarlyErrors(): void {
    if (typeof window === 'undefined') {
      return;
    }

    if (!this.routeMatcher.shouldCapture()) {
      console.debug(
        '[EarlyErrorCapture] 当前路由不在监控范围内，跳过早期错误上报:',
        window.location.pathname,
      );
      const flushFn = (window as any).__flushEarlyErrors__;
      if (typeof flushFn === 'function') {
        flushFn(() => {});
      }
      return;
    }

    const flushFn = (
      window as Window & {
        __flushEarlyErrors__?: (
          callback: (errors: EarlyError[]) => void,
        ) => void;
      }
    ).__flushEarlyErrors__;

    if (typeof flushFn !== 'function') {
      console.warn(
        '[EarlyErrorCapture] Early error capture script not found. Make sure to use the build plugin.',
      );
      return;
    }

    flushFn((errors: EarlyError[]) => {
      if (!this.logger || errors.length === 0) {
        return;
      }

      console.debug(`[EarlyErrorCapture] Flushed ${errors.length} early errors`);

      errors.forEach((earlyError) => {
        const err = new Error(earlyError.message || 'Early error');
        (err as any).type = earlyError.type;
        (err as any).stack = earlyError.stack;
        (err as any).filename = earlyError.filename;
        (err as any).lineno = earlyError.lineno;
        (err as any).colno = earlyError.colno;
        (err as any).source = earlyError.source;
        (err as any).earlyError = true;
        (err as any).captureTimestamp = earlyError.timestamp;
        (err as any).device = earlyError.device;

        this.logger!.error(`Early ${earlyError.type} error`, { error: err });
      });
    });
  }

  public getConfig(): EarlyErrorCaptureOptions {
    return { ...this.options };
  }
}

/**
 * 生成早期错误捕获脚本（供构建插件使用）
 *
 * @deprecated 请使用 `getEarlyErrorCaptureScript(options)` 代替。
 *             该函数保留用于向后兼容，内部已转发到新的统一实现。
 */
export function generateEarlyErrorScript(
  options: Required<EarlyErrorCaptureOptions>,
): string {
  return getEarlyErrorCaptureScript({
    maxErrors: options.maxErrors,
    fallbackEndpoint: options.fallbackEndpoint,
    fallbackTimeout: options.fallbackTimeout,
    autoRefreshOnChunkError: options.autoRefreshOnChunkError,
    checkCompatibility: options.checkCompatibility,
    fallbackTransport: options.fallbackTransport as 'auto' | 'xhr' | 'beacon' | undefined,
    fallbackHeaders: options.fallbackHeaders,
    formatPayload: options.formatPayload,
  });
}
