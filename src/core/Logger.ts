/**
 * AemeathJs 核心（参考 Sentry 设计）
 */

import type {
  LogLevel,
  LogEntry,
  LogOptions,
  ErrorInfo,
  LogContext,
  BeforeLogResult,
  AemeathPlugin,
  LogListener,
  PluginMetadata,
  EventListeners,
  AemeathInterface,
  ContextUpdater,
  ContextValue,
} from '../types';
import { LogLevel as LogLevelEnum, ErrorCategory } from '../types';
import { RouteMatcher, type RouteMatchConfig } from '../utils/routeMatcher';
import { generateId } from '../utils/generateId';

interface AemeathOptions {
  /** 是否启用控制台输出 @default true */
  enableConsole?: boolean;
  context?: LogContext;
  environment?: string;
  release?: string;
  /** 是否启用调试模式（输出 AemeathJs 内部日志） */
  debug?: boolean;
  /** 全局路由匹配配置（对所有插件生效） */
  routeMatch?: RouteMatchConfig;
}

export class AemeathLogger implements AemeathInterface {
  private readonly plugins: Map<string, PluginMetadata> = new Map();
  private readonly eventListeners: EventListeners = new Map();
  private readonly logListeners: Set<LogListener> = new Set();
  private readonly pluginInstances: AemeathPlugin[] = [];
  private enableConsole: boolean;
  private staticContext: LogContext = {};
  private readonly dynamicContext: Map<string, ContextUpdater> = new Map();
  private readonly environment?: string;
  private readonly release?: string;
  private readonly debugEnabled: boolean;
  private readonly _routeMatcher: RouteMatcher;

  get routeMatcher(): RouteMatcher {
    return this._routeMatcher;
  }

  [key: string]: unknown;

  constructor(options?: AemeathOptions) {
    this.enableConsole = options?.enableConsole ?? true;
    this.environment = options?.environment;
    this.release = options?.release;
    this.debugEnabled = options?.debug ?? false;
    this._routeMatcher = new RouteMatcher({
      config: options?.routeMatch,
      debug: options?.debug,
      debugPrefix: '[Aemeath:Global]',
    });
    if (options?.context) {
      this.setContext(options.context);
    }
  }

  /** 内部调试日志 */
  private debugLog(...args: unknown[]): void {
    if (this.debugEnabled) {
      console.log('[Aemeath]', ...args);
    }
  }

  /** 内部警告日志 */
  private debugWarn(...args: unknown[]): void {
    if (this.debugEnabled) {
      console.warn('[Aemeath]', ...args);
    }
  }

  // ==================== 核心方法 ====================

  /**
   * 核心日志记录方法（统一入口）
   *
   * 注意：level 只影响控制台输出，不影响 listener（如上传插件）
   * 手动调用 logger.info/warn/error 始终会触发 listener
   */
  private log(
    level: LogLevel,
    message: string,
    options: LogOptions = {},
  ): void {
    // Phase 1: beforeLog 管道 — 遍历插件，允许拦截或修改参数
    let currentLevel = level;
    let currentMessage = message;
    let currentOptions = options;

    for (const plugin of this.pluginInstances) {
      if (!plugin.beforeLog) continue;
      try {
        const result: BeforeLogResult = plugin.beforeLog(
          currentLevel,
          currentMessage,
          currentOptions,
        );
        if (result === false) {
          return;
        }
        if (result && typeof result === 'object' && 'level' in result) {
          currentLevel = result.level;
          currentMessage = result.message;
          currentOptions = result.options;
        }
      } catch (err) {
        this.debugWarn(`Plugin "${plugin.name}" beforeLog error:`, err);
      }
    }

    // Phase 2: 构建 LogEntry
    const timestamp = Date.now();

    let context = this.buildContext({ level: currentLevel, message: currentMessage, timestamp });
    if (currentOptions.context) {
      context = { ...context, ...currentOptions.context };
    }

    let entry = this.createLogEntry(
      currentLevel,
      currentMessage,
      timestamp,
      currentOptions,
      context,
    );

    // Phase 3: afterLog 管道 — 遍历插件，允许修改或拦截 entry
    for (const plugin of this.pluginInstances) {
      if (!plugin.afterLog) continue;
      try {
        const result = plugin.afterLog(entry);
        if (result === false) {
          return;
        }
        if (result && typeof result === 'object' && 'level' in result) {
          entry = result;
        }
      } catch (err) {
        this.debugWarn(`Plugin "${plugin.name}" afterLog error:`, err);
      }
    }

    // Phase 4: 输出到控制台
    if (this.enableConsole) {
      this.outputToConsole(entry);
    }

    // Phase 5: 通知监听器（不受 level 过滤，始终触发）
    this.logListeners.forEach((listener) => {
      try {
        listener(entry);
      } catch (err) {
        this.debugWarn('Listener error:', err);
      }
    });
  }

