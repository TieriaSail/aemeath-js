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
import { PluginPriority } from '../types';
import type { PlatformAdapter } from '../platform/types';
import type {
  NetworkEvent,
  NetworkErrorType,
  NetworkErrorDetail,
  ResponseBodyCaptureContext,
  InstrumentOptions,
  Unsubscribe,
} from '../instrumentation/types';
import { instrumentFetch } from '../instrumentation/fetch';
import { instrumentXHR } from '../instrumentation/xhr';
import { instrumentMiniAppRequest } from '../instrumentation/miniapp-request';
import { RouteMatcher, type RouteMatchConfig } from '../utils/routeMatcher';

export type { NetworkErrorType, NetworkErrorDetail } from '../instrumentation/types';

export interface NetworkLog {
  type: 'fetch' | 'xhr' | 'request';
  url: string;
  method: string;
  status?: number;
  statusText?: string;
  duration: number;
  timestamp: number;
  error?: string;
  errorType?: NetworkErrorType;
  errorDetail?: NetworkErrorDetail;
  requestBody?: unknown;
  responseBody?: unknown;
  responseBodyTruncated?: boolean;
  responseCode?: number | string;
  responseMessage?: string;
}

export type NetworkLogType = 'success' | 'error' | 'slow';

const DEFAULT_MAX_RESPONSE_BODY_SIZE = 10240;
const DEFAULT_RESPONSE_BODY_CAPTURE_TIMEOUT = 2000;

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback;
}

export interface NetworkPluginOptions {
  interceptFetch?: boolean;
  interceptXHR?: boolean;
  urlFilter?: (url: string) => boolean;
  logTypes?: NetworkLogType[];
  captureRequestBody?: boolean;
  captureResponseBody?: boolean;
  /** Browser Fetch only. Defaults to explicit text/JSON/XML response types. */
  shouldCaptureResponseBody?: (context: ResponseBodyCaptureContext) => boolean;
  /** Maximum number of Fetch response-body bytes to retain. @default 10240 */
  maxResponseBodySize?: number;
  /** Maximum time to wait for Fetch body capture before cancellation. @default 2000 */
  responseBodyCaptureTimeout?: number;
  slowThreshold?: number;
  slowRequestExcludePatterns?: string[];
  /**
   * 不捕获这些 errorType 的网络错误。
   * 匹配到的请求会在捕获层直接跳过（不记录、不上报、不产生 console 输出）。
   *
   * @example
   * ignoreErrorTypes: ['network.aborted', 'network.offline']
   *
   * @default []
   */
  ignoreErrorTypes?: NetworkErrorType[];
  /**
   * 是否捕获主动取消（AbortController.abort()）的请求。
   * 等价于 ignoreErrorTypes 中包含/不包含 'network.aborted' 的语法糖。
   * 如果同时设置了 ignoreErrorTypes，两者取并集。
   *
   * @default false
   */
  captureAborted?: boolean;
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
    'urlFilter' | 'logTypes' | 'slowRequestExcludePatterns' | 'miniAppAPI' | 'routeMatch' | 'ignoreErrorTypes' | 'captureAborted' | 'shouldCaptureResponseBody'
  >
> &
  Pick<NetworkPluginOptions, 'urlFilter' | 'miniAppAPI' | 'shouldCaptureResponseBody'> & {
    logTypes: Set<NetworkLogType>;
    slowRequestExcludePatterns: string[];
    ignoreErrorTypes: Set<NetworkErrorType>;
  };

export class NetworkPlugin implements AemeathPlugin {
  readonly name = 'network';
  readonly version = '2.0.0';
  readonly priority: number = PluginPriority.NORMAL;
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

    const ignoreSet = new Set<NetworkErrorType>(options.ignoreErrorTypes ?? []);
    if (!(options.captureAborted ?? false)) {
      ignoreSet.add('network.aborted');
    }

    this.config = {
      interceptFetch: options.interceptFetch ?? true,
      interceptXHR: options.interceptXHR ?? true,
      urlFilter: options.urlFilter,
      logTypes: new Set(options.logTypes ?? defaultLogTypes),
      captureRequestBody: options.captureRequestBody ?? true,
      captureResponseBody: options.captureResponseBody ?? true,
      shouldCaptureResponseBody: options.shouldCaptureResponseBody,
      maxResponseBodySize: normalizeNonNegativeInteger(
        options.maxResponseBodySize,
        DEFAULT_MAX_RESPONSE_BODY_SIZE,
      ),
      responseBodyCaptureTimeout: normalizePositiveInteger(
        options.responseBodyCaptureTimeout,
        DEFAULT_RESPONSE_BODY_CAPTURE_TIMEOUT,
      ),
      slowThreshold: options.slowThreshold ?? 3000,
      slowRequestExcludePatterns:
        options.slowRequestExcludePatterns ?? defaultSlowExcludePatterns,
      debug: options.debug ?? false,
      miniAppAPI: options.miniAppAPI,
      ignoreErrorTypes: ignoreSet,
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
      // Route ownership is fixed when the request starts. Fetch instrumentation
      // keeps that subscriber snapshot until the response event is emitted.
      shouldCapture: (url: string) =>
        this.routeMatcher.shouldCapture(this.platform.getCurrentPath()) &&
        this.shouldCapture(url),
      captureRequestBody: this.config.captureRequestBody,
      captureResponseBody: this.config.captureResponseBody,
      shouldCaptureResponseBody: this.config.shouldCaptureResponseBody,
      maxResponseBodySize: this.config.maxResponseBodySize,
      responseBodyCaptureTimeout: this.config.responseBodyCaptureTimeout,
    };
  }

  private handleNetworkEvent = (event: NetworkEvent): void => {
    this.recordRequest({
      type: event.type,
      url: event.url,
      method: event.method,
      status: event.status,
      statusText: event.statusText,
      duration: event.duration,
      timestamp: event.timestamp,
      error: event.error,
      errorType: event.errorType,
      errorDetail: event.errorDetail,
      requestBody: event.requestBody,
      responseBody: event.responseBody,
      responseBodyTruncated: event.responseBodyTruncated,
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

    if (log.errorType && this.config.ignoreErrorTypes.has(log.errorType)) {
      this.log(`Ignored ${log.errorType}: ${log.method} ${log.url}`);
      return;
    }

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
    if (log.errorType) tags['networkErrorType'] = log.errorType;
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
    if (log.responseBodyTruncated) {
      context['responseDataTruncated'] = true;
    }
    if (log.error) context['error'] = log.error;
    if (log.errorType) context['errorType'] = log.errorType;
    if (log.errorDetail) context['errorDetail'] = log.errorDetail;

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
