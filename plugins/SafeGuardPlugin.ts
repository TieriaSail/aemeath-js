/**
 * 安全保护插件 - 防止 Logger 崩溃
 *
 * 体积：~3KB
 * 依赖：无
 * 功能：
 * - 递归错误保护
 * - 频率限制
 * - 健康监控
 * - 自动恢复
 */

import type { AemeathPlugin, AemeathInterface } from '../types';

export interface SafeGuardPluginOptions {
  /** 最大错误数（超过后暂停 Logger） */
  maxErrors?: number;

  /** 重置间隔（ms） */
  resetInterval?: number;

  /** 频率限制（每秒最多记录多少条） */
  rateLimit?: number;

  /** 是否启用递归保护 */
  enableRecursionGuard?: boolean;
}

type SafeGuardPluginConfig = Required<SafeGuardPluginOptions>;

interface HealthStatus {
  isHealthy: boolean;
  isPaused: boolean;
  errorCount: number;
  logCount: number;
  uptime: number;
}

export class SafeGuardPlugin implements AemeathPlugin {
  readonly name = 'safe-guard';
  readonly version = '1.0.0';
  readonly description = '安全保护';

  private readonly config: SafeGuardPluginConfig;
  private logger: AemeathInterface | null = null;
  private errorCount = 0;
  private logCount = 0;
  private lastLogTime = Date.now();
  private isPaused = false;
  private isLogging = false;
  private resetTimer: ReturnType<typeof setInterval> | null = null;
  private readonly startTime = Date.now();

  // 绑定后的事件处理函数引用（用于正确移除监听器）
  private boundHandleLog: (() => void) | null = null;
  private boundHandleError: (() => void) | null = null;
  private boundGetHealth: (() => HealthStatus) | null = null;
  private boundPause: (() => void) | null = null;
  private boundResume: (() => void) | null = null;

  constructor(options: SafeGuardPluginOptions = {}) {
    this.config = {
      maxErrors: options.maxErrors ?? 100,
      resetInterval: options.resetInterval ?? 60000,
      rateLimit: options.rateLimit ?? 100,
      enableRecursionGuard: options.enableRecursionGuard ?? true,
    };
  }

  install(logger: AemeathInterface): void {
    this.logger = logger;

    // 创建绑定后的事件处理函数引用
    this.boundHandleLog = this.handleLog.bind(this);
    this.boundHandleError = this.handleError.bind(this);
    this.boundGetHealth = this.getHealth.bind(this);
    this.boundPause = this.pause.bind(this);
    this.boundResume = this.resume.bind(this);

    // 监听日志事件
    logger.on('log', this.boundHandleLog);

    // 监听错误事件
    logger.on('error', this.boundHandleError);

    // 定期重置计数器
    this.resetTimer = setInterval(() => {
      this.reset();
    }, this.config.resetInterval);

    // 添加健康检查 API
    (logger as any).getHealth = this.boundGetHealth;
    (logger as any).pause = this.boundPause;
    (logger as any).resume = this.boundResume;
  }

  uninstall(logger: AemeathInterface): void {
    if (this.resetTimer) {
      clearInterval(this.resetTimer);
      this.resetTimer = null;
    }

    // 使用保存的引用正确移除监听器
    if (this.boundHandleLog) {
      logger.off('log', this.boundHandleLog);
      this.boundHandleLog = null;
    }
    if (this.boundHandleError) {
      logger.off('error', this.boundHandleError);
      this.boundHandleError = null;
    }

    delete (logger as any).getHealth;
    delete (logger as any).pause;
    delete (logger as any).resume;

    this.boundGetHealth = null;
    this.boundPause = null;
    this.boundResume = null;
    this.logger = null;
  }

  private handleLog(): void {
    // 递归保护
    if (this.config.enableRecursionGuard && this.isLogging) {
      const warning = new Error('[SafeGuard] 检测到递归日志调用，已忽略');
      // 🛡️ 标记为日志系统内部错误
      (warning as any)._isAemeathInternalError = true;
      console.warn(warning.message);
      return;
    }

    // 暂停检查
    if (this.isPaused) {
      return;
    }

    this.isLogging = true;
    this.logCount++;

    // 频率限制
    const now = Date.now();
    const timeSinceLastLog = now - this.lastLogTime;

    if (timeSinceLastLog < 1000) {
      const logsPerSecond = this.logCount / (timeSinceLastLog / 1000);
      if (logsPerSecond > this.config.rateLimit) {
        this.pause();
        const warning = new Error('[SafeGuard] 日志频率过高，已暂停 Logger');
        // 🛡️ 标记为日志系统内部错误
        (warning as any)._isAemeathInternalError = true;
        console.warn(warning.message);
      }
    }

    this.lastLogTime = now;
    this.isLogging = false;
  }

  private handleError(): void {
    this.errorCount++;

    // 错误数过多，暂停 Logger
    if (this.errorCount > this.config.maxErrors) {
      this.pause();
      const error = new Error('[SafeGuard] 错误数过多，已暂停 Logger');
      // 🛡️ 标记为日志系统内部错误
      (error as any)._isAemeathInternalError = true;
      console.error(error.message);
    }
  }

  private reset(): void {
    this.errorCount = 0;
    this.logCount = 0;

    // 如果已暂停，自动恢复
    if (this.isPaused) {
      this.resume();
    }
  }

  /**
   * 暂停 Logger
   */
  pause(): void {
    this.isPaused = true;
    this.logger?.emit('paused');
  }

  /**
   * 恢复 Logger
   */
  resume(): void {
    this.isPaused = false;
    this.errorCount = 0;
    this.logCount = 0;
    this.logger?.emit('resumed');
  }

  /**
   * 获取健康状态
   */
  getHealth(): HealthStatus {
    return {
      isHealthy:
        !this.isPaused && this.errorCount < this.config.maxErrors * 0.8,
      isPaused: this.isPaused,
      errorCount: this.errorCount,
      logCount: this.logCount,
      uptime: Date.now() - this.startTime,
    };
  }
}

// 扩展 Logger 接口（用于 TypeScript 类型提示）
declare module '../types' {
  interface AemeathInterface {
    getHealth?(): HealthStatus;
    pause?(): void;
    resume?(): void;
  }
}
