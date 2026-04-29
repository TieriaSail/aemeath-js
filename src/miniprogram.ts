/**
 * AemeathJs - 微信小程序专用精简入口
 *
 * 此入口构建为 `dist-miniprogram/index.js` 单文件 CJS bundle，
 * 通过 package.json 的 `miniprogram` 字段被 微信开发者工具 npm 构建识别。
 *
 * ⚠️ 与主入口 `aemeath-js` 的差异：
 * 1. 只导出小程序环境下可运行的 API，浏览器专用能力（DOM、Web Vitals、
 *    构建期早期错误捕获等）被排除，以减小包体积。
 * 2. `initAemeath()` 要求显式传入 `platform` 参数（通过 `createMiniAppAdapter`
 *    构造），不做自动平台检测 —— 避免小程序打包期误将 `wx` 当成未声明全局。
 * 3. 不会自动启用 `BrowserApiErrorsPlugin`（仅对 window/XHR 生效，在小程序
 *    环境无意义）。
 *
 * 对应用户文档：docs/zh/11-miniprogram-support.md
 */

import { AemeathLogger } from './core/Logger';
import { ErrorCapturePlugin } from './plugins/ErrorCapturePlugin';
import { UploadPlugin, type UploadResult } from './plugins/UploadPlugin';
import { SafeGuardPlugin, type SafeGuardMode } from './plugins/SafeGuardPlugin';
import { NetworkPlugin, type NetworkLogType } from './plugins/NetworkPlugin';
import { BeforeSendPlugin } from './plugins/BeforeSendPlugin';
import { createMiniAppAdapter } from './platform/miniapp';
import type { BeforeSendHook, LogEntry } from './types';
import type { PlatformAdapter } from './platform/types';
import type { RouteMatchConfig } from './utils/routeMatcher';

// ==================== 核心 ====================
export { AemeathLogger };

// ==================== 类型 ====================
export type {
  LogLevel,
  LogEntry,
  LogOptions,
  ErrorInfo,
  StackFrame,
  LogTags,
  LogContext,
  BeforeLogResult,
  AfterLogResult,
  BeforeSendHook,
  AemeathPlugin,
  LogListener,
  PluginMetadata,
  AemeathInterface,
  BundleConfig,
  ContextUpdater,
  ContextValue,
} from './types';

export { LogLevel as LogLevelEnum, ErrorCategory, PluginPriority } from './types';

// ==================== 插件（仅小程序可用子集） ====================
export { ErrorCapturePlugin };
export type { ErrorCapturePluginOptions } from './plugins/ErrorCapturePlugin';

export { UploadPlugin };
export type {
  UploadPluginOptions,
  UploadResult,
  UploadCallback,
  PriorityCallback,
} from './plugins/UploadPlugin';

export { SafeGuardPlugin };
export type {
  SafeGuardPluginOptions,
  SafeGuardMode,
  SafeGuardHealth,
} from './plugins/SafeGuardPlugin';

export { NetworkPlugin };
export type {
  NetworkPluginOptions,
  NetworkLog,
  NetworkLogType,
} from './plugins/NetworkPlugin';

export { BeforeSendPlugin };
export type { BeforeSendPluginOptions } from './plugins/BeforeSendPlugin';

// ==================== 平台适配器 ====================
export { createMiniAppAdapter };
export type { MiniAppAPI } from './platform/miniapp';
export type {
  PlatformAdapter,
  PlatformType,
  MiniAppVendor,
  GlobalErrorInfo,
  UnhandledRejectionInfo,
} from './platform/types';

// ==================== Instrumentation（仅小程序请求拦截） ====================
export { instrumentMiniAppRequest } from './instrumentation/miniapp-request';
export type { MiniAppRequestAPI } from './instrumentation/miniapp-request';
export type {
  NetworkEvent,
  InstrumentOptions,
  NetworkHandler,
  Unsubscribe as NetworkUnsubscribe,
} from './instrumentation/types';

export type { RouteMatchConfig };

// ==================== 单例模式（小程序精简版） ====================

/**
 * 全局 AemeathJs 实例（小程序入口独立维护，与主入口隔离）
 */
let globalAemeath: AemeathLogger | null = null;

/**
 * 小程序版 AemeathJs 初始化配置
 *
 * 与主入口 `aemeath-js` 的 `AemeathInitOptions` 相比：
 * - `platform` 为必填（必须通过 `createMiniAppAdapter('wechat', wx)` 构造）
 * - 删除 `browserApiErrors`（浏览器专用）
 * - 保留 `errorCapture` / `network` / `safeGuard` / `upload` / `context` 等
 */
