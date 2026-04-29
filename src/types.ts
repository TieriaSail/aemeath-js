/**
 * AemeathJs 模块化日志系统 - 类型定义（参考 Sentry）
 */

/**
 * 日志级别
 */
export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  /** 埋点追踪（逻辑等同 info，用于业务层面区分） */
  TRACK = 'track',
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
  /** 日志唯一标识（Logger 核心自动生成，同一条日志无论上报多少次 logId 不变） */
  logId: string;
  /** 上报请求标识（UploadPlugin 每次上报尝试自动生成，用于消费端幂等去重） */
  requestId?: string;
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
 * `beforeSend` 钩子函数：日志管道末端的最后一道关卡
 *
 * 当某条日志即将被 listener 消费（包括 UploadPlugin 上报）前，会调用本函数。
 * 用户可以：
 *
 * - **修改字段**：返回一个新的 / 修改后的 `LogEntry`
 *   ```ts
 *   beforeSend: (entry) => ({
 *     ...entry,
 *     message: redact(entry.message),
 *   })
 *   ```
 *
 * - **完全丢弃**：返回 `null`（该条日志不会再传给任何 listener，**也不会上报**）
 *   ```ts
 *   beforeSend: (entry) => entry.tags?.errorCategory === 'noise' ? null : entry
 *   ```
 *
 * - **原样放行**：返回 `entry` 本身、`undefined` 或不返回
 *
 * **重要规则：**
 * 1. 必须是**同步**函数。`async` 会返回 Promise，无法在此管道中等待，将被忽略并 `console.warn`。
 * 2. `beforeSend` 是**全链路**钩子，对 `error` / `info` / `track` / `warn` / `debug`
 *    以及所有 `NetworkPlugin` 自动捕获的日志**全部生效**。
 * 3. `beforeSend` 在所有插件 `afterLog` 之后、listener 之前执行
 *    （由 `BeforeSendPlugin` 以 `priority: PluginPriority.LATEST` 注入）。
 * 4. **本函数本身的异常会被静默吞掉**（fail-safe），原 entry 会按未修改状态继续传递。
 *    这是为了避免脱敏代码 bug 影响线上日志通道。
 * 5. 不要在本函数内调用 `logger.error/info/...` 否则会导致无限递归
 *    （`SafeGuardPlugin` 会拦截，但仍应避免）。
 *
 * @see docs/{zh,en}/9-before-send.md
 */
export type BeforeSendHook = (entry: LogEntry) => LogEntry | null | undefined | void;

/**
 * 预设的插件执行优先级常量
 *
 * 数值小的先执行；相同优先级按 use() 调用顺序执行（稳定排序）。
 *
 * 详见 docs/{zh,en}/8-plugin-ordering.md
 */
export const PluginPriority = {
  /** 最先执行：必须最早 wrap 浏览器 API 的插件（如 BrowserApiErrorsPlugin） */
  EARLIEST: -1000,
  /** 较早执行：beforeLog 拦截类、错误捕获类（如 SafeGuardPlugin / ErrorCapturePlugin） */
  EARLY: -100,
  /** 默认：大多数功能类插件 */
  NORMAL: 0,
  /** 较晚执行：消费类、上传类（如 UploadPlugin） */
  LATE: 100,
  /** 最后执行：用户最终拦截类（如 BeforeSendPlugin） */
  LATEST: 1000,
} as const;

/**
 * 插件执行优先级类型
 */
export type PluginPriorityValue = number;

/**
 * 插件接口
 *
 * 插件通过可选的 beforeLog / afterLog hook 参与日志管道：
 * - beforeLog：日志创建前调用，可拦截或修改参数
 * - afterLog：LogEntry 构建后、通知 listener 前调用，可拦截或修改 entry
 *
 * 插件之间的执行顺序由 priority 字段决定（详见 priority 字段说明）。
 */
export interface AemeathPlugin {
  /** 插件名称（必须唯一） */
  name: string;

  /** 插件版本 */
  version?: string;

  /**
   * 插件执行优先级（影响 install / beforeLog / afterLog / uninstall 顺序）
   *
   * - 数值小的先执行
   * - 默认 0（即 PluginPriority.NORMAL）
   * - 相同优先级按 use() 调用顺序执行（稳定排序）
   * - 未声明 priority 的插件 = 0（与旧版本行为完全一致，向下兼容）
   *
   * 推荐使用 PluginPriority 常量而非魔法数字。
   *
   * @see PluginPriority
   * @see docs/{zh,en}/8-plugin-ordering.md
   */
  priority?: number;

  /** 安装插件 */
  install(logger: AemeathInterface, options?: unknown): void;

  /** 卸载插件（可选） */
  uninstall?(logger: AemeathInterface): void;

  /** 插件依赖（可选；只检查存在性，不影响顺序——顺序由 priority 决定） */
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
  /** 实际生效的执行优先级（未声明时为 0） */
  priority: number;
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
  track(message: string, options?: LogOptions): void;
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
  /**
   * 按 name 查找已安装的插件实例
   *
   * 主要用于运行时获取插件以调用其特有方法（如 BeforeSendPlugin.setHook）。
   * 普通用户场景请优先使用 hasPlugin / getPlugins。
   */
  getPluginInstance(name: string): AemeathPlugin | undefined;

  // 配置
  setConsoleEnabled(enabled: boolean): void;

  // 全局上下文
  setContext(context: ContextValue): void;
  updateContext(key: string, value: unknown | ContextUpdater): void;
  getContext(): Record<string, unknown>;
  clearContext(keys?: string[]): void;

  // 平台适配器（构造时自动注入，一定存在）
  readonly platform: import('./platform/types').PlatformAdapter;

  // 全局路由匹配器（供插件获取以组合自身路由规则）
  readonly routeMatcher: import('./utils/routeMatcher').RouteMatcher;

  // 插件扩展属性容器
  readonly extensions: Record<string, unknown>;

  // 生命周期
  destroy(): void;
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