  /**
   * 构建日志条目（统一数据结构）
   */
  private createLogEntry(
    level: LogLevel,
    message: string,
    timestamp: number,
    options: LogOptions,
    context: LogContext,
  ): LogEntry {
    const entry: LogEntry = {
      logId: generateId(),
      level,
      message,
      timestamp,
    };

    // 自动注入 environment 和 release（到 log 根级别，不是 context）
    if (this.environment) {
      entry.environment = this.environment;
    }
    if (this.release) {
      entry.release = this.release;
    }

    // 处理错误
    if (options.error) {
      const errorInfo = this.normalizeError(options.error);
      entry.error = errorInfo;

      // 自动识别错误类别（如果未提供）
      if (!options.tags?.errorCategory) {
        const category = this.identifyErrorCategory(errorInfo);
        entry.tags = {
          ...options.tags,
          errorCategory: category,
        };
      } else {
        entry.tags = options.tags;
      }
    } else if (options.tags) {
      entry.tags = options.tags;
    }

    // 添加上下文
    if (Object.keys(context).length > 0) {
      entry.context = context;
    }

    return entry;
  }

  /**
   * 标准化错误对象为 ErrorInfo
   */
  private normalizeError(error: Error | ErrorInfo): ErrorInfo {
    // 如果已经是 ErrorInfo 格式（有 type+value 且非原生 Error），直接返回
    if (!(error instanceof Error) && 'type' in error && 'value' in error) {
      return error as ErrorInfo;
    }

    // 转换 Error 对象
    const err = error as Error;
    const errorInfo: ErrorInfo = {
      type: err.name || 'Error',
      value: err.message || String(err),
    };

    // 添加堆栈
    if (err.stack) {
      errorInfo.stack = err.stack;
    }

    // 复制所有自定义属性
    Object.keys(err).forEach((key) => {
      if (!['message', 'name', 'stack'].includes(key)) {
        errorInfo[key] = (err as any)[key];
      }
    });

    // 复制不可枚举属性
    Object.getOwnPropertyNames(err).forEach((key) => {
      if (!['message', 'name', 'stack'].includes(key) && !(key in errorInfo)) {
        errorInfo[key] = (err as any)[key];
      }
    });

    return errorInfo;
  }

  /**
   * 自动识别错误类别
   */
  private identifyErrorCategory(errorInfo: ErrorInfo): ErrorCategory {
    // 早期错误
    if (errorInfo.earlyError === true) {
      return ErrorCategory.EARLY;
    }

    // 全局错误：优先通过 type 字段判断（ErrorCapturePlugin 显式设置）
    // 或者通过 source/lineno 判断（兼容旧逻辑）
    if (
      errorInfo.type === 'global' ||
      (errorInfo.source && typeof errorInfo.lineno === 'number')
    ) {
      return ErrorCategory.GLOBAL;
    }

    // Promise rejection
    if (
      errorInfo.type === 'unhandledrejection' ||
      errorInfo.reason !== undefined
    ) {
      return ErrorCategory.PROMISE;
    }

    // 资源错误
    if (errorInfo.tagName && errorInfo.src) {
      return ErrorCategory.RESOURCE;
    }

    // 默认：业务手动错误
    return ErrorCategory.MANUAL;
  }

  /**
   * 构建完整上下文（合并静态 + 动态）
   */
  private buildContext(partialEntry: Partial<LogEntry>): LogContext {
    let context: LogContext = { ...this.staticContext };

    // 计算动态上下文
    if (this.dynamicContext.size > 0) {
      this.dynamicContext.forEach((updater, key) => {
        try {
          const result = updater(context, partialEntry);
          if (result && typeof result === 'object') {
            context = { ...context, ...result };
          }
        } catch (err) {
          this.debugWarn(`Dynamic context "${key}" error:`, err);
        }
      });
    }

    return context;
  }

  /**
   * 输出到控制台
   */
  private outputToConsole(entry: LogEntry): void {
    const timestamp = new Date(entry.timestamp).toISOString();
    const prefix = `[${timestamp}] [${entry.level.toUpperCase()}]`;

    const consoleMethod = ({
      [LogLevelEnum.DEBUG]: console.debug,
      [LogLevelEnum.INFO]: console.info,
      [LogLevelEnum.TRACK]: console.info,
      [LogLevelEnum.WARN]: console.warn,
      [LogLevelEnum.ERROR]: console.error,
    } as Record<string, typeof console.log>)[entry.level] ?? console.log;

    consoleMethod(prefix, entry.message);
    if (entry.error) {
      consoleMethod('Error:', entry.error);
    }
    if (entry.tags) {
      consoleMethod('Tags:', entry.tags);
    }
  }

