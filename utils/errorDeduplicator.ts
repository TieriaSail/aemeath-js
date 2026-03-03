/**
 * 错误去重器
 *
 * 防止同一个错误被多次捕获和上报
 *
 * 场景：
 * - React Error Boundary 捕获错误 → console.error
 * - ErrorCapturePlugin 同时监听 window.onerror 和 console.error
 * - 结果：同一个错误被记录两次 ❌
 *
 * 解决：使用 hash 算法对错误去重
 */

export interface ErrorDeduplicatorOptions {
  /**
   * 是否启用去重
   * @default true
   */
  enabled?: boolean;

  /**
   * 去重时间窗口（毫秒）
   * 在此时间窗口内的相同错误只记录一次
   *
   * @default 5000 (5秒)
   */
  timeWindow?: number;

  /**
   * 最大缓存数量
   * 防止内存泄漏
   *
   * @default 100
   */
  maxCacheSize?: number;

  /**
   * 自定义 hash 函数
   *
   * 默认使用：message + stack + type
   */
  hashFn?: (error: ErrorInfo) => string;
}

export interface ErrorInfo {
  message: string;
  stack?: string;
  type?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  [key: string]: unknown;
}

interface CachedError {
  hash: string;
  timestamp: number;
  count: number; // 重复次数
  hasLocation: boolean; // 是否有位置信息（用于判断信息完整度）
  stackLength: number; // stack 长度（用于判断信息完整度）
}

export class ErrorDeduplicator {
  private readonly options: Required<
    Omit<ErrorDeduplicatorOptions, 'hashFn'>
  > & {
    hashFn?: (error: ErrorInfo) => string;
  };

