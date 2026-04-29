/**
 * SafeGuard 插件 - 智能日志保护
 *
 * 功能：
 * - 递归调用硬拦截
 * - 滑动窗口频率限制
 * - 重复日志合并（合并计数，只上报一条）
 * - 高频非重复日志采样 + 开发者警告
 * - Circuit Breaker 三状态（Closed / Open / Half-Open）
 * - 三种保护模式：standard / cautious / strict
 *
 * 模式区别（仅影响被拦截日志的处理方式）：
 * - standard（默认）：被拦截的日志直接丢弃
 * - cautious：暂存到内存回收站，浏览器空闲时低优先级回放
 * - strict：与 cautious 相同，但回收站持久化到 localStorage
 */

import type {
  AemeathPlugin,
  AemeathInterface,
  BeforeLogResult,
  LogLevel,
  LogOptions,
} from '../types';
import { PluginPriority } from '../types';

// ==================== 类型定义 ====================

export type SafeGuardMode = 'standard' | 'cautious' | 'strict';

type CircuitState = 'closed' | 'open' | 'half-open';

export interface SafeGuardPluginOptions {
  /** 保护模式 @default 'standard' */
  mode?: SafeGuardMode;
  /** 每秒最大日志数 @default 100 */
  rateLimit?: number;
  /** 最大错误数（触发熔断）@default 100 */
  maxErrors?: number;
  /** 熔断冷却时间 ms @default 30000 */
  cooldownPeriod?: number;
  /** 重复日志合并窗口 ms @default 2000 */
  mergeWindow?: number;
  /** 是否启用递归保护 @default true */
  enableRecursionGuard?: boolean;
  /** 回收站最大容量（cautious/strict） @default 200 */
  parkingLotSize?: number;
  /** 回收站条目过期时间 ms（cautious/strict） @default 300000 */
  parkingLotTTL?: number;
  /** localStorage key（strict 模式持久化）@default '__aemeath_safeguard_parking__' */
  storageKey?: string;
}

interface SafeGuardConfig {
  mode: SafeGuardMode;
  rateLimit: number;
  maxErrors: number;
  cooldownPeriod: number;
  mergeWindow: number;
  enableRecursionGuard: boolean;
  parkingLotSize: number;
  parkingLotTTL: number;
  storageKey: string;
}

interface MergeEntry {
  count: number;
  level: LogLevel;
  message: string;
  options: LogOptions;
  firstTimestamp: number;
}

interface ParkedLog {
  level: LogLevel;
  message: string;
  options: LogOptions;
  timestamp: number;
}

export interface SafeGuardHealth {
  state: CircuitState;
  mode: SafeGuardMode;
  isHealthy: boolean;
  currentRate: number;
  errorCount: number;
  droppedCount: number;
  mergedCount: number;
  parkingLotSize: number;
  uptime: number;
}

// ==================== 插件实现 ====================

export class SafeGuardPlugin implements AemeathPlugin {
  readonly name = 'safe-guard';
  readonly version = '1.2.0';
  readonly priority: number = PluginPriority.EARLY;
  readonly description = '智能日志保护';

  private readonly config: SafeGuardConfig;
  private logger: AemeathInterface | null = null;

  // Circuit breaker
  private state: CircuitState = 'closed';
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;

  // 滑动窗口
  private logTimestamps: number[] = [];
  private readonly maxTimestamps = 500;

  // 错误计数
  private errorCount = 0;
  private errorResetTimer: ReturnType<typeof setInterval> | null = null;

  // 递归保护 & 内部回放绕过
  private isInBeforeLog = false;
  private bypassing = false;

  // 重复日志合并
  private mergeMap: Map<string, MergeEntry> = new Map();
  private mergeFlushTimer: ReturnType<typeof setTimeout> | null = null;

  private hasWarnedHighFrequency = false;

  // 统计
  private droppedCount = 0;
  private mergedCount = 0;
  private readonly startTime = Date.now();

  // 回收站（cautious / strict）
  private parkingLot: ParkedLog[] = [];
  private idleScheduled = false;

  // 事件处理函数引用
  private boundHandleError: (() => void) | null = null;
  private boundBeforeUnload: (() => void) | null = null;

