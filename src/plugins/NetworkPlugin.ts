/**
 * 网络请求监控插件
 *
 * 根据平台自动选择正确的 instrumentation 模块：
 * - Browser: fetch + XHR
 * - MiniApp: miniapp-request
 * - Unknown/Noop: no-op
 *
 * 所有 monkey-patch 逻辑完全由 instrumentation 层管理。
 */

import type { AemeathPlugin, AemeathInterface } from '../types';
import type { PlatformAdapter } from '../platform/types';
import type { NetworkEvent, InstrumentOptions, Unsubscribe } from '../instrumentation/types';
import { instrumentFetch } from '../instrumentation/fetch';
import { instrumentXHR } from '../instrumentation/xhr';
import { instrumentMiniAppRequest } from '../instrumentation/miniapp-request';
import { RouteMatcher, type RouteMatchConfig } from '../utils/routeMatcher';

export interface NetworkLog {
  type: 'fetch' | 'xhr' | 'request';
  url: string;
  method: string;
  status?: number;
  statusText?: string;
  duration: number;
  timestamp: number;
  error?: string;
  requestBody?: unknown;
  responseBody?: unknown;
  responseCode?: number | string;
  responseMessage?: string;
}

export type NetworkLogType = 'success' | 'error' | 'slow';

export interface NetworkPluginOptions {
  interceptFetch?: boolean;
  interceptXHR?: boolean;
  urlFilter?: (url: string) => boolean;
  logTypes?: NetworkLogType[];
  captureRequestBody?: boolean;
  captureResponseBody?: boolean;
  maxResponseBodySize?: number;
  slowThreshold?: number;
  slowRequestExcludePatterns?: string[];
  debug?: boolean;
  /**
   * 插件级路由匹配配置
   * 在全局 routeMatch 基础上进一步限定网络监控的路由范围
   */
  routeMatch?: RouteMatchConfig;
  /**
   * MiniApp raw API object — when platform is miniapp,
   * the caller must provide the API handle (e.g. `wx`, `my`) for request instrumentation.
   * If omitted, the plugin will try to auto-detect from well-known globals.
   */
  miniAppAPI?: { request?: (options: Record<string, unknown>) => unknown };
}

type NetworkPluginConfig = Required<
  Omit<
    NetworkPluginOptions,
    'urlFilter' | 'logTypes' | 'slowRequestExcludePatterns' | 'miniAppAPI' | 'routeMatch'
  >
> &
  Pick<NetworkPluginOptions, 'urlFilter' | 'miniAppAPI'> & {
    logTypes: Set<NetworkLogType>;
    slowRequestExcludePatterns: string[];
  };

export class NetworkPlugin implements AemeathPlugin {
  readonly name = 'network';
  readonly version = '2.0.0';
  readonly description = '网络请求监控';

  private readonly config: NetworkPluginConfig;
  private readonly pluginRouteMatch: RouteMatchConfig | undefined;
  private routeMatcher!: RouteMatcher;
  private logger: AemeathInterface | null = null;
  private platform!: PlatformAdapter;
  private readonly unsubscribers: Unsubscribe[] = [];

  constructor(options: NetworkPluginOptions = {}) {
    const defaultLogTypes: NetworkLogType[] = ['success', 'error', 'slow'];
    const defaultSlowExcludePatterns = [
      '.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a',
      '.mp4', '.webm', '.avi', '.mov', '.mkv',
      '.png', '.jpg', '.jpeg', '.gif', '.webp',
      '.woff', '.woff2', '.ttf', '.otf', '.eot',
      '.pdf', '.zip', '.rar',
    ];

    this.config = {
      interceptFetch: options.interceptFetch ?? true,
      interceptXHR: options.interceptXHR ?? true,
      urlFilter: options.urlFilter,
      logTypes: new Set(options.logTypes ?? defaultLogTypes),
      captureRequestBody: options.captureRequestBody ?? true,
      captureResponseBody: options.captureResponseBody ?? true,
      maxResponseBodySize: options.maxResponseBodySize ?? 10240,
      slowThreshold: options.slowThreshold ?? 3000,
      slowRequestExcludePatterns:
        options.slowRequestExcludePatterns ?? defaultSlowExcludePatterns,
      debug: options.debug ?? false,
      miniAppAPI: options.miniAppAPI,
    };
    this.pluginRouteMatch = options.routeMatch;
  }

  private log(...args: unknown[]): void {
    if (this.config.debug) {
      console.log('[NetworkPlugin]', ...args);
    }
  }

  private warn(...args: unknown[]): void {
    if (this.config.debug) {
      console.warn('[NetworkPlugin]', ...args);
    }
  }

  install(logger: AemeathInterface): void {
    this.logger = logger;
    this.platform = logger.platform;

    this.routeMatcher = RouteMatcher.compose(
      logger.routeMatcher,
      this.pluginRouteMatch,
      { debug: this.config.debug, debugPrefix: '[NetworkPlugin]' },
    );

    try {
      this.setupIntercept();
    } catch (e) {
      this.warn('Failed to set up network intercept:', e);
    }

    this.log('Installed');
  }

  private buildInstrumentOptions(): InstrumentOptions {
    return {
      shouldCapture: (url: string) => this.shouldCapture(url),
      captureRequestBody: this.config.captureRequestBody,
      captureResponseBody: this.config.captureResponseBody,
      maxResponseBodySize: this.config.maxResponseBodySize,
    };
  }

