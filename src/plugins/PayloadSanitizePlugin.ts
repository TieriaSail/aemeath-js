/**
 * PayloadSanitize 插件 — 日志源头的载荷清洗
 *
 * 1.x backport：**默认关闭**，需通过 `initAemeath({ payloadSanitize: true })`
 * 或 `logger.use(new PayloadSanitizePlugin())` 显式启用。启用后放在管道里所有
 * 采集类插件之后、`BeforeSendPlugin` 之前，因此用户写 `beforeSend` 时面对的
 * 已经是"干净的骨架"，不必自己处理 Data URL / 二进制。
 *
 * 行为见 `src/utils/payloadSanitize.ts`：
 * - Data URL / Blob / ArrayBuffer → 结构化占位符
 * - 单字段超过 `maxBytes` → 整条拒绝（console.error + `payload:rejected` 事件
 *   + 走 UploadPlugin 的 `onDrop` / `upload:drop`，原因 `payload-too-large`）
 * - 整包超过 `maxBytes` → 按字段拆成多条（console.warn + `payload:split` 事件）
 */

import type { AemeathPlugin, AemeathInterface, AfterLogResult, LogEntry } from '../types';
import { PluginPriority } from '../types';
import type { UploadPlugin, UploadDropInfo } from './UploadPlugin';
import {
  sanitizeLogEntry,
  normalizeMaxBytes,
  type PayloadSanitizeOptions,
} from '../utils/payloadSanitize';

/** 同一类问题最多连续提示几次，之后只计数不刷屏 */
const CONSOLE_WARN_LIMIT = 3;

export interface PayloadSanitizePluginOptions extends PayloadSanitizeOptions {
  /** 是否输出调试信息（每条被清洗的日志都会打印） @default false */
  debug?: boolean;
}

export interface PayloadSanitizeStats {
  /** 处理过的日志总数 */
  processed: number;
  /** 发生过 Data URL / 二进制替换的日志数 */
  sanitized: number;
  /** 被拆分的日志数（原始条数，不是分片数） */
  split: number;
  /** 拆分产生的分片总数 */
  splitChunks: number;
  /** 因单字段超限被拒绝的日志数 */
  rejected: number;
}

export class PayloadSanitizePlugin implements AemeathPlugin {
  readonly name = 'payload-sanitize';
  readonly version = '1.10.0';
  /** 采集类插件之后、BeforeSendPlugin（LATEST）之前 */
  readonly priority: number = PluginPriority.LATEST - 100;
  readonly description = '载荷清洗（Data URL / 二进制占位、超限拆分或拒绝）';

  private readonly maxBytes: number;
  private readonly debugEnabled: boolean;
  private logger: AemeathInterface | null = null;

  private stats: PayloadSanitizeStats = {
    processed: 0,
    sanitized: 0,
    split: 0,
    splitChunks: 0,
    rejected: 0,
  };

  private splitWarnings = 0;
  private rejectWarnings = 0;
  private stripNoticeShown = false;

  constructor(options: PayloadSanitizePluginOptions = {}) {
    // 与 sanitizeLogEntry 用同一套归一化：这里若放行小数或过小的值，
    // 插件报告的 maxBytes 会和实际生效的不是一个数
    this.maxBytes = normalizeMaxBytes(options.maxBytes);
    this.debugEnabled = options.debug ?? false;
  }

  install(logger: AemeathInterface): void {
    this.logger = logger;
  }

  uninstall(): void {
    this.logger = null;
  }

  /** 已处理 / 已清洗 / 已拆分 / 已拒绝的计数 */
  getStats(): PayloadSanitizeStats {
    return { ...this.stats };
  }

  afterLog(entry: LogEntry): AfterLogResult {
    this.stats.processed++;

    let result;
    try {
      result = sanitizeLogEntry(entry, { maxBytes: this.maxBytes });
    } catch (err) {
      // 清洗本身出问题时放行原始日志：宁可大一点，也不要因为清洗器的 bug 丢日志
      this.debug('sanitize failed, passing through:', err);
      return undefined;
    }

    if (result.strips.length > 0) {
      this.stats.sanitized++;
      this.noticeStrips(result);
    }

    if (result.status === 'ok') {
      return result.entries[0] === entry ? undefined : result.entries[0];
    }

    if (result.status === 'rejected') {
      this.stats.rejected++;
      this.reportRejected(entry, result.field, result.fieldBytes, result.bytes, result.budget);
      return false;
    }

    this.stats.split++;
    this.stats.splitChunks += result.entries.length;
    this.reportSplit(entry, result.entries.length, result.bytes);
    return result.entries;
  }