  constructor(options: SafeGuardPluginOptions = {}) {
    this.config = {
      mode: options.mode ?? 'standard',
      rateLimit: options.rateLimit ?? 100,
      maxErrors: options.maxErrors ?? 100,
      cooldownPeriod: options.cooldownPeriod ?? 30000,
      mergeWindow: options.mergeWindow ?? 2000,
      enableRecursionGuard: options.enableRecursionGuard ?? true,
      parkingLotSize: options.parkingLotSize ?? 200,
      parkingLotTTL: options.parkingLotTTL ?? 5 * 60 * 1000,
      storageKey: options.storageKey ?? '__aemeath_safeguard_parking__',
    };
  }

  // ==================== 生命周期 ====================

  install(logger: AemeathInterface): void {
    this.logger = logger;

    this.boundHandleError = this.handleError.bind(this);
    logger.on('error', this.boundHandleError);

    this.errorResetTimer = setInterval(() => {
      this.errorCount = 0;
    }, 60000);

    if (this.config.mode === 'strict') {
      this.restoreFromStorage();
      if (typeof window !== 'undefined') {
        this.boundBeforeUnload = this.persistToStorage.bind(this);
        window.addEventListener('beforeunload', this.boundBeforeUnload);
      }
    }

    (logger as any).getHealth = this.getHealth.bind(this);
    (logger as any).pause = this.manualPause.bind(this);
    (logger as any).resume = this.manualResume.bind(this);
  }

  uninstall(logger: AemeathInterface): void {
    if (this.boundHandleError) {
      logger.off('error', this.boundHandleError);
      this.boundHandleError = null;
    }

    if (this.errorResetTimer) {
      clearInterval(this.errorResetTimer);
      this.errorResetTimer = null;
    }

    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }

    this.flushMergeMap();
    if (this.mergeFlushTimer) {
      clearTimeout(this.mergeFlushTimer);
      this.mergeFlushTimer = null;
    }

    if (this.config.mode === 'strict') {
      this.persistToStorage();
    }
    if (typeof window !== 'undefined' && this.boundBeforeUnload) {
      window.removeEventListener('beforeunload', this.boundBeforeUnload);
      this.boundBeforeUnload = null;
    }

    delete (logger as any).getHealth;
    delete (logger as any).pause;
    delete (logger as any).resume;

