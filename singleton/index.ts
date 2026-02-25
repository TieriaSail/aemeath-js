/**
 * AemeathJs 单例模式
 *
 * 设计理念：
 * - 后台只存储数据（不做复杂处理）
 * - 上传完全自定义（用户控制）
 * - 前端负责记录和解析（Source Map 解析在前端）
 */

import { AemeathLogger } from '../core/Logger';
import { ErrorCapturePlugin } from '../plugins/ErrorCapturePlugin';
import { EarlyErrorCapturePlugin } from '../plugins/EarlyErrorCapturePlugin';
import { UploadPlugin, type UploadResult } from '../plugins/UploadPlugin';
import { SafeGuardPlugin } from '../plugins/SafeGuardPlugin';
import { NetworkPlugin, type NetworkLogType } from '../plugins/NetworkPlugin';
import type { LogEntry } from '../types';

/**
 * 全局 AemeathJs 实例
 */
let globalAemeath: AemeathLogger | null = null;

// ==================== 配置类型 ====================

/**
 * 路由匹配配置
 */
export interface RouteMatchConfig {
  /**
   * 路由白名单：只监控这些路由
   * 支持字符串精确匹配、正则表达式、函数匹配
   */
  includeRoutes?: Array<string | RegExp | ((path: string) => boolean)>;
  /**
   * 路由黑名单：排除这些路由
   * 优先级高于白名单
   */
  excludeRoutes?: Array<string | RegExp | ((path: string) => boolean)>;
}

/**
 * AemeathJs 初始化配置
 *
 * @example
 * ```javascript
 * // 基础配置
 * initAemeath({
 *   upload: async (log) => {
 *     await fetch('/api/logs', {
 *       method: 'POST',
 *       body: JSON.stringify(log)
 *     });
 *   }
 * });
 *
 * // 带路由过滤
 * initAemeath({
 *   upload: async (log) => { ... },
 *   routeMatch: {
 *     includeRoutes: ['/home', '/product', /^\/user\/.+/],
 *     excludeRoutes: ['/debug']
 *   }
 * });
 * ```
 */
export interface AemeathInitOptions {
  /**
   * 是否启用错误捕获
   *
   * 捕获全局错误、Promise 错误、资源加载失败
   *
   * @default true
   */
  errorCapture?: boolean;

  /**
   * 路由匹配配置
   * 控制在哪些路由下启用错误监控
   *
   * @example
   * ```javascript
   * routeMatch: {
   *   includeRoutes: ['/home', '/about', /^\/product\/.+/],
   *   excludeRoutes: ['/debug']
   * }
   * ```
   */
  routeMatch?: RouteMatchConfig;

  /**
   * 自定义上传函数
   *
   * 完全由你控制如何上传日志到服务器
   *
   * @example
   * ```javascript
   * upload: async (log) => {
   *   try {
   *     const token = getAuthToken();
   *     const response = await fetch('/api/logs', {
   *       method: 'POST',
   *       headers: {
   *         'Authorization': `Bearer ${token}`,
   *         'Content-Type': 'application/json'
   *       },
   *       body: JSON.stringify(log)
   *     });
   *
   *     const data = await response.json();
   *
   *     if (data.code === 200) {
   *       return { success: true };
   *     } else {
   *       return { success: false, shouldRetry: true, error: data.message };
   *     }
   *   } catch (error) {
   *     return { success: false, shouldRetry: true, error: error.message };
   *   }
   * }
   * ```
   */
  upload?: (log: LogEntry) => Promise<UploadResult>;

  /**
   * 可选：自定义优先级
   *
   * 返回数字越大，优先级越高
   *
   * @example
   * ```javascript
   * getPriority: (log) => {
   *   if (log.level === 'error') return 10;
   *   if (log.level === 'warn') return 5;
   *   return 1;
   * }
   * ```
   */
  getPriority?: (log: LogEntry) => number;

  /**
   * 队列配置
   *
   * @default { maxSize: 100, uploadInterval: 5000, concurrency: 1, maxRetries: 3 }
   */
  queue?: {
    /** 最大队列大小 @default 100 */
    maxSize?: number;
    /** 上传间隔（毫秒）@default 5000 */
    uploadInterval?: number;
    /** 并发数 @default 1 */
    concurrency?: number;
    /** 最大重试次数 @default 3 */
    maxRetries?: number;
  };

