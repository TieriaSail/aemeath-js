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
  AfterLogResult,
  AemeathPlugin,
  LogListener,
  PluginMetadata,
  EventListeners,
  AemeathInterface,
  AemeathEventMap,
  ContextUpdater,
  ContextValue,
  DeliveryStatus,
} from '../types';
import type { PlatformAdapter } from '../platform/types';
import type { UploadQueueStatus } from '../plugins/UploadPlugin';
import type { OfflinePersistenceStatus } from '../plugins/OfflinePersistencePlugin';
import { getSdkSplitId } from '../utils/splitIdentity';

/**
 * 一条日志经 afterLog 扇出后最多保留多少条
 *
 * 扇出是相乘的，多个插件各返回 N 条就是 N^k。上界既保护宿主页面（监听器回调、
 * 控制台输出），也保护后端（每条分片都是一次上传）。
 */
const MAX_FANOUT_ENTRIES = 64;

const DELIVERY_EVENT_ALIASES: Readonly<Record<string, string>> = {
  'upload:enqueued': 'delivery:queued',
  'upload:attempt': 'delivery:attempt',
  'upload:retry-scheduled': 'delivery:retry-scheduled',
  'upload:parked': 'delivery:parked',
  'upload:unparked': 'delivery:unparked',
  'upload:success': 'delivery:delivered',
  'upload:drop': 'delivery:dropped',
  'upload:paused': 'delivery:paused',
  'upload:resumed': 'delivery:resumed',
  'upload:offline-unavailable': 'delivery:persistence-unavailable',
};

/**
 * 扇出截断时保持 splitId 分组完整：放不下的整组丢弃，绝不留下残片。
 */
function truncateFanoutPreservingSplits(entries: LogEntry[], max: number): LogEntry[] {
  if (entries.length <= max) return entries;

  // splitId 是全局组身份，不是“相邻元素游程”。插件完全可能交错返回
  // A1/B1/A2/B2；按相邻片段截断会把每一片都误当完整组。先建立原子单元，
  // 同时保留各组第一次出现的相对顺序，再做容量裁剪。
  const units: LogEntry[][] = [];
  const splitUnits = new Map<string, LogEntry[]>();
  for (const entry of entries) {
    const splitId = getSdkSplitId(entry);
    if (splitId === undefined) {
      units.push([entry]);
      continue;
    }
    let unit = splitUnits.get(splitId);
    if (!unit) {
      unit = [];
      splitUnits.set(splitId, unit);
      units.push(unit);
    }
    unit.push(entry);
  }

  const result: LogEntry[] = [];
  for (const unit of units) {
    if (result.length + unit.length > max) {
      // 单组本身就超过上限：整组放行，避免"本意是拆分保留"却静默丢光。
      // 多组场景下放不下的后续组整组丢弃，绝不留下残片。
      if (result.length === 0) {
        return unit;
      }
      break;
    }
    result.push(...unit);
  }
  return result;
}

import { detectPlatform } from '../platform/detect';
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
  /** 平台适配器（不传则自动检测） */
  platform?: PlatformAdapter;
  /** 全局路由匹配配置（对所有插件生效） */
  routeMatch?: RouteMatchConfig;
}

export class AemeathLogger implements AemeathInterface {
  private readonly plugins: Map<string, PluginMetadata> = new Map();
  private readonly eventListeners: EventListeners = new Map();
  private readonly logListeners: Set<LogListener> = new Set();
  private readonly pluginInstances: AemeathPlugin[] = [];
  private enableConsole: boolean;
  private destroyed = false;
  private staticContext: LogContext = {};
  private readonly dynamicContext: Map<string, ContextUpdater> = new Map();
  /** 已经警告过的异步 dynamic-context key（避免每条日志都刷屏） */
  private readonly asyncContextWarned: Set<string> = new Set();
  private fanoutWarned = false;
  private readonly environment?: string;
  private readonly release?: string;
  private readonly debugEnabled: boolean;

  public readonly platform: PlatformAdapter;

  public readonly extensions: Record<string, unknown> = {};

  private readonly _routeMatcher: RouteMatcher;

  /** Global route matcher shared by all plugins */
  get routeMatcher(): RouteMatcher {
    return this._routeMatcher;
  }