    this.logger = null;
  }

  // ==================== 核心：beforeLog Hook ====================

  beforeLog(level: LogLevel, message: string, options: LogOptions): BeforeLogResult {
    // 内部回放调用（合并回放 / 回收站回放）→ 直接放行
    if (this.bypassing) {
      return;
    }

    // 递归保护（最高优先级）
    if (this.config.enableRecursionGuard && this.isInBeforeLog) {
      this.droppedCount++;
      return false;
    }

    this.isInBeforeLog = true;
    try {
      return this.analyze(level, message, options);
    } finally {
      this.isInBeforeLog = false;
    }
  }

  private analyze(level: LogLevel, message: string, options: LogOptions): BeforeLogResult {
    // Circuit breaker: Open 状态拦截所有日志
    if (this.state === 'open') {
      this.handleBlocked(level, message, options);
      return false;
    }

    // 记录时间戳 + 获取当前频率
    this.recordTimestamp();
    const rate = this.getRecentRate();

    // 频率正常 → 放行
    if (rate <= this.config.rateLimit) {
      if (this.state === 'half-open') {
        this.transitionTo('closed');
      }
      return;
    }

    // 频率超标 → 智能分析
    if (!this.hasWarnedHighFrequency) {
      this.hasWarnedHighFrequency = true;
      console.warn(
        '[SafeGuard] 检测到高频日志调用（%d/s，限制 %d/s），建议使用 throttle/debounce。当前模式：%s',
        rate,
        this.config.rateLimit,
        this.config.mode,
      );
    }

    const hash = this.computeHash(level, message, options);

    // 重复日志 → 合并计数
    if (this.mergeMap.has(hash)) {
      const entry = this.mergeMap.get(hash)!;
      entry.count++;
      this.mergedCount++;
      this.scheduleMergeFlush();
      return false;
    }

    // 首次出现的日志 → 进入合并窗口，首条始终放行
    this.mergeMap.set(hash, {
      count: 1,
      level,
      message,
      options,
      firstTimestamp: Date.now(),
    });
    this.scheduleMergeFlush();
    return; // 首条通过，跳过采样
  }

  // ==================== 错误计数 + 熔断 ====================

  private handleError(): void {
    this.errorCount++;
    if (this.errorCount > this.config.maxErrors && this.state !== 'open') {
      this.transitionTo('open');
      console.error(
        '[SafeGuard] 错误数过多（%d/%d），已触发熔断。冷却 %dms 后尝试恢复',
        this.errorCount,
        this.config.maxErrors,
        this.config.cooldownPeriod,
      );
    }
  }

  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    if (oldState === newState) return;

    this.state = newState;

    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }

    if (newState === 'open') {
      this.cooldownTimer = setTimeout(() => {
        this.transitionTo('half-open');
      }, this.config.cooldownPeriod);
    }

    if (newState === 'half-open') {
      this.errorCount = 0;
      this.hasWarnedHighFrequency = false;
    }

    if (newState === 'closed') {
      this.errorCount = 0;
      this.hasWarnedHighFrequency = false;
    }

    this.logger?.emit('safeguard:stateChange', { from: oldState, to: newState });
  }

  // ==================== 滑动窗口 ====================

  private recordTimestamp(): void {
    const now = Date.now();
    this.logTimestamps.push(now);
    const cutoff = now - 1000;
    while (
      this.logTimestamps.length > 0 &&
      (this.logTimestamps[0]! < cutoff || this.logTimestamps.length > this.maxTimestamps)
    ) {
      this.logTimestamps.shift();
    }
  }

  private getRecentRate(): number {
    const now = Date.now();
    const cutoff = now - 1000;
    let count = 0;
    for (let i = this.logTimestamps.length - 1; i >= 0; i--) {
      if (this.logTimestamps[i]! >= cutoff) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  // ==================== 重复日志合并 ====================

  private computeHash(level: LogLevel, message: string, options: LogOptions): string {
    const parts = [level, message];

    if (options.error) {
      const err = options.error;
      if (err instanceof Error) {
        parts.push(err.name, err.message);
        if (err.stack) {
          const firstFrame = this.extractFirstFrame(err.stack);
          if (firstFrame) parts.push(firstFrame);
        }
      } else {
        parts.push((err as any).type ?? '', (err as any).value ?? '');
      }
    }

    return this.djb2(parts.join('|'));
  }

  private extractFirstFrame(stack: string): string | null {
    const lines = stack.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('at ')) {
        return trimmed;
      }
    }
    return null;
  }

  private djb2(str: string): string {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) + hash + str.charCodeAt(i);
    }
    return (hash >>> 0).toString(16);
  }

  private scheduleMergeFlush(): void {
    if (this.mergeFlushTimer) return;
    this.mergeFlushTimer = setTimeout(() => {
      this.mergeFlushTimer = null;
      this.flushMergeMap();
    }, this.config.mergeWindow);
  }

  private flushMergeMap(): void {
    if (!this.logger || this.mergeMap.size === 0) return;

    const entriesToFlush = Array.from(this.mergeMap.entries());
    this.mergeMap.clear();

    for (const [, entry] of entriesToFlush) {
      if (entry.count <= 1) continue;

      const mergedTags = {
        ...entry.options.tags,
        repeatedCount: entry.count,
        safeguardMerged: true as const,
      };

      this.replayLog(entry.level, entry.message, {
        ...entry.options,
        tags: mergedTags,
      });
    }
  }

  private getLogMethod(level: LogLevel): (message: string, options?: LogOptions) => void {
    if (!this.logger) return () => {};
    switch (level) {
      case 'debug': return this.logger.debug.bind(this.logger);
      case 'info': return this.logger.info.bind(this.logger);
      case 'track': return this.logger.track.bind(this.logger);
      case 'warn': return this.logger.warn.bind(this.logger);
      case 'error': return this.logger.error.bind(this.logger);
      default: return this.logger.info.bind(this.logger);
    }
  }

  /**
   * 内部回放日志（绕过自身 beforeLog hook）
   *
   * 通过 bypassing 标记让 beforeLog 直接放行，
   * 逻辑完全内聚在 SafeGuard 内部，Logger 核心零感知。
   */
  private replayLog(level: LogLevel, message: string, options: LogOptions): void {
    if (!this.logger) return;
    this.bypassing = true;
    try {
      const method = this.getLogMethod(level);
      method.call(this.logger, message, options);
    } finally {
      this.bypassing = false;
    }
  }

  // ==================== 被拦截日志处理 ====================

  private handleBlocked(level: LogLevel, message: string, options: LogOptions): void {
    this.droppedCount++;

    if (this.config.mode === 'standard') {
      return;
    }

    // cautious / strict：存入回收站
    if (this.parkingLot.length >= this.config.parkingLotSize) {
      return;
    }

    this.parkingLot.push({
      level,
      message,
      options,
      timestamp: Date.now(),
    });

    this.scheduleIdleReplay();
  }

  // ==================== 回收站闲时回放 ====================

  private scheduleIdleReplay(): void {
    if (this.idleScheduled || this.parkingLot.length === 0) return;
    this.idleScheduled = true;

    const callback = () => {
      this.idleScheduled = false;
      this.replayParkingLot();
    };

    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(callback, { timeout: 10000 });
    } else {
      setTimeout(callback, 5000);
    }
  }

  private replayParkingLot(): void {
    if (!this.logger || this.parkingLot.length === 0) return;

    // 如果系统还在 open 状态，不回放，等下次空闲
    if (this.state === 'open') {
      this.scheduleIdleReplay();
      return;
    }

    const now = Date.now();
    const ttl = this.config.parkingLotTTL;

    // 清理过期条目
    this.parkingLot = this.parkingLot.filter((item) => now - item.timestamp < ttl);

    // 每次最多回放 10 条，避免阻塞
    const batch = this.parkingLot.splice(0, 10);

    for (const item of batch) {
      const tags = {
        ...item.options.tags,
        safeguardReplayed: true as const,
      };
      this.replayLog(item.level, item.message, { ...item.options, tags });
    }

    // 如果还有剩余，继续调度
    if (this.parkingLot.length > 0) {
      this.scheduleIdleReplay();
    }

    // strict 模式更新持久化
    if (this.config.mode === 'strict') {
      this.persistToStorage();
    }
  }

  // ==================== strict 模式持久化 ====================

  private persistToStorage(): void {
    if (this.config.mode !== 'strict' || this.parkingLot.length === 0) {
      this.removeStorage();
      return;
    }

    try {
      const data = this.parkingLot.map((item) => ({
        level: item.level,
        message: item.message,
        options: this.serializeOptions(item.options),
        timestamp: item.timestamp,
      }));
      localStorage.setItem(this.config.storageKey, JSON.stringify(data));
    } catch {
      // localStorage 不可用或超限，静默忽略
    }
  }

  private restoreFromStorage(): void {
    if (this.config.mode !== 'strict') return;

    try {
      const raw = localStorage.getItem(this.config.storageKey);
      if (!raw) return;

      const data = JSON.parse(raw) as ParkedLog[];
      const now = Date.now();
      const ttl = this.config.parkingLotTTL;

      this.parkingLot = data
        .filter((item) => now - item.timestamp < ttl)
        .slice(0, this.config.parkingLotSize);

      this.removeStorage();

      if (this.parkingLot.length > 0) {
        this.scheduleIdleReplay();
      }
    } catch {
      this.removeStorage();
    }
  }

  private removeStorage(): void {
    try {
      localStorage.removeItem(this.config.storageKey);
    } catch {
      // 静默忽略
    }
  }

  /**
   * 序列化 LogOptions 以便存入 localStorage
   * Error 对象不能直接 JSON.stringify，需要转换
   */
  private serializeOptions(options: LogOptions): LogOptions {
    if (!options.error || !(options.error instanceof Error)) {
      return options;
    }
    const err = options.error;
    return {
      ...options,
      error: {
        type: err.name || 'Error',
        value: err.message || String(err),
        stack: err.stack,
      },
    };
  }

  // ==================== 手动控制 ====================

  private manualPause(): void {
    this.transitionTo('open');
  }

  private manualResume(): void {
    this.transitionTo('closed');
    this.replayParkingLot();
  }

  // ==================== 健康状态 ====================

  getHealth(): SafeGuardHealth {
    return {
      state: this.state,
      mode: this.config.mode,
      isHealthy: this.state === 'closed',
      currentRate: this.getRecentRate(),
      errorCount: this.errorCount,
      droppedCount: this.droppedCount,
      mergedCount: this.mergedCount,
      parkingLotSize: this.parkingLot.length,
      uptime: Date.now() - this.startTime,
    };
  }
}

// 扩展 Logger 接口（用于 TypeScript 类型提示）
declare module '../types' {
  interface AemeathInterface {
    getHealth?(): SafeGuardHealth;
    pause?(): void;
    resume?(): void;
  }
}
