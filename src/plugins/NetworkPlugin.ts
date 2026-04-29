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
  /** 请求体（如果配置捕获） */
  requestBody?: unknown;
  /** 响应体（如果配置捕获） */
  responseBody?: unknown;
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
   * 响应体最大记录大小（字节），超过则截断
   * @default 10240 (10KB)
   */
  maxResponseBodySize?: number;

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
    'urlFilter' | 'logTypes' | 'slowRequestExcludePatterns' | 'routeMatch'
  >
> &
  Pick<NetworkPluginOptions, 'urlFilter'> & {
    logTypes: Set<NetworkLogType>;
    slowRequestExcludePatterns: string[];
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

  /**
   * 记录网络请求
   */
  private recordRequest(log: NetworkLog): void {
    if (!this.logger) return;

    if (!this.routeMatcher.shouldCapture()) {
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

    if (log.error) {
      context['error'] = log.error;
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
      const method = init?.method?.toUpperCase() || 'GET';

      // 检查是否需要记录
      if (!self.shouldCapture(url)) {
        return self.originalFetch!.call(window, input, init);
      }

      // 捕获请求体
      let requestBody: unknown;
      if (self.config.captureRequestBody && init?.body) {
        try {
          requestBody = self.safeParseJSON(init.body);
        } catch {
          requestBody = '[Unable to parse request body]';
        }
      }

      try {
        const response = await self.originalFetch!.call(window, input, init);

        // 捕获响应体（需要 clone，因为 body 只能读取一次）
        let responseBody: unknown;
        let responseCode: number | string | undefined;
        let responseMessage: string | undefined;

        if (self.config.captureResponseBody) {
          try {
            const clonedResponse = response.clone();
            const text = await clonedResponse.text();
            responseBody = self.safeParseJSON(text);

            // 提取业务码
            const businessInfo = self.extractBusinessInfo(responseBody);
            responseCode = businessInfo.code;
            responseMessage = businessInfo.message;
          } catch {
            responseBody = '[Unable to read response body]';
          }
        }

        self.recordRequest({
          type: 'fetch',
          url,
          method,
          status: response.status,
          statusText: response.statusText,
          duration: Date.now() - startTime,
          timestamp: startTime,
          requestBody,
          responseBody,
          responseCode,
          responseMessage,
        });

        return response;
      } catch (error) {
        // fetch 抛出异常时，通常是网络层错误（没有 HTTP 响应）
        const isOnline =
          typeof navigator !== 'undefined' ? navigator.onLine : true;
        let errorMessage =
          error instanceof Error ? error.message : String(error);

        // 补充离线状态信息
        if (!isOnline && !errorMessage.includes('offline')) {
          errorMessage = `${errorMessage} (device appears to be offline)`;
        }

        self.recordRequest({
          type: 'fetch',
          url,
          method,
          status: 0, // 网络层错误，没有 HTTP 状态码
          statusText: 'Network Error',
          duration: Date.now() - startTime,
          timestamp: startTime,
          requestBody,
          error: errorMessage,
        });

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
      const handleError = () => {
        // 防止重复记录
        if (isRecorded) return;
        isRecorded = true;

        const duration = Date.now() - info.startTime;

        // 尝试获取更多诊断信息
        // 当 error 事件触发时，status 通常是 0（表示网络层失败，没有收到 HTTP 响应）
        const networkStatus = this.status; // 0 表示网络层错误，非 HTTP 错误
        const isOnline =
          typeof navigator !== 'undefined' ? navigator.onLine : true;
        const readyState = this.readyState;

        // 构建更详细的错误信息
        // readyState: 0=UNSENT, 1=OPENED, 2=HEADERS_RECEIVED, 3=LOADING, 4=DONE
        let errorMessage = 'Network Error';
        const diagnosticInfo: string[] = [];

        if (!isOnline) {
          errorMessage = 'Network Error: Device appears to be offline';
        } else {
          diagnosticInfo.push(`readyState=${readyState}`);
          if (networkStatus === 0) {
            diagnosticInfo.push('status=0 (no HTTP response)');
            errorMessage = `Network Error: No response received (readyState=${readyState}, possible causes: CORS, DNS failure, connection refused, SSL error, server closed connection)`;
          } else {
            // 极少数情况下 error 事件时 status 不为 0
            diagnosticInfo.push(`status=${networkStatus}`);
            errorMessage = `Network Error: Unexpected error (status=${networkStatus}, readyState=${readyState})`;
          }
        }

        self.recordRequest({
          type: 'xhr',
          url: info.url,
          method: info.method,
          status: networkStatus, // 记录 status（通常是 0）
          statusText: this.statusText || 'Network Error',
          duration,
          timestamp: info.startTime,
          requestBody: info.requestBody,
          error: errorMessage,
        });

        // 注意：error 事件后 loadend 也会触发，cleanup 会在 loadend 中进行
      };

      // 监听请求超时
      const handleTimeout = () => {
        // 防止重复记录
        if (isRecorded) return;
        isRecorded = true;

        const duration = Date.now() - info.startTime;

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
        });

        // 注意：timeout 事件后 loadend 也会触发，cleanup 会在 loadend 中进行
      };

      this.addEventListener('readystatechange', handleReadyStateChange);
      this.addEventListener('loadend', handleLoadEnd);
      this.addEventListener('error', handleError);
      this.addEventListener('timeout', handleTimeout);

      return self.originalXHRSend!.call(this, body);
    };
  }
}
