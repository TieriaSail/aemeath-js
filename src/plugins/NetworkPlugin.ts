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
import type { PlatformAdapter, NetworkRequestLog } from '../platform/types';
import { detectPlatform } from '../platform/detect';

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
}

type NetworkPluginConfig = Required<
  Omit<
    NetworkPluginOptions,
    'urlFilter' | 'logTypes' | 'slowRequestExcludePatterns'
  >
> &
  Pick<NetworkPluginOptions, 'urlFilter'> & {
    logTypes: Set<NetworkLogType>;
    slowRequestExcludePatterns: string[];
  };

export class NetworkPlugin implements AemeathPlugin {
  readonly name = 'network';
  readonly version = '1.1.2';
  readonly description = '网络请求监控';

  private readonly config: NetworkPluginConfig;
  private logger: AemeathInterface | null = null;
  private platform!: PlatformAdapter;
  private unregisterIntercept: (() => void) | null = null;

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
  }

  /** 调试日志 */
  private log(...args: unknown[]): void {
    if (this.config.debug) {
      console.log('[NetworkPlugin]', ...args);
    }
  }

  install(logger: AemeathInterface): void {
    this.logger = logger;
    this.platform = logger.platform ?? detectPlatform();

    this.unregisterIntercept = this.platform.network.intercept(
      (log: NetworkRequestLog) => {
        this.recordRequest({
          type: log.type === 'request' ? 'fetch' : log.type,
          url: log.url,
          method: log.method,
          status: log.status,
          statusText: log.statusText,
          duration: log.duration,
          timestamp: log.timestamp,
          error: log.error,
          requestBody: log.requestBody,
          responseBody: log.responseBody,
          responseCode: log.responseCode,
          responseMessage: log.responseMessage,
        });
      },
      {
        shouldCapture: (url: string) => this.shouldCapture(url),
        captureRequestBody: this.config.captureRequestBody,
        captureResponseBody: this.config.captureResponseBody,
        maxResponseBodySize: this.config.maxResponseBodySize,
      },
    );

    this.log('Installed');
  }

  uninstall(): void {
    if (this.unregisterIntercept) {
      this.unregisterIntercept();
      this.unregisterIntercept = null;
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
   * 记录网络请求
   */
  private recordRequest(log: NetworkLog): void {
    if (!this.logger) return;

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
      type: 'HTTP_ERROR',
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

}
