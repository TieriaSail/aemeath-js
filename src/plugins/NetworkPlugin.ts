/**
 * 网络请求监控插件 - 自动捕获 fetch 和 axios 请求
 *
 * 功能：
 * - 自动拦截所有 fetch 请求
 * - 自动拦截所有 XMLHttpRequest 请求（axios 底层使用）
 * - 记录请求 URL、方法、状态码、耗时
 * - 记录请求/响应数据（可配置）
 * - 记录请求失败的错误信息
 *
 * 替代 api.ts 中的手动 reportHttpError，实现自动化监控
 */

import type { AemeathPlugin, AemeathInterface } from '../types';
import { PluginPriority } from '../types';
import { RouteMatcher, type RouteMatchConfig } from '../utils/routeMatcher';

/**
 * Low-cardinality error classification following OpenTelemetry `error.type`
 * semantic conventions.
 */
export type NetworkErrorType =
  | 'network.offline'
  | 'network.timeout'
  | 'network.aborted'
  | 'network.connection_refused'
  | 'network.unknown';

/**
 * Structured diagnostic detail for failed network events.
 */
export interface NetworkErrorDetail {
  /** navigator.onLine value at the time of failure */
  navigatorOnLine?: boolean;
  /** XHR readyState at the time of failure (0-4) */
  readyState?: number;
  /** HTTP status code (typically 0 for network errors) */
  statusCode?: number;
  /** Browser-original error message or exception toString */
  raw?: string;
}

/** Response metadata available before a Fetch body is read. */
export interface ResponseBodyCaptureContext {
  url: string;
  method: string;
  status: number;
  headers: Headers;
}

interface ResponseBodyReadResult {
  bytes: Uint8Array;
  truncated: boolean;
}

interface ResponseBodyReadTask {
  promise: Promise<ResponseBodyReadResult>;
  cancel: () => void;
}

const DEFAULT_MAX_RESPONSE_BODY_SIZE = 10240;
const DEFAULT_RESPONSE_BODY_CAPTURE_TIMEOUT = 2000;

function normalizeNonNegativeInteger(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback;
}

function defaultShouldCaptureResponseBody(
  context: ResponseBodyCaptureContext,
): boolean {
  const disposition = context.headers.get('content-disposition') ?? '';
  if (/\battachment\b/i.test(disposition)) return false;

  const rawContentType = context.headers.get('content-type');
  if (!rawContentType) return false;

  const contentType = rawContentType.split(';', 1)[0]!.trim().toLowerCase();
  if (contentType === 'text/event-stream') return false;
  if (contentType.startsWith('text/')) return true;
  if (
    contentType === 'application/json' ||
    (contentType.startsWith('application/') && contentType.endsWith('+json'))
  ) {
    return true;
  }
  if (
    contentType === 'application/xml' ||
    (contentType.startsWith('application/') && contentType.endsWith('+xml'))
  ) {
    return true;
  }

  return (
    contentType === 'application/x-www-form-urlencoded' ||
    contentType === 'application/javascript' ||
    contentType === 'application/ecmascript' ||
    contentType === 'application/x-javascript'
  );
}

function parseContentLength(headers: Headers): number | undefined {
  const value = headers.get('content-length');
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => {
      // Cancellation is best-effort and must never affect the business branch.
    });
  } catch {
    // Non-standard stream implementations may throw synchronously.
  }
}

function joinChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function readResponseBodyAtMost(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
): ResponseBodyReadTask {
  if (!response.body) {
    return {
      promise: Promise.resolve({ bytes: new Uint8Array(), truncated: false }),
      cancel: () => {},
    };
  }

  const reader = response.body.getReader();
  const declaredLength = parseContentLength(response.headers);
  const byteLimit = normalizeNonNegativeInteger(maxBytes, 0);
  const captureTimeout = normalizePositiveInteger(
    timeoutMs,
    DEFAULT_RESPONSE_BODY_CAPTURE_TIMEOUT,
  );
  let settled = false;
  let cancellationReason: 'timeout' | 'cancelled' | undefined;
  let resolveCancellation!: (reason: 'timeout' | 'cancelled') => void;
  const cancellation = new Promise<'timeout' | 'cancelled'>((resolve) => {
    resolveCancellation = resolve;
  });

  const cancel = (reason: 'timeout' | 'cancelled' = 'cancelled'): void => {
    if (settled || cancellationReason) return;
    cancellationReason = reason;
    resolveCancellation(reason);
    cancelReader(reader);
  };

  const timeoutId = setTimeout(() => cancel('timeout'), captureTimeout);
  const promise = (async (): Promise<ResponseBodyReadResult> => {
    const chunks: Uint8Array[] = [];
    let bytesRead = 0;

    if (byteLimit <= 0) {
      cancelReader(reader);
      return {
        bytes: new Uint8Array(),
        truncated: declaredLength !== 0,
      };
    }

    while (true) {
      const readOutcome = reader.read().then(
        (result) => ({ kind: 'read' as const, result }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      );
      const outcome = await Promise.race([
        readOutcome,
        cancellation.then((reason) => ({ kind: 'cancel' as const, reason })),
      ]);

      if (outcome.kind === 'cancel') {
        return { bytes: joinChunks(chunks, bytesRead), truncated: true };
      }
      if (outcome.kind === 'error') throw outcome.error;

      const { done, value } = outcome.result;
      if (done) {
        return { bytes: joinChunks(chunks, bytesRead), truncated: false };
      }
      if (!value || value.byteLength === 0) continue;

      const remaining = byteLimit - bytesRead;
      const chunk =
        value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk.slice());
      bytesRead += chunk.byteLength;

      if (value.byteLength > remaining || bytesRead >= byteLimit) {
        cancelReader(reader);
        return {
          bytes: joinChunks(chunks, bytesRead),
          truncated:
            value.byteLength > remaining ||
            declaredLength === undefined ||
            declaredLength > bytesRead,
        };
      }
    }
  })().finally(() => {
    settled = true;
    clearTimeout(timeoutId);
  });

  return { promise, cancel: () => cancel('cancelled') };
}

/**
 * 网络请求日志
 */
export interface NetworkLog {
  /** 请求类型 */
  type: 'fetch' | 'xhr';
  /** 请求 URL */
  url: string;
  /** 请求方法 */
  method: string;
  /** 响应状态码 */
  status?: number;
  /** 状态文本 */
  statusText?: string;
  /** 请求耗时（毫秒） */
  duration: number;
  /** 请求开始时间 */
  timestamp: number;
  /** 错误信息（如果失败） */
  error?: string;
  /** 低基数错误分类，用于聚合 */
  errorType?: NetworkErrorType;
  /** 结构化诊断证据 */
  errorDetail?: NetworkErrorDetail;
  /** 请求体（如果配置捕获） */
  requestBody?: unknown;
  /** 响应体（如果配置捕获） */
  responseBody?: unknown;
  /** Fetch 响应体是否因达到字节上限或捕获超时而截断 */
  responseBodyTruncated?: boolean;
  /** 业务响应码（如 response.data.code） */
  responseCode?: number | string;
  /** 业务响应消息（如 response.data.message） */
  responseMessage?: string;
}

/**
 * 记录类型
 */
export type NetworkLogType = 'success' | 'error' | 'slow';

export interface NetworkPluginOptions {
  /**
   * 是否拦截 fetch 请求
   * @default true
   */
  interceptFetch?: boolean;

  /**
   * 是否拦截 XMLHttpRequest 请求（axios 使用）
   * @default true
   */
  interceptXHR?: boolean;

  /**
   * URL 过滤器 - 返回 false 则不记录该请求
   * 用于排除日志上报接口本身，避免死循环
   */
  urlFilter?: (url: string) => boolean;

  /**
   * 要记录的请求类型
   * - 'success': 成功的请求（状态码 < 400）
   * - 'error': 失败的请求（状态码 >= 400 或网络错误）
   * - 'slow': 慢请求（超过 slowThreshold）
   *
   * @example
   * logTypes: ['error', 'slow']  // 只记录错误和慢请求
   * logTypes: ['error']          // 只记录错误
   * logTypes: ['success', 'error', 'slow']  // 记录全部（默认）
   *
   * @default ['success', 'error', 'slow']
   */
  logTypes?: NetworkLogType[];

  /**
   * 是否记录请求体
   * @default true
   */
  captureRequestBody?: boolean;

  /**
   * 是否记录响应体
   * @default true
   */
  captureResponseBody?: boolean;

