/**
 * 早期错误统一转发 helper
 *
 * 把早期错误脚本（`window.__EARLY_ERRORS__`）捕获到的一条 EarlyError
 * 转发为主 Logger 的标准日志条目。
 *
 * 设计目标：
 * 让所有入口（npm 单例 `singleton/index.ts` 通过 `EarlyErrorCapturePlugin`、
 * 独立 IIFE bundle `browser/index.ts` 内联调用）产出**完全相同**的 LogEntry，
 * 这样无论用户从哪个入口接入 aemeath-js，服务端聚合 / 报表 / 告警规则都对齐。
 *
 * 历史背景：v2.4.0-beta.2 之前，两个入口各写各的转发逻辑，schema 显著不同：
 *
 * | 字段                       | 旧 singleton            | 旧 browser bundle              |
 * | -------------------------- | ----------------------- | ------------------------------ |
 * | `entry.message`            | `"Early ${type} error"` | `err.message`                  |
 * | `entry.error`              | 完整 ErrorInfo + 扩展   | 不存在                         |
 * | `entry.tags.errorCategory` | `"early"`（自动识别）   | 不存在                         |
 * | `entry.tags.source`        | 不存在                  | `"early-error"`                |
 * | `entry.context`            | 不存在                  | 扁平 dict                      |
 * | `level`                    | 全部 `error`            | resource 用 `warn`，其余 error |
 *
 * 这导致同一份早期错误在两个入口下，看板里聚合不到一起、按 level 过滤丢条目。
 *
 * 统一方案（v2.4.0-beta.3+）：
 * - **canonical schema = 旧 singleton 的 `{ error: err }` 形态**
 *   - 让 ErrorCapturePlugin / Logger 自动 normalize → 自动识别 `errorCategory: 'early'`
 *   - err 上挂的扩展属性（`type` / `filename` / `lineno` / `colno` / `source` /
 *     `earlyError` / `captureTimestamp` / `device`）通过 `normalizeError()`
 *     完整保留到 `entry.error.{...}`，全部可查询
 * - **additive 加 `tags: { source: 'early-error' }`**
 *   - 旧 singleton 没有这个 tag，旧 browser 已经有 → 现在两者都有
 *   - 不删 `errorCategory: 'early'`（依旧由 `identifyErrorCategory()` 自动注入）
 *
 * 行为变更（仅影响 IIFE bundle 用户）：
 * - resource 错误的 `level` 由 `warn` → `error`
 *   旧 browser 把 `<img onerror>` 这类资源加载失败标为 warn，
 *   现在统一标为 error，与 singleton 行为对齐。如需 warn 级别可在
 *   `beforeSend` 钩子里降级。
 * - `entry.message` 由 `err.message` → `"Early ${type} error"`
 *   原始错误文本仍然保留在 `entry.error.value`，按 message 聚合的
 *   看板需要切到 `entry.error.value` 维度。
 * - `entry.context` 不再被预先填入扁平字段
 *   `errorType` / `filename` / `lineno` / `colno` / `source` / `timestamp` /
 *   `device` 现在统一在 `entry.error.{...}` 下查询。
 * - `compatibility` 类型的早期错误现在也会被转发（旧 browser 路径会丢弃）
 *   与 singleton 行为对齐。如需过滤，可在 `beforeSend` 里：
 *   `(entry) => entry.error?.type === 'compatibility' ? null : entry`
 *
 * 发行时请在本仓库发行说明（changelog）中保留「browser IIFE bundle 早期错误
 * schema 对齐」条目，便于升级用户对照迁移。
 */

import type { EarlyError } from '../platform/types';
import type { AemeathInterface } from '../types';

/**
 * Error 上的扩展属性。`Logger.normalizeError()` 会拷贝所有 own properties
 * （除 `message` / `name` / `stack` 外）到 `entry.error.{...}`。
 *
 * `device` 字段的形状与 EarlyError['device'] 严格对齐，避免后续 EarlyError
 * 增加字段时这里漏掉同步。
 */
interface EarlyErrorExtended extends Error {
  type?: EarlyError['type'];
  filename?: string;
  lineno?: number;
  colno?: number;
  source?: string;
  earlyError?: boolean;
  captureTimestamp?: number;
  device?: EarlyError['device'];
}

/**
 * 把单条早期错误转发到主 Logger，产出标准 LogEntry。
 *
 * 调用方应已经确认：
 * 1. `platform.earlyCapture.isInstalled() === true`（即构建插件已注入早期脚本）
 * 2. 路由匹配通过（如有）
 * 3. `errors.length > 0`
 *
 * 失败容忍：所有字段访问都是防御性的，不会因为 EarlyError 字段缺失而抛错。
 *
 * @param logger 主 Logger 实例（必须已 install）
 * @param earlyError 早期错误脚本捕获的单条记录
 */
export function forwardEarlyError(
  logger: AemeathInterface,
  earlyError: EarlyError,
): void {
  const err = new Error(earlyError.message || 'Early error') as EarlyErrorExtended;
  // stack: 早期脚本可能拿不到 stack（旧浏览器、跨域脚本），保持 undefined 而非 'null'
  err.stack = earlyError.stack ?? undefined;
  err.type = earlyError.type;
  err.filename = earlyError.filename;
  err.lineno = earlyError.lineno;
  err.colno = earlyError.colno;
  err.source = earlyError.source;
  err.earlyError = true;
  err.captureTimestamp = earlyError.timestamp;
  err.device = earlyError.device;

  logger.error(`Early ${earlyError.type} error`, {
    error: err,
    // additive：仅追加 source 标签，不覆盖 errorCategory（由 Logger 自动识别为 'early'）
    tags: { source: 'early-error' },
  });
}
