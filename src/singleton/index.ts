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
import { BrowserApiErrorsPlugin, type BrowserApiErrorsPluginOptions } from '../plugins/BrowserApiErrorsPlugin';
import { EarlyErrorCapturePlugin } from '../plugins/EarlyErrorCapturePlugin';
import { UploadPlugin, type UploadResult } from '../plugins/UploadPlugin';
import { SafeGuardPlugin, type SafeGuardMode } from '../plugins/SafeGuardPlugin';
import { NetworkPlugin, type NetworkLogType } from '../plugins/NetworkPlugin';
import { BeforeSendPlugin } from '../plugins/BeforeSendPlugin';
import type { BeforeSendHook, LogEntry } from '../types';
import type { PlatformAdapter } from '../platform/types';
import { detectPlatform } from '../platform/detect';
import type { RouteMatchConfig } from '../utils/routeMatcher';

export type { RouteMatchConfig };

/**
 * 全局 AemeathJs 实例
 */
let globalAemeath: AemeathLogger | null = null;

/**
 * AemeathJs 初始化配置
 *
 * @example
 * ```javascript
 * // 基础配置
 * initAemeath({
 *   upload: async (log) => {
 *     const res = await fetch('/api/logs', {
 *       method: 'POST',
 *       body: JSON.stringify(log)
 *     });
 *     return { success: res.ok };
 *   }
 * });
 *
 * // 带路由过滤
 * initAemeath({
 *   upload: async (log) => { return { success: true }; },
 *   routeMatch: {
 *     includeRoutes: ['/home', '/product', /^\/user\/.+/],
 *     excludeRoutes: ['/debug']
 *   }
 * });
 * ```
 */
export interface AemeathInitOptions {
  /**
   * 平台适配器
   *
   * 自动检测时无需设置，手动指定时可传入自定义适配器
   * - 浏览器环境自动使用 browserAdapter
   * - 小程序环境自动使用对应厂商适配器
   * - 也可传入 createMiniAppAdapter() 或自定义适配器
   */
  platform?: PlatformAdapter;

  /**
   * 错误捕获配置
   *
   * - `true` / `undefined`：启用（默认）
   * - `false`：禁用
   * - `{ enabled?, routeMatch? }`：启用并配置插件级路由规则
   *
   * @default true
   */
  errorCapture?: boolean | {
    enabled?: boolean;
    routeMatch?: RouteMatchConfig;
  };

  /**
   * 浏览器 API 回调增强捕获
   *
   * 通过 monkey-patch 浏览器 API（addEventListener / setTimeout / setInterval /
   * requestAnimationFrame / XMLHttpRequest.send），为回调函数注入 try-catch，
   * 解决 WebView 等跨域环境下 "Script error." 无法获取完整错误信息的问题。
   *
   * - `true` / `undefined`：启用（默认）
   * - `false`：禁用
   * - `object`：启用并自定义选项
   *
   * @default true
   */
  browserApiErrors?: boolean | BrowserApiErrorsPluginOptions;

