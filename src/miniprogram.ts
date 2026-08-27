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
import { ErrorCapturePlugin, type ErrorCapturePluginOptions } from './plugins/ErrorCapturePlugin';
import {
  UploadPlugin,
  parseRetryAfter,
  classifyHttpUploadResponse,
  type UploadResult,
  type UploadCallback,
  type UploadDropCallback,
  type UploadBindingOptions,
} from './plugins/UploadPlugin';
import { PayloadSanitizePlugin } from './plugins/PayloadSanitizePlugin';
import {
  OfflinePersistencePlugin,
  purgeOfflinePersistenceStorage,
  type OfflinePersistencePluginOptions,
} from './plugins/OfflinePersistencePlugin';
import { SafeGuardPlugin, type SafeGuardMode } from './plugins/SafeGuardPlugin';
import { NetworkPlugin, type NetworkLogType, type NetworkErrorType } from './plugins/NetworkPlugin';
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
  DeliveryState,
  DeliveryStatus,
} from './types';

export { LogLevel as LogLevelEnum, ErrorCategory, PluginPriority } from './types';

// ==================== 插件（仅小程序可用子集） ====================
export { ErrorCapturePlugin };
export type { ErrorCapturePluginOptions } from './plugins/ErrorCapturePlugin';

export { UploadPlugin, parseRetryAfter, classifyHttpUploadResponse };
export type {
  UploadPluginOptions,
  UploadResult,
  UploadCallback,
  UploadPayload,
  UploadBindingOptions,
  PriorityCallback,
  UploadRetryReason,
  UploadDropReason,
  UploadDropInfo,
  UploadDropCallback,
  UploadQueueStatus,
  UploadQueueStatusItem,
} from './plugins/UploadPlugin';

export { PayloadSanitizePlugin };
export type {
  PayloadSanitizePluginOptions,
  PayloadSanitizeStats,
} from './plugins/PayloadSanitizePlugin';

export { OfflinePersistencePlugin };
export type {
  OfflinePersistencePluginOptions,
  OfflinePersistenceStatus,
} from './plugins/OfflinePersistencePlugin';

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
  NetworkErrorType,
  NetworkErrorDetail,
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
/** 记住显式退出，避免稍后通过 setUpload / 增量 init 又把持久化装回来 */
let offlinePersistenceConfig: boolean | OfflinePersistencePluginOptions | undefined;
/** 关闭持久化时保留最近一次有效参数，后续传 true 可原配置恢复。 */
let offlinePersistenceOptions: OfflinePersistencePluginOptions = {};