export interface AemeathInitOptions {
  /**
   * 平台适配器（必填）
   *
   * @example
   * ```javascript
   * import { initAemeath, createMiniAppAdapter } from 'aemeath-js';
   *
   * initAemeath({
   *   platform: createMiniAppAdapter('wechat', wx),
   *   upload: async (log) => { ... }
   * });
   * ```
   */
  platform: PlatformAdapter;

  /**
   * 错误捕获配置
   *
   * @default true
   */
  errorCapture?: boolean | {
    enabled?: boolean;
    routeMatch?: RouteMatchConfig;
  };

  /**
   * 全局路由匹配配置
   */
  routeMatch?: RouteMatchConfig;

  /**
   * 自定义上传函数
   */
  upload?: (log: LogEntry) => Promise<UploadResult>;

  /**
   * 自定义优先级
   */
  getPriority?: (log: LogEntry) => number;

  /**
   * 队列配置
   *
   * @default { maxSize: 100, uploadInterval: 30000, concurrency: 1, maxRetries: 3 }
   */
  queue?: {
    maxSize?: number;
    uploadInterval?: number;
    concurrency?: number;
    maxRetries?: number;
  };

  /** 是否启用控制台输出 @default true */
  enableConsole?: boolean;

  /** 环境标识 */
  environment?: string;

  /** 版本号 */
  release?: string;

  /** 全局上下文信息 */
  context?: Record<string, unknown>;

  /**
   * 安全保护配置
   */
  safeGuard?: {
    enabled?: boolean;
    mode?: SafeGuardMode;
    maxErrors?: number;
    cooldownPeriod?: number;
    rateLimit?: number;
    mergeWindow?: number;
    enableRecursionGuard?: boolean;
  };

  /**
   * 错误过滤器
   */
  errorFilter?: (error: Error) => boolean;

  /**
   * 网络请求监控配置
   *
   * ⚠️ 小程序场景下，`NetworkPlugin` 会通过 `platform.nativeAPI.request`
   * 拦截请求。确保 `platform` 已通过 `createMiniAppAdapter(vendor, wx)` 构造。
   */
  network?: {
    enabled?: boolean;
    routeMatch?: RouteMatchConfig;
    logTypes?: NetworkLogType[];
    captureRequestBody?: boolean;
    captureResponseBody?: boolean;
    slowThreshold?: number;
    excludeUrls?: string[];
    slowRequestExcludePatterns?: string[];
    monitorAllSlowRequests?: boolean;
  };

  /**
   * 全链路日志最终拦截钩子（隐私脱敏 / 业务过滤 / 字段补充）
   *
   * 详见 docs/{zh,en}/9-before-send.md
   */
  beforeSend?: BeforeSendHook;

  /**
   * @deprecated 使用 context 代替
   */
  tags?: Record<string, unknown>;
}

/**
 * 初始化 AemeathJs 小程序实例（单例）
 *
 * @example
 * ```javascript
 * // app.js
 * const { initAemeath, createMiniAppAdapter } = require('aemeath-js');
 *
 * App({
 *   onLaunch() {
 *     initAemeath({
 *       platform: createMiniAppAdapter('wechat', wx),
 *       upload: async (log) => {
 *         return new Promise((resolve) => {
 *           wx.request({
 *             url: 'https://your-server.com/api/logs',
 *             method: 'POST',
 *             data: log,
 *             success: () => resolve({ success: true }),
 *             fail: (err) => resolve({
 *               success: false,
 *               shouldRetry: true,
 *               error: err.errMsg
 *             })
 *           });
 *         });
 *       }
 *     });
 *   }
 * });
 * ```
 */
