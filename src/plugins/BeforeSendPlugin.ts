/**
 * BeforeSend 插件 — 全链路日志最终拦截
 *
 * 设计原则：
 * 1. 复用插件机制（不污染 Logger 核心）
 * 2. 通过 priority: LATEST 确保在所有其他插件 afterLog 之后执行
 * 3. 用户钩子内的异常**静默吞掉**，永远不阻塞主管道
 * 4. 支持运行时动态切换钩子（setHook / clearHook）
 *
 * 主要使用场景：
 * - 隐私保护 / 数据脱敏（敏感字段、token、URL 参数）
 * - 业务过滤（丢弃噪音日志）
 * - 字段补充（统一加 traceId / sessionId）
 *
 * 详细文档参见 docs/{zh,en}/9-before-send.md
 */

import type {
  AemeathPlugin,
  AemeathInterface,
  LogEntry,
  AfterLogResult,
  BeforeSendHook,
} from '../types';
import { PluginPriority } from '../types';

export interface BeforeSendPluginOptions {
  /**
   * 钩子函数（可选；后续可通过 `plugin.setHook(...)` 动态设置）
   *
   * @see BeforeSendHook
   */
  beforeSend?: BeforeSendHook;

  /**
   * 是否在钩子异常时打印到控制台（默认 false，完全静默）
   *
   * 仅用于开发阶段调试，生产环境应保持 false。
   */
  debug?: boolean;
}

export class BeforeSendPlugin implements AemeathPlugin {
  readonly name = 'before-send';
  readonly version = '1.5.0';
  readonly priority: number = PluginPriority.LATEST;
  readonly description = '全链路日志最终拦截（隐私脱敏 / 过滤 / 字段补充）';

  private hook: BeforeSendHook | null;
  private debug: boolean;

  constructor(options: BeforeSendPluginOptions = {}) {
    this.hook = options.beforeSend ?? null;
    this.debug = options.debug ?? false;
  }

  install(_logger: AemeathInterface): void {
    // 无需在 install 时做任何事；钩子通过 afterLog 生效
  }

  uninstall(_logger: AemeathInterface): void {
    this.hook = null;
  }

  /**
   * 运行时设置 / 替换钩子函数
   *
   * 适合下面场景：
   * - 用户登录后才能拿到完整的脱敏规则
   * - 不同业务页面切换不同的过滤规则
   *
   * @example
   *   const plugin = logger.getPluginInstance('before-send') as BeforeSendPlugin;
   *   plugin.setHook((entry) => ({ ...entry, message: redact(entry.message) }));
   */
  setHook(hook: BeforeSendHook | null): void {
    this.hook = hook;
  }

  /**
   * 运行时清除钩子（恢复"原样放行"）
   */
  clearHook(): void {
    this.hook = null;
  }

  /**
   * 获取当前钩子（主要用于测试）
   */
  getHook(): BeforeSendHook | null {
    return this.hook;
  }

  /**
   * 在所有插件之后、listener 之前调用
   *
   * fail-safe 策略：
   * - 钩子未设置 → 原样返回
   * - 钩子返回 null → 拦截（返回 false 让 Logger 跳过 listener）
   * - 钩子返回 LogEntry → 使用新 entry
   * - 钩子返回 undefined / void → 原样返回
   * - 钩子抛出异常 → 静默吞掉，原样返回（永不阻塞主管道）
   */
  afterLog(entry: LogEntry): AfterLogResult {
    const hook = this.hook;
    if (!hook) return entry;

    let result: LogEntry | null | undefined | void;
    try {
      result = hook(entry);
    } catch (err) {
      if (this.debug && typeof console !== 'undefined' && console.warn) {
        try {
          console.warn('[Aemeath] beforeSend hook threw:', err);
        } catch {
          // ignore
        }
      }
      return entry;
    }

    if (result === null) return false;
    if (result === undefined) return entry;

    // async (entry) => ... 会返回 Promise，主管道不 await，必须明确拒绝并提示
    const maybeThenable = result as { then?: unknown };
    if (typeof maybeThenable.then === 'function') {
      if (typeof console !== 'undefined' && console.warn) {
        try {
          console.warn(
            '[Aemeath] beforeSend returned a Promise / thenable. The hook must be synchronous; '
              + 'the async result was ignored. Remove `async` or precompute data before logging.',
          );
        } catch {
          // 用户可能 monkey-patch 了 console.warn；不让它把日志主管道拖下水
        }
      }
      return entry;
    }

    if (
      typeof result !== 'object' || !result
      || typeof (result as LogEntry).logId !== 'string'
      || typeof (result as LogEntry).level !== 'string'
    ) {
      // 与 async/thenable 一样：形态错误在任意环境都 warn，避免生产误以为脱敏已生效
      if (typeof console !== 'undefined' && console.warn) {
        try {
          console.warn(
            '[Aemeath] beforeSend hook returned an invalid value '
              + '(must be LogEntry with logId & level / null / undefined). '
              + 'Falling back to original entry.',
          );
        } catch {
          // ignore
        }
      }
      return entry;
    }

    return result as LogEntry;
  }
}