  constructor(options?: AemeathOptions) {
    this.enableConsole = options?.enableConsole ?? true;
    this.environment = options?.environment;
    this.release = options?.release;
    this.debugEnabled = options?.debug ?? false;
    this.platform = options?.platform ?? detectPlatform();
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
    if (this.destroyed) return;

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
        if (
          result && typeof result === 'object' &&
          'level' in result && 'message' in result && 'options' in result
        ) {
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

    // Phase 3: afterLog 管道 — 遍历插件，允许修改、拦截或扇出 entry
    //
    // 绝大多数情况下 entries 始终只有一条；返回数组的插件（如 PayloadSanitizePlugin
    // 把超限日志按字段拆成多条）会让后续插件对每个分片各执行一次。
    let entries: LogEntry[] = [entry];

    for (const plugin of this.pluginInstances) {
      if (!plugin.afterLog) continue;

      const next: LogEntry[] = [];
      // 本轮被拦掉的分片所属的分组
      let suppressedSplitIds: Set<string> | null = null;
      for (const current of entries) {
        let result: AfterLogResult;
        try {
          result = plugin.afterLog(current);
        } catch (err) {
          this.debugWarn(`Plugin "${plugin.name}" afterLog error:`, err);
          next.push(current);
          continue;
        }

        if (result === false) {
          // 拦掉的是某个分片 → 记下分组，稍后把同组其余分片一起拦掉。
          //
          // 用户写 beforeSend 时想的是"这条日志不要发"，可拆分之后钩子是按分片
          // 逐个调用的：只拦住带敏感字段的那一片，另外两片照发不误，
          // 既漏了数据又在后端留下拼不回来的碎片。
          const splitId = getSdkSplitId(current);
          if (splitId !== undefined) {
            (suppressedSplitIds ??= new Set()).add(splitId);
          }
          continue;
        }

        if (Array.isArray(result)) {
          let kept = 0;
          for (const item of result) {
            if (this.isValidEntry(item)) {
              next.push(item);
              kept++;
            } else {
              this.warnInvalidAfterLog(plugin.name);
            }
          }
          // 插件想拆分却拆出了一堆坏数据：保住原件，别让日志凭空消失。
          // （返回空数组是明确的"丢弃"意图，不在此列。）
          if (kept === 0 && result.length > 0) next.push(current);
          continue;
        }

        if (result && typeof result === 'object') {
          if (this.isValidEntry(result)) {
            next.push(result);
          } else {
            this.warnInvalidAfterLog(plugin.name);
            next.push(current);
          }
          continue;
        }

        next.push(current);
      }

      entries = next;

      // 分组里只要有一片被拦下，整组都不发：半组分片对后端毫无意义，
      // 而且用户的本意本来就是"这条日志不要发"
      if (suppressedSplitIds) {
        const kept = entries.filter(
          (it) => !suppressedSplitIds.has(getSdkSplitId(it) ?? ''),
        );
        if (kept.length !== entries.length) {
          this.debugWarn(
            `Plugin "${plugin.name}" suppressed part of a split log; dropping the remaining ${entries.length - kept.length} chunk(s) so the backend never sees an unassemblable fragment.`,
          );
        }
        entries = kept;
      }

      if (entries.length === 0) return;

      // 扇出是会**相乘**的：每个插件都返回 N 条，k 个插件就是 N^k。
      // 一次 logger.error() 变成几百条日志意味着几百次监听器回调、几百个
      // 上传请求，足以把宿主页面和后端一起拖垮。超限就截断并告警。
      // 截断必须保完整 splitId 组，否则后端会收到拼不回来的残片。
      if (entries.length > MAX_FANOUT_ENTRIES) {
        const kept = truncateFanoutPreservingSplits(entries, MAX_FANOUT_ENTRIES);
        this.warnFanoutCapped(plugin.name, entries.length, kept.length);
        entries = kept;
      }
    }

    const listenerSnapshot = Array.from(this.logListeners);

    for (const finalEntry of entries) {
      // Phase 4: 输出到控制台
      if (this.enableConsole) {
        this.outputToConsole(finalEntry);
      }

      // Phase 5: 通知监听器（不受 level 过滤，始终触发）
      for (const listener of listenerSnapshot) {
        try {
          listener(finalEntry);
        } catch (err) {
          this.debugWarn('Listener error:', err);
        }
      }
    }
  }

  private isValidEntry(value: unknown): value is LogEntry {
    const candidate = value as LogEntry | null;
    return (
      candidate != null &&
      typeof candidate === 'object' &&
      typeof candidate.logId === 'string' &&
      typeof candidate.level === 'string'
    );
  }

  private warnFanoutCapped(pluginName: string, produced: number, kept: number): void {
    if (this.fanoutWarned) return;
    this.fanoutWarned = true;
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(
        `[Aemeath] afterLog fan-out from plugin "${pluginName}" produced ${produced} entries `
          + `for a single log; kept ${kept} (cap ${MAX_FANOUT_ENTRIES}, split groups kept intact). `
          + 'This usually means a payload is far above the size budget. (This warning is shown once.)',
      );
    }
  }