  /**
   * 按响应元数据决定是否捕获 Fetch 响应体。
   * 默认只捕获明确的文本/JSON/XML 类型；二进制、附件、SSE 和无 Content-Type 响应会跳过 body。
   */
  shouldCaptureResponseBody?: (context: ResponseBodyCaptureContext) => boolean;

  /**
   * Fetch 响应体最大保留和解码大小（字节），超过则截断
   * @default 10240 (10KB)
   */
  maxResponseBodySize?: number;

  /**
   * Fetch 响应体后台捕获最长等待时间（毫秒），超时后取消捕获并记录已读取部分
   * @default 2000
   */
  responseBodyCaptureTimeout?: number;

  /**
   * 慢请求阈值（毫秒），超过此值会标记为慢请求
   * @default 3000
   */
  slowThreshold?: number;

  /**
   * 慢请求排除模式 - 匹配的 URL 不会触发慢请求告警
   * 用于排除音频、视频、大图片等本来就慢的资源
   *
   * @default 包含常见音视频、字体等后缀
   *
   * @example
   * slowRequestExcludePatterns: ['.mp3', '.mp4', '.wav', '.ogg']
   */
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

  /**
   * 是否启用调试模式
   * @default false
   */
  debug?: boolean;

  /**
   * 插件级路由匹配配置
   * 在全局 routeMatch 基础上进一步限定网络监控的路由范围
   */
  routeMatch?: RouteMatchConfig;
}

type NetworkPluginConfig = Required<
  Omit<
    NetworkPluginOptions,
    'urlFilter' | 'logTypes' | 'slowRequestExcludePatterns' | 'routeMatch' | 'ignoreErrorTypes' | 'captureAborted' | 'shouldCaptureResponseBody'
  >
> &
  Pick<NetworkPluginOptions, 'urlFilter' | 'shouldCaptureResponseBody'> & {
    logTypes: Set<NetworkLogType>;
    slowRequestExcludePatterns: string[];
    ignoreErrorTypes: Set<NetworkErrorType>;
  };

export class NetworkPlugin implements AemeathPlugin {
  readonly name = 'network';
  readonly version = '1.2.0';
  readonly priority: number = PluginPriority.NORMAL;
  readonly description = '网络请求监控';

  private readonly config: NetworkPluginConfig;
  private readonly pluginRouteMatch: RouteMatchConfig | undefined;
  private routeMatcher!: RouteMatcher;
  private logger: AemeathInterface | null = null;

  // 保存原始方法，用于卸载时恢复
  private originalFetch: typeof fetch | null = null;
  private originalXHROpen: typeof XMLHttpRequest.prototype.open | null = null;
  private originalXHRSend: typeof XMLHttpRequest.prototype.send | null = null;
  private readonly pendingFetchCaptures = new Set<ResponseBodyReadTask>();

  constructor(options: NetworkPluginOptions = {}) {
    // 默认记录全部类型
    const defaultLogTypes: NetworkLogType[] = ['success', 'error', 'slow'];

    // 默认排除的慢请求资源类型
    const defaultSlowExcludePatterns = [
      // 音频
      '.mp3',
      '.wav',
      '.ogg',
      '.flac',
      '.aac',
      '.m4a',
      // 视频
      '.mp4',
      '.webm',
      '.avi',
      '.mov',
      '.mkv',
      // 大图片
      '.png',
      '.jpg',
      '.jpeg',
      '.gif',
      '.webp',
      // 字体
      '.woff',
      '.woff2',
      '.ttf',
      '.otf',
      '.eot',
      // 其他大文件
      '.pdf',
      '.zip',
      '.rar',
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
      ignoreErrorTypes: ignoreSet,
    };
    this.pluginRouteMatch = options.routeMatch;
  }

  /** 调试日志 */
  private log(...args: unknown[]): void {
    if (this.config.debug) {
      console.log('[NetworkPlugin]', ...args);
    }
  }

  install(logger: AemeathInterface): void {
    this.logger = logger;

    this.routeMatcher = RouteMatcher.compose(
      logger.routeMatcher,
      this.pluginRouteMatch,
      { debug: this.config.debug, debugPrefix: '[NetworkPlugin]' },
    );

    if (this.config.interceptFetch) {
      this.interceptFetch();
    }

    if (this.config.interceptXHR) {
      this.interceptXHR();
    }

    this.log('Installed');
  }

