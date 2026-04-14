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
  AemeathPlugin,
  LogListener,
  PluginMetadata,
  AemeathInterface,
  BundleConfig,
  ContextUpdater,
  ContextValue,
} from './types';

export { LogLevel as LogLevelEnum, ErrorCategory } from './types';

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
export { UploadPlugin } from './plugins/UploadPlugin';
export type {
  UploadPluginOptions,
  UploadResult,
  UploadCallback,
  PriorityCallback,
} from './plugins/UploadPlugin';

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
} from './singleton';

export type { AemeathInitOptions, RouteMatchConfig } from './singleton';