  /**
   * 是否启用控制台输出
   *
   * @default true
   */
  enableConsole?: boolean;

  /**
   * 环境标识
   *
   * @example 'development' | 'staging' | 'production'
   */
  environment?: string;

  /**
   * 版本号
   *
   * @example '1.0.0'
   */
  release?: string;

  /**
   * 全局上下文信息
   *
   * 这些信息会自动附加到每条日志中
   *
   * 适用于：userId、deviceId、appVersion、ip、platform 等标识信息
   *
   * @example
   * ```javascript
   * {
   *   userId: '12345',
   *   deviceId: 'abc-def-123',
   *   appVersion: '1.0.0',
   *   platform: 'iOS',
   *   ip: '192.168.1.1'
   * }
   * ```
   */
  context?: Record<string, unknown>;

  /**
   * 安全保护配置（防止日志系统自身错误导致死循环）
   */
  safeGuard?: {
    /** 是否启用安全保护 */
    enabled?: boolean;
    /** 最大错误数（超过后暂停 AemeathJs） */
    maxErrors?: number;
    /** 重置间隔（ms） */
    resetInterval?: number;
    /** 频率限制（每秒最多记录多少条） */
    rateLimit?: number;
    /** 是否启用递归保护 */
    enableRecursionGuard?: boolean;
  };

  /**
   * 错误过滤器
   *
   * 返回 false 可以阻止该错误被捕获和上报
   *
   * @example
   * ```javascript
   * errorFilter: (error) => {
   *   if (error.message?.includes('401') || (error as any).status === 401) {
   *     return false;
   *   }
   *   return true;
   * }
   * ```
   */
  errorFilter?: (error: Error) => boolean;

  /**
   * 网络请求监控配置
   *
   * 自动捕获所有 fetch 和 XMLHttpRequest 请求
   *
   * @example
   * ```javascript
   * network: {
   *   enabled: true,
   *   logTypes: ['error', 'slow'],
   *   captureRequestBody: true,
   *   captureResponseBody: true,
   *   slowThreshold: 3000,
   * }
   * ```
   */
  network?: {
    /** 是否启用网络监控 @default true */
    enabled?: boolean;
    /**
     * 要记录的请求类型
     * - 'success': 成功的请求
     * - 'error': 失败的请求（状态码 >= 400 或网络错误）
     * - 'slow': 慢请求（超过 slowThreshold）
     * @default ['success', 'error', 'slow']
     */
    logTypes?: NetworkLogType[];
    /** 是否记录请求体 @default true */
    captureRequestBody?: boolean;
    /** 是否记录响应体 @default true */
    captureResponseBody?: boolean;
    /** 慢请求阈值（毫秒）@default 3000 */
    slowThreshold?: number;
    /** 额外排除的 URL 模式（日志上报接口已自动排除） */
    excludeUrls?: string[];
    /**
     * 慢请求排除模式 - 匹配的 URL 不会触发慢请求告警
     *
     * 传入自定义数组会**完全替换**默认排除列表
     *
     * @example
     * slowRequestExcludePatterns: ['.mp3', '.wav', '.ogg', '.m4a']
     */
    slowRequestExcludePatterns?: string[];
    /**
     * 监控所有资源的慢请求（包括大文件）
     *
     * 设为 true 时会忽略 slowRequestExcludePatterns，监控所有请求
     *
     * @default false
     */
    monitorAllSlowRequests?: boolean;
  };

  /**
   * @deprecated 使用 context 代替
   */
  tags?: Record<string, unknown>;
}

// ==================== 核心 API ====================

/**
 * 初始化 AemeathJs（单例）
 *
 * 只需要调用一次，通常在应用入口
 *
 * @example
 * ```javascript
 * import { initAemeath, getAemeath } from 'aemeath-js';
 *
 * initAemeath({
 *   upload: async (log) => {
 *     await fetch('/api/logs', {
 *       method: 'POST',
 *       body: JSON.stringify(log)
 *     });
 *   }
 * });
 *
 * const logger = getAemeath();
 * logger.info('Hello World');
 * ```
 */