  uninstall(): void {
    for (const task of this.pendingFetchCaptures) task.cancel();
    this.pendingFetchCaptures.clear();

    // 恢复原始 fetch
    if (this.originalFetch) {
      window.fetch = this.originalFetch;
      this.originalFetch = null;
    }

    // 恢复原始 XMLHttpRequest
    if (this.originalXHROpen) {
      XMLHttpRequest.prototype.open = this.originalXHROpen;
      this.originalXHROpen = null;
    }
    if (this.originalXHRSend) {
      XMLHttpRequest.prototype.send = this.originalXHRSend;
      this.originalXHRSend = null;
    }

    this.logger = null;
    this.log('Uninstalled');
  }

  /**
   * 检查 URL 是否应该被记录
   */
  private shouldCapture(url: string): boolean {
    // 排除日志上报接口，避免死循环
    const excludePatterns = [
      '/api/logs',
      '/api/session-recordings',
      '/logger',
      '/user/front/error/log/add', // 与 api.ts 中的 LOGGER_UPLOAD_PATH 保持一致
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

  /**
   * 安全解析 JSON
   */
  private safeParseJSON(data: unknown): unknown {
    if (typeof data === 'string') {
      try {
        return JSON.parse(data);
      } catch {
        return data;
      }
    }
    return data;
  }

  /**
   * 截断过大的数据
   */
  private truncateData(data: unknown, maxSize: number): unknown {
    if (data === null || data === undefined) return data;

    const str = typeof data === 'string' ? data : JSON.stringify(data);
    if (str.length <= maxSize) {
      return data;
    }

    return {
      _truncated: true,
      _originalSize: str.length,
      _preview: str.substring(0, maxSize) + '...',
    };
  }

  /**
   * 从响应数据中提取业务码和消息
   */
  private extractBusinessInfo(data: unknown): {
    code?: number | string;
    message?: string;
  } {
    if (!data || typeof data !== 'object') return {};

    const obj = data as Record<string, unknown>;
    return {
      code: obj['code'] as number | string | undefined,
      message: (obj['message'] || obj['msg'] || obj['error']) as
        | string
        | undefined,
    };
  }

  private shouldCaptureFetchResponseBody(
    context: ResponseBodyCaptureContext,
  ): boolean {
    if (!this.config.captureResponseBody) return false;
    const filter =
      this.config.shouldCaptureResponseBody ?? defaultShouldCaptureResponseBody;
    try {
      return filter(context);
    } catch {
      return false;
    }
  }

  /**
   * 记录网络请求
   */
  private recordRequest(log: NetworkLog, routeMatched?: boolean): void {
    if (!this.logger) return;

    if (!(routeMatched ?? this.routeMatcher.shouldCapture())) {
      return;
    }

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

    // 根据配置的 logTypes 决定是否记录
    const shouldLog =
      (isError && this.config.logTypes.has('error')) ||
      (isSlow && !isError && this.config.logTypes.has('slow')) ||
      (isSuccess && this.config.logTypes.has('success'));

    if (!shouldLog) {
      return;
    }

    // 构建标签
    const tags: Record<string, string | number | boolean> = {
      errorCategory: 'http',
      type: log.type,
      method: log.method,
    };

    if (log.status) {
      tags['httpStatus'] = log.status;
    }

    if (log.errorType) {
      tags['networkErrorType'] = log.errorType;
    }

    if (isSlow) {
      tags['slow'] = true;
    }

    // 构建上下文（与 reportHttpError 格式保持一致）
    const context: Record<string, unknown> = {
      type: isError ? 'HTTP_ERROR' : 'HTTP_REQUEST',
      url: log.url,
      method: log.method,
      status: log.status,
      statusText: log.statusText,
      duration: log.duration,
      timestamp: log.timestamp,
    };

    // 业务响应码
    if (log.responseCode !== undefined) {
      context['responseCode'] = log.responseCode;
    }
    if (log.responseMessage) {
      context['responseMessage'] = log.responseMessage;
    }

    // 请求体（如果配置捕获）
    if (this.config.captureRequestBody && log.requestBody !== undefined) {
      context['requestData'] = log.requestBody;
    }

    // 响应体（如果配置捕获）
    if (this.config.captureResponseBody && log.responseBody !== undefined) {
      context['responseData'] = this.truncateData(
        log.responseBody,
        this.config.maxResponseBodySize,
      );
    }
    if (log.responseBodyTruncated) {
      context['responseDataTruncated'] = true;
    }

    if (log.error) {
      context['error'] = log.error;
    }
    if (log.errorType) {
      context['errorType'] = log.errorType;
    }
    if (log.errorDetail) {
      context['errorDetail'] = log.errorDetail;
    }

    // 根据状态选择日志级别
    if (isError) {
      this.logger.error(
        `HTTP ${log.status || 'Error'}: ${log.method} ${log.url}`,
        {
          tags,
          context,
        },
      );
    } else if (isSlow) {
      this.logger.warn(
        `Slow request: ${log.method} ${log.url} (${log.duration}ms)`,
        {
          tags,
          context,
        },
      );
    } else {
      this.logger.info(`HTTP ${log.status}: ${log.method} ${log.url}`, {
        tags,
        context,
      });
    }
  }

  /**
   * 拦截 fetch 请求
   */
  private interceptFetch(): void {
    if (typeof window === 'undefined' || !window.fetch) {
      return;
    }

    this.originalFetch = window.fetch;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    window.fetch = async function (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const startTime = Date.now();
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const isRequest =
        typeof Request !== 'undefined' && input instanceof Request;
      const method = (
        init?.method ?? (isRequest ? input.method : 'GET')
      ).toUpperCase();
      const routeMatched = self.routeMatcher.shouldCapture();

      // 检查是否需要记录
      if (!routeMatched || !self.shouldCapture(url)) {
        return self.originalFetch!.call(window, input, init);
      }

      // 捕获请求体
      let requestBody: unknown;
      const body = init?.body ?? (isRequest ? input.body : null);
      if (self.config.captureRequestBody && body) {
        try {
          requestBody =
            isRequest && init?.body == null
              ? '[ReadableStream]'
              : self.safeParseJSON(body);
        } catch {
          requestBody = '[Unable to parse request body]';
        }
      }

      try {
        const response = await self.originalFetch!.call(window, input, init);
        const duration = Date.now() - startTime;
        const baseLog: NetworkLog = {
          type: 'fetch',
          url,
          method,
          status: response.status,
          statusText: response.statusText,
          duration,
          timestamp: startTime,
          requestBody,
        };

        const captureContext: ResponseBodyCaptureContext = {
          url,
          method,
          status: response.status,
          headers: response.headers,
        };

        if (self.shouldCaptureFetchResponseBody(captureContext)) {
          try {
            const clonedResponse = response.clone();
            const task = readResponseBodyAtMost(
              clonedResponse,
              self.config.maxResponseBodySize,
              self.config.responseBodyCaptureTimeout,
            );
            self.pendingFetchCaptures.add(task);
            void task.promise
              .then(({ bytes, truncated }) => {
                const text = new TextDecoder().decode(bytes);
                const responseBody = self.safeParseJSON(text);
                const businessInfo = self.extractBusinessInfo(responseBody);
                self.recordRequest(
                  {
                    ...baseLog,
                    responseBody,
                    responseBodyTruncated: truncated || undefined,
                    responseCode: businessInfo.code,
                    responseMessage: businessInfo.message,
                  },
                  routeMatched,
                );
              })
              .catch(() => {
                self.recordRequest(
                  {
                    ...baseLog,
                    responseBody: '[Unable to read response body]',
                  },
                  routeMatched,
                );
              })
              .finally(() => {
                self.pendingFetchCaptures.delete(task);
              });
          } catch {
            self.recordRequest(
              {
                ...baseLog,
                responseBody: '[Unable to read response body]',
              },
              routeMatched,
            );
          }
        } else {
          self.recordRequest(baseLog, routeMatched);
        }

        // 响应体捕获与业务解耦：响应头可用后立即返回原始 Response。
        return response;
      } catch (error) {
        const navigatorOnLine =
          typeof navigator !== 'undefined' ? navigator.onLine : true;
        // Read `name` / `message` as plain properties instead of relying on
        // `instanceof Error`: cross-realm errors (iframe / worker / jsdom)
        // fail instanceof checks while still carrying the standard fields.
        const errObj = error as { name?: unknown; message?: unknown } | null;
        const rawMessage =
          errObj != null && typeof errObj.message === 'string'
            ? errObj.message
            : String(error);
        // Per WHATWG fetch spec, abort/timeout reject with a DOMException
        // whose `name` is standardized ('AbortError' / 'TimeoutError').
        // `name` is locale-independent and reliable across browsers,
        // unlike `message` which varies.
        const errName =
          errObj != null && typeof errObj.name === 'string' ? errObj.name : '';

        let errorType: NetworkErrorType;
        let errorMessage: string;
        if (errName === 'AbortError') {
          errorType = 'network.aborted';
          errorMessage = 'Network Error: Request aborted';
        } else if (errName === 'TimeoutError') {
          errorType = 'network.timeout';
          errorMessage = 'Network Error: Request timed out (AbortSignal.timeout)';
        } else if (!navigatorOnLine) {
          errorType = 'network.offline';
          errorMessage = 'Network Error: Device appears to be offline';
        } else {
          // fetch TypeError does not expose the underlying cause
          // (CORS / DNS / connection refused / SSL are indistinguishable)
          errorType = 'network.unknown';
          errorMessage = `Network Error: ${rawMessage}`;
        }

        const errorDetail: NetworkErrorDetail = {
          navigatorOnLine,
          statusCode: 0,
          raw: rawMessage,
        };

        self.recordRequest(
          {
            type: 'fetch',
            url,
            method,
            status: 0,
            statusText: 'Network Error',
            duration: Date.now() - startTime,
            timestamp: startTime,
            requestBody,
            error: errorMessage,
            errorType,
            errorDetail,
          },
          routeMatched,
        );

        throw error;
      }
    };
  }

  /**
   * 拦截 XMLHttpRequest 请求（axios 底层使用）
   */
  private interceptXHR(): void {
    if (typeof window === 'undefined' || !window.XMLHttpRequest) {
      return;
    }

    this.originalXHROpen = XMLHttpRequest.prototype.open;
    this.originalXHRSend = XMLHttpRequest.prototype.send;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    // 拦截 open 方法，记录 URL 和方法
    XMLHttpRequest.prototype.open = function (
      method: string,
      url: string | URL,
      async: boolean = true,
      username?: string | null,
      password?: string | null,
    ): void {
      // 存储请求信息到 XHR 实例上
      (this as any)._networkInfo = {
        method: method.toUpperCase(),
        url: typeof url === 'string' ? url : url.href,
        startTime: 0,
        requestBody: undefined,
      };

      return self.originalXHROpen!.call(
        this,
        method,
        url,
        async,
        username,
        password,
      );
    };

    // 拦截 send 方法，记录请求开始和结束
    XMLHttpRequest.prototype.send = function (
      body?: Document | XMLHttpRequestBodyInit | null,
    ): void {
      const info = (this as any)._networkInfo;

      if (!info || !self.shouldCapture(info.url)) {
        return self.originalXHRSend!.call(this, body);
      }

      info.startTime = Date.now();

      // 捕获请求体
      if (self.config.captureRequestBody && body) {
        try {
          info.requestBody = self.safeParseJSON(body);
        } catch {
          info.requestBody = '[Unable to parse request body]';
        }
      }

      // 标记请求是否已被记录（防止 error/timeout 和 loadend 重复记录）
      let isRecorded = false;

      // 清理所有事件监听器的函数
      const cleanup = () => {
        this.removeEventListener('readystatechange', handleReadyStateChange);
        this.removeEventListener('loadend', handleLoadEnd);
        this.removeEventListener('error', handleError);
        this.removeEventListener('abort', handleAbort);
        this.removeEventListener('timeout', handleTimeout);
      };

      const captureXHRSuccess = () => {
        const duration = Date.now() - info.startTime;

        let responseBody: unknown;
        let responseCode: number | string | undefined;
        let responseMessage: string | undefined;

        if (self.config.captureResponseBody) {
          try {
            responseBody = self.safeParseJSON(this.responseText);
            const businessInfo = self.extractBusinessInfo(responseBody);
            responseCode = businessInfo.code;
            responseMessage = businessInfo.message;
          } catch {
            responseBody = '[Unable to read response body]';
          }
        }

        self.recordRequest({
          type: 'xhr',
          url: info.url,
          method: info.method,
          status: this.status,
          statusText: this.statusText,
          duration,
          timestamp: info.startTime,
          requestBody: info.requestBody,
          responseBody,
          responseCode,
          responseMessage,
        });
      };

      // Capture early on readyState=4 with a valid HTTP status.
      // This defends against iOS WKWebView firing a spurious `error` event
      // after the response has already been delivered via onreadystatechange.
      const handleReadyStateChange = () => {
        if (this.readyState !== 4) return;
        if (isRecorded) return;
        if (this.status === 0) return;

        isRecorded = true;
        captureXHRSuccess();
        cleanup();
      };

      // 监听请求完成（无论成功还是失败，都会触发 loadend）
      const handleLoadEnd = () => {
        if (isRecorded) {
          cleanup();
          return;
        }
        isRecorded = true;
        captureXHRSuccess();
        cleanup();
      };

      // 监听请求错误（网络层错误，不是 HTTP 4xx/5xx 错误）
      // 依据 WHATWG XHR 规范：error / abort / timeout / load 四个事件互斥，
      // 主动取消只会触发 abort 事件，因此 error 事件必然是真实网络故障。
      const handleError = () => {
        if (isRecorded) return;
        isRecorded = true;

        const duration = Date.now() - info.startTime;
        const navigatorOnLine =
          typeof navigator !== 'undefined' ? navigator.onLine : true;

        let errorType: NetworkErrorType;
        let errorMessage: string;
        if (!navigatorOnLine) {
          errorType = 'network.offline';
          errorMessage = 'Network Error: Device appears to be offline';
        } else {
          // XHR error 事件不暴露底层原因（CORS / DNS / 连接拒绝 / SSL 均不可区分）
          errorType = 'network.unknown';
          errorMessage = `Network Error: No response received (possible causes: CORS, DNS failure, connection refused, SSL error)`;
        }

        const errorDetail: NetworkErrorDetail = {
          navigatorOnLine,
          readyState: this.readyState,
          statusCode: this.status,
        };

        self.recordRequest({
          type: 'xhr',
          url: info.url,
          method: info.method,
          status: this.status,
          statusText: this.statusText || 'Network Error',
          duration,
          timestamp: info.startTime,
          requestBody: info.requestBody,
          error: errorMessage,
          errorType,
          errorDetail,
        });
      };

      // 监听主动取消（xhr.abort()）。
      // 规范保证 abort 事件仅由主动取消触发，与 error 事件互斥，100% 可靠。
      const handleAbort = () => {
        if (isRecorded) return;
        isRecorded = true;

        const duration = Date.now() - info.startTime;
        const navigatorOnLine =
          typeof navigator !== 'undefined' ? navigator.onLine : true;

        self.recordRequest({
          type: 'xhr',
          url: info.url,
          method: info.method,
          status: 0,
          statusText: 'Request Aborted',
          duration,
          timestamp: info.startTime,
          requestBody: info.requestBody,
          error: 'Network Error: Request aborted',
          errorType: 'network.aborted',
          errorDetail: {
            navigatorOnLine,
            readyState: this.readyState,
            statusCode: 0,
          },
        });
      };

      // 监听请求超时
      const handleTimeout = () => {
        if (isRecorded) return;
        isRecorded = true;

        const duration = Date.now() - info.startTime;
        const navigatorOnLine =
          typeof navigator !== 'undefined' ? navigator.onLine : true;

        self.recordRequest({
          type: 'xhr',
          url: info.url,
          method: info.method,
          status: 0,
          statusText: 'Request Timeout',
          duration,
          timestamp: info.startTime,
          requestBody: info.requestBody,
          error: `Request Timeout: No response within ${duration}ms`,
          errorType: 'network.timeout',
          errorDetail: {
            navigatorOnLine,
            readyState: this.readyState,
            statusCode: 0,
          },
        });
      };

      this.addEventListener('readystatechange', handleReadyStateChange);
      this.addEventListener('loadend', handleLoadEnd);
      this.addEventListener('error', handleError);
      this.addEventListener('abort', handleAbort);
      this.addEventListener('timeout', handleTimeout);

      return self.originalXHRSend!.call(this, body);
    };
  }
}