export function initAemeath(options: AemeathInitOptions): AemeathLogger {
  if (globalAemeath) {
    // 重复 init：整个 options 不会被再次应用，但下面的「可挽救」选项会被增量应用：
    //   - beforeSend：直接 setHook 到现有 BeforeSendPlugin
    //   - upload：第一次 init 没传 upload 时，第二次 init({ upload }) 会被丢弃，
    //     这里**增量补装**，否则用户在多模块场景下传 upload 会被静默吞掉。
    //     （与 web 端 singleton/index.ts 修复对称。）
    const honored: string[] = [];
    if (options && options.beforeSend !== undefined) {
      const existing = globalAemeath.getPluginInstance('before-send') as BeforeSendPlugin | undefined;
      if (existing && typeof existing.setHook === 'function') {
        existing.setHook(options.beforeSend);
        honored.push('beforeSend');
      }
    }
    if (options && options.upload && !globalAemeath.hasPlugin('upload')) {
      globalAemeath.use(
        new UploadPlugin({
          onUpload: options.upload,
          getPriority: options.getPriority,
          queue: options.queue,
          cache: { enabled: true },
        }),
      );
      honored.push('upload');
    }
    if (typeof console !== 'undefined' && console.warn) {
      const ignored = options ? Object.keys(options).filter((k) => !honored.includes(k)) : [];
      if (ignored.length > 0) {
        const honoredText = honored.length > 0
          ? ` Only the following were honored: ${honored.join(', ')}.`
          : '';
        console.warn(
          '[Aemeath] initAemeath() called twice. The following options were ignored: '
            + `${ignored.join(', ')}.${honoredText}`,
        );
      }
    }
    return globalAemeath;
  }

  if (!options || !options.platform) {
    throw new TypeError(
      '[AemeathJs] initAemeath requires options.platform for miniprogram entry. '
        + 'Use createMiniAppAdapter(vendor, wx) to construct the adapter.',
    );
  }

  const context: Record<string, unknown> = {
    ...options.tags,
    ...options.context,
  };

  const logger = new AemeathLogger({
    enableConsole: options.enableConsole ?? true,
    context,
    environment: options.environment,
    release: options.release,
    platform: options.platform,
    routeMatch: options.routeMatch,
  });

  const ecOpt = options.errorCapture;
  const ecEnabled = ecOpt === undefined || ecOpt === true
    || (typeof ecOpt === 'object' && ecOpt.enabled !== false);
  if (ecEnabled) {
    const ecRouteMatch = typeof ecOpt === 'object' ? ecOpt.routeMatch : undefined;
    logger.use(
      new ErrorCapturePlugin({
        routeMatch: ecRouteMatch,
        errorFilter: options.errorFilter,
      }),
    );
  }

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

  if (options.upload) {
    logger.use(
      new UploadPlugin({
        onUpload: options.upload,
        getPriority: options.getPriority,
        queue: options.queue,
        cache: { enabled: true },
      }),
    );
  }

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

  // 全链路最终拦截 / 脱敏（priority: LATEST）
  logger.use(new BeforeSendPlugin({ beforeSend: options.beforeSend }));

  globalAemeath = logger;
  return logger;
}

/**
 * 在运行时设置 / 替换 / 清除全链路日志拦截钩子（`beforeSend`）
 *
 * 详见 docs/{zh,en}/9-before-send.md
 *
 * @param hook 钩子函数（传 `null` 清除）
 */
export function setBeforeSend(hook: BeforeSendHook | null): void {
  if (!globalAemeath) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(
        '[Aemeath] setBeforeSend() was called before initAemeath(). '
          + 'The hook is dropped. Call initAemeath() first, or pass `beforeSend` to it directly.',
      );
    }
    return;
  }
  const plugin = globalAemeath.getPluginInstance('before-send') as BeforeSendPlugin | undefined;
  if (plugin && typeof plugin.setHook === 'function') {
    plugin.setHook(hook);
  } else if (typeof console !== 'undefined' && console.warn) {
    console.warn(
      '[Aemeath] setBeforeSend() called but BeforeSendPlugin is not installed. The hook is ignored.',
    );
  }
}

/**
 * 获取全局 AemeathJs 实例
 *
 * 若尚未初始化，会抛出 TypeError（小程序入口要求显式初始化，
 * 避免在缺失 `platform` 的情况下静默创建空实例）。
 */
export function getAemeath(): AemeathLogger {
  if (!globalAemeath) {
    throw new TypeError(
      '[AemeathJs] Not initialized. Call initAemeath({ platform: createMiniAppAdapter(vendor, wx), ... }) first.',
    );
  }
  return globalAemeath;
}

/** 检查是否已初始化 */
export function isAemeathInitialized(): boolean {
  return globalAemeath !== null;
}

/**
 * 重置全局实例（主要用于测试场景）
 */
export function resetAemeath(): void {
  if (globalAemeath) {
    globalAemeath.destroy?.();
  }
  globalAemeath = null;
}

export type { AemeathInterface as Logger } from './types';