  private cache: Map<string, CachedError> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ErrorDeduplicatorOptions = {}) {
    this.options = {
      enabled: options.enabled ?? true,
      timeWindow: options.timeWindow ?? 5000,
      maxCacheSize: options.maxCacheSize ?? 100,
      hashFn: options.hashFn,
    };

    // 定期清理过期缓存
    if (this.options.enabled) {
      this.startCleanup();
    }
  }

  /**
   * 检查错误是否重复
   *
   * @returns true 表示是新错误（应该上报），false 表示重复错误（不上报）
   *
   * 优化策略：
   * - 如果是重复错误，但当前错误信息更完整，则返回 true（上报更完整的）
   * - 完整度判断依据：1. 有位置信息 2. stack 更长
   * - 这样可以保留信息最完整的那条日志
   */
  public check(error: ErrorInfo): boolean {
    if (!this.options.enabled) {
      return true; // 未启用去重，所有错误都视为新错误
    }

    const hash = this.generateHash(error);
    const now = Date.now();
    const cached = this.cache.get(hash);
    const currentStackLength = this.getStackLength(error);
    const currentHasLocation = this.hasLocationInfo(error);

    if (cached) {
      // 检查是否在时间窗口内
      if (now - cached.timestamp < this.options.timeWindow) {
        // 重复错误，检查当前错误是否信息更完整
        const isMoreComplete = this.isMoreComplete(
          currentHasLocation,
          currentStackLength,
          cached.hasLocation,
          cached.stackLength,
        );

        if (isMoreComplete) {
          // 当前错误信息更完整，更新缓存并返回 true
          cached.count++;
          cached.timestamp = now;
          cached.hasLocation = currentHasLocation;
          cached.stackLength = currentStackLength;
          return true; // ✅ 上报信息更完整的这条
        }

        // 其他情况：重复错误，不上报
        cached.count++;
        cached.timestamp = now;
        return false;
      } else {
        // 超出时间窗口，视为新错误
        this.cache.set(hash, {
          hash,
          timestamp: now,
          count: 1,
          hasLocation: currentHasLocation,
          stackLength: currentStackLength,
        });
        this.checkCacheSize();
        return true;
      }
    }

    // 新错误
    this.cache.set(hash, {
      hash,
      timestamp: now,
      count: 1,
      hasLocation: currentHasLocation,
      stackLength: currentStackLength,
    });

    // 检查缓存大小
    this.checkCacheSize();

    return true;
  }

  /**
   * 检查错误是否包含位置信息
   */
  private hasLocationInfo(error: ErrorInfo): boolean {
    return (
      !!(error.filename || error.source) &&
      typeof error.lineno === 'number' &&
      error.lineno > 0 &&
      typeof error.colno === 'number' &&
      error.colno > 0
    );
  }

  /**
   * 获取 stack 的长度（行数）
   */
  private getStackLength(error: ErrorInfo): number {
    if (!error.stack) return 0;
    return error.stack.split('\n').length;
  }

  /**
   * 判断当前错误是否比缓存的错误信息更完整
   *
   * 判断依据（按优先级）：
   * 1. 有位置信息 > 无位置信息
   * 2. stack 更长 > stack 更短
   */
  private isMoreComplete(
    currentHasLocation: boolean,
    currentStackLength: number,
    cachedHasLocation: boolean,
    cachedStackLength: number,
  ): boolean {
    // 1. 位置信息优先：当前有位置信息，缓存没有
    if (currentHasLocation && !cachedHasLocation) {
      return true;
    }

    // 2. 如果位置信息状态相同，比较 stack 长度
    if (currentHasLocation === cachedHasLocation) {
      // 当前 stack 更长，认为更完整
      if (currentStackLength > cachedStackLength) {
        return true;
      }
    }

    return false;
  }

  /**
   * 获取错误的重复次数
   */
  public getCount(error: ErrorInfo): number {
    if (!this.options.enabled) {
      return 1;
    }

    const hash = this.generateHash(error);
    const cached = this.cache.get(hash);
    return cached?.count ?? 1;
  }

  /**
   * 清除所有缓存
   */
  public clear(): void {
    this.cache.clear();
  }

  /**
   * 停止去重器
   */
  public stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.clear();
  }

  /**
   * 生成错误 hash（根据错误类型选择不同的 hash 策略）
   */
  private generateHash(error: ErrorInfo): string {
    // 使用自定义 hash 函数
    if (this.options.hashFn) {
      return this.options.hashFn(error);
    }

    // 识别错误类型，使用不同的 hash 策略
    const errorType = this.identifyErrorType(error);
    const parts: string[] = [];

    switch (errorType) {
      case 'resource': {
        // 资源加载错误：tagName + src
        parts.push('resource');
        if (error.tagName) parts.push(String(error.tagName));
        if (error.src) parts.push(String(error.src));
        break;
      }

      case 'promise': {
        // Promise rejection：message + reason
        parts.push('promise');
        if (error.message) parts.push(error.message);
        if (error.reason) parts.push(String(error.reason));
        // stack 可能没有，也加上
        if (error.stack) {
          parts.push(error.stack.substring(0, 200));
        }
        break;
      }

      case 'performance': {
        // 性能日志：name + duration + endpoint
        parts.push('performance');
        if (error.name) parts.push(String(error.name));
        if (error.duration !== undefined) parts.push(String(error.duration));
        if (error.endpoint) parts.push(String(error.endpoint));
        break;
      }

      case 'javascript': {
        // JavaScript 错误：message + stack 第一个调用帧
        // 不使用整个 stack，因为同一错误在不同捕获点（如 React 事件系统 vs window.onerror）
        // 会产生不同的调用链，导致去重失效
        parts.push('javascript');
        if (error.message) parts.push(error.message);
        if (error.stack) {
          // 提取第一个调用帧（错误发生的位置），忽略后续调用链
          const firstFrame = this.extractFirstStackFrame(error.stack);
          if (firstFrame) {
            parts.push(firstFrame);
          }
        }
        break;
      }

      default: {
        // 其他类型：通用策略 - message
        parts.push('other');
        if (error.message) parts.push(error.message);
        if (error.stack) {
          parts.push(error.stack.substring(0, 200));
        }
      }
    }

    const combined = parts.join('|');
    return this.simpleHash(combined);
  }

  /**
   * 识别错误类型
   */
  private identifyErrorType(error: ErrorInfo): string {
    // 资源加载错误
    if (error.tagName && error.src) {
      return 'resource';
    }

    // Promise rejection
    if (error.type === 'unhandledrejection' || error.reason !== undefined) {
      return 'promise';
    }

    // 性能日志（来自 PerformancePlugin）
    if (error.name && (error.duration !== undefined || error.endpoint)) {
      return 'performance';
    }

    // JavaScript 错误（有 stack 或 message）
    if (error.stack || (error.message && !error.tagName)) {
      return 'javascript';
    }

    return 'other';
  }

  /**
   * 提取 stack 的第一个调用帧
   *
   * 从 stack trace 中提取第一个 "at xxx" 行，用于去重
   * 这样可以忽略后续调用链的差异（如 React 事件系统的不同处理路径）
   *
   * @example
   * 输入：
   * "Error: Script error.\n    at window.onerror (index.js:1:22595)\n    at Object.n0 (lib-react.js:2:48576)"
   * 输出：
   * "at window.onerror (index.js:1:22595)"
   */
  private extractFirstStackFrame(stack: string): string | null {
    if (!stack) return null;

    const lines = stack.split('\n');

    // 跳过第一行（通常是 "Error: message"），找到第一个 "at " 开头的行
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('at ')) {
        return trimmed;
      }
    }

    // 如果没有找到标准格式，返回 stack 第一行
    return lines[0]?.trim() || null;
  }

  /**
   * 简单的 hash 函数（djb2 算法）
   */
  private simpleHash(str: string): string {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) + hash + char; // hash * 33 + char
    }
    // 转为正数并转为 16 进制
    return (hash >>> 0).toString(16);
  }

  /**
   * 检查缓存大小，超出则删除最旧的
   */
  private checkCacheSize(): void {
    if (this.cache.size <= this.options.maxCacheSize) {
      return;
    }

    // 按时间排序，删除最旧的 10%
    const entries = Array.from(this.cache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

    const deleteCount = Math.floor(this.options.maxCacheSize * 0.1);
    for (let i = 0; i < deleteCount; i++) {
      this.cache.delete(entries[i][0]);
    }
  }

  /**
   * 启动定期清理
   */
  private startCleanup(): void {
    // 每 30 秒清理一次过期缓存
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired();
    }, 30000);
  }

  /**
   * 清理过期缓存
   */
  private cleanupExpired(): void {
    const now = Date.now();
    const expired: string[] = [];

    this.cache.forEach((cached, hash) => {
      if (now - cached.timestamp > this.options.timeWindow) {
        expired.push(hash);
      }
    });

    expired.forEach((hash) => this.cache.delete(hash));
  }

  /**
   * 获取统计信息
   */
  public getStats() {
    const errors = Array.from(this.cache.values());
    const totalCount = errors.reduce((sum, e) => sum + e.count, 0);
    const duplicateCount = totalCount - errors.length;

    return {
      uniqueErrors: errors.length,
      totalErrors: totalCount,
      duplicates: duplicateCount,
      cacheSize: this.cache.size,
      duplicateRate:
        totalCount > 0
          ? ((duplicateCount / totalCount) * 100).toFixed(2) + '%'
          : '0%',
    };
  }
}

/**
 * 创建全局单例去重器
 */
let globalDeduplicator: ErrorDeduplicator | null = null;

export function getGlobalDeduplicator(
  options?: ErrorDeduplicatorOptions,
): ErrorDeduplicator {
  if (!globalDeduplicator) {
    globalDeduplicator = new ErrorDeduplicator(options);
  }
  return globalDeduplicator;
}

export function resetGlobalDeduplicator(): void {
  if (globalDeduplicator) {
    globalDeduplicator.stop();
    globalDeduplicator = null;
  }
}
