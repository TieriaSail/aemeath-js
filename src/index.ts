/**
 * AemeathJs - 模块化日志系统
 *
 * 核心理念：
 * 1. 最小核心：只提供基础功能，体积 ~2KB
 * 2. 插件化：所有高级功能都是插件
 * 3. 按需引入：用户只加载需要的功能
 * 4. 零依赖：插件之间不相互依赖
 * 5. 简洁数据结构：参考 Sentry 设计，使用 tags + context
 */

// ==================== 核心 ====================
export { AemeathLogger } from './core/Logger';

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
  AemeathEventMap,
  BundleConfig,
  ContextUpdater,
  ContextValue,
  DeliveryState,
  DeliveryStatus,
} from './types';

export { LogLevel as LogLevelEnum, ErrorCategory, PluginPriority } from './types';

// ==================== Level 1 插件 ====================
export { BrowserApiErrorsPlugin } from './plugins/BrowserApiErrorsPlugin';
export type { BrowserApiErrorsPluginOptions } from './plugins/BrowserApiErrorsPlugin';

export { ErrorCapturePlugin } from './plugins/ErrorCapturePlugin';
export type { ErrorCapturePluginOptions } from './plugins/ErrorCapturePlugin';

export { EarlyErrorCapturePlugin } from './plugins/EarlyErrorCapturePlugin';
export type {
  EarlyErrorCaptureOptions,
  EarlyErrorScriptOptions,
  EarlyError,
} from './plugins/EarlyErrorCapturePlugin';

// ==================== Upload Plugin（推荐） ====================
export {
  UploadPlugin,
  parseRetryAfter,
  classifyHttpUploadResponse,
} from './plugins/UploadPlugin';
export type {
  UploadPluginOptions,
  UploadResult,
  UploadCallback,
  UploadBindingOptions,
  PriorityCallback,
  UploadRetryReason,
  UploadDropReason,
  UploadDropInfo,
  UploadDropCallback,
  UploadQueueStatus,
  UploadQueueStatusItem,
} from './plugins/UploadPlugin';

// ==================== 载荷清洗（默认启用） ====================
export { PayloadSanitizePlugin } from './plugins/PayloadSanitizePlugin';
export type {
  PayloadSanitizePluginOptions,
  PayloadSanitizeStats,
} from './plugins/PayloadSanitizePlugin';
export { sanitizeLogEntry, utf8Bytes, DEFAULT_MAX_BYTES } from './utils/payloadSanitize';
export type {
  PayloadSanitizeOptions,
  PayloadSanitizeResult,
  PayloadStrip,
} from './utils/payloadSanitize';

// ==================== 断网续传（标准入口随 upload 默认启用，可显式关闭） ====================
export { OfflinePersistencePlugin } from './plugins/OfflinePersistencePlugin';
export type {
  OfflinePersistencePluginOptions,
  OfflinePersistenceStatus,
} from './plugins/OfflinePersistencePlugin';
export type {
  OfflineBackend,
  OfflineRecord,
  OfflineRecordMeta,
  OfflineStore,
} from './plugins/offline/OfflineStore';

// ==================== 可选插件 ====================
export { PerformancePlugin } from './plugins/PerformancePlugin';
export type { PerformancePluginOptions, WebVitalsOptions } from './plugins/PerformancePlugin';

export { SafeGuardPlugin } from './plugins/SafeGuardPlugin';
export type {
  SafeGuardPluginOptions,
  SafeGuardMode,
  SafeGuardHealth,
} from './plugins/SafeGuardPlugin';

export { NetworkPlugin } from './plugins/NetworkPlugin';
export type {
  NetworkPluginOptions,
  NetworkLog,
  NetworkLogType,
} from './plugins/NetworkPlugin';

// ==================== BeforeSend 钩子（隐私脱敏 / 全链路过滤） ====================
export { BeforeSendPlugin } from './plugins/BeforeSendPlugin';
export type { BeforeSendPluginOptions } from './plugins/BeforeSendPlugin';

// ==================== 平台适配器 ====================
export { createBrowserAdapter } from './platform/browser';
export { createMiniAppAdapter } from './platform/miniapp';
export type { MiniAppAPI } from './platform/miniapp';
export { createNoopAdapter } from './platform/noop';
export { detectPlatform, setPlatform, resetPlatform } from './platform/detect';
export type {
  PlatformAdapter,
  PlatformType,
  MiniAppVendor,
  GlobalErrorInfo,
  UnhandledRejectionInfo,
} from './platform/types';

// ==================== Instrumentation 层 ====================
export type {
  NetworkEvent,
  NetworkErrorType,
  NetworkErrorDetail,
  ResponseBodyCaptureContext,
  InstrumentOptions,
  NetworkHandler,
  Unsubscribe as NetworkUnsubscribe,
} from './instrumentation/types';
export { instrumentFetch } from './instrumentation/fetch';
export { instrumentXHR } from './instrumentation/xhr';
export { instrumentMiniAppRequest } from './instrumentation/miniapp-request';
export type { MiniAppRequestAPI } from './instrumentation/miniapp-request';
/**
 * 在忽略窗口内跑一段代码，期间发起的网络请求不会被 NetworkPlugin 记录。
 * UploadPlugin 已自动包住 `onUpload`；只有你自己绕开 UploadPlugin 做上报时才需要。
 */
export {
  beginIgnoreNetworkCapture,
  endIgnoreNetworkCapture,
  runWithoutNetworkCapture,
  shouldIgnoreNetworkCapture,
} from './utils/ignoreNetworkCapture';
/**
 * Symbol marker for synthetic error stacks created by platform adapters.
 * Exported for custom adapter authors who need to mark errors consistently.
 */
export { SYNTHETIC_STACK } from './platform/constants';

// ==================== 构建插件（按需导入）====================
// 使用方式：
// import { ameathEarlyErrorPlugin } from 'aemeath-js/build-plugins/rsbuild';
// import { AemeathEarlyErrorWebpackPlugin } from 'aemeath-js/build-plugins/webpack';
// import { ameathEarlyErrorPlugin } from 'aemeath-js/build-plugins/vite';

// ==================== Source Map 解析 ====================
export { SourceMapParser, createParser } from './parser';

export type {
  ParsedStackFrame,
  ParseResult,
  RawSourceMap,
  SourceMapParserConfig,
} from './parser';

// ==================== 单例模式（推荐） ====================
export {
  initAemeath,
  getAemeath,
  resetAemeath,
  isAemeathInitialized,
  setBeforeSend,
  setUpload,
} from './singleton';

export type { AemeathInitOptions, RouteMatchConfig } from './singleton';