  private warnInvalidAfterLog(pluginName: string): void {
    // 与 beforeSend 非法返回值一致：始终 warn，避免生产环境静默坏数据
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(
        `[Aemeath] Plugin "${pluginName}" afterLog returned an object without valid logId & level; `
          + 'ignored. Return false to drop the log, void/undefined to keep the previous entry.',
      );
    }
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
    if (error == null || typeof error !== 'object') {
      return { type: 'Error', value: String(error) };
    }

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

    const skip = new Set(['message', 'name', 'stack']);
    for (const key of Object.getOwnPropertyNames(err)) {
      if (!skip.has(key)) {
        errorInfo[key] = (err as unknown as Record<string, unknown>)[key];
      }
    }

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
            // 拒绝异步 updater：thenable 会作为对象被 spread 进去，污染 context
            const maybeThenable = result as { then?: unknown };
            if (typeof maybeThenable.then === 'function') {
              if (!this.asyncContextWarned.has(key)
                  && typeof console !== 'undefined' && console.warn) {
                this.asyncContextWarned.add(key);
                console.warn(
                  `[Aemeath] Dynamic context updater "${key}" returned a Promise / thenable; `
                    + 'updaters must be synchronous. The async result was ignored. '
                    + '(This warning is shown once per key.)',
                );
              }
            } else {
              context = { ...context, ...result };
            }
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

  public on<K extends keyof AemeathEventMap>(
    event: K,
    listener: (payload: AemeathEventMap[K]) => void,
  ): void;
  public on(event: string, listener: (...args: unknown[]) => void): void;
  public on(event: string, listener: (...args: never[]) => void): void {
    if (event === 'log') {
      this.logListeners.add(listener as LogListener);
      return;
    }
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(listener as (...args: unknown[]) => void);
  }