  // ==================== 公开 API ====================

  public debug(message: string, options?: LogOptions): void {
    this.log(LogLevelEnum.DEBUG, message, options);
  }

  public info(message: string, options?: LogOptions): void {
    this.log(LogLevelEnum.INFO, message, options);
  }

  public track(message: string, options?: LogOptions): void {
    this.log(LogLevelEnum.TRACK, message, options);
  }

  public warn(message: string, options?: LogOptions): void {
    this.log(LogLevelEnum.WARN, message, options);
  }

  public error(message: string, options?: LogOptions): void {
    this.log(LogLevelEnum.ERROR, message, options);
  }

  // ==================== 事件系统 ====================

  public on(event: string, listener: (...args: unknown[]) => void): void {
    if (event === 'log') {
      this.logListeners.add(listener as LogListener);
      return;
    }
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(listener);
  }

  public off(event: string, listener: (...args: unknown[]) => void): void {
    if (event === 'log') {
      this.logListeners.delete(listener as LogListener);
      return;
    }
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.eventListeners.delete(event);
      }
    }
  }

  public emit(event: string, ...args: unknown[]): void {
    const listeners = this.eventListeners.get(event);
    if (!listeners) return;

    listeners.forEach((listener) => {
      try {
        listener(...args);
      } catch (err) {
        this.debugWarn(`Error in event listener for "${event}":`, err);
      }
    });
  }

  // ==================== 插件系统 ====================

  public use(plugin: AemeathPlugin, options?: unknown): this {
    if (this.plugins.has(plugin.name)) {
      this.debugWarn(`Plugin "${plugin.name}" is already installed`);
      return this;
    }

    if (plugin.dependencies) {
      for (const dep of plugin.dependencies) {
        if (!this.plugins.has(dep)) {
          throw new Error(`[Aemeath] Plugin "${plugin.name}" requires "${dep}"`);
        }
      }
    }

    try {
      plugin.install(this, options);
      this.pluginInstances.push(plugin);
      this.plugins.set(plugin.name, {
        name: plugin.name,
        version: plugin.version,
        enabled: true,
        installedAt: Date.now(),
        options,
      });
      this.debugLog(`Plugin "${plugin.name}" installed`);
    } catch (err) {
      this.debugWarn(`Failed to install plugin "${plugin.name}":`, err);
      throw err;
    }

    return this;
  }

  public hasPlugin(name: string): boolean {
    return this.plugins.has(name);
  }

  public uninstall(name: string): boolean {
    const metadata = this.plugins.get(name);
    if (!metadata) {
      this.debugWarn(`Plugin "${name}" is not installed`);
      return false;
    }

    const idx = this.pluginInstances.findIndex((p) => p.name === name);
    if (idx !== -1) {
      const plugin = this.pluginInstances[idx]!;
      plugin.uninstall?.(this);
      this.pluginInstances.splice(idx, 1);
    }

    this.emit('plugin:uninstall', name);
    this.plugins.delete(name);
    this.debugLog(`Plugin "${name}" uninstalled`);
    return true;
  }

  public getPlugins(): PluginMetadata[] {
    return Array.from(this.plugins.values());
  }

  // ==================== 配置管理 ====================

  public setConsoleEnabled(enabled: boolean): void {
    this.enableConsole = enabled;
  }

  // ==================== 上下文管理 ====================

  public setContext(context: ContextValue): void {
    if (typeof context === 'function') {
      this.dynamicContext.clear();
      this.dynamicContext.set('__root__', context as ContextUpdater);
    } else {
      this.staticContext = { ...context };
      this.dynamicContext.delete('__root__');
    }
  }

  public updateContext(key: string, value: unknown | ContextUpdater): void {
    if (typeof value === 'function') {
      this.dynamicContext.set(key, value as ContextUpdater);
      delete this.staticContext[key];
    } else {
      this.staticContext[key] = value;
      this.dynamicContext.delete(key);
    }
  }

  public getContext(): Record<string, unknown> {
    return { ...this.staticContext };
  }

  public clearContext(keys?: string[]): void {
    if (!keys || keys.length === 0) {
      this.staticContext = {};
      this.dynamicContext.clear();
    } else {
      for (const key of keys) {
        delete this.staticContext[key];
        this.dynamicContext.delete(key);
      }
    }
  }

  public destroy(): void {
    const pluginNames = Array.from(this.plugins.keys());
    for (const name of pluginNames) {
      this.uninstall(name);
    }
    this.logListeners.clear();
    this.eventListeners.clear();
    this.pluginInstances.length = 0;
    this.staticContext = {};
    this.dynamicContext.clear();
  }
}

