/**
 * Upload Plugin - 简化的日志上传插件
 *
 * 核心特性：
 * - 回调函数方式，用户完全控制上传逻辑
 * - 优先级队列，按优先级排序
 * - 同一时间只有一个请求（串行）
 * - 失败自动降级重试
 * - 本地缓存队列
 */

import type { AemeathPlugin, LogEntry, AemeathInterface } from '../types';

/**
 * 队列中的日志项
 */
interface QueuedLog {
  /** 日志内容 */
  log: LogEntry;

  /** 优先级（数字越大越优先） */
  priority: number;

  /** 重试次数 */
  retryCount: number;

  /** 入队时间 */
  timestamp: number;
}

/**
 * 上传结果
 */
export interface UploadResult {
  /** 是否成功 */
  success: boolean;
  /** 是否需要重试（仅在 success = false 时有效） */
  shouldRetry?: boolean;
  /** 错误信息 */
  error?: string;
}

/**
 * 上传回调函数
 *
 * @param log - 要上传的日志
 * @returns UploadResult - 明确的上传结果
 */
export type UploadCallback = (log: LogEntry) => Promise<UploadResult>;

/**
 * 优先级计算回调
 *
 * @param log - 日志内容
 * @returns number - 优先级数字（越大越优先，建议范围：1-100）
 */
export type PriorityCallback = (log: LogEntry) => number;

/**
 * 上传插件配置
 */
export interface UploadPluginOptions {
  /**
   * 上传回调函数（必需）
   *
   * 用户完全控制如何上传日志（POST/GET、域名、headers、跨域等）
   *
   * @example
   * ```typescript
   * onUpload: async (log) => {
   *   const res = await fetch('https://api.example.com/logs', {
   *     method: 'POST',
   *     headers: {
   *       'Authorization': `Bearer ${token}`,
   *       'Content-Type': 'application/json'
   *     },
   *     body: JSON.stringify(log)
   *   });
   *   return { success: res.ok };
   * }
   * ```
   */
  onUpload: UploadCallback;

  /**
   * 优先级计算回调（可选）
   *
   * 返回数字，越大越优先。建议范围：1-100
   *
   * 默认规则：
   * - error: 100
   * - warn: 50
   * - info: 10
   * - debug: 1
   *
   * @example
   * ```typescript
   * getPriority: (log) => {
   *   if (log.level === 'error') return 100;
   *   if (log.level === 'warn') return 50;
   *   if (log.tags?.urgent) return 80;
   *   return 10;
   * }
   * ```
   */
  getPriority?: PriorityCallback;

  /**
   * 队列配置
   */
  queue?: {
    /**
     * 队列最大长度（默认：100）
     *
     * 超过此长度时，会移除优先级最低的旧日志
     */
    maxSize?: number;

    /**
     * 并发数（默认：1，建议保持为 1）
     *
     * 设置为 1 可确保同一时间只有一个上传请求，不影响性能
     */
    concurrency?: number;

    /**
     * 最大重试次数（默认：3）
     *
     * 上传失败后会降低优先级并重试
     */
    maxRetries?: number;

    /**
     * 自动上传间隔（毫秒，默认：30000）
     *
     * 定时触发队列处理
     */
    uploadInterval?: number;

    /**
     * 去重延迟（毫秒，默认：50）
     *
     * 日志入队后等待此时间再处理，让重复日志都进入队列后统一去重
     * 这样可以确保保留信息最完整的那条日志
     */
    deduplicationDelay?: number;
  };

  /**
   * 本地缓存配置
   */
  cache?: {
    /**
     * 是否启用缓存（默认：true）
     *
     * 启用后，队列会保存到 localStorage，页面刷新后恢复
     */
    enabled?: boolean;

    /**
     * 缓存 key（默认：'__logger_upload_queue__'）
     */
    key?: string;
  };

  /**
   * 是否在页面卸载时保存队列到缓存（默认：true）
   *
   * 启用后，页面卸载时会将未上传的日志保存到 localStorage
   * 下次页面加载时会自动恢复并重试上传
   */
  saveOnUnload?: boolean;

  /**
   * 是否启用调试模式（输出详细日志）
   * @default false
   */
  debug?: boolean;
}

/**
 * 默认优先级计算
 */
const defaultGetPriority: PriorityCallback = (log: LogEntry) => {
  switch (log.level) {
    case 'error':
      return 100;
    case 'warn':
      return 50;
    case 'info':
    case 'track':
      return 10;
    case 'debug':
      return 1;
    default:
      return 10;
  }
};

/**
 * Upload Plugin
 */