  private handleNetworkEvent = (event: NetworkEvent): void => {
    if (!this.routeMatcher.shouldCapture(this.platform.getCurrentPath())) {
      return;
    }

    this.recordRequest({
      type: event.type,
      url: event.url,
      method: event.method,
      status: event.status,
      statusText: event.statusText,
      duration: event.duration,
      timestamp: event.timestamp,
      error: event.error,
      requestBody: event.requestBody,
      responseBody: event.responseBody,
      responseCode: event.responseCode,
      responseMessage: event.responseMessage,
    });
  };

  private setupIntercept(): void {
    const opts = this.buildInstrumentOptions();

    if (this.platform.type === 'browser') {
      if (this.config.interceptFetch) {
        this.unsubscribers.push(instrumentFetch(this.handleNetworkEvent, opts));
      }
      if (this.config.interceptXHR) {
        this.unsubscribers.push(instrumentXHR(this.handleNetworkEvent, opts));
      }
    } else if (this.platform.type === 'miniapp') {
      const api = this.resolveMiniAppAPI();
      if (api) {
        this.unsubscribers.push(instrumentMiniAppRequest(api, this.handleNetworkEvent, opts));
      }
    }
    // noop / unknown — nothing to instrument
  }

  private resolveMiniAppAPI(): { request?: (options: Record<string, unknown>) => unknown } | null {
    if (this.config.miniAppAPI) return this.config.miniAppAPI;

    // Prefer the adapter's internal (possibly wrapped) API object to ensure
    // the instrumentation patches the same object the adapter uses.
    if (this.platform.nativeAPI?.request) return this.platform.nativeAPI;

    // Fallback: auto-detect from well-known globals
    try {
      if (typeof wx !== 'undefined' && wx?.request) return wx as any;
      if (typeof my !== 'undefined' && my?.request) return my as any;
      if (typeof tt !== 'undefined' && tt?.request) return tt as any;
      if (typeof swan !== 'undefined' && swan?.request) return swan as any;
    } catch {
      // Global access may throw in strict environments
    }
    return null;
  }

  uninstall(): void {
    for (const unsub of this.unsubscribers) {
      try { unsub(); } catch { /* safe cleanup */ }
    }
    this.unsubscribers.length = 0;
    this.log('Uninstalled');
    this.logger = null;
  }

  private shouldCapture(url: string): boolean {
    const excludePatterns = [
      '/api/logs',
      '/api/session-recordings',
      '/logger',
      '/user/front/error/log/add',
      'sentry.io',
      'clarity.ms',
    ];

    if (excludePatterns.some((pattern) => url.includes(pattern))) {
      return false;
    }

    if (this.config.urlFilter) {
      try {
        if (!this.config.urlFilter(url)) return false;
      } catch {
        // urlFilter error should not block network capture
      }
    }

    return true;
  }

  private truncateData(data: unknown, maxSize: number): unknown {
    if (data === null || data === undefined) return data;

    let str: string;
    try {
      str = typeof data === 'string' ? data : JSON.stringify(data);
    } catch {
      return { _truncated: true, _originalSize: -1, _error: 'Circular reference or unserializable' };
    }

    if (str.length <= maxSize) return data;

    return {
      _truncated: true,
      _originalSize: str.length,
      _preview: str.substring(0, maxSize) + '...',
    };
  }

  private recordRequest(log: NetworkLog): void {
    if (!this.logger) return;

    const isSlowExcluded = this.config.slowRequestExcludePatterns.some(
      (pattern) => log.url.toLowerCase().includes(pattern.toLowerCase()),
    );
    const isSlow = !isSlowExcluded && log.duration > this.config.slowThreshold;
    const isError = !log.status || log.status >= 400 || !!log.error;
    const isSuccess = !isError && !isSlow;

    const shouldLog =
      (isError && this.config.logTypes.has('error')) ||
      (isSlow && !isError && this.config.logTypes.has('slow')) ||
      (isSuccess && this.config.logTypes.has('success'));

    if (!shouldLog) return;

    const tags: Record<string, string | number | boolean> = {
      errorCategory: 'http',
      type: log.type,
      method: log.method,
    };

    if (log.status) tags['httpStatus'] = log.status;
    if (isSlow) tags['slow'] = true;

    const context: Record<string, unknown> = {
      type: isError ? 'HTTP_ERROR' : 'HTTP_REQUEST',
      url: log.url,
      method: log.method,
      status: log.status,
      statusText: log.statusText,
      duration: log.duration,
      timestamp: log.timestamp,
    };

    if (log.responseCode !== undefined) context['responseCode'] = log.responseCode;
    if (log.responseMessage) context['responseMessage'] = log.responseMessage;
    if (this.config.captureRequestBody && log.requestBody !== undefined) {
      context['requestData'] = log.requestBody;
    }
    if (this.config.captureResponseBody && log.responseBody !== undefined) {
      context['responseData'] = this.truncateData(log.responseBody, this.config.maxResponseBodySize);
    }
    if (log.error) context['error'] = log.error;

    if (isError) {
      this.logger.error(
        `HTTP ${log.status || 'Error'}: ${log.method} ${log.url}`,
        { tags, context },
      );
    } else if (isSlow) {
      this.logger.warn(
        `Slow request: ${log.method} ${log.url} (${log.duration}ms)`,
        { tags, context },
      );
    } else {
      this.logger.info(`HTTP ${log.status}: ${log.method} ${log.url}`, {
        tags,
        context,
      });
    }
  }
}