  private noticeStrips(result: { strips: Array<{ path: string; kind: string; bytes: number }> }): void {
    if (this.debugEnabled) {
      console.log('[Aemeath:payload-sanitize] stripped', result.strips);
      return;
    }
    if (this.stripNoticeShown) return;
    this.stripNoticeShown = true;
    if (typeof console === 'undefined' || !console.info) return;
    const first = result.strips[0]!;
    console.info(
      `[Aemeath] Replaced an unloggable value at "${first.path}" (${first.kind}) with a short placeholder. `
        + 'Data URLs, Blob/ArrayBuffer values, circular references and unserializable objects are '
        + 'substituted so logs stay within the upload size budget and always serialize. '
        + '(Shown once per session.)',
    );
  }

  private reportSplit(entry: LogEntry, chunks: number, bytes: number): void {
    this.logger?.emit('payload:split', {
      splitId: entry.logId,
      chunks,
      bytes,
      maxBytes: this.maxBytes,
    });

    if (typeof console === 'undefined' || !console.warn) return;
    if (this.splitWarnings >= CONSOLE_WARN_LIMIT) return;
    this.splitWarnings++;
    const suffix =
      this.splitWarnings === CONSOLE_WARN_LIMIT
        ? ' (Further split warnings are suppressed; see PayloadSanitizePlugin.getStats().)'
        : '';
    console.warn(
      `[Aemeath] Log "${entry.logId}" is ${bytes} bytes, above the ${this.maxBytes}-byte upload budget. `
        + `It was split into ${chunks} entries linked by tags.splitId — no content was dropped. `
        + `Reduce the log size or raise \`payloadSanitize.maxBytes\` if your backend allows it.${suffix}`,
    );
  }

  private reportRejected(
    entry: LogEntry,
    field: string,
    fieldBytes: number,
    bytes: number,
    budget: number,
  ): void {
    this.logger?.emit('payload:rejected', {
      logId: entry.logId,
      field,
      fieldBytes,
      bytes,
      maxBytes: this.maxBytes,
      // 真正生效的上限：扣掉上报字段预留和骨架开销之后剩给单个字段的空间
      budget,
    });

    // 启用后唯一会丢日志的路径，必须并入宿主已经在监听的那个出口。
    // 只发 payload:rejected 的话，只接了 onDrop 的集成会以为这条日志从未存在过。
    this.reportDrop(entry, {
      reason: 'payload-too-large',
      error: `field "${field}" is ${fieldBytes} bytes (limit ${budget})`,
    });

    if (typeof console === 'undefined' || !console.error) return;
    if (this.rejectWarnings >= CONSOLE_WARN_LIMIT) return;
    this.rejectWarnings++;
    const suffix =
      this.rejectWarnings === CONSOLE_WARN_LIMIT
        ? ' (Further rejection errors are suppressed; see PayloadSanitizePlugin.getStats().)'
        : '';
    console.error(
      `[Aemeath] Log "${entry.logId}" was DROPPED: field "${field}" alone is ${fieldBytes} bytes, `
        + `above the ${budget}-byte limit for a single field. A single field cannot be split, so the `
        + 'whole entry is unsendable. Split the data across fields, store it elsewhere and log a '
        + `reference, or raise \`payloadSanitize.maxBytes\` (currently ${this.maxBytes}; the per-field `
        + 'limit is lower because it excludes the entry envelope and the metadata added at upload time)'
        + `.${suffix}`,
    );
  }

  /**
   * 丢弃汇报统一走 UploadPlugin 的出口
   *
   * 宿主只需要关心一个 `onDrop` / 一个 `upload:drop`，不必分辨这条日志是死在
   * 队列里、持久层里，还是根本没能通过体积检查。UploadPlugin 不在时退回裸事件，
   * 不要求宿主必须装上传插件。
   */
  private reportDrop(log: LogEntry, info: UploadDropInfo): void {
    const upload = this.logger?.getPluginInstance('upload') as UploadPlugin | undefined;
    if (upload && typeof upload.reportExternalDrop === 'function') {
      // 已卸载的 UploadPlugin 会拒接，这时候要退回自己发事件
      if (upload.reportExternalDrop(log, info) !== false) return;
    }
    this.logger?.emit('upload:drop', { log, ...info });
  }

  private debug(...args: unknown[]): void {
    if (this.debugEnabled) {
      console.log('[Aemeath:payload-sanitize]', ...args);
    }
  }
}