export class UploadPlugin implements AemeathPlugin {
  readonly name = 'upload';
  readonly version = '1.2.0';
  readonly description = '日志上传插件（回调方式）';

  private config: {
    onUpload: UploadCallback;
    getPriority: PriorityCallback;
    queue: Required<NonNullable<UploadPluginOptions['queue']>>;
    cache: Required<NonNullable<UploadPluginOptions['cache']>>;
    saveOnUnload: boolean;
    debug: boolean;
  };
  private queue: QueuedLog[] = [];
  private isProcessing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private deduplicationTimer: ReturnType<typeof setTimeout> | null = null;
  private debugEnabled: boolean;

  // 绑定后的事件处理函数引用（用于正确移除监听器）
  private boundHandleLog: ((entry: LogEntry) => void) | null = null;
  private boundHandleBeforeUnload: (() => void) | null = null;

  constructor(options: UploadPluginOptions) {
    this.debugEnabled = options.debug ?? false;
    this.config = {
      onUpload: options.onUpload,
      getPriority: options.getPriority || defaultGetPriority,
      queue: {
        maxSize: options.queue?.maxSize ?? 100,
        concurrency: options.queue?.concurrency ?? 1,
        maxRetries: options.queue?.maxRetries ?? 3,
        uploadInterval: options.queue?.uploadInterval ?? 30000,
        deduplicationDelay: options.queue?.deduplicationDelay ?? 50,
      },
      cache: {
        enabled: options.cache?.enabled !== false,
        key: options.cache?.key || '__logger_upload_queue__',
      },
      saveOnUnload: options.saveOnUnload !== false,
      debug: options.debug ?? false,
    };
  }

  /** 调试日志（仅在 debug 模式输出） */
  private log(...args: unknown[]): void {
    if (this.debugEnabled) {
      console.log('[UploadPlugin]', ...args);
    }
  }

  /** 警告日志（仅在 debug 模式输出） */
  private warn(...args: unknown[]): void {
    if (this.debugEnabled) {
      console.warn('[UploadPlugin]', ...args);
    }
  }