export type ErrorCaptureConfig =
  | boolean
  | ({ enabled?: boolean } & ErrorCapturePluginOptions);

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
  errorCapture?: ErrorCaptureConfig;

  /**
   * 全局路由匹配配置
   */
  routeMatch?: RouteMatchConfig;

  /**
   * 自定义上传函数
   */
  upload?: (log: LogEntry) => Promise<UploadResult>;

  /** 投递目标稳定作用域；多租户必须为每个租户使用独立存储 key */
  deliveryScope?: string;

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
    /** 网络不可用时暂停队列而不是耗尽重试预算 @default 'pause' */
    offlinePolicy?: 'pause' | 'legacy';
    /** 重试退避 @default true */
    retryBackoff?: boolean | { baseMs?: number; maxMs?: number };
    /** 连续失败多少次判定为疑似离线 @default 3 */
    suspectedOfflineThreshold?: number;
  };

  /**
   * 本地缓存配置
   *
   * ⚠️ 只解决冷启动导致的队列丢失，**不提供断网续传**（那是 `offlinePersistence`）。
   */
  cache?: {
    enabled?: boolean;
    key?: string;
    /** 有效期（毫秒），从写入缓存时刻算起 @default 3600000 */
    ttl?: number;
  };

  /** 日志被丢弃时的回调（不挂则丢弃在生产环境完全静默） */
  onDrop?: UploadDropCallback;

  /**
   * 载荷清洗 @default true
   *
   * Data URL / 二进制占位、单字段超限拒绝、整包超限按字段拆分。
   */
  payloadSanitize?: boolean | { maxBytes?: number };

  /**
   * 断网续传 @default true
   *
   * 小程序没有 IndexedDB，会使用平台 storage 作为后端，容量与条数上限相应收紧。
   * 配置 upload 时默认开启，可显式传入 `false` 关闭。
   */
  offlinePersistence?: boolean | OfflinePersistencePluginOptions;

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
   *
   * @deprecated 推荐使用 `errorCapture.errorFilter`；此字段继续作为兼容兜底。
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
    /** 不捕获这些 errorType 的网络错误（捕获层直接跳过） */
    ignoreErrorTypes?: NetworkErrorType[];
    /** 是否捕获主动取消的请求 @default false */
    captureAborted?: boolean;
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
 *             success: (res) => resolve(classifyHttpUploadResponse(
 *               res.statusCode,
 *               res.header?.['Retry-After'] ?? res.header?.['retry-after']
 *             )),
 *             // wx.request 的 fail 只在请求发不出去时触发（4xx/5xx 走 success），
 *             // 所以这里一定是传输层失败。小程序没有 navigator.onLine，
 *             // retryReason 是 SDK 判定断网的唯一信号，务必填上
 *             fail: (err) => resolve({
 *               success: false,
 *               shouldRetry: true,
 *               retryReason: 'network',
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
  const requestedOfflinePersistence = options?.offlinePersistence;
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
    if (options?.payloadSanitize === false) {
      // 与 singleton 入口对齐：显式关掉必须能撤销已装的实例
      if (globalAemeath.uninstall('payload-sanitize')) honored.push('payloadSanitize');
    } else if (options?.payloadSanitize && !globalAemeath.hasPlugin('payload-sanitize')) {
      globalAemeath.use(
        new PayloadSanitizePlugin(
          typeof options.payloadSanitize === 'object' ? options.payloadSanitize : {},
        ),
      );
      honored.push('payloadSanitize');
    }
    if (options && options.upload && !globalAemeath.hasPlugin('upload')) {
      const localPersistence = requestedOfflinePersistence === false
        ? false
        : requestedOfflinePersistence !== undefined || offlinePersistenceConfig !== false;
      globalAemeath.use(
        new UploadPlugin({
          onUpload: options.upload,
          deliveryScope: options.deliveryScope,
          getPriority: options.getPriority,
          queue: options.queue,
          cache: { enabled: options.cache?.enabled !== false, ...options.cache },
          localPersistence,
          onDrop: options.onDrop,
        }),
      );
      // 这几项是随 UploadPlugin 一起生效的，不记进来就会在下面被反过来报成"已忽略"
      honored.push('upload', 'deliveryScope', 'getPriority', 'queue', 'cache', 'onDrop');
    }
    // 持久化随 UploadPlugin 默认开启；显式 false 必须也能撤销已经装上的实例。
    if (requestedOfflinePersistence === false) {
      offlinePersistenceConfig = false;
      const upload = globalAemeath.getPluginInstance('upload') as UploadPlugin | undefined;
      upload?.setCachePersistenceEnabled(false, true);
      const offline = globalAemeath.getPluginInstance('offline-persistence') as
        | OfflinePersistencePlugin
        | undefined;
      offline?.requestPurgeOnUninstall();
      globalAemeath.uninstall('offline-persistence');
      void purgeOfflinePersistenceStorage(globalAemeath.platform, offlinePersistenceOptions).catch(
        (error) => console.warn('[Aemeath] Failed to purge offline persistence:', error),
      );
      honored.push('offlinePersistence');
    } else {
      const alreadyInstalled = globalAemeath.hasPlugin('offline-persistence');
      if (requestedOfflinePersistence !== undefined) {
        if (alreadyInstalled) {
          // 不在运行中热切持久化库，否则旧 dbName/key 中的日志会失去补传出口。
          if (requestedOfflinePersistence === true) honored.push('offlinePersistence');
        } else {
          // 先应用本次显式配置，再判断是否安装，允许此前的 false 被一次 true
          // 调用立即撤销，而不是要求用户重复调用 init。
          offlinePersistenceConfig = requestedOfflinePersistence;
          if (typeof requestedOfflinePersistence === 'object') {
            offlinePersistenceOptions = requestedOfflinePersistence;
          }
          honored.push('offlinePersistence');
        }
      }
      if (
        offlinePersistenceConfig !== false &&
        globalAemeath.hasPlugin('upload') &&
        !globalAemeath.hasPlugin('offline-persistence')
      ) {
        globalAemeath.use(
          new OfflinePersistencePlugin(offlinePersistenceOptions),
        );
      }
      if (requestedOfflinePersistence !== undefined) {
        const upload = globalAemeath.getPluginInstance('upload') as UploadPlugin | undefined;
        upload?.setCachePersistenceEnabled(true);
      }
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

  // 只有参数校验通过后才提交模块级配置。失败的 init 不得影响下一次合法初始化。
  if (requestedOfflinePersistence !== undefined) {
    offlinePersistenceConfig = requestedOfflinePersistence;
    if (typeof requestedOfflinePersistence === 'object') {
      offlinePersistenceOptions = requestedOfflinePersistence;
    }
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
    const { enabled: _enabled, ...pluginOptions } =
      typeof ecOpt === 'object' ? ecOpt : {};
    logger.use(
      new ErrorCapturePlugin({
        ...pluginOptions,
        errorFilter: pluginOptions.errorFilter ?? options.errorFilter,
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
        deliveryScope: options.deliveryScope,
        getPriority: options.getPriority,
        queue: options.queue,
        cache: { enabled: options.cache?.enabled !== false, ...options.cache },
        localPersistence: offlinePersistenceConfig !== false,
        onDrop: options.onDrop,
      }),
    );

    // 断网续传（默认开启，可显式关闭；必须在 UploadPlugin 之后安装）
    if (offlinePersistenceConfig !== false) {
      logger.use(
        new OfflinePersistencePlugin(offlinePersistenceOptions),
      );
    } else {
      void purgeOfflinePersistenceStorage(logger.platform).catch((error) => {
        console.warn('[Aemeath] Failed to purge offline persistence:', error);
      });
    }
  } else if (options.offlinePersistence && typeof console !== 'undefined' && console.warn) {
    // 当前不安装，但保留给稍后 setUpload / 增量 init。
    console.warn(
      '[Aemeath] `offlinePersistence` was configured without an `upload` callback. '
        + 'The plugin is not installed yet; the option is retained and will be applied '
        + 'when upload is configured later.',
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
        ignoreErrorTypes: options.network?.ignoreErrorTypes,
        captureAborted: options.network?.captureAborted,
      }),
    );
  }

  // 载荷清洗（默认启用，位于采集插件之后、beforeSend 之前）
  if (options.payloadSanitize !== false) {
    logger.use(
      new PayloadSanitizePlugin(
        typeof options.payloadSanitize === 'object' ? options.payloadSanitize : {},
      ),
    );
  } else if (typeof console !== 'undefined' && console.warn) {
    console.warn(
      '[Aemeath] `payloadSanitize` is disabled. Data URLs, binary values and oversized text will '
        + 'be uploaded and cached as-is, which can break your upload endpoint, truncate database '
        + 'columns and exhaust storage quota. You are on your own here.',
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
 * 在运行时设置 / 替换 / 暂停 upload 回调
 *
 * 与 web 入口 `src/singleton/index.ts` 的 `setUpload` **语义对称**：`null` 会冻结
 * 队列与持久副本，绑定新回调后从原位置恢复。
 *
 * 用户文档：`docs/zh/9-before-send.md` / `docs/en/9-before-send.md` 末节
 * 「setUpload（运行时绑定上传）」。
 *
 * **与二次 `initAemeath` 的配合**：全局实例已存在且 `UploadPlugin` 已由 `setUpload`
 * 懒装载后，后续 `initAemeath({ upload, queue })` 的 `upload`/`queue` 等可能不会被
 * 采纳（见 `singleton` `setUpload` 与增量 init 的规则）；继续使用 `setUpload(...)`
 * 或 `resetAemeath()` 后完整初始化。
 *
 * @param callback 新的上传回调（传 `null` 暂停上报）
 *
 * @example
 * ```ts
 * App({
 *   onLaunch() {
 *     initAemeath({ platform: createMiniAppAdapter('wechat', wx) });
 *   },
 *   onLogin(loginRes) {
 *     setUpload(async (log) => {
 *       return new Promise((resolve) => {
 *         wx.request({
 *           url: 'https://api.example.com/logs',
 *           method: 'POST',
 *           header: { Authorization: `Bearer ${loginRes.token}` },
 *           data: log,
 *           success: (res) => resolve(classifyHttpUploadResponse(
 *             res.statusCode,
 *             res.header?.['Retry-After'] ?? res.header?.['retry-after']
 *           )),
 *           fail: (e) =>
 *             resolve({ success: false, shouldRetry: true, retryReason: 'network', error: e.errMsg }),
 *         });
 *       });
 *     });
 *   },
 * });
 * ```
 */
export function setUpload(
  callback: UploadCallback | null,
  options: UploadBindingOptions = {},
): void {
  if (!globalAemeath) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(
        '[Aemeath] setUpload() was called before initAemeath(). '
          + 'The callback is dropped. Call initAemeath() first.',
      );
    }
    return;
  }
  const existing = globalAemeath.getPluginInstance('upload') as UploadPlugin | undefined;
  if (existing) {
    existing.setOnUpload(callback, options);
    return;
  }
  const upload = new UploadPlugin({
    onUpload: callback ?? (async () => ({ success: false, shouldRetry: true })),
    deliveryScope: options.deliveryScope,
    localPersistence: offlinePersistenceConfig !== false,
    cache: { enabled: true },
  });
  if (callback === null) upload.setOnUpload(null);
  globalAemeath.use(upload);
  if (offlinePersistenceConfig !== false) {
    globalAemeath.use(
      new OfflinePersistencePlugin(offlinePersistenceOptions),
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
  offlinePersistenceConfig = undefined;
  offlinePersistenceOptions = {};
}

export type { AemeathInterface as Logger } from './types';