  public off<K extends keyof AemeathEventMap>(
    event: K,
    listener: (payload: AemeathEventMap[K]) => void,
  ): void;
  public off(event: string, listener: (...args: unknown[]) => void): void;
  public off(event: string, listener: (...args: never[]) => void): void {
    if (event === 'log') {
      this.logListeners.delete(listener as LogListener);
      return;
    }
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.delete(listener as (...args: unknown[]) => void);
      if (listeners.size === 0) {
        this.eventListeners.delete(event);
      }
    }
  }

  public emit<K extends keyof AemeathEventMap>(event: K, payload: AemeathEventMap[K]): void;
  public emit(event: string, ...args: unknown[]): void;
  public emit(event: string, ...args: unknown[]): void {
    const dispatch = (target: string): void => {
      const listeners = this.eventListeners.get(target);
      if (!listeners) return;
      for (const listener of Array.from(listeners)) {
        try {
          listener(...args);
        } catch (err) {
          this.debugWarn(`Error in event listener for "${target}":`, err);
        }
      }
    };

    dispatch(event);
    const alias = DELIVERY_EVENT_ALIASES[event];
    if (alias) {
      dispatch(alias);
      this.notifyDeliveryStatus();
    }
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
      const priority = plugin.priority ?? 0;
      let insertAt = this.pluginInstances.length;
      for (let i = this.pluginInstances.length - 1; i >= 0; i--) {
        const existing = this.pluginInstances[i]!.priority ?? 0;
        if (existing <= priority) {
          insertAt = i + 1;
          break;
        }
        insertAt = i;
      }
      this.pluginInstances.splice(insertAt, 0, plugin);
      this.plugins.set(plugin.name, {
        name: plugin.name,
        version: plugin.version,
        priority,
        enabled: true,
        installedAt: Date.now(),
        options,
      });
      this.debugLog(`Plugin "${plugin.name}" installed (priority=${priority})`);
      // 与 plugin:uninstall 对称：OfflinePersistence 靠它在 Upload 被单独 remount
      // 后重新唤醒盘上补传（upload:resumed 不会在 install 时发出）。
      this.emit('plugin:install', plugin.name);
      if (plugin.name === 'upload' || plugin.name === 'offline-persistence') {
        this.notifyDeliveryStatus();
      }
    } catch (err) {
      this.debugWarn(`Failed to install plugin "${plugin.name}":`, err);
      return this;
    }

    return this;
  }

  public hasPlugin(name: string): boolean {
    return this.plugins.has(name);
  }

  public getPluginInstance(name: string): AemeathPlugin | undefined {
    return this.pluginInstances.find((p) => p.name === name);
  }

  /**
   * 聚合 UploadPlugin 与 OfflinePersistencePlugin 的统一只读状态。
   *
   * 两个插件仍各自拥有调度与持久化职责；这里只建立按稳定 `logId` 去重的观测视图。
   */
  public getDeliveryStatus(): DeliveryStatus {
    const uploadPlugin = this.getPluginInstance('upload') as
      | (AemeathPlugin & { getQueueStatus?: () => UploadQueueStatus })
      | undefined;
    const offlinePlugin = this.getPluginInstance('offline-persistence') as
      | (AemeathPlugin & { getStatus?: () => OfflinePersistenceStatus })
      | undefined;
    let upload: Partial<UploadQueueStatus> | undefined;
    let offline: Partial<OfflinePersistenceStatus> | undefined;
    try {
      upload = uploadPlugin?.getQueueStatus?.();
    } catch (err) {
      // 状态观测不得反向拖垮日志主链路。同名第三方插件如果提供了
      // 不完整的状态实现，本次快照降级为空状态并仅在 debug 下告警。
      this.debugWarn('Upload delivery status provider failed:', err);
    }
    try {
      offline = offlinePlugin?.getStatus?.();
    } catch (err) {
      this.debugWarn('Offline delivery status provider failed:', err);
    }
    const count = (value: unknown): number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
    const stats = (value: unknown): { total: number; byReason: Record<string, number> } => {
      if (!value || typeof value !== 'object') return { total: 0, byReason: {} };
      const raw = value as { total?: unknown; byReason?: unknown };
      const byReason: Record<string, number> = {};
      if (raw.byReason && typeof raw.byReason === 'object') {
        for (const [reason, n] of Object.entries(raw.byReason)) {
          if (typeof n === 'number' && Number.isFinite(n) && n >= 0) byReason[reason] = n;
        }
      }
      return { total: count(raw.total), byReason };
    };
    const uploadItems = (Array.isArray(upload?.pendingItems)
      ? upload.pendingItems
      : Array.isArray(upload?.items) ? upload.items : [])
      .filter((item): item is UploadQueueStatus['items'][number] =>
        !!item && typeof item.logId === 'string' && item.logId.length > 0,
      );
    const offlineItems = (Array.isArray(offline?.items) ? offline.items : [])
      .filter((item): item is OfflinePersistenceStatus['items'][number] =>
        !!item && typeof item.logId === 'string' && item.logId.length > 0,
      );
    const validBackends = new Set(['initializing', 'indexeddb', 'localstorage', 'noop']);
    const backend = typeof offline?.backend === 'string' && validBackends.has(offline.backend)
      ? offline.backend as OfflinePersistenceStatus['backend']
      : offlinePlugin ? 'initializing' as const : 'disabled' as const;
    const queued = count(upload?.length);
    const inFlight = count(upload?.inFlight);
    const parked = count(upload?.parked);
    const persisted = count(offline?.pending);
    const buffered = count(offline?.buffered);
    const replaying = count(offline?.replaying);
    const consecutiveFailures = count(upload?.consecutiveFailures);
    const ids = new Set<string>();
    let persistedOnly = 0;
    let oldestCapturedAt = Infinity;
    // pendingItems 是 2.5.1 的全量观测面；items 继续保持 2.4/2.5 的“仅活跃队列”
    // 兼容语义。回退可同时兼容自定义/旧版状态提供者。
    for (const item of uploadItems) {
      ids.add(item.logId);
      if (Number.isFinite(item.capturedAt)) {
        oldestCapturedAt = Math.min(oldestCapturedAt, item.capturedAt);
      }
    }
    for (const item of offlineItems) {
      if (item.state !== 'buffering' && !ids.has(item.logId)) persistedOnly++;
      ids.add(item.logId);
      if (Number.isFinite(item.capturedAt)) {
        oldestCapturedAt = Math.min(oldestCapturedAt, item.capturedAt);
      }
    }
    // 2.5.1 之前的第三方状态提供器可能只有计数、没有稳定 logId。
    // 这部分不能伪造 ID，也不能直接丢成 0；按两层计数的较大缺口保守去重。
    const anonymousUpload = Math.max(0, queued + inFlight + parked - uploadItems.length);
    const persistedItems = offlineItems.filter((item) => item.state !== 'buffering').length;
    const bufferedItems = offlineItems.filter((item) => item.state === 'buffering').length;
    const anonymousPersisted = Math.max(0, persisted - persistedItems);
    const anonymousBuffered = Math.max(0, buffered - bufferedItems);
    const anonymousOffline = anonymousPersisted + anonymousBuffered;
    const anonymousPending = Math.max(anonymousUpload, anonymousOffline);
    persistedOnly += Math.max(0, anonymousPersisted - anonymousUpload);

    return {
      enabled: !!uploadPlugin,
      state: !uploadPlugin
        ? 'disabled'
        : upload?.paused === true
          ? 'paused'
          : backend === 'noop' || parked > 0 || buffered > 0 || consecutiveFailures > 0
            ? 'degraded'
            : ids.size + anonymousPending > 0
              ? 'delivering'
              : 'idle',
      totalPending: ids.size + anonymousPending,
      queued,
      inFlight,
      parked,
      persisted,
      buffered,
      persistedOnly,
      replaying,
      oldestPendingAgeMs: oldestCapturedAt === Infinity
        ? 0
        : Math.max(0, Date.now() - oldestCapturedAt),
      consecutiveFailures,
      attempts: stats(upload?.attempts),
      drops: stats(upload?.drops),
      persistence: {
        enabled: !!offlinePlugin,
        backend,
        bytes: count(offline?.bytes),
        buffered,
        quotaDrops: count(offline?.quotaDrops),
        giveUps: count(offline?.giveUps),
        replayed: count(offline?.replayed),
      },
    };
  }

  public notifyDeliveryStatus(): void {
    if (this.eventListeners.has('delivery:status')) {
      this.emit('delivery:status', this.getDeliveryStatus());
    }
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
      try {
        plugin.uninstall?.(this);
      } catch (err) {
        this.debugWarn(`Plugin "${name}" uninstall error:`, err);
      }
      this.pluginInstances.splice(idx, 1);
    }

    this.emit('plugin:uninstall', name);
    this.plugins.delete(name);
    this.debugLog(`Plugin "${name}" uninstalled`);
    if (name === 'upload' || name === 'offline-persistence') {
      this.notifyDeliveryStatus();
    }
    return true;
  }

  public getPlugins(): PluginMetadata[] {
    const result: PluginMetadata[] = [];
    for (const plugin of this.pluginInstances) {
      const meta = this.plugins.get(plugin.name);
      if (meta) result.push(meta);
    }
    return result;
  }

  // ==================== 配置管理 ====================

  public setConsoleEnabled(enabled: boolean): void {
    this.enableConsole = enabled;
  }

  // ==================== 上下文管理 ====================

  public setContext(context: ContextValue): void {
    if (typeof context === 'function') {
      this.dynamicContext.clear();
      this.asyncContextWarned.clear();
      this.dynamicContext.set('__root__', context as ContextUpdater);
    } else {
      this.staticContext = { ...context };
      this.dynamicContext.delete('__root__');
      this.asyncContextWarned.delete('__root__');
    }
  }

  public updateContext(key: string, value: unknown | ContextUpdater): void {
    if (typeof value === 'function') {
      this.dynamicContext.set(key, value as ContextUpdater);
      this.asyncContextWarned.delete(key);
      delete this.staticContext[key];
    } else {
      this.staticContext[key] = value;
      this.dynamicContext.delete(key);
      this.asyncContextWarned.delete(key);
    }
  }

  public getContext(): Record<string, unknown> {
    return { ...this.staticContext };
  }

  public clearContext(keys?: string[]): void {
    if (!keys || keys.length === 0) {
      this.staticContext = {};
      this.dynamicContext.clear();
      this.asyncContextWarned.clear();
    } else {
      for (const key of keys) {
        delete this.staticContext[key];
        this.dynamicContext.delete(key);
        this.asyncContextWarned.delete(key);
      }
    }
  }

  public destroy(): void {
    this.destroyed = true;
    const pluginNames = this.pluginInstances.slice().reverse().map((p) => p.name);
    for (const name of pluginNames) {
      try {
        this.uninstall(name);
      } catch (err) {
        this.debugWarn(`Failed to uninstall plugin "${name}" during destroy:`, err);
      }
    }
    this.logListeners.clear();
    this.eventListeners.clear();
    this.plugins.clear();
    this.pluginInstances.length = 0;
    this.staticContext = {};
    this.dynamicContext.clear();
    this.asyncContextWarned.clear();
  }
}