export function initAemeath(options: AemeathInitOptions = {}): AemeathLogger {
  if (globalAemeath) {
    console.warn('[Aemeath] Already initialized, returning existing instance');
    return globalAemeath;
  }

  // 构建全局上下文（只包含用户配置的内容）
  const context: Record<string, unknown> = {
    ...options.tags,
    ...options.context,
  };

  const logger = new AemeathLogger({
    enableConsole: options.enableConsole ?? true,
    context,
    environment: options.environment,
    release: options.release,
  });

  // 1. 错误捕获（默认启用）
  if (options.errorCapture !== false) {
    logger.use(
      new ErrorCapturePlugin({
        routeMatch: options.routeMatch,
        errorFilter: options.errorFilter,
      }),
    );
  }

  // 2. 早期错误捕获（如果构建时启用了）
  if (typeof window !== 'undefined' && (window as any).__EARLY_ERRORS__) {
    logger.use(
      new EarlyErrorCapturePlugin({
        routeMatch: options.routeMatch,
      }),
    );
  }

  // 3. 安全保护（防止日志系统自身错误导致死循环）
  if (options.safeGuard?.enabled !== false) {
    logger.use(
      new SafeGuardPlugin({
        maxErrors: options.safeGuard?.maxErrors,
        resetInterval: options.safeGuard?.resetInterval,
        rateLimit: options.safeGuard?.rateLimit,
        enableRecursionGuard: options.safeGuard?.enableRecursionGuard,
      }),
    );
  }

  // 4. 上传配置
  if (options.upload) {
    const uploadPlugin = new UploadPlugin({
      onUpload: options.upload,
      getPriority: options.getPriority,
      queue: options.queue,
      cache: { enabled: true },
    });
    logger.use(uploadPlugin);
  }

  // 5. 网络请求监控（默认启用）
  if (options.network?.enabled !== false) {
    logger.use(
      new NetworkPlugin({
        logTypes: options.network?.logTypes,
        captureRequestBody: options.network?.captureRequestBody ?? true,
        captureResponseBody: options.network?.captureResponseBody ?? true,
        slowThreshold: options.network?.slowThreshold ?? 3000,
        slowRequestExcludePatterns: options.network?.monitorAllSlowRequests
          ? []
          : options.network?.slowRequestExcludePatterns,
        urlFilter: options.network?.excludeUrls?.length
          ? (url) =>
              !options.network!.excludeUrls!.some((pattern) =>
                url.includes(pattern),
              )
          : undefined,
      }),
    );
  }

  globalAemeath = logger;
  return logger;
}

/**
 * 获取全局 AemeathJs 实例
 *
 * 如果未初始化，返回默认实例（只有错误捕获）
 *
 * @example
 * ```javascript
 * import { getAemeath } from 'aemeath-js';
 *
 * const logger = getAemeath();
 * logger.info('User logged in', { userId: 123 });
 * logger.error('Payment failed', error);
 * ```
 */
export function getAemeath(): AemeathLogger {
  if (!globalAemeath) {
    console.warn(
      '[Aemeath] Not initialized. Call initAemeath() first.\n' +
        'Creating default instance with error capture only.',
    );
    globalAemeath = new AemeathLogger();
    globalAemeath.use(new ErrorCapturePlugin());
  }

  return globalAemeath;
}

/**
 * 检查是否已初始化
 *
 * @example
 * ```javascript
 * import { isAemeathInitialized, initAemeath } from 'aemeath-js';
 *
 * if (!isAemeathInitialized()) {
 *   initAemeath({ upload: ... });
 * }
 * ```
 */
export function isAemeathInitialized(): boolean {
  return globalAemeath !== null;
}

/**
 * 重置全局 AemeathJs
 *
 * 主要用于测试
 *
 * @example
 * ```javascript
 * import { resetAemeath, initAemeath } from 'aemeath-js';
 *
 * afterEach(() => {
 *   resetAemeath();
 * });
 *
 * test('aemeath', () => {
 *   initAemeath({ upload: ... });
 * });
 * ```
 */
export function resetAemeath(): void {
  if (globalAemeath) {
    globalAemeath.destroy?.();
  }
  globalAemeath = null;
}

// ==================== 类型导出 ====================

export type { AemeathInterface as Logger, LogEntry } from '../types';
