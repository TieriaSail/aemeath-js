/**
 * AemeathJs 模块化日志系统 - 类型定义（参考 Sentry）
 */

/**
 * 日志级别
 */
export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

/**
 * 错误类别（用于 tags.errorCategory）
 */
export enum ErrorCategory {
  /** 全局 JS 错误 */
  GLOBAL = 'global',
  /** Promise rejection */
  PROMISE = 'promise',
  /** 资源加载错误 */
  RESOURCE = 'resource',
  /** 早期错误 */
  EARLY = 'early',
  /** 业务手动错误 */
  MANUAL = 'manual',
}

/**
 * 堆栈帧（参考 Sentry）
 */
export interface StackFrame {
  /** 文件名 */
  filename: string;
  /** 行号 */
  lineno: number;
  /** 列号 */
  colno: number;
  /** 函数名 */
  function?: string;
  /** 源代码片段 */
  source?: string;
}

/**
 * 错误信息（参考 Sentry 的 exception）
 */
export interface ErrorInfo {
  /** 错误类型（如 TypeError, BusinessError） */
  type: string;
  /** 错误消息 */
  value: string;
  /** 结构化堆栈信息 */
  stacktrace?: {
    frames: StackFrame[];
  };
  /** 原始堆栈字符串 */
  stack?: string;
  /** 其他自定义字段 */
  [key: string]: unknown;
}

/**
 * 日志标签（用于分类和筛选）
 */
export interface LogTags {
  /** 错误类别（自动识别或手动指定）*/
  errorCategory?: ErrorCategory | string;
  /** 组件名 */
  component?: string;
  /** 操作/动作 */
  action?: string;
  /** 其他自定义标签 */
  [key: string]: string | number | boolean | undefined;
}

/**
 * 日志上下文（详细信息）
 */
export interface LogContext {
  /** 用户信息 */
  user?: {
    id?: string;
    name?: string;
    email?: string;
    [key: string]: unknown;
  };
  /** 设备信息 */
  device?: {
    platform: string;
    userAgent: string;
    screenWidth: number;
    screenHeight: number;
    [key: string]: unknown;
  };
  /** 应用信息 */
  app?: {
    name: string;
    version: string;
    environment: string;
    release?: string;
    [key: string]: unknown;
  };
  /** 其他自定义上下文 */
  [key: string]: unknown;
}

/**
 * 日志条目（简化版，统一结构）
 */
export interface LogEntry {
  /** 日志级别 */
  level: LogLevel;
  /** 日志消息 */
  message: string;
  /** 时间戳 */
  timestamp: number;
  /** 环境标识（系统自动注入）*/
  environment?: string;
  /** 版本号（系统自动注入）*/
  release?: string;
  /** 错误信息（仅 error 级别） */
  error?: ErrorInfo;
  /** 标签（用于分类筛选）*/
  tags?: LogTags;
  /** 上下文（详细信息，用户配置）*/
  context?: LogContext;
}

/**
 * 日志选项（用户调用时传入）
 */
export interface LogOptions {
  /** 错误对象（可以是 Error 对象或 ErrorInfo） */
  error?: Error | ErrorInfo;
  /** 标签 */
  tags?: LogTags;
  /** 上下文 */
  context?: LogContext;
}

/**
 * beforeLog hook 的返回值
 *
 * - false：拦截日志（不进入管道）
 * - 对象：修改日志参数后继续
 * - true / undefined / void：放行
 */
export type BeforeLogResult =
  | void
  | boolean
  | { level: LogLevel; message: string; options: LogOptions };

/**
 * afterLog hook 的返回值
 *
 * - false：拦截日志（不继续传递给 listener）
 * - LogEntry：使用修改后的 entry 继续
 * - void：原样继续
 */
export type AfterLogResult = false | LogEntry | void;

/**
 * 插件接口
 *
 * 插件通过可选的 beforeLog / afterLog hook 参与日志管道：
 * - beforeLog：日志创建前调用，可拦截或修改参数
 * - afterLog：LogEntry 构建后、通知 listener 前调用，可拦截或修改 entry
 */
export interface AemeathPlugin {
  /** 插件名称（必须唯一） */
  name: string;

  /** 插件版本 */
  version?: string;

  /** 安装插件 */
  install(logger: AemeathInterface, options?: unknown): void;

  /** 卸载插件（可选） */
  uninstall?(logger: AemeathInterface): void;

  /** 插件依赖（可选） */
  dependencies?: string[];

  /** 插件描述（可选） */
  description?: string;

  /**
   * 日志前置拦截（在 LogEntry 创建之前调用）
   *
   * - 返回 false → 拦截该日志，不进入管道
   * - 返回 { level, message, options } → 使用修改后的参数继续
   * - 返回 true / undefined / void → 原样放行
   */
  beforeLog?(
    level: LogLevel,
    message: string,
    options: LogOptions,
  ): BeforeLogResult;

  /**
   * 日志后置处理（在 LogEntry 构建完成后、通知 listener 之前调用）
   *
   * - 返回 false → 拦截（不传递给 listener）
   * - 返回 LogEntry → 使用修改后的 entry 继续
   * - 返回 void → 原样继续
   */
  afterLog?(entry: LogEntry): AfterLogResult;
}

/**
 * 日志监听器
 */
export type LogListener = (entry: LogEntry) => void;

/**
 * 事件监听器 Map
 */
export type EventListeners = Map<string, Set<(...args: unknown[]) => void>>;

/**
 * 插件元数据
 */
export interface PluginMetadata {
  name: string;
  version?: string;
  enabled: boolean;
  installedAt: number;
  options?: unknown;
}

/**
 * 动态上下文计算函数
 */
export type ContextUpdater = (
  currentContext: Readonly<Record<string, unknown>>,
  entry: Partial<LogEntry>,
) => Record<string, unknown>;

/**
 * 上下文值
 */
export type ContextValue = Record<string, unknown> | ContextUpdater;

/**
 * AemeathJs 接口（供插件使用）
 */
export interface AemeathInterface {
  // 基础日志方法
  debug(message: string, options?: LogOptions): void;
  info(message: string, options?: LogOptions): void;
  warn(message: string, options?: LogOptions): void;
  error(message: string, options?: LogOptions): void;

  // 事件系统
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;

  // 插件管理
  use(plugin: AemeathPlugin, options?: unknown): this;
  hasPlugin(name: string): boolean;
  uninstall(name: string): boolean;
  getPlugins(): PluginMetadata[];

  // 配置
  setConsoleEnabled(enabled: boolean): void;

  // 全局上下文
  setContext(context: ContextValue): void;
  updateContext(key: string, value: unknown | ContextUpdater): void;
  getContext(): Record<string, unknown>;
  clearContext(keys?: string[]): void;

  // 生命周期
  destroy(): void;

  // 插件可能添加的动态属性
  [key: string]: unknown;
}

/**
 * Bundle 配置
 */
export interface BundleConfig {
  /** 上报端点 */
  endpoint?: string;

  /** 版本号 */
  release?: string;

  /** 环境 */
  environment?: string;

  /** 自定义配置 */
  [key: string]: unknown;
}