  /**
   * 全局路由匹配配置
   *
   * 控制在哪些路由下启用所有监控能力（错误捕获、网络监控、性能监控等）。
   * excludeRoutes 优先级高于 includeRoutes。
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
   * @default { maxSize: 100, uploadInterval: 30000, concurrency: 1, maxRetries: 3 }
   */
  queue?: {
    /** 最大队列大小 @default 100 */
    maxSize?: number;
    /** 上传间隔（毫秒）@default 30000 */
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
   * 安全保护配置
   *
   * 提供三种保护模式：
   * - 'standard'（默认）：被拦截的日志直接丢弃，最轻量
   * - 'cautious'：暂存到内存回收站，浏览器空闲时低优先级回放
   * - 'strict'：与 cautious 相同，但回收站持久化到 localStorage
   *
   * @example
   * ```javascript
   * safeGuard: { enabled: true, mode: 'cautious' }
   * ```
   */
  safeGuard?: {
    /** 是否启用安全保护 @default true */
    enabled?: boolean;
    /** 保护模式 @default 'standard' */
    mode?: SafeGuardMode;
    /** 最大错误数（触发熔断）@default 100 */
    maxErrors?: number;
    /** 熔断冷却时间 ms @default 30000 */
    cooldownPeriod?: number;
    /** 每秒最大日志数 @default 100 */
    rateLimit?: number;
    /** 重复日志合并窗口 ms @default 2000 */
    mergeWindow?: number;
    /** 是否启用递归保护 @default true */
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
     * 插件级路由匹配配置
     * 在全局 routeMatch 基础上进一步限定网络监控的路由范围
     */
    routeMatch?: RouteMatchConfig;
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
   * 全链路日志最终拦截钩子（隐私脱敏 / 业务过滤 / 字段补充）
   *
   * 在所有插件 `afterLog` 之后、listener（含 UploadPlugin）之前调用。
   *
   * 用户可以：
   * - **修改字段**：返回新的 `LogEntry`（如脱敏 message / 删除敏感 context）
   * - **完全丢弃**：返回 `null`（该条日志不会被任何 listener 接收，**也不会上报**）
   * - **原样放行**：返回 `entry` 本身、`undefined` 或不返回
   *
   * **fail-safe**：钩子内部异常会被静默吞掉，原 entry 会按未修改状态继续传递。
   *
   * 详细文档参见 docs/{zh,en}/9-before-send.md
   *
   * @example 隐私脱敏
   * ```ts
   * initAemeath({
   *   beforeSend: (entry) => {
   *     if (entry.context?.user) {
   *       return {
   *         ...entry,
   *         context: { ...entry.context, user: { id: entry.context.user.id } },
   *       };
   *     }
   *     return entry;
   *   },
   * });
   * ```
   *
   * @example 丢弃噪音日志
   * ```ts
   * initAemeath({
   *   beforeSend: (entry) =>
   *     entry.tags?.errorCategory === 'noise' ? null : entry,
   * });
   * ```
   */
  beforeSend?: BeforeSendHook;

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
 *     const res = await fetch('/api/logs', {
 *       method: 'POST',
 *       body: JSON.stringify(log)
 *     });
 *     return { success: res.ok };
 *   }
 * });
 *
 * const logger = getAemeath();
 * logger.info('Hello World');
 * ```
 */
export function initAemeath(options: AemeathInitOptions = {}): AemeathLogger {
  if (globalAemeath) {
    // 兼容场景：用户在 initAemeath 之前先调了 getAemeath()（兜底创建了实例）。
    // 整个 options 不会再被应用（避免重复 use 同名插件 / 改变已被使用的全局状态），
    // 但单独把 options.beforeSend 转嫁到现有 BeforeSendPlugin 上 —— 否则用户传的
    // beforeSend 钩子会被静默丢弃，这是 v2.4.0+ 最容易踩的坑。
    if (options.beforeSend !== undefined) {
      const existing = globalAemeath.getPluginInstance('before-send') as BeforeSendPlugin | undefined;
      if (existing && typeof existing.setHook === 'function') {
        existing.setHook(options.beforeSend);
      }
    }
    if (typeof console !== 'undefined' && console.warn) {
      const ignored = Object.keys(options).filter((k) => k !== 'beforeSend');
      if (ignored.length > 0) {
        console.warn(
          '[Aemeath] initAemeath() called after the global instance already exists '
            + '(probably because getAemeath() was used first). The following options '
            + `were ignored: ${ignored.join(', ')}. Only beforeSend is honored.`,
        );
      }
    }
    return globalAemeath;
  }

  // 构建全局上下文（只包含用户配置的内容）
  const context: Record<string, unknown> = {
    ...options.tags,
    ...options.context,
  };

  const platform = options.platform ?? detectPlatform();

  const logger = new AemeathLogger({
    enableConsole: options.enableConsole ?? true,
    context,
    environment: options.environment,
    release: options.release,
    platform,
    routeMatch: options.routeMatch,
  });

  // 0. Browser API callback wrapping (must be installed BEFORE ErrorCapturePlugin
  //    so that wrapped callbacks report via try-catch first, and the global
  //    handler can skip duplicates via shouldIgnoreOnError())
  const baeOpt = options.browserApiErrors;
  const baeEnabled = baeOpt === undefined || baeOpt === true || (typeof baeOpt === 'object');
  if (baeEnabled) {
    const baeConfig: BrowserApiErrorsPluginOptions =
      typeof baeOpt === 'object' ? baeOpt : {};
    logger.use(new BrowserApiErrorsPlugin(baeConfig));
  }

  // 1. 错误捕获（默认启用）
  const ecOpt = options.errorCapture;
  const ecEnabled = ecOpt === undefined || ecOpt === true || (typeof ecOpt === 'object' && ecOpt.enabled !== false);
  if (ecEnabled) {
    const ecRouteMatch = typeof ecOpt === 'object' ? ecOpt.routeMatch : undefined;
    logger.use(
      new ErrorCapturePlugin({
        routeMatch: ecRouteMatch,
        errorFilter: options.errorFilter,
      }),
    );
  }

  // 2. 早期错误捕获
  //    判定依据：构建插件已注入早期脚本（即 __flushEarlyErrors__ 存在）。
  //    旧版本曾用 hasEarlyErrors()（length > 0），导致绝大多数无错误的健康加载
  //    根本不装载本插件 → __LOGGER_INITIALIZED__ 永远不被翻牌 → 早期脚本和
  //    模块化 ErrorCapturePlugin 双轨捕获 + fallback 定时器到点重复上报。
  //    详见 v2.2.0-beta.1 early-handoff-bug-report。
  if (platform.earlyCapture.isInstalled()) {
    logger.use(
      new EarlyErrorCapturePlugin(),
    );
  }

  // 3. 安全保护
  if (options.safeGuard?.enabled !== false) {
    logger.use(
      new SafeGuardPlugin({
        mode: options.safeGuard?.mode,
        maxErrors: options.safeGuard?.maxErrors,
        cooldownPeriod: options.safeGuard?.cooldownPeriod,
        rateLimit: options.safeGuard?.rateLimit,
        mergeWindow: options.safeGuard?.mergeWindow,
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
        routeMatch: options.network?.routeMatch,
      }),
    );
  }

  // 6. 全链路最终拦截 / 脱敏（PluginPriority.LATEST，永远在管道末端）
  //    即使用户没传 beforeSend，也注入此插件，以便后续运行时通过
  //    setBeforeSend(...) 动态启用。开销极小（无钩子时直接放行）。
  logger.use(new BeforeSendPlugin({ beforeSend: options.beforeSend }));

  globalAemeath = logger;
  return logger;
}

/**
 * 在运行时设置 / 替换 / 清除全链路日志拦截钩子（`beforeSend`）
 *
 * 适用于：
 * - 用户登录后才能拿到完整的脱敏规则
 * - 不同业务页面切换不同的过滤规则
 *
 * 必须在 `initAemeath()` 之后调用。
 *
 * @param hook 钩子函数（传 `null` 清除）
 *
 * @example
 * ```ts
 * setBeforeSend((entry) => ({
 *   ...entry,
 *   message: redact(entry.message),
 * }));
 * ```
 */
export function setBeforeSend(hook: BeforeSendHook | null): void {
  if (!globalAemeath) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(
        '[Aemeath] setBeforeSend() was called before any Aemeath instance exists. '
          + 'The hook is dropped. Call initAemeath()/getAemeath() first, '
          + 'or pass `beforeSend` to initAemeath() directly.',
      );
    }
    return;
  }
  const plugin = globalAemeath.getPluginInstance('before-send') as BeforeSendPlugin | undefined;
  if (plugin && typeof plugin.setHook === 'function') {
    plugin.setHook(hook);
  } else if (typeof console !== 'undefined' && console.warn) {
    console.warn(
      '[Aemeath] setBeforeSend() called but BeforeSendPlugin is not installed on the '
        + 'global instance. The hook is ignored. (This typically means the instance was '
        + 'created without the singleton helpers.)',
    );
  }
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
 * logger.info('User logged in', { context: { userId: 123 } });
 * logger.error('Payment failed', { error });
 * ```
 */
export function getAemeath(): AemeathLogger {
  if (!globalAemeath) {
    globalAemeath = new AemeathLogger({ platform: detectPlatform() });
    globalAemeath.use(new ErrorCapturePlugin());
    // 兜底也要装 BeforeSendPlugin，否则后续 setBeforeSend(...) 会静默无效
    globalAemeath.use(new BeforeSendPlugin());
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