  install(logger: AemeathInterface): void {
    // 从本地缓存恢复队列（这是真正可靠的"不丢失"机制）
    if (this.config.cache.enabled) {
      this.restoreFromCache();
    }

    // 创建绑定后的事件处理函数引用
    this.boundHandleLog = this.handleLog.bind(this);
    this.boundHandleBeforeUnload = this.handleBeforeUnload.bind(this);

    // 监听日志事件
    logger.on('log', this.boundHandleLog as (...args: unknown[]) => void);

    // 启动定时上传
    this.startPeriodicUpload();

    // 监听页面卸载，保存队列到缓存
    if (this.config.saveOnUnload && typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this.boundHandleBeforeUnload);
    }
  }

  uninstall(logger?: AemeathInterface): void {
    // 停止定时器
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // 停止去重延迟定时器
    if (this.deduplicationTimer) {
      clearTimeout(this.deduplicationTimer);
      this.deduplicationTimer = null;
    }

    // 最后一次上传
    this.flush();

    // 移除日志事件监听
    if (logger && this.boundHandleLog) {
      logger.off('log', this.boundHandleLog as (...args: unknown[]) => void);
    }

    // 移除页面卸载事件监听（使用保存的引用）
    if (typeof window !== 'undefined' && this.boundHandleBeforeUnload) {
      window.removeEventListener('beforeunload', this.boundHandleBeforeUnload);
    }

    // 清理引用
    this.boundHandleLog = null;
    this.boundHandleBeforeUnload = null;
  }

  /**
   * 处理日志
   */
  private handleLog(entry: LogEntry): void {
    let priority: number;
    try {
      priority = this.config.getPriority(entry);
    } catch {
      priority = 0;
    }

    // 添加到队列（不做去重，让所有日志都进入队列）
    this.addToQueue({
      log: entry,
      priority,
      retryCount: 0,
      timestamp: Date.now(),
    });

    // 使用延迟处理，让短时间内的重复日志都进入队列后统一去重
    this.scheduleProcessQueue(priority >= 80);
  }

  /**
   * 调度队列处理（带去重延迟）
   *
   * @param immediate - 是否立即处理（用于高优先级日志，但仍会有短暂延迟等待重复日志）
   */
  private scheduleProcessQueue(immediate: boolean = false): void {
    // 如果已经有调度中的处理，不重复调度
    if (this.deduplicationTimer) {
      return;
    }

    // 延迟时间：高优先级使用较短延迟，普通日志使用配置的延迟
    const delay = immediate
      ? Math.min(this.config.queue.deduplicationDelay, 20)
      : this.config.queue.deduplicationDelay;

    this.deduplicationTimer = setTimeout(() => {
      this.deduplicationTimer = null;
      this.processQueue();
    }, delay);
  }

  /**
   * 添加到队列（按优先级排序）
   */
  private addToQueue(item: QueuedLog): void {
    // 检查队列长度
    if (this.queue.length >= this.config.queue.maxSize) {
      // 移除优先级最低的日志
      this.queue.sort((a, b) => a.priority - b.priority);
      this.queue.shift();
    }

    // 添加到队列
    this.queue.push(item);

    // 按优先级排序（高优先级在前）
    this.queue.sort((a, b) => b.priority - a.priority);

    // 保存到缓存
    if (this.config.cache.enabled) {
      this.saveToCache();
    }
  }

  /**
   * 处理队列（串行上传）
   */
  private async processQueue(): Promise<void> {
    // 如果正在处理，或队列为空，则跳过
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;

    try {
      // 🎯 处理前先对队列进行去重，保留信息最完整的日志
      this.deduplicateQueue();

      // 依次处理队列中的日志（串行，确保同一时间只有一个请求）
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (!item) break;

        try {
          // 调用用户的上传回调
          const result = await this.config.onUpload(item.log);

          // 检查上传结果
          if (result.success) {
            // 上传成功，更新缓存
            if (this.config.cache.enabled) {
              this.saveToCache();
            }
          } else {
            // 上传失败（业务逻辑失败，如 code !== 200）
            this.warn('Upload failed:', result.error || 'Unknown error');

            // 检查是否需要重试
            if (
              result.shouldRetry &&
              item.retryCount < this.config.queue.maxRetries
            ) {
              item.retryCount++;
              // 降低 10 个优先级单位
              item.priority = Math.max(1, item.priority - 10);

              // 重新入队
              this.addToQueue(item);
            } else {
              // 不需要重试或达到最大重试次数，放弃
              this.warn(
                `Dropping log (shouldRetry=${result.shouldRetry}, retryCount=${item.retryCount})`,
              );
            }
          }
        } catch (error) {
          // 🛡️ 标记为日志系统内部错误，避免被 ErrorCapturePlugin 捕获
          if (error instanceof Error) {
            (error as any)._isAemeathInternalError = true;
          }

          // 上传回调抛出异常（网络错误、代码错误等）
          this.warn('Upload callback threw error:', error);

          // 如果还有重试次数，降低优先级后重新入队
          if (item.retryCount < this.config.queue.maxRetries) {
            item.retryCount++;
            // 降低 10 个优先级单位
            item.priority = Math.max(1, item.priority - 10);

            // 重新入队
            this.addToQueue(item);
          } else {
            // 达到最大重试次数，放弃
            this.warn('Max retries reached, dropping log');
          }
        }

        // 控制并发（虽然默认是 1，但保留扩展性）
        if (this.config.queue.concurrency === 1) {
          // 串行模式，每次只处理一个
          // 可以在这里添加延迟，避免请求过快
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    } finally {
      this.isProcessing = false;

      if (this.queue.length > 0) {
        setTimeout(() => this.processQueue(), 0);
      }
    }
  }

  /**
   * 启动定时上传
   */
  private startPeriodicUpload(): void {
    this.timer = setInterval(() => {
      this.processQueue();
    }, this.config.queue.uploadInterval);
  }

  /**
   * 队列去重
   *
   * 对队列中的日志进行去重，保留信息最完整的那条
   * 判断依据：
   * 1. 相同 hash 的日志视为重复
   * 2. 保留 stack 最长的那条
   */
  private deduplicateQueue(): void {
    if (this.queue.length <= 1) {
      return;
    }

    // 按 hash 分组
    const groups = new Map<string, QueuedLog[]>();

    for (const item of this.queue) {
      const hash = this.generateLogHash(item.log);
      const group = groups.get(hash) || [];
      group.push(item);
      groups.set(hash, group);
    }

    // 每组保留最完整的那条
    const deduplicated: QueuedLog[] = [];
    let duplicateCount = 0;

    for (const group of groups.values()) {
      if (group.length === 1) {
        deduplicated.push(group[0]!);
      } else {
        // 多条重复日志，选择最完整的
        const best = this.selectMostComplete(group);
        if (best) {
          deduplicated.push(best);
          duplicateCount += group.length - 1;
        }
      }
    }

    if (duplicateCount > 0) {
      this.log(
        `Deduplicated ${duplicateCount} logs, ${this.queue.length} -> ${deduplicated.length}`,
      );
    }

    // 更新队列，保持优先级排序
    this.queue = deduplicated;
    this.queue.sort((a, b) => b.priority - a.priority);
  }

  /**
   * 生成日志的 hash（用于去重）
   *
   * 使用 message + 第一个 stack 帧 进行 hash
   */
  private generateLogHash(log: LogEntry): string {
    const parts: string[] = [];

    // 1. 日志级别
    parts.push(log.level);

    // 2. 消息
    parts.push(log.message || '');

    // 3. 如果有 error，提取第一个 stack 帧
    const error = log.error;
    if (error) {
      if (error.stack) {
        const firstFrame = this.extractFirstStackFrame(error.stack);
        if (firstFrame) {
          parts.push(firstFrame);
        }
      } else {
        parts.push(error.value);
      }
    }

    return this.simpleHash(parts.join('|'));
  }

  /**
   * 提取 stack 的第一个调用帧
   */
  private extractFirstStackFrame(stack: string): string | null {
    if (!stack) return null;

    const lines = stack.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('at ')) {
        return trimmed;
      }
    }

    return lines[0]?.trim() || null;
  }

  /**
   * 从重复日志中选择最完整的那条
   *
   * 判断依据：stack 长度最长的
   */
  private selectMostComplete(group: QueuedLog[]): QueuedLog | undefined {
    if (group.length === 0) return undefined;

    let best = group[0]!;
    let bestStackLength = this.getStackLength(best.log);

    for (let i = 1; i < group.length; i++) {
      const current = group[i]!;
      const currentStackLength = this.getStackLength(current.log);

      if (currentStackLength > bestStackLength) {
        best = current;
        bestStackLength = currentStackLength;
      }
    }

    return best;
  }

  /**
   * 获取日志中 error 的 stack 长度
   */
  private getStackLength(log: LogEntry): number {
    const error = log.error;
    if (error?.stack) {
      return error.stack.split('\n').length;
    }
    return 0;
  }

  /**
   * 简单的 hash 函数（djb2 算法）
   */
  private simpleHash(str: string): string {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) + hash + char;
    }
    return (hash >>> 0).toString(16);
  }

  /**
   * 立即上传所有日志
   */
  async flush(): Promise<void> {
    await this.processQueue();
  }

  /**
   * 页面卸载前保存队列到缓存
   *
   * 这是真正可靠的"不丢失"机制：
   * 1. 页面卸载时保存到 localStorage
   * 2. 下次页面加载时从缓存恢复
   * 3. 重新尝试上传，得到成功响应后才从队列移除
   *
   * 注意：不使用 sendBeacon，因为它无法确认后端是否收到
   */
  private handleBeforeUnload(): void {
    if (this.queue.length === 0) return;

    // 保存到 localStorage，下次启动时恢复并重试
    if (this.config.cache.enabled) {
      this.log(`Page unloading, saving ${this.queue.length} pending logs to cache`);
      this.saveToCache();
    }
  }

  /**
   * 保存到本地缓存
   */
  private saveToCache(): void {
    if (!this.config.cache.enabled) return;

    try {
      // 只保存必要信息，避免缓存过大
      const cacheData = this.queue.map((item) => ({
        log: item.log,
        priority: item.priority,
        retryCount: item.retryCount,
        timestamp: item.timestamp,
      }));

      localStorage.setItem(this.config.cache.key, JSON.stringify(cacheData));
    } catch (error) {
      // 忽略缓存失败（可能是 quota 超限）
      this.warn('Failed to save to cache:', error);
    }
  }

  /**
   * 从本地缓存恢复
   */
  private restoreFromCache(): void {
    if (!this.config.cache.enabled) return;

    try {
      const data = localStorage.getItem(this.config.cache.key);
      if (data) {
        const cacheData = JSON.parse(data) as QueuedLog[];

        // 过滤掉过期的日志（超过 1 小时）
        const now = Date.now();
        const validLogs = cacheData.filter(
          (item) => now - item.timestamp < 60 * 60 * 1000,
        );

        this.queue = validLogs;

        // 按优先级排序
        this.queue.sort((a, b) => b.priority - a.priority);

        // 恢复后立即触发上传
        if (this.queue.length > 0) {
          this.processQueue();
        }
      }
    } catch (error) {
      // 忽略恢复失败
      this.warn('Failed to restore from cache:', error);
    }
  }

  /**
   * 获取队列状态（用于调试）
   */
  getQueueStatus(): {
    length: number;
    isProcessing: boolean;
    items: Array<{ priority: number; retryCount: number; level: string }>;
  } {
    return {
      length: this.queue.length,
      isProcessing: this.isProcessing,
      items: this.queue.map((item) => ({
        priority: item.priority,
        retryCount: item.retryCount,
        level: item.log.level,
      })),
    };
  }
}
