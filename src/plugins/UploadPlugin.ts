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

import type {
  AemeathPlugin,
  LogEntry,
  LogTags,
  AemeathInterface,
  AemeathEventMap,
} from '../types';
import { PluginPriority } from '../types';
import type { PlatformAdapter } from '../platform/types';
import { generateId } from '../utils/generateId';
import { getSdkSplitId } from '../utils/splitIdentity';
import {
  beginIgnoreNetworkCapture,
  endIgnoreNetworkCapture,
} from '../utils/ignoreNetworkCapture';
import { getCrossTabDeliveryCapability } from './offline/CrossTabCapability';

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

  /** 退避后的最早可尝试时间（不设置表示立即可尝试） */
  nextAttemptAt?: number;

  /** 服务端 Retry-After 的协议期限；本地 flush 也不得绕过。 */
  serverNotBefore?: number;

  /**
   * 本条日志连续遭遇传输层失败的次数
   *
   * 传输层失败不消耗 `retryCount`，所以必须另有一个计数来保证终止：
   * 全局的 `consecutiveFailures` 会被任何一条成功 / 明确拒绝的日志清零，
   * 只靠它的话，一条日志可能永远达不到暂停阈值而无限重试。
   */
  transportAttempts?: number;

  /** 入队来源（`requeue()` 传入；离线补传为 `offline-replay`） */
  source?: string;

  /** 进入冷却等待区的次数（用于跨周期退避） */
  parkCount?: number;

  /** 冷却等待结束时刻；存在时表示该条当前位于 parked 区 */
  parkedUntil?: number;

  /** 最近一次可重试失败的归一化原因 */
  lastRetryReason?: UploadRetryReason;

  /** 2.6 持久恢复领取回执；只存在于内存，不进入 Upload cache。 */
  deliveryReceipt?: DurableDeliveryReceipt;

  /** 当前页面已发起的真实网络调用序号；持久恢复项以 receipt 返回值为准。 */
  deliveryAttempt?: number;
  /** 仅在内存中标记该项来自本次 Upload cache hydrate。 */
  restoredFromCache?: boolean;
}

interface PendingSplitAdmission {
  expectedTotal: number;
  items: Map<number, QueuedLog>;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 队列容量的最小决策单元。
 *
 * 普通日志可以单条淘汰；已完成和接纳中的分片组必须整组淘汰，避免容量压力
 * 把一个可重组的日志撕成永远无法恢复的孤片。
 */
interface CapacityUnit {
  key: string;
  kind: 'resident' | 'admission' | 'incoming';
  members: QueuedLog[];
  first: QueuedLog;
  splitId?: string;
}

/**
 * 失败原因语义
 *
 * - `network`：传输层失败（不可达 / 超时 / DNS），与日志内容无关，**不消耗重试预算**
 * - `server`：服务端明确响应了可恢复失败（5xx / 业务错误码），消耗热重试预算
 * - `payload`：日志本身有问题（400 / 413 / 字段非法），重试无意义
 * - 其余原因把认证、限流、取消和回调异常分开，便于观测与调度
 */
export type UploadRetryReason =
  | 'network'
  | 'server'
  | 'payload'
  | 'auth'
  | 'rate-limit'
  | 'unknown'
  | 'callback-error'
  | 'cancelled';

type RetryableUploadReason = Exclude<UploadRetryReason, 'payload'>;

interface NormalizedUploadFailure {
  terminal: boolean;
  reason: UploadRetryReason;
  error: string;
  retryAfterMs?: number;
}

/**
 * 日志被丢弃的原因
 */
export type UploadDropReason =
  /** 服务端明确表示不必重试（`shouldRetry: false` 或 `retryReason: 'payload'`） */
  | 'no-retry'
  /** legacy 策略下重试预算耗尽 */
  | 'max-retries'
  /** 队列超过 maxSize，挤掉了优先级最低的日志 */
  | 'queue-overflow'
  /** 本地缓存中的日志已超过 TTL */
  | 'cache-expired'
  /** 离线持久化存储配额已满（由 OfflinePersistencePlugin 触发） */
  | 'storage-quota'
  /** 日志本身无法被持久化引擎接受（非配额问题） */
  | 'storage-rejected'
  /** 单字段体积超限，无法上报（由 PayloadSanitizePlugin 触发） */
  | 'payload-too-large'
  /** legacy 离线补传反复失败，放弃该条（由 OfflinePersistencePlugin 触发） */
  | 'offline-give-up'
  /** SDK 主动合并了内容相同的日志；这是可观测的本地终态。 */
  | 'deduplicated';

/**
 * 丢弃事件的附加信息
 */
export interface UploadDropInfo {
  reason: UploadDropReason;
  /** 已消耗的重试次数 */
  retryCount?: number;
  /** 最后一次失败的错误描述 */
  error?: string;
  /** 该条日志的入队来源（离线补传为 `offline-replay`） */
  source?: string;
}

/**
 * 丢弃回调
 *
 * 在日志被 UploadPlugin 放弃**之前**调用，宿主可以借此自救
 * （落 IndexedDB、转交原生端、计数上报）。同一时刻还会 emit
 * `upload:drop` 事件，两者等价，按喜好二选一。
 */
export type UploadDropCallback = (log: LogEntry, info: UploadDropInfo) => void;

/**
 * 上传结果
 */
export interface UploadResult {
  /** 是否成功 */
  success: boolean;
  /** 是否需要重试（仅在 success = false 时有效） */
  shouldRetry?: boolean;
  /**
   * 失败分类（可选）：决定调度与观测，不取代 `shouldRetry` 的意图表达。
   *
   * `shouldRetry: true` 且省略本字段时归为 `unknown`；只传非 `payload` 原因也视为
   * 明确的重试意图。传 `network` 可以让这次失败不消耗热重试预算。
   */
  retryReason?: UploadRetryReason;
  /**
   * 服务端建议的最短重试等待时间（毫秒）。
   *
   * 与 `retryAfter` 同时提供时，本字段优先，适合已经由业务代码换算完成的场景。
   */
  retryAfterMs?: number;
  /**
   * 原始 HTTP `Retry-After` 响应头。
   *
   * 支持标准的 delta-seconds（如 `"120"`）与 HTTP-date。UploadPlugin 不拥有
   * 用户的 fetch/XHR 响应，因此由回调把原始头值交进来，解析和调度由 SDK 完成。
   */
  retryAfter?: string | null;
  /** 错误信息 */
  error?: string;
}

export interface UploadQueueStatusItem {
  logId: string;
  capturedAt: number;
  priority: number;
  retryCount: number;
  level: string;
  state: 'admitting' | 'queued' | 'in-flight' | 'parked';
}

export interface UploadQueueStatus {
  /** 活跃队列中的条数；不含 in-flight 与 parked */
  length: number;
  inFlight: number;
  parked: number;
  /** 正在等待分片组收齐、尚不可执行的实际条数。 */
  admitting: number;
  maxSize: number;
  isProcessing: boolean;
  /** 是否因判定离线或正在半开探测而暂停正常消费 */
  paused: boolean;
  consecutiveFailures: number;
  drops: { total: number; byReason: Record<string, number> };
  /** 本会话发起的上传尝试，以及已结束尝试的结果分类 */
  attempts: { total: number; byReason: Record<string, number> };
  oldestPendingAgeMs: number;
  /**
   * 活跃队列快照（不含 in-flight 与 parked）。
   *
   * 保留旧版语义：`items.length === length`，避免补丁版本破坏现有监控代码。
   */
  items: UploadQueueStatusItem[];
  /** 全部未完成项（admitting + queued + in-flight + parked），供统一状态去重 */
  pendingItems?: UploadQueueStatusItem[];
}

/**
 * 持久恢复插件与 UploadPlugin 之间的最小租约协议。
 *
 * UploadPlugin 不知道租约来自多标签、Service Worker 还是其它持久调度器；
 * 它只在真实网络调用和结果转换点提交状态。协议为可选项，普通上传不进入该路径。
 */
export interface DurableDeliveryReceipt {
  readonly logId: string;
  isSettled(): boolean;
  beginAttempt(now?: number): Promise<number | null>;
  renew(now?: number): Promise<boolean>;
  succeed(): Promise<boolean>;
  retry(update: DurableDeliveryUpdate): Promise<boolean>;
  retryScheduled(update: DurableDeliveryUpdate): Promise<boolean>;
  park(update: DurableDeliveryUpdate): Promise<boolean>;
  terminal(): Promise<boolean>;
}

export interface DurableDeliveryUpdate {
  nextEligibleAt: number;
  serverNotBefore?: number;
  replayAttempts?: number;
  parkCount?: number;
  lastRetryReason?: string;
}

/**
 * 已由 OfflineStore 原子领取的恢复项。
 *
 * 这是内部恢复协议，不等同于普通 requeue：分片组可能已经有部分成员在上一任
 * leader 中成功，因此这里只校验剩余成员自身坐标，不再要求数量等于 splitTotal。
 */
export interface CoordinatedRecoveryItem {
  log: LogEntry;
  priority?: number;
  receipt: DurableDeliveryReceipt;
}

export interface RecoveryCacheItem {
  log: LogEntry;
  priority: number;
  parkedUntil?: number;
  serverNotBefore?: number;
  parkCount?: number;
  nextAttemptAt?: number;
  lastRetryReason?: UploadRetryReason;
}

/**
 * 上传回调函数
 *
 * @param log - 要上传的日志
 * @returns UploadResult - 明确的上传结果
 */
/**
 * 实际交给上传回调的副本。核心 LogEntry 保持稳定；只有持久领取的网络尝试才带
 * deliveryAttempt，服务端可用它观察同一 logId 的投递世代。
 */
export interface UploadPayload extends LogEntry {
  deliveryAttempt?: number;
}

export type UploadCallback = (log: UploadPayload) => Promise<UploadResult>;

export interface UploadBindingOptions {
  /**
   * 投递目标的稳定作用域（项目/租户标识）。改变作用域时，只要仍有待投递日志就会
   * 拒绝切换，防止旧租户日志被新 endpoint 接收。省略表示仍是当前作用域。
   */
  deliveryScope?: string;
}

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
   *   return classifyHttpUploadResponse(res.status, res.headers.get('Retry-After'));
   * }
   * ```
   */
  onUpload: UploadCallback;

  /** 初始投递作用域；多租户必须同时使用独立 cache/db/key @default 'default' */
  deliveryScope?: string;

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
     * 上传失败后会降低优先级、按指数退避重试；默认策略下预算耗尽会进入
     * `parked` 冷却区，而不是丢弃。只有 `legacy` 策略仍以此作为生命周期上限。
     *
     * 注意分工：这个预算防的是**单条毒丸日志**（整体链路正常、只有这一条
     * 反复被服务端拒绝）。整条链路断掉的情况由 `offlinePolicy` 负责 ——
     * 那种场景下队列会暂停，根本不消耗这里的预算。
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

    /**
     * 网络不可用时的策略（默认：`'pause'`）
     *
     * - `'pause'`：判定离线时**暂停队列** —— 不调用 `onUpload`、不消耗重试预算、
     *   不丢弃任何日志；`online` 只放行一条半开探测，探测证明链路可达后继续。
     * - `'legacy'`：v2.4 及更早的行为 —— 不感知在线状态，失败即消耗重试预算，
     *   预算耗尽就丢弃。仅用于回归对比，不建议在生产使用。
     *
     * 切到 `'legacy'` 时 `retryBackoff` 也会默认关闭（除非显式指定）。
     */
    offlinePolicy?: 'pause' | 'legacy';

    /**
     * 重试退避（默认：开启，base 1s / max 30s）
     *
     * 关闭时失败日志会立刻重新排队，重试预算可能在一秒内被耗尽。
     */
    retryBackoff?: boolean | { baseMs?: number; maxMs?: number };

    /**
     * 连续失败多少次后判定为"疑似离线"并暂停队列（默认：3）
     *
     * `navigator.onLine` 在部分 WebView 里只反映"存在网络接口"而非"能连通"，
     * 因此除了它之外还需要这个启发式兜底。
     */
    suspectedOfflineThreshold?: number;
  };

  /**
   * 本地缓存配置
   *
   * ⚠️ 本地缓存解决的是**页面重载**导致的内存队列丢失（刷新、关闭后重开）。
   * 它本身**不提供断网续传**（缓存是队列镜像，日志一旦被丢弃就不在缓存里）。
   * 需要断网续传请使用 `OfflinePersistencePlugin`。
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

    /**
     * 缓存有效期（毫秒，默认：3600000 即 1 小时）
     *
     * 从**写入缓存的时刻**开始计算。超期的日志在恢复时会被丢弃，
     * 并触发 `onDrop(log, { reason: 'cache-expired' })`。
     */
    ttl?: number;
  };

  /**
   * 是否允许任何本地队列镜像。标准入口在 `offlinePersistence:false` 时传 false，
   * 从而让“本地不留存”同时覆盖 Upload cache 与 OfflinePersistence。
   * @internal
   */
  localPersistence?: boolean;

  /**
   * 日志被丢弃时的回调
   *
   * 生产环境下 UploadPlugin 的丢弃是静默的（`warn` 只在 debug 模式输出）。
   * 挂上这个回调（或监听 `upload:drop` 事件）才能知道"日志系统自己吞了多少条"。
   *
   * @example
   * ```ts
   * onDrop: (log, info) => {
   *   navigator.sendBeacon('/api/log-drops', JSON.stringify({ id: log.logId, ...info }));
   * }
   * ```
   */
  onDrop?: UploadDropCallback;

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

/** 本地缓存默认有效期：1 小时 */
const DEFAULT_CACHE_TTL = 60 * 60 * 1000;

/** 暂停后首次探测的间隔 */
const PROBE_BASE_MS = 5000;

/** 探测间隔上限（指数增长到此为止） */
const PROBE_MAX_MS = 60000;

/** 热重试预算耗尽后的冷却等待；与删除日志的生命周期彻底分开 */
const PARK_BASE_MS = 60_000;
const PARK_MAX_MS = 15 * 60_000;
const REJECTED_SPLIT_TTL_MS = 60_000;
const MAX_REJECTED_SPLIT_IDS = 1024;

/** 单次上传的超时上限 */
const UPLOAD_TIMEOUT_MS = 30000;

/** 浏览器与 Node setTimeout 都能安全表达的最大单段等待时间 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * 标记本插件自己抛出的上传超时
 *
 * 用打标而不是匹配错误文案：文案是给人看的，随时可能被改写或本地化，
 * 而它一旦和判定逻辑失配，超时就会从"暂停等网络"悄悄退化成"消耗重试预算"，
 * 且没有任何测试会红。
 */
const UPLOAD_TIMEOUT_TAG = '__aemeathUploadTimeout';

function isUploadTimeoutError(err: unknown): boolean {
  if (err == null || (typeof err !== 'object' && typeof err !== 'function'))
    return false;
  return (err as Record<string, unknown>)[UPLOAD_TIMEOUT_TAG] === true;
}

/** processQueue 自身崩溃后的最小重排间隔，防止热循环 */
const CRASH_BACKOFF_MS = 30000;

/**
 * 当前页面上已被占用的缓存 key
 *
 * 模块级共享。同一份 bundle 里 new 出来的多个实例都能看到彼此，
 * 从而发现"两个实例抢同一个 localStorage 条目"这种撞车。
 */
const CLAIMED_CACHE_KEYS = new Set<string>();

/**
 * 打上"这是日志系统内部错误"的标记
 *
 * ErrorCapturePlugin 靠它把 SDK 自己的异常排除在捕获之外。不打标的话，SDK 崩溃
 * 会被 SDK 自己捕获成宿主错误再上报，而上报又走同一条崩溃路径 —— 自噬循环。
 *
 * 不用 `instanceof Error` 判断：跨 realm（iframe、小程序容器）时它并不可靠，
 * 而恰恰是那种环境最需要这层保护。
 */
function markInternalError(err: unknown): void {
  if (err == null || (typeof err !== 'object' && typeof err !== 'function'))
    return;
  try {
    (err as Record<string, unknown>)['_isAemeathInternalError'] = true;
  } catch {
    /* 冻结对象：忽略即可，下面还有 stack 特征兜底 */
  }
}

/**
 * 抛出的异常是不是"根本没连上"
 *
 * 只在能**正面认定**为网络层失败时才返回 true，其余一律按服务端失败处理。
 * 方向是刻意选的：
 *
 * - 误判成服务端失败 → 消耗热重试预算，耗尽后进入 parked。有界、可观测。
 * - 误判成离线 → 整个队列暂停，上报静默停摆。无界、无声。
 *
 * 后者严重得多，所以举证责任在"离线"这一侧。这也堵住了最常见的一类误判：
 * axios / ky / got 默认对 4xx-5xx 抛异常 —— 那恰恰证明服务端回了话。
 *
 * 想要确定性而不是启发式，在 `onUpload` 里显式返回 `retryReason`。
 */
function isNetworkError(err: unknown): boolean {
  if (err == null) return false;
  const e = err as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    response?: unknown;
  };

  // 异常上挂着 response/status → 服务端答复过了，链路是通的
  if (e.response != null) return false;

  const name = String(e.name ?? '');
  // fetch 的网络失败是 TypeError，但用户回调自身的编程错误同样通常是 TypeError。
  // 仅凭 name 会把 `Cannot read properties of undefined` 之类的 bug 当成断网，
  // 达到阈值后冻结整条队列。这里再要求常见 fetch 网络失败文案；无法确认时按
  // callback-error 有界重试，比无期限暂停更安全。
  const message = String(e.message ?? '');
  if (
    name === 'TypeError' &&
    /(?:failed to fetch|fetch failed|networkerror when attempting to fetch resource|load failed|network request failed)/i.test(
      message,
    )
  ) {
    return true;
  }
  // 主动 Abort 不能作为整条链路断开的证据；它可能来自宿主取消、路由切换或卸载。
  // TimeoutError（含本插件自己的上传超时）仍属于传输层失败。
  if (name === 'TimeoutError') return true;

  // axios / node 风格的错误码
  const code = String(e.code ?? '');
  if (
    /^(ERR_NETWORK|ECONNABORTED|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)$/.test(
      code,
    )
  ) {
    return true;
  }

  return (e as Record<string, unknown>)[UPLOAD_TIMEOUT_TAG] === true;
}

function getHttpStatus(err: unknown): number | undefined {
  if (err == null || typeof err !== 'object') return undefined;
  const response = (err as { response?: unknown }).response;
  if (response == null || typeof response !== 'object') return undefined;
  const value = (response as { status?: unknown }).status;
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function getHttpRetryAfter(err: unknown): string | undefined {
  if (err == null || typeof err !== 'object') return undefined;
  const response = (err as { response?: unknown }).response;
  if (response == null || typeof response !== 'object') return undefined;
  const headers = (response as { headers?: unknown }).headers;
  if (headers == null || typeof headers !== 'object') return undefined;
  try {
    const getter = (headers as { get?: unknown }).get;
    if (typeof getter === 'function') {
      const value =
        getter.call(headers, 'Retry-After') ??
        getter.call(headers, 'retry-after');
      if (typeof value === 'string') return value;
      if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    }
    const record = headers as Record<string, unknown>;
    const value = record['retry-after'] ?? record['Retry-After'];
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string') return first;
    if (typeof first === 'number' && Number.isFinite(first))
      return String(first);
  } catch {
    // 第三方 Headers 实现可能有抛错 getter；分类仍可退回只使用 status。
  }
  return undefined;
}

function normalizeRetryAfterMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    return undefined;
  const milliseconds = Math.ceil(value);
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function deadlineAfter(delayMs: number, now: number = Date.now()): number {
  return Math.min(Number.MAX_SAFE_INTEGER, now + delayMs);
}

/**
 * 解析标准 HTTP `Retry-After` 响应头为相对毫秒数。
 *
 * - delta-seconds 必须是非负整数；
 * - HTTP-date 按调用时刻换算，已经过去的时间返回 0；
 * - 空值、非法值和超出安全数值范围的值返回 `undefined`。
 *
 * @param value 原始 `Retry-After` 响应头
 * @param now 当前 Unix 毫秒；参数主要用于确定性测试
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (raw.length === 0) return undefined;

  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    const milliseconds = seconds * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }

  // 防止 Date.parse 把 `-1`、`1.5` 之类非标准数值误解释成日期。
  if (!/[A-Za-z]{3}/.test(raw)) return undefined;
  const target = Date.parse(raw);
  if (!Number.isFinite(target)) return undefined;
  const base = Number.isFinite(now) ? now : Date.now();
  const milliseconds = Math.ceil(Math.max(0, target - base));
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

/**
 * 将 HTTP 响应状态稳定映射为 UploadPlugin 的投递语义。
 *
 * fetch、wx.request、uni.request 与 Taro 对 HTTP 非 2xx 的处理并不一致；接入方
 * 若只返回 `res.ok` / 只看 request 的 success 回调，会把 5xx 当终态丢弃，或把
 * 小程序的 5xx 当成功删除。统一入口同时透传 Retry-After，避免示例各写一套。
 */
export function classifyHttpUploadResponse(
  status: number,
  retryAfter?: string | null,
): UploadResult {
  if (!Number.isFinite(status) || status < 100 || status > 599) {
    return {
      success: false,
      shouldRetry: true,
      retryReason: 'unknown',
      retryAfter,
      error: 'Invalid HTTP status',
    };
  }
  if (Number.isFinite(status) && status >= 200 && status < 300) {
    return { success: true };
  }

  if (status === 401 || status === 403) {
    return {
      success: false,
      shouldRetry: true,
      retryReason: 'auth',
      retryAfter,
      error: `HTTP ${status}`,
    };
  }

  if (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  ) {
    return {
      success: false,
      shouldRetry: true,
      retryReason: status === 429 ? 'rate-limit' : 'server',
      retryAfter,
      error: `HTTP ${status}`,
    };
  }

  return {
    success: false,
    shouldRetry: false,
    retryReason: 'payload',
    error: `HTTP ${status}`,
  };
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
  readonly version = '2.6.0';
  readonly priority: number = PluginPriority.LATE;
  readonly description = '日志上传插件（回调方式）';

  private config: {
    onUpload: UploadCallback;
    getPriority: PriorityCallback;
    queue: {
      maxSize: number;
      concurrency: number;
      maxRetries: number;
      uploadInterval: number;
      deduplicationDelay: number;
      offlinePolicy: 'pause' | 'legacy';
      backoffBaseMs: number;
      backoffMaxMs: number;
      suspectedOfflineThreshold: number;
    };
    cache: { enabled: boolean; key: string; ttl: number };
    saveOnUnload: boolean;
    debug: boolean;
    onDrop: UploadDropCallback | null;
    deliveryScope: string;
  };
  private queue: QueuedLog[] = [];
  private isProcessing = false;
  /**
   * 生命周期世代：同实例 remount 时递增。
   * 旧 processQueue / attemptUpload 靠它自废，避免污染新一轮的暂停/忽略窗口。
   */
  private lifecycleEpoch = 0;
  private destroyed = false;
  /** flush() 等待当前 processQueue 结束 */
  private processingWaiters: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private deduplicationTimer: ReturnType<typeof setTimeout> | null = null;
  private debugEnabled: boolean;

  /** 队列因判定离线而暂停 */
  private paused = false;
  /** 业务通过 setOnUpload(null) 主动暂停；flush/online 都不得绕过 */
  private callbackPaused = false;
  /** 半开状态：只允许一次探测性上传，成功才完全恢复 */
  private halfOpen = false;
  /** 当前探测间隔（指数增长，上限 PROBE_MAX_MS） */
  private probeDelay = 0;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  /** 退避唤醒定时器 */
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** 热重试预算耗尽后的内存等待区；不参与活跃队列轮询 */
  private readonly parked = new Map<string, QueuedLog>();
  /** 唤醒最早到期 parked 条目的定时器 */
  private parkWakeTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 连续**传输层**失败次数，用于"疑似离线"判定
   *
   * 只统计请求没能到达服务端的失败。服务端回了 5xx 说明链路是通的，那种失败会
   * 把这个计数清零 —— 否则后端故障会被误判成用户断网。
   */
  private consecutiveFailures = 0;
  /** flush() 期间忽略退避与暂停 */
  private forceRun = false;
  private forceRunDepth = 0;
  private cacheSaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Upload cache → OfflineStore 的提交式所有权转移窗口。 */
  private recoveryCacheTransfer: QueuedLog[] | null = null;
  /** 协调状态提交重试链的活跃定时器；uninstall 必须能整体取消 */
  private readonly receiptRetryTimers = new Set<ReturnType<typeof setTimeout>>();
  /**
   * 本实例仍持有的 ignoreNetworkCapture 层数
   *
   * 与全局计数成对：uninstall 时必须强制揭开，否则挂死的 onUpload
   * 会让 NetworkPlugin 永久致盲。
   */
  private ignoreHolds = 0;

  /** 本实例实际认领到的缓存 key，卸载时要归还 */
  private claimedCacheKey: string | null = null;

  /** 用户声明的 cache.enabled，撞车让位后据此复位 */
  private readonly cacheEnabledByConfig: boolean;
  /** 标准入口的总持久化开关；false 时即使 cache.enabled 默认 true 也不得落盘 */
  private localPersistenceAllowed: boolean;

  /** 正在上传中的 logId（已出队但请求未回来） */
  /**
   * 正在飞行中的条目
   *
   * 存整条而不只是 id：卸载时它已经被 splice 出队列，只留 id 的话既进不了缓存、
   * 也没送达服务端 —— 这条日志就凭空消失了。
   */
  private readonly inFlight = new Map<string, QueuedLog>();
  /** 同一次扇出中已经被 overflow 放弃的 splitId，阻止后续分片留下独苗。 */
  private readonly rejectedSplitIds = new Map<
    string,
    { reason: UploadDropReason; expiresAt: number }
  >();
  private readonly pendingSplitAdmissions = new Map<
    string,
    PendingSplitAdmission
  >();

  /** 自上次成功上报以来丢弃的条数（随下一条成功上报的日志带出） */
  private pendingDropCount = 0;
  private dropStats: { total: number; byReason: Record<string, number> } = {
    total: 0,
    byReason: {},
  };
  private attemptStats: { total: number; byReason: Record<string, number> } = {
    total: 0,
    byReason: {},
  };

  // 绑定后的事件处理函数引用（用于正确移除监听器）
  private boundHandleLog: ((entry: LogEntry) => void) | null = null;
  private boundHandleBeforeUnload: (() => void) | null = null;
  private boundHandleOnline: (() => void) | null = null;
  private unregisterBeforeExit: (() => void) | null = null;
  private platform!: PlatformAdapter;
  private logger: AemeathInterface | null = null;
  /**
   * uninstall 后 logger 已空，但飞行中的 success/drop 仍需扇出给 OfflinePersistence。
   * inFlight 清空后再丢掉。
   */
  private emitTarget: AemeathInterface | null = null;

  constructor(options: UploadPluginOptions) {
    this.debugEnabled = options.debug ?? false;
    const clamp = (v: number | undefined, fallback: number, min: number) =>
      v != null && Number.isFinite(v) && v >= min ? v : fallback;
    const count = (v: number | undefined, fallback: number, min: number) =>
      v != null && Number.isSafeInteger(v) && v >= min ? v : fallback;

    const offlinePolicy =
      options.queue?.offlinePolicy === 'legacy' ? 'legacy' : 'pause';
    // legacy 模式默认同时关闭退避，作为完整的行为回归开关
    const backoffOption =
      options.queue?.retryBackoff ?? offlinePolicy !== 'legacy';
    const backoffEnabled = backoffOption !== false;
    const backoffConfig =
      typeof backoffOption === 'object' ? backoffOption : {};

    this.config = {
      onUpload: options.onUpload,
      getPriority: options.getPriority || defaultGetPriority,
      queue: {
        maxSize: count(options.queue?.maxSize, 100, 1),
        concurrency: count(options.queue?.concurrency, 1, 1),
        maxRetries: count(options.queue?.maxRetries, 3, 0),
        uploadInterval: clamp(options.queue?.uploadInterval, 30000, 1000),
        deduplicationDelay: clamp(options.queue?.deduplicationDelay, 50, 0),
        offlinePolicy,
        backoffBaseMs: backoffEnabled
          ? clamp(backoffConfig.baseMs, 1000, 0)
          : 0,
        backoffMaxMs: backoffEnabled ? clamp(backoffConfig.maxMs, 30000, 0) : 0,
        suspectedOfflineThreshold: count(
          options.queue?.suspectedOfflineThreshold,
          3,
          1,
        ),
      },
      cache: {
        enabled:
          options.localPersistence !== false &&
          options.cache?.enabled !== false,
        key: options.cache?.key || '__logger_upload_queue__',
        ttl: clamp(options.cache?.ttl, DEFAULT_CACHE_TTL, 0),
      },
      saveOnUnload: options.saveOnUnload !== false,
      debug: options.debug ?? false,
      onDrop: options.onDrop ?? null,
      deliveryScope: options.deliveryScope?.trim() || 'default',
    };
    this.cacheEnabledByConfig = options.cache?.enabled !== false;
    this.localPersistenceAllowed = options.localPersistence !== false;
  }

  /**
   * 在运行时替换 `onUpload` 回调
   *
   * 适用于：endpoint / token / authorization header 在 logger 初始化之后才能
   * 拿到的场景（典型：用户登录后才能拿到 access token，或同一项目刷新 token）。
   *
   * **保留状态**：队列里已经在排队的日志会用新的回调上报；正在飞行的 in-flight
   * 请求仍走旧回调（不打断它）。getPriority / queue / cache 等其他配置不变。
   *
   * 如果传 `null`，会冻结队列及持久副本；不会调用旧回调、不会消耗预算，重新绑定
   * callback 后从原位置恢复。跨项目/租户切换必须使用 deliveryScope，并在切换前清空
   * 待投递状态及隔离 cache/db/key。
   *
   * @param callback 新的上传回调（传 `null` 暂停上报）
   *
   * @example
   * ```ts
   * const upload = logger.getPluginInstance('upload') as UploadPlugin;
   * upload.setOnUpload(async (log) => {
   *   const res = await fetch(`${userEndpoint}/api/logs`, {
   *     method: 'POST',
   *     headers: { Authorization: `Bearer ${userToken}` },
   *     body: JSON.stringify(log),
   *   });
   *   return classifyHttpUploadResponse(res.status, res.headers.get('Retry-After'));
   * });
   * ```
   */
  public setOnUpload(
    callback: UploadCallback | null,
    options: UploadBindingOptions = {},
  ): void {
    if (callback === null) {
      if (this.callbackPaused) return;
      this.callbackPaused = true;
      this.emit('upload:paused', {
        reason: 'callback-paused',
        queued: this.queue.length,
        logs: this.peekQueuedForPersist(),
      });
      this.scheduleCacheSave();
      return;
    }

    const requestedScope = options.deliveryScope?.trim();
    if (requestedScope && requestedScope !== this.config.deliveryScope) {
      let pending =
        this.queue.length +
        this.parked.size +
        this.inFlight.size +
        this.pendingAdmissionSize();
      let persistenceInitializing = false;
      try {
        const delivery = this.logger?.getDeliveryStatus?.();
        pending = Math.max(pending, delivery?.totalPending ?? 0);
        persistenceInitializing =
          delivery?.persistence.enabled === true &&
          delivery.persistence.backend === 'initializing';
      } catch {
        // 状态提供者异常时仍以本插件自己的队列作为安全下限。
      }
      // 持久层 hydrate 完成前 totalPending 仍可能为 0；此时允许换租户会让稍后
      // 读出的旧租户记录直接走新 callback。宁可让调用方 ready 后重试，也不能串台。
      if (persistenceInitializing) {
        throw new Error(
          `[Aemeath] Refusing to switch upload deliveryScope from "${this.config.deliveryScope}" ` +
            `to "${requestedScope}" while offline persistence is still initializing. ` +
            'Wait for persistence readiness, then verify getDeliveryStatus().totalPending is 0.',
        );
      }
      if (pending > 0) {
        throw new Error(
          `[Aemeath] Refusing to switch upload deliveryScope from "${this.config.deliveryScope}" ` +
            `to "${requestedScope}" while ${pending} log(s) are still pending. Flush or reset ` +
            'the logger and use tenant-specific cache/offline storage keys before switching.',
        );
      }
      this.config.deliveryScope = requestedScope;
    }

    this.config.onUpload = callback;
    const wasPaused = this.callbackPaused;
    this.callbackPaused = false;
    if (wasPaused) {
      // 这里只解除“业务未绑定 callback”这一层暂停。若网络状态机仍处于 paused /
      // half-open，发送 resumed 会谎报端到端恢复，并诱导离线层提前补投。
      if (!this.paused && !this.halfOpen) {
        this.emit('upload:resumed', { queued: this.queue.length });
      }
      void this.processQueue();
    }
  }

  public getDeliveryScope(): string {
    return this.config.deliveryScope;
  }

  /**
   * 运行时启停 UploadPlugin 的队列镜像。
   *
   * `offlinePersistence:false` 使用它实现真正的“本地不留存”；重新开启时恢复用户
   * 原本的 cache 选择。关闭只影响磁盘镜像，不删除仍在内存中的待投递日志。
   */
  public setCachePersistenceEnabled(enabled: boolean, purge = false): void {
    this.localPersistenceAllowed = enabled;
    const shouldEnable = enabled && this.cacheEnabledByConfig;
    if (shouldEnable === this.config.cache.enabled) {
      if (!enabled && purge) this.removeCacheEntry();
      return;
    }
    if (!shouldEnable) {
      if (this.cacheSaveTimer) {
        clearTimeout(this.cacheSaveTimer);
        this.cacheSaveTimer = null;
      }
      if (purge) this.removeCacheEntry();
      this.config.cache.enabled = false;
      this.releaseCacheKey();
      return;
    }

    this.config.cache.enabled = true;
    this.claimCacheKey();
    if (this.config.cache.enabled) this.scheduleCacheSave();
  }

  private removeCacheEntry(): void {
    try {
      const storage = this.platform?.storage;
      if (!storage) return;
      storage.removeItem(this.config.cache.key);
      if (storage.getItem(this.config.cache.key) !== null) {
        throw new Error('upload cache remove did not stick');
      }
    } catch (err) {
      this.warn('Failed to remove cache:', err);
    }
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

  /**
   * 认领缓存 key，撞车时让出
   *
   * 缓存 key 有确定性默认值，所以同一个页面上的两个实例（宿主站 + 内嵌组件、
   * 微前端主子应用）默认会写同一个 localStorage 条目。后果有两个，都很难查：
   *
   * 1. 互相覆盖 —— 后存的把先存的整个抹掉，那些日志再也回不来了。
   * 2. 串台 —— 下次打开时两边都从同一个 key 恢复，A 项目的日志被发到
   *    B 项目的上报地址上。
   *
   * 撞车时让第二个实例关掉缓存，而不是自动改名：自动改名要依赖安装顺序，
   * 而脚本异步加载时这个顺序在两次访问之间可能翻转 —— 那会把一个稳定的 bug
   * 变成偶发的串台，更难查。关掉缓存只损失"刷新后续传"这一项增强能力，
   * 上报主链路不受影响，而且必然不会串台。
   */
  private claimCacheKey(): void {
    // 从用户声明的值重新起算，而不是从上次装载留下的值。撞车时这里会把
    // enabled 改成 false，若不复位，卸载重装（HMR、框架 remount）之后即使
    // 撞车方早已走人，缓存也再不会打开 —— 又一个不报错的哑巴。
    this.config.cache.enabled =
      this.cacheEnabledByConfig && this.localPersistenceAllowed;
    if (!this.config.cache.enabled) return;

    const key = this.config.cache.key;
    if (!CLAIMED_CACHE_KEYS.has(key)) {
      CLAIMED_CACHE_KEYS.add(key);
      this.claimedCacheKey = key;
      return;
    }

    this.config.cache.enabled = false;
    console.warn(
      `[Aemeath] Two UploadPlugin instances on this page share the cache key "${key}". ` +
        "They would overwrite each other and could restore one project's logs into the other's " +
        'endpoint, so caching is now disabled for this instance (uploading is unaffected). ' +
        'Give each instance its own `cache.key` to keep offline caching on both.',
    );
  }

  private releaseCacheKey(): void {
    if (this.claimedCacheKey === null) return;
    CLAIMED_CACHE_KEYS.delete(this.claimedCacheKey);
    this.claimedCacheKey = null;
  }

  install(logger: AemeathInterface): void {
    // 复装同一个实例时必须解除墓碑标记，否则插件看起来装上了（hasPlugin 为真、
    // 定时器在转、监听器已挂），实际 processQueue / requeue / scheduleProbe
    // 全都在入口早退 —— 一个不报错的哑巴。HMR 和框架的 teardown/remount
    // 正好会走这条路。
    this.lifecycleEpoch++;
    this.destroyed = false;
    // 旧 processQueue 可能仍卡在 await attemptUpload：放开闸让新一轮能跑，
    // 旧循环靠 epoch 自检退出，避免永久 isProcessing 死锁。
    this.isProcessing = false;
    const stuckWaiters = this.processingWaiters.splice(0);
    for (const w of stuckWaiters) w();
    // 直接 install（不经 uninstall）时旧 hold 不会被揭开；世代已变，必须在这里排空，
    // 否则 NetworkPlugin 会永久致盲。
    while (this.ignoreHolds > 0) {
      this.releaseIgnoreNetworkCapture();
    }
    // uninstall 会清探针但不清 paused；若 remount 后仍 paused 且探针已无，
    // processQueue 会永久早退，pause 模式下队列静默死掉。
    this.paused = false;
    this.halfOpen = false;
    this.probeDelay = 0;
    this.consecutiveFailures = 0;
    this.clearProbeTimer();
    this.clearParkWakeTimer();
    this.clearPendingSplitAdmissions(false);
    // 直接 install（不经 uninstall）时旧重试链定时器同样属于上一世代
    this.clearReceiptRetryTimers();
    this.recoveryCacheTransfer = null;
    // remount 后旧 split 拒绝集无意义；新扇出会用新的 splitId。
    this.rejectedSplitIds.clear();
    this.platform = logger.platform;
    this.logger = logger;
    this.emitTarget = logger;

    if (
      !this.config.cache.enabled &&
      !CLAIMED_CACHE_KEYS.has(this.config.cache.key)
    ) {
      this.removeCacheEntry();
    }
    this.claimCacheKey();

    if (this.config.cache.enabled) {
      try {
        this.restoreFromCache();
      } catch (e) {
        this.warn('Failed to restore from cache:', e);
      }
    }

    // 创建绑定后的事件处理函数引用
    this.boundHandleLog = this.handleLog.bind(this);
    this.boundHandleBeforeUnload = this.handleBeforeUnload.bind(this);

    // 监听日志事件
    logger.on('log', this.boundHandleLog as (...args: unknown[]) => void);

    // 启动定时上传
    this.startPeriodicUpload();

    // 监听页面卸载，保存队列到缓存
    if (this.config.saveOnUnload) {
      try {
        this.unregisterBeforeExit = this.platform.onBeforeExit(
          this.boundHandleBeforeUnload,
        );
      } catch {
        this.warn('Failed to register onBeforeExit handler');
      }
    }

    this.registerOnlineListener();
    // remount 后队列里可能还扣着暂停期攒下的日志：立刻开一轮
    // 未显式预装多标签插件时严格保持 2.5.2 的同步启动时序。
    if (this.isCrossTabRecoveryOptedIn()) {
      if (!this.deduplicationTimer) void this.processQueue();
    } else {
      void this.processQueue();
    }
  }

  uninstall(logger?: AemeathInterface): void {
    // 存盘必须在打墓碑标记之前：saveToCache 会对 destroyed 早退
    // （那道早退是为了防止已卸载实例覆盖接任实例的缓存）
    //
    // 队列空时也要写：一条被明确拒收的日志刚从队列里拿掉，缓存里却还留着旧副本，
    // 不覆盖的话下次打开又原样恢复、又发一遍。
    if (this.config.cache.enabled) {
      // uninstall is synchronous; flush() is async and cannot reliably complete.
      this.saveToCache({ includeInFlight: true });
    }

    // 存盘之后才归还，否则接任实例可能在本实例落盘前就认领到同一个 key
    this.releaseCacheKey();

    this.destroyed = true;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // 停止去重延迟定时器
    if (this.deduplicationTimer) {
      clearTimeout(this.deduplicationTimer);
      this.deduplicationTimer = null;
    }

    this.clearPendingSplitAdmissions(true);

    this.clearProbeTimer();
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    this.clearParkWakeTimer();
    if (this.cacheSaveTimer) {
      clearTimeout(this.cacheSaveTimer);
      this.cacheSaveTimer = null;
    }
    // 未提交的协调状态有 lease 硬截止时间，由下一任 coordinator 接管；
    // 留着定时器只会让墓碑实例在卸载后继续写共享存储。
    this.clearReceiptRetryTimers();

    // 移除日志事件监听。
    //
    // 框架的 teardown 钩子常常直接 `plugin.uninstall()` 不带参数；只认形参的话
    // 监听器会留在 logger 上，这个"墓碑"实例继续收日志、攒满队列、还朝宿主发
    // queue-overflow 回调，而它一条都发不出去。所以回退到 install 时存下的引用。
    // 每一步都各自兜异常：拆卸链上任何一环抛出，后面的清理就全被跳过 ——
    // online 监听留在 window 上、logger 引用留在实例上，于是这个已卸载的实例
    // 连同它引用的整个 logger（及其全部插件）永远不会被回收。
    // 反注册走的是宿主 API（小程序的 offAppHide、浏览器的 removeEventListener），
    // 抛不抛不由我们说了算。
    const host = logger ?? this.logger;
    if (host && this.boundHandleLog) {
      try {
        host.off('log', this.boundHandleLog as (...args: unknown[]) => void);
      } catch (err) {
        this.warn('Failed to detach log listener:', err);
      }
    }

    // 移除页面卸载事件监听
    if (this.unregisterBeforeExit) {
      try {
        this.unregisterBeforeExit();
      } catch (err) {
        this.warn('Failed to detach beforeExit handler:', err);
      }
      this.unregisterBeforeExit = null;
    }

    this.unregisterOnlineListener();

    // 揭开本实例仍持有的忽略窗口（挂起的 onUpload 可能永远不 settle）
    while (this.ignoreHolds > 0) {
      this.releaseIgnoreNetworkCapture();
    }

    // 清理引用。emitTarget 留给飞行中的 success/drop；inFlight 清空后再丢掉。
    this.boundHandleLog = null;
    this.boundHandleBeforeUnload = null;
    this.logger = null;
    if (this.inFlight.size === 0) {
      this.emitTarget = null;
    }
  }

  private holdIgnoreNetworkCapture(): void {
    beginIgnoreNetworkCapture();
    this.ignoreHolds++;
  }

  private releaseIgnoreNetworkCapture(): void {
    if (this.ignoreHolds <= 0) return;
    this.ignoreHolds--;
    endIgnoreNetworkCapture();
  }

  // ==================== 在线状态 ====================

  private registerOnlineListener(): void {
    if (this.config.queue.offlinePolicy === 'legacy') return;
    if (
      typeof window === 'undefined' ||
      typeof window.addEventListener !== 'function'
    )
      return;
    this.boundHandleOnline = () => {
      this.log('online event received, starting a half-open probe');
      this.beginHalfOpenProbe();
    };
    try {
      window.addEventListener('online', this.boundHandleOnline);
    } catch {
      this.boundHandleOnline = null;
    }
  }

  private unregisterOnlineListener(): void {
    if (!this.boundHandleOnline) return;
    try {
      window.removeEventListener('online', this.boundHandleOnline);
    } catch {
      /* ignore */
    }
    this.boundHandleOnline = null;
  }

  /**
   * `navigator.onLine === false` 是"确定离线"的硬信号
   *
   * 反过来 `true` **不能**说明网络可用（WebView 里它常常只表示存在网络接口），
   * 所以还需要连续失败的启发式兜底。
   */
  private isDefinitelyOffline(): boolean {
    if (this.config.queue.offlinePolicy === 'legacy') return false;
    return (
      typeof navigator !== 'undefined' &&
      typeof navigator.onLine === 'boolean' &&
      navigator.onLine === false
    );
  }

  /** 队列是否处于"扣住不发"的状态（暂停或半开探测中） */
  private isHeld(): boolean {
    return this.callbackPaused || this.paused || this.halfOpen;
  }

  /** 暂停队列，并安排一次探测 */
  private pause(reason: 'offline' | 'suspected-offline'): void {
    if (this.config.queue.offlinePolicy === 'legacy') return;
    const wasPaused = this.paused;
    this.paused = true;
    this.halfOpen = false;
    if (!wasPaused) {
      this.log(`Queue paused (${reason}), ${this.queue.length} logs held`);
      // 带上当前扣在队列里的日志：暂停之前入队的那几条不会再有 upload:enqueued
      // 事件，OfflinePersistencePlugin 需要靠这份快照把它们一起落盘
      this.emit('upload:paused', {
        reason,
        queued: this.queue.length,
        logs: this.queue.map((item) => ({
          log: item.log,
          priority: item.priority,
        })),
      });
    }
    this.scheduleProbe();
  }

  private scheduleProbe(): void {
    // 已经排好一次探测就别重排。
    //
    // pause() 每次调用都会走到这里，而下面是无条件翻倍：离线期间反复
    // flush() 会把探测间隔一路推到 60 秒上限，可实际上一次探测都没发生过。
    // 退避应该由"探测失败"驱动，不是由"又暂停了一次"驱动。
    if (this.probeTimer) return;
    if (this.destroyed) return;
    this.probeDelay =
      this.probeDelay === 0
        ? PROBE_BASE_MS
        : Math.min(this.probeDelay * 2, PROBE_MAX_MS);
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      if (this.destroyed) return;
      // 半开：只放行一次尝试，成功才完全恢复
      this.paused = false;
      this.halfOpen = true;
      this.processQueue();
    }, this.probeDelay);
  }

  private clearProbeTimer(): void {
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
  }

  /** online 只是唤醒提示，不是端到端连通证明：先只放行一条探测。 */
  private beginHalfOpenProbe(): void {
    if (this.destroyed || this.callbackPaused) return;
    this.clearProbeTimer();
    this.paused = false;
    // online 只证明网络接口恢复，不得推翻服务端给出的 Retry-After，也不应
    // 提前结束 server/rate-limit/auth 等失败的 parked 冷却。只接纳已经到期的
    // 一条；网络暂停本身的探测项原本就在活跃队列中。
    if (this.queue.length === 0) {
      this.halfOpen = true;
      if (this.unparkDue(false, 1) === 0) {
        this.halfOpen = false;
        this.scheduleParkWake();
      }
    } else {
      this.halfOpen = true;
    }
    if (this.queue.length === 0) {
      this.halfOpen = false;
      return;
    }
    void this.processQueue();
  }

  /**
   * 发事件
   *
   * 刻意约束到 `AemeathEventMap`：这个私有包装如果收 `Record<string, unknown>`，
   * 就把类型信息在此处抹平了 —— 事件载荷改了字段而类型表没跟上，tsc 一声不吭，
   * 用户拿到的是一份说谎的类型定义。
   */
  private emit<K extends keyof AemeathEventMap & string>(
    event: K,
    payload: AemeathEventMap[K],
  ): void {
    const host = this.logger ?? this.emitTarget;
    if (!host) return;
    try {
      host.emit(event, payload);
    } catch (err) {
      // AemeathLogger 会隔离监听器异常，但插件也允许安装到手写 AemeathInterface。
      // 自定义 emit 若抛错，绝不能让已出队条目卡成永久 in-flight。
      this.warn(`Host emit failed for "${String(event)}":`, err);
    }
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
    this.enqueueFreshItem(
      {
        log: entry,
        priority,
        retryCount: 0,
        timestamp: Date.now(),
      },
      { announce: true },
    );

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
   * 重新入队一批日志（供离线补传使用）
   *
   * 与 `logger.log()` 的关键区别：**只进入上传队列**，不会重新经过日志管道，
   * 因此其它插件、`beforeSend`、以及业务侧的 `logger.on('log')` 监听都不会被
   * 重复触发。这是补传不打扰业务代码的前提。
   *
   * 日志的 `timestamp`（捕获时刻）始终保持不变；重试预算会**重新计满**
   * ——新的一次补传通常意味着新的网络环境，不该继承上一轮消耗掉的预算。
   *
   * @param log 要重新入队的日志（单条或多条）
   * @param options.source 入队来源标记，离线补传请传 `'offline-replay'`
   * @param options.priority 覆盖优先级（默认按 getPriority 计算）
   */
  public requeue(
    log: LogEntry | LogEntry[],
    options: {
      source?: string;
      priority?: number;
    } = {},
  ): void {
    if (this.destroyed) return;
    const logs = Array.isArray(log) ? log : [log];
    for (const entry of logs) {
      if (!entry || typeof entry !== 'object') continue;
      let priority = options.priority;
      if (priority == null) {
        try {
          priority = this.config.getPriority(entry);
        } catch {
          priority = 0;
        }
      }
      this.enqueueFreshItem(
        {
          log: entry,
          priority,
          retryCount: 0,
          timestamp: Date.now(),
          source: options.source,
        },
        { announce: true },
      );
    }
    this.scheduleProcessQueue(true);
  }

  /** 暂停 cache 恢复项并提交式转交给 OfflinePersistence。 */
  public beginRecoveryCacheTransfer(): readonly RecoveryCacheItem[] {
    const snapshot = (items: readonly QueuedLog[]): RecoveryCacheItem[] =>
      items.map((item) => ({
        log: item.log,
        priority: item.priority,
        parkedUntil: item.parkedUntil,
        serverNotBefore: item.serverNotBefore,
        parkCount: item.parkCount,
        nextAttemptAt: item.nextAttemptAt,
        lastRetryReason: item.lastRetryReason,
      }));
    if (this.recoveryCacheTransfer) return snapshot(this.recoveryCacheTransfer);
    // 已经飞行中的恢复项同样源自旧 cache：不纳入快照的话，confirm 删除旧 cache
    // 后它的唯一持久副本就没了（结果未知期间崩溃即丢失）。纳入快照让 OfflineStore
    // 接住它，但它仍归飞行请求所有 —— 成功/失败都由既有 settle 路径收敛，
    // isPending 也会阻止协调器对同一 logId 重复领取。
    const inFlightRestored = Array.from(this.inFlight.values()).filter(
      (item) => item.restoredFromCache === true,
    );
    const items = [
      ...this.queue.filter((item) => item.restoredFromCache === true),
      ...Array.from(this.parked.values()).filter(
        (item) => item.restoredFromCache === true,
      ),
      ...inFlightRestored,
    ];
    if (items.length === 0) return [];
    const ids = new Set(items.map((item) => item.log.logId));
    this.queue = this.queue.filter((item) => !ids.has(item.log.logId));
    for (const id of ids) this.parked.delete(id);
    this.recoveryCacheTransfer = items;
    this.scheduleParkWake();
    return snapshot(items);
  }

  /** OfflineStore 已持久提交全部恢复项后，才删除旧 cache。 */
  public confirmRecoveryCacheTransfer(): void {
    if (!this.recoveryCacheTransfer) return;
    this.recoveryCacheTransfer = null;
    this.removeCacheEntry();
    this.scheduleCacheSave();
  }

  /** 持久导入确定失败时，把所有权与发送职责还给 Upload。 */
  public rollbackRecoveryCacheTransfer(): void {
    const items = this.recoveryCacheTransfer;
    if (!items) return;
    this.recoveryCacheTransfer = null;
    for (const item of items) {
      // 快照里的飞行项仍归在途请求所有：settle 路径自己会决定重试或落盘，
      // 这里再入队会造成同一条日志的双副本。
      if (this.inFlight.has(item.log.logId)) continue;
      this.enqueueFreshItem(item, { announce: true });
    }
    this.scheduleProcessQueue(true);
    this.scheduleCacheSave();
  }

  /**
   * 接纳一批已持有持久租约的恢复项。
   *
   * 整组容量在提交前重新检查；容量或本地所有权冲突只会释放租约，绝不会把
   * 持久事实转换成 UploadPlugin 自己的 queue/cache 权威。
   */
  public async requeueCoordinated(
    deliveries: readonly CoordinatedRecoveryItem[],
  ): Promise<void> {
    if (deliveries.length === 0) return;
    if (this.destroyed) {
      await Promise.all(
        deliveries.map(({ receipt }) =>
          receipt.retry({
            nextEligibleAt: Date.now(),
            lastRetryReason: 'upload-unavailable',
          }),
        ),
      );
      return;
    }

    const groups = new Map<string, QueuedLog[]>();
    for (const delivery of deliveries) {
      let priority = delivery.priority;
      if (priority == null) {
        try {
          priority = this.config.getPriority(delivery.log);
        } catch {
          priority = 0;
        }
      }
      const item: QueuedLog = {
        log: delivery.log,
        priority,
        retryCount: 0,
        timestamp: Date.now(),
        source: 'offline-replay',
        deliveryReceipt: delivery.receipt,
      };
      this.normalizeQueuedItem(item);
      const splitId = getSdkSplitId(item.log);
      const key =
        splitId === undefined ? `log:${item.log.logId}` : `split:${splitId}`;
      const group = groups.get(key);
      if (group) group.push(item);
      else groups.set(key, [item]);
    }

    let accepted = 0;
    for (const [key, group] of groups) {
      const now = Date.now();
      const release = async (reason: string): Promise<void> => {
        await Promise.all(
          group.map((item) =>
            item.deliveryReceipt!.retry({
              nextEligibleAt: now + 1000,
              lastRetryReason: reason,
            }),
          ),
        );
      };

      const splitTotals = new Set(
        group.map((item) => Number(item.log.tags?.splitTotal)),
      );
      const splitIndices = group.map((item) =>
        Number(item.log.tags?.splitIndex),
      );
      const malformed =
        (key.startsWith('split:') &&
          (splitTotals.size !== 1 ||
            new Set(splitIndices).size !== splitIndices.length)) ||
        group.some((item) => {
          const splitId = getSdkSplitId(item.log);
          if (!key.startsWith('split:')) return splitId !== undefined;
          const index = Number(item.log.tags?.splitIndex);
          const total = Number(item.log.tags?.splitTotal);
          return (
            splitId !== key.slice(6) ||
            !Number.isSafeInteger(index) ||
            !Number.isSafeInteger(total) ||
            total <= 0 ||
            index < 1 ||
            index > total
          );
        });
      if (malformed) {
        for (const item of group) {
          if (await item.deliveryReceipt!.terminal()) {
            this.reportDrop(item, {
              reason: 'storage-rejected',
              retryCount: item.retryCount,
              error: 'invalid coordinated recovery group',
            });
          }
        }
        continue;
      }

      const splitId = key.startsWith('split:') ? key.slice(6) : undefined;
      if (
        group.some((item) => this.isPending(item.log.logId)) ||
        (splitId !== undefined && this.hasActiveSplitOwner(splitId))
      ) {
        await release('live-owner');
        continue;
      }

      const status = this.getQueueStatus();
      const room =
        status.maxSize - status.length - status.parked - status.admitting;
      if (group.length > room) {
        await release('queue-capacity');
        continue;
      }

      // 持久层的 claimBatch 已经把剩余分片作为一个原子容量单元领取；绕过普通
      // split admission 是为了允许“部分成员已被前任成功提交”的合法残余组。
      this.commitQueueItems(group, { announce: true });
      accepted += group.length;
    }

    if (accepted > 0) this.scheduleProcessQueue(true);
  }

  /**
   * Broadcast 证实另一标签已送达后，撤销本标签尚未发出的同 logId 镜像。
   *
   * 撤销是"已在别处成功"的收敛，不是丢弃，因此不发 drop 事件。仅在显式启用
   * 跨标签插件时生效：默认路径没有"别处已送达"的事实源，宿主误调用不能
   * 变成静默删日志的入口。
   */
  public acknowledgeDelivered(logId: string): void {
    if (!this.isCrossTabRecoveryOptedIn()) return;
    this.queue = this.queue.filter((item) => item.log.logId !== logId);
    this.parked.delete(logId);
    for (const [splitId, admission] of this.pendingSplitAdmissions) {
      for (const [index, item] of admission.items) {
        if (item.log.logId !== logId) continue;
        admission.items.delete(index);
      }
      if (admission.items.size === 0) {
        clearTimeout(admission.timer);
        this.pendingSplitAdmissions.delete(splitId);
      }
    }
    this.scheduleParkWake();
    this.scheduleCacheSave();
    this.scheduleNextRun();
  }

  /**
   * 添加到队列（按优先级排序）
   */
  private clearPendingSplitAdmissions(report: boolean): void {
    const pending = [...this.pendingSplitAdmissions.entries()];
    this.pendingSplitAdmissions.clear();
    for (const [splitId, admission] of pending) {
      clearTimeout(admission.timer);
      if (report) {
        for (const item of admission.items.values()) {
          this.reportDrop(item, {
            reason: 'storage-rejected',
            retryCount: item.retryCount,
            error: `incomplete split group: ${splitId}`,
          });
        }
      }
    }
  }

  private rejectPendingSplit(
    splitId: string,
    admission: PendingSplitAdmission,
    extra: QueuedLog | undefined,
    error: string,
    reason: UploadDropReason = 'storage-rejected',
  ): void {
    clearTimeout(admission.timer);
    this.pendingSplitAdmissions.delete(splitId);
    this.rememberRejectedSplit(splitId, reason);
    const items = [...admission.items.values()];
    if (extra && !items.some((item) => item.log.logId === extra.log.logId))
      items.push(extra);
    for (const item of items) {
      this.reportDrop(item, {
        reason,
        retryCount: item.retryCount,
        error,
      });
    }
  }

  /** 所有入口共享的队列身份与计数规范化边界。 */
  private normalizeQueuedItem(item: QueuedLog): void {
    if (
      typeof item.log.logId !== 'string' ||
      item.log.logId.trim().length === 0
    ) {
      item.log.logId = generateId();
    }
    item.priority = Number.isFinite(item.priority) ? item.priority : 0;
    item.retryCount = Number.isFinite(item.retryCount)
      ? Math.max(0, Math.floor(item.retryCount))
      : 0;
    item.timestamp =
      Number.isFinite(item.timestamp) && item.timestamp >= 0
        ? item.timestamp
        : Date.now();
    item.source =
      typeof item.source === 'string' && item.source.length > 0
        ? item.source
        : undefined;
    item.lastRetryReason =
      typeof item.lastRetryReason === 'string'
        ? item.lastRetryReason
        : undefined;
    item.deliveryAttempt =
      Number.isSafeInteger(item.deliveryAttempt) &&
      (item.deliveryAttempt ?? 0) >= 0
        ? item.deliveryAttempt
        : undefined;
    if (
      item.deliveryReceipt &&
      (typeof item.deliveryReceipt.beginAttempt !== 'function' ||
        typeof item.deliveryReceipt.succeed !== 'function' ||
        typeof item.deliveryReceipt.terminal !== 'function')
    ) {
      item.deliveryReceipt = undefined;
    }
  }

  /** 任一阶段的同名分片组；一个 splitId 在实例内只能有一个生命周期所有者。 */
  private hasActiveSplitOwner(splitId: string): boolean {
    const owns = (item: QueuedLog): boolean =>
      getSdkSplitId(item.log) === splitId;
    return (
      this.pendingSplitAdmissions.has(splitId) ||
      this.queue.some(owns) ||
      Array.from(this.parked.values()).some(owns) ||
      Array.from(this.inFlight.values()).some(owns)
    );
  }

  private enqueueFreshItem(
    item: QueuedLog,
    opts: { announce?: boolean } = {},
  ): void {
    this.normalizeQueuedItem(item);
    if (this.isPending(item.log.logId)) return;
    const rawSplitId = item.log.tags?.splitId;
    const rawIndex = item.log.tags?.splitIndex;
    const rawTotal = item.log.tags?.splitTotal;
    if (
      rawSplitId === undefined ||
      (rawIndex === undefined && rawTotal === undefined)
    ) {
      this.addToQueue(item, opts);
      return;
    }
    const splitId = String(rawSplitId);
    const index = Number(rawIndex);
    const total = Number(rawTotal);
    if (
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(total) ||
      total <= 0 ||
      index < 1 ||
      index > total
    ) {
      this.reportDrop(item, {
        reason: 'storage-rejected',
        retryCount: item.retryCount,
        error: 'invalid splitIndex/splitTotal',
      });
      return;
    }
    if (total > this.config.queue.maxSize) {
      // 当前实例装不下，不等于这条逻辑日志永久不可送达：Offline 会保留完整组，
      // 下次以更大 maxSize 启动时仍可恢复。因此保持可恢复的容量分类。
      this.rememberRejectedSplit(splitId, 'queue-overflow');
      this.reportDrop(item, {
        reason: 'queue-overflow',
        retryCount: item.retryCount,
      });
      return;
    }
    const previousRejection = this.getRejectedSplitReason(splitId);
    if (
      previousRejection &&
      (previousRejection !== 'queue-overflow' ||
        item.source !== 'offline-replay')
    ) {
      this.reportDrop(item, {
        reason: previousRejection,
        retryCount: item.retryCount,
      });
      return;
    }
    let admission = this.pendingSplitAdmissions.get(splitId);
    if (!admission) {
      if (this.hasActiveSplitOwner(splitId)) {
        this.reportDrop(item, {
          reason: 'storage-rejected',
          retryCount: item.retryCount,
          error: 'splitId is already owned by another pending group',
        });
        return;
      }
      while (this.pendingSplitAdmissions.size >= MAX_REJECTED_SPLIT_IDS) {
        const oldestId = this.pendingSplitAdmissions.keys().next().value as
          string | undefined;
        if (oldestId === undefined) break;
        const oldest = this.pendingSplitAdmissions.get(oldestId);
        if (oldest)
          this.rejectPendingSplit(
            oldestId,
            oldest,
            undefined,
            'split admission capacity exceeded',
          );
      }
      const timer = setTimeout(
        () => {
          const pending = this.pendingSplitAdmissions.get(splitId);
          if (pending)
            this.rejectPendingSplit(
              splitId,
              pending,
              undefined,
              'incomplete split group',
            );
        },
        Math.max(50, this.config.queue.deduplicationDelay),
      );
      admission = { expectedTotal: total, items: new Map(), timer };
      this.pendingSplitAdmissions.set(splitId, admission);
    }
    if (
      admission.expectedTotal !== total ||
      admission.items.has(index) ||
      Array.from(admission.items.values()).some(
        (member) => member.log.logId === item.log.logId,
      )
    ) {
      this.rejectPendingSplit(
        splitId,
        admission,
        item,
        'inconsistent or duplicated split coordinates',
      );
      return;
    }
    // admission 是第一阶段的真实内存所有者，也必须与 queue/parked 共用 maxSize。
    // 未收齐组不能在容量满时无条件输给 resident；把“已有片 + 新片”作为一个
    // 原子候选，与普通日志、完整分片和其他 admission 统一比较优先级。
    const proposed = new Map(admission.items);
    proposed.set(index, item);
    const group = Array.from(proposed.entries())
      .sort(([a], [b]) => a - b)
      .map(([, value]) => value);
    const completesGroup = group.length === admission.expectedTotal;
    const accepted = this.makeRoomForCapacityUnit(
      group,
      completesGroup ? `split:${splitId}` : `admission:${splitId}`,
      () => {
        if (completesGroup) {
          clearTimeout(admission.timer);
          this.pendingSplitAdmissions.delete(splitId);
          this.commitQueueItems(group, opts);
        } else {
          admission.items.set(index, item);
        }
      },
      splitId,
    );
    if (!accepted) {
      this.rememberRejectedSplit(splitId, 'queue-overflow');
      this.rejectPendingSplit(
        splitId,
        admission,
        item,
        'split admission capacity exceeded',
        'queue-overflow',
      );
      return;
    }
  }

  /** 所有未收齐分片组实际持有的条数；与 queue/parked 共享硬容量。 */
  private pendingAdmissionSize(): number {
    let total = 0;
    for (const admission of this.pendingSplitAdmissions.values()) {
      total += admission.items.size;
    }
    return total;
  }

  /**
   * 为一个尚未进入共享状态的原子单元规划容量。
   *
   * 规划阶段不修改任何集合；如果 incoming 落在淘汰线内，直接拒绝且保留当前
   * 状态。只有确定可以接纳后，才整批移除选中的 resident/admission，并在任何
   * 外部丢弃通知前执行 `commit`。这样回调即使同步重入，也只能看到完整的新
   * 状态，不会抢走“已腾出但尚未入队”的容量，把完整分片撕成半组。
   *
   * `excludedAdmissionSplitId` 用于 admission 增长：调用方把该组的旧成员连同
   * 新成员一并放进 incoming，因此旧组必须从当前占用和候选中排除，避免双计数。
   */
  private makeRoomForCapacityUnit(
    incoming: readonly QueuedLog[],
    incomingKey: string,
    commit: () => void,
    excludedAdmissionSplitId?: string,
  ): boolean {
    const resident = [...this.queue, ...this.parked.values()];
    const admissions = Array.from(this.pendingSplitAdmissions.entries()).filter(
      ([splitId]) => splitId !== excludedAdmissionSplitId,
    );
    const admissionSize = admissions.reduce(
      (total, [, admission]) => total + admission.items.size,
      0,
    );
    const required =
      resident.length +
      admissionSize +
      incoming.length -
      this.config.queue.maxSize;
    if (required <= 0) {
      commit();
      return true;
    }

    const inFlightSplitIds = new Set(
      Array.from(this.inFlight.values(), (item) =>
        getSdkSplitId(item.log),
      ).filter((value): value is string => value !== undefined),
    );
    const units = new Map<string, QueuedLog[]>();
    for (const item of resident) {
      const splitId = getSdkSplitId(item.log);
      const key =
        splitId === undefined ? `log:${item.log.logId}` : `split:${splitId}`;
      const members = units.get(key);
      if (members) members.push(item);
      else units.set(key, [item]);
    }
    const residentCandidates: CapacityUnit[] = Array.from(units.entries())
      .filter(
        ([key, members]) =>
          // 已领取项的唯一持久副本仍由 receipt 代表。同步容量规划无法原子完成
          // “移出内存 + 释放 lease”，因此它们不是可淘汰候选；空间不足时拒绝
          // 新 incoming，或淘汰普通内存项。
          members.every((item) => !item.deliveryReceipt) &&
          (!key.startsWith('split:') ||
            !inFlightSplitIds.has(key.slice(6))),
      )
      .map(([key, members]) => ({
        key,
        members,
        kind: 'resident',
        first: [...members].sort(
          (a, b) => a.priority - b.priority || a.timestamp - b.timestamp,
        )[0]!,
        splitId: key.startsWith('split:') ? key.slice(6) : undefined,
      }));
    const admissionCandidates: CapacityUnit[] = admissions
      .filter(([, admission]) => admission.items.size > 0)
      .map(([splitId, admission]) => {
        const members = [...admission.items.values()];
        return {
          key: `admission:${splitId}`,
          kind: 'admission',
          members,
          first: [...members].sort(
            (a, b) => a.priority - b.priority || a.timestamp - b.timestamp,
          )[0]!,
          splitId,
        };
      });
    const incomingFirst = [...incoming].sort(
      (a, b) => a.priority - b.priority || a.timestamp - b.timestamp,
    )[0];
    if (!incomingFirst) {
      commit();
      return true;
    }
    const candidates: CapacityUnit[] = [
      ...residentCandidates,
      ...admissionCandidates,
      {
        key: incomingKey,
        kind: 'incoming' as const,
        members: [...incoming],
        first: incomingFirst,
        splitId: getSdkSplitId(incomingFirst.log),
      },
    ].sort(
      (a, b) =>
        a.first.priority - b.first.priority ||
        a.first.timestamp - b.first.timestamp,
    );

    const selected: CapacityUnit[] = [];
    let planned = 0;
    for (const candidate of candidates) {
      if (candidate.kind === 'incoming') return false;
      selected.push(candidate);
      planned += candidate.members.length;
      if (planned >= required) break;
    }
    if (planned < required) return false;

    const residentVictims = selected.filter(
      (candidate) => candidate.kind === 'resident',
    );
    const victimIds = new Set(
      residentVictims.flatMap((candidate) =>
        candidate.members.map((item) => item.log.logId),
      ),
    );
    this.queue = this.queue.filter((item) => !victimIds.has(item.log.logId));
    for (const id of victimIds) this.parked.delete(id);
    const victims: QueuedLog[] = [];
    for (const candidate of selected) {
      if (candidate.kind === 'admission') {
        const splitId = candidate.splitId!;
        const admission = this.pendingSplitAdmissions.get(splitId);
        if (admission) {
          clearTimeout(admission.timer);
          this.pendingSplitAdmissions.delete(splitId);
          this.rememberRejectedSplit(splitId, 'queue-overflow');
          victims.push(...admission.items.values());
        }
        continue;
      }
      if (candidate.splitId !== undefined) {
        this.rememberRejectedSplit(candidate.splitId, 'queue-overflow');
      }
      victims.push(...candidate.members);
    }
    commit();
    this.scheduleParkWake();
    for (const victim of victims) {
      this.reportDrop(victim, {
        reason: 'queue-overflow',
        retryCount: victim.retryCount,
        error: 'capacity unit evicted',
      });
    }
    return true;
  }

  /** 已通过容量规划的条目一次性成为 queue 所有者；本方法不再做准入判断。 */
  private commitQueueItems(
    items: readonly QueuedLog[],
    opts: { announce?: boolean } = {},
  ): void {
    this.queue.push(...items);
    this.queue.sort((a, b) => b.priority - a.priority);
    if (opts.announce) {
      for (const item of items) {
        this.emit('upload:enqueued', {
          log: item.log,
          priority: item.priority,
          source: item.source,
          paused: this.isHeld(),
        });
      }
    }
    if (this.config.cache.enabled) this.scheduleCacheSave();
  }

  private getRejectedSplitReason(
    splitId: string,
  ): UploadDropReason | undefined {
    const entry = this.rejectedSplitIds.get(splitId);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.rejectedSplitIds.delete(splitId);
      return undefined;
    }
    return entry.reason;
  }

  private rememberRejectedSplit(
    splitId: string,
    reason: UploadDropReason,
  ): void {
    const now = Date.now();
    for (const [id, entry] of this.rejectedSplitIds) {
      if (entry.expiresAt <= now) this.rejectedSplitIds.delete(id);
    }
    while (this.rejectedSplitIds.size >= MAX_REJECTED_SPLIT_IDS) {
      const oldest = this.rejectedSplitIds.keys().next().value as
        string | undefined;
      if (oldest === undefined) break;
      this.rejectedSplitIds.delete(oldest);
    }
    this.rejectedSplitIds.set(splitId, {
      reason,
      expiresAt: now + REJECTED_SPLIT_TTL_MS,
    });
  }

  private addToQueue(item: QueuedLog, opts: { announce?: boolean } = {}): void {
    // 已卸载的实例不再收日志。
    //
    // `plugin.uninstall()`（不带参数直接调，正是框架 teardown 钩子的写法）
    // 不会摘掉 logger 上的 log 监听器，于是这个"墓碑"实例会继续攒日志、
    // 攒到 maxSize 后还朝宿主发 queue-overflow 的 onDrop —— 而它一条都发不出去。
    if (this.destroyed) return;
    if (this.isPending(item.log.logId)) return;

    const incomingSplitId = getSdkSplitId(item.log);
    // 拒绝集只挡同一次入队风暴里的后续独苗；offline-replay 必须放行，
    // 否则 overflow 落盘后的补传会被同一 splitId 永久拒收。
    if (incomingSplitId !== undefined) {
      const previousRejection = this.getRejectedSplitReason(
        String(incomingSplitId),
      );
      if (
        previousRejection &&
        (previousRejection !== 'queue-overflow' ||
          item.source !== 'offline-replay')
      ) {
        this.reportDrop(item, {
          reason: previousRejection,
          retryCount: item.retryCount,
        });
        return;
      }
    }

    // 普通日志也经过统一原子容量规划，不能拥有一套不同于分片/admission 的
    // 淘汰规则。
    if (
      !this.makeRoomForCapacityUnit([item], `log:${item.log.logId}`, () =>
        this.commitQueueItems([item], opts),
      )
    ) {
      this.reportDrop(item, {
        reason: 'queue-overflow',
        retryCount: item.retryCount,
      });
      return;
    }
  }

  /**
   * 某条日志是否仍由本插件持有（排队中、退避等待中，或正在上传）
   *
   * 供 OfflinePersistencePlugin 判断"这条还在内存队列里、不需要从持久层再投一次"。
   * 必须把**正在上传**也算进来：网络恢复的那一瞬间，条目已经被取出队列但请求
   * 还没回来，只看队列数组就会把它当成"丢了"而重复补投。
   */
  public isPending(logId: string): boolean {
    this.purgeSettledCoordinatedItems();
    return (
      this.inFlight.has(logId) ||
      this.parked.has(logId) ||
      this.queue.some((item) => item.log.logId === logId) ||
      Array.from(this.pendingSplitAdmissions.values()).some((admission) =>
        Array.from(admission.items.values()).some(
          (item) => item.log.logId === logId,
        ),
      )
    );
  }

  /**
   * receipt 是协调项的所有权事实。协调器停止/依赖替换时可能在 Upload 队列外
   * 释放 lease；本地镜像一旦 settled 就不再是 owner，必须在任何容量/去重查询
   * 前撤销，不能继续阻塞下一任 coordinator 的 claim。
   */
  private purgeSettledCoordinatedItems(): void {
    const settled = (item: QueuedLog): boolean =>
      item.deliveryReceipt?.isSettled() === true;
    // isPending/getQueueStatus 是热路径；默认路径没有 receipt，先零分配探测，
    // 确认有 settled 项才重建队列数组。
    let queueHasSettled = false;
    for (const item of this.queue) {
      if (settled(item)) {
        queueHasSettled = true;
        break;
      }
    }
    if (queueHasSettled) {
      this.queue = this.queue.filter((item) => !settled(item));
    }
    let parkedChanged = false;
    for (const [logId, item] of this.parked) {
      if (!settled(item)) continue;
      this.parked.delete(logId);
      parkedChanged = true;
    }
    if (queueHasSettled || parkedChanged) {
      this.scheduleParkWake();
      if (this.config.cache.enabled) this.scheduleCacheSave();
    }
  }

  /** 是否正在飞行（已出队、等 onUpload）。Offline uninstall 墓碑只认这个，不含排队。 */
  public isInFlight(logId: string): boolean {
    return this.inFlight.has(logId);
  }

  private park(item: QueuedLog, failure: NormalizedUploadFailure): void {
    const parked = this.preparePark(item, failure);
    this.parked.set(item.log.logId, item);
    this.deferQueuedSplitSiblings(
      item,
      parked.parkedUntil,
      parked.serverNotBefore,
    );
    this.emit('upload:parked', parked);
    this.scheduleCacheSave();
    this.scheduleParkWake();
  }

  private preparePark(
    item: QueuedLog,
    failure: NormalizedUploadFailure,
  ): AemeathEventMap['upload:parked'] {
    const parkCount = (item.parkCount ?? 0) + 1;
    const exponent = Math.min(parkCount - 1, 8);
    const coolingMs = Math.min(
      PARK_BASE_MS * Math.pow(2, exponent),
      PARK_MAX_MS,
    );
    const now = Date.now();
    const serverNotBefore =
      failure.retryAfterMs === undefined
        ? undefined
        : deadlineAfter(failure.retryAfterMs, now);
    const parkedUntil = Math.max(
      deadlineAfter(coolingMs, now),
      serverNotBefore ?? 0,
    );
    item.parkCount = parkCount;
    item.parkedUntil = parkedUntil;
    item.serverNotBefore = serverNotBefore;
    item.lastRetryReason = failure.reason as RetryableUploadReason;
    item.nextAttemptAt = undefined;
    item.transportAttempts = 0;
    return {
      log: item.log,
      priority: item.priority,
      source: item.source,
      reason: failure.reason,
      retryCount: item.retryCount,
      parkedUntil,
      serverNotBefore,
      parkCount,
    };
  }

  private async parkCoordinated(
    item: QueuedLog,
    failure: NormalizedUploadFailure,
  ): Promise<void> {
    const parked = this.preparePark(item, failure);
    const update = {
      nextEligibleAt: parked.parkedUntil,
      serverNotBefore: parked.serverNotBefore,
      parkCount: parked.parkCount,
      lastRetryReason: parked.reason,
    };
    let committed = false;
    try {
      committed = await item.deliveryReceipt!.park(update);
    } catch (error) {
      this.warn('Failed to persist coordinated parked state:', error);
      this.retryReceiptTransition(
        'parked state',
        () => item.deliveryReceipt!.park(update),
        () => this.finishCoordinatedPark(item, parked),
      );
      return;
    }
    if (!committed) return;

    await this.finishCoordinatedPark(item, parked);
  }

  private async finishCoordinatedPark(
    item: QueuedLog,
    parked: AemeathEventMap['upload:parked'],
  ): Promise<void> {
    this.deferQueuedSplitSiblings(
      item,
      parked.parkedUntil,
      parked.serverNotBefore,
    );
    const splitId = getSdkSplitId(item.log);
    if (splitId !== undefined) {
      await Promise.all(
        this.queue
          .filter(
            (sibling) =>
              getSdkSplitId(sibling.log) === splitId && sibling.deliveryReceipt,
          )
          .map(async (sibling) => {
            try {
              await sibling.deliveryReceipt!.retryScheduled({
                nextEligibleAt: parked.parkedUntil,
                serverNotBefore: parked.serverNotBefore,
                lastRetryReason: parked.reason,
              });
            } catch (error) {
              this.warn('Failed to defer coordinated split sibling:', error);
              this.retryReceiptTransition(
                'split sibling deadline',
                () =>
                  sibling.deliveryReceipt!.retryScheduled({
                    nextEligibleAt: parked.parkedUntil,
                    serverNotBefore: parked.serverNotBefore,
                    lastRetryReason: parked.reason,
                  }),
                () => undefined,
              );
            }
          }),
      );
    }
    this.emit('upload:parked', parked);
    this.scheduleCacheSave();
  }

  /** 同组一片退避/停放时，其余尚未尝试的分片不得绕过这条服务端期限。 */
  private deferQueuedSplitSiblings(
    item: QueuedLog,
    until: number,
    serverNotBefore?: number,
  ): void {
    const splitId = getSdkSplitId(item.log);
    if (splitId === undefined || !Number.isFinite(until)) return;
    const sid = splitId;
    for (const sibling of this.queue) {
      if (getSdkSplitId(sibling.log) !== sid) continue;
      sibling.nextAttemptAt = Math.max(sibling.nextAttemptAt ?? 0, until);
      if (serverNotBefore !== undefined) {
        sibling.serverNotBefore = Math.max(
          sibling.serverNotBefore ?? 0,
          serverNotBefore,
        );
      }
    }
    let parkedChanged = false;
    for (const sibling of this.parked.values()) {
      if (getSdkSplitId(sibling.log) !== sid) continue;
      const nextParkedUntil = Math.max(sibling.parkedUntil ?? 0, until);
      if (nextParkedUntil !== sibling.parkedUntil) {
        sibling.parkedUntil = nextParkedUntil;
        parkedChanged = true;
      }
      if (serverNotBefore !== undefined) {
        const nextServerDeadline = Math.max(
          sibling.serverNotBefore ?? 0,
          serverNotBefore,
        );
        if (nextServerDeadline !== sibling.serverNotBefore) {
          sibling.serverNotBefore = nextServerDeadline;
          parkedChanged = true;
        }
      }
    }
    if (parkedChanged) this.scheduleParkWake();
  }

  private unparkDue(
    forceAll = false,
    limit = Number.POSITIVE_INFINITY,
  ): number {
    if (this.destroyed || this.parked.size === 0) return 0;
    const now = Date.now();
    const due = Array.from(this.parked.values())
      .filter(
        (item) =>
          (item.serverNotBefore ?? 0) <= now &&
          (forceAll || (item.parkedUntil ?? 0) <= now),
      )
      .sort((a, b) => (a.parkedUntil ?? 0) - (b.parkedUntil ?? 0))
      .slice(0, limit);
    for (const item of due) {
      this.parked.delete(item.log.logId);
      const reason = item.lastRetryReason ?? 'unknown';
      item.retryCount = 0;
      item.transportAttempts = 0;
      item.nextAttemptAt = undefined;
      item.parkedUntil = undefined;
      item.serverNotBefore = undefined;
      this.queue.push(item);
      this.emit('upload:unparked', {
        log: item.log,
        source: item.source,
        reason,
      });
    }
    if (due.length > 0) {
      this.queue.sort((a, b) => b.priority - a.priority);
      this.scheduleCacheSave();
    }
    this.scheduleParkWake();
    return due.length;
  }

  private scheduleParkWake(): void {
    this.clearParkWakeTimer();
    if (
      this.destroyed ||
      this.callbackPaused ||
      this.halfOpen ||
      this.parked.size === 0
    )
      return;
    let earliest = Infinity;
    for (const item of this.parked.values()) {
      earliest = Math.min(
        earliest,
        Math.max(item.parkedUntil ?? Date.now(), item.serverNotBefore ?? 0),
      );
    }
    const delay = Math.max(0, earliest - Date.now());
    this.parkWakeTimer = setTimeout(
      () => {
        this.parkWakeTimer = null;
        // 每次只唤醒一条作为服务恢复探测，避免后端刚恢复就瞬间灌满。
        this.halfOpen = true;
        if (this.unparkDue(false, 1) > 0) {
          void this.processQueue();
        } else {
          this.halfOpen = false;
          // 超过单段 setTimeout 表达范围时分段等待，到点后重新核对真实期限。
          this.scheduleParkWake();
        }
      },
      Math.min(delay, MAX_TIMER_DELAY_MS),
    );
  }

  private clearParkWakeTimer(): void {
    if (!this.parkWakeTimer) return;
    clearTimeout(this.parkWakeTimer);
    this.parkWakeTimer = null;
  }

  /**
   * 供配套插件（如 OfflinePersistencePlugin）汇报丢弃
   *
   * 走的是和内部丢弃完全相同的出口，宿主只需要关心一个 `onDrop` / 一个
   * `upload:drop` 事件，不必分辨这条日志是死在队列里还是死在持久层里。
   */
  public reportExternalDrop(log: LogEntry, info: UploadDropInfo): boolean {
    // 返回值告诉调用方"我接手了没有"。已卸载的实例会拒接，
    // 调用方需要据此自己发事件，否则这次丢弃就无人知晓了。
    if (this.destroyed) return false;
    this.reportDrop(
      { log, priority: 0, retryCount: 0, timestamp: Date.now() },
      info,
    );
    return true;
  }

  private recordAttemptOutcome(reason: 'success' | UploadRetryReason): void {
    this.attemptStats.byReason[reason] =
      (this.attemptStats.byReason[reason] ?? 0) + 1;
  }

  /**
   * 统一的丢弃出口：计数 + 回调 + 事件
   *
   * 所有放弃日志的路径都必须走这里，否则宿主又会回到"日志静默消失"的状态。
   */
  private reportDrop(
    item: QueuedLog,
    info: Omit<UploadDropInfo, 'source'> & { source?: string },
  ): void {
    const payload: UploadDropInfo = {
      ...info,
      source: info.source ?? item.source,
    };
    this.dropStats.total++;
    this.dropStats.byReason[payload.reason] =
      (this.dropStats.byReason[payload.reason] ?? 0) + 1;
    this.pendingDropCount++;

    this.warn(
      `Dropping log (${payload.reason}, retryCount=${item.retryCount})`,
    );

    // 卸载之后仍经 emitTarget 扇出 drop：OfflinePersistence 要靠它清盘。
    // 但不再调宿主 onDrop、也不再写 cache——宿主上下文可能已拆掉。
    if (this.destroyed) {
      this.emit('upload:drop', { log: item.log, ...payload });
      if (this.inFlight.size === 0) this.emitTarget = null;
      return;
    }

    if (this.config.onDrop) {
      try {
        this.config.onDrop(item.log, payload);
      } catch (err) {
        this.warn('onDrop callback threw:', err);
      }
    }
    this.emit('upload:drop', { log: item.log, ...payload });

    // 丢弃是终态，缓存必须跟着更新。否则一条被服务端明确拒收（no-retry）的日志
    // 仍留在缓存里，下次打开页面又被恢复、又被发一遍。
    //
    // 合并写入：队列溢出时丢弃是连着发生的，每次都全量序列化会退化成 O(n²)。
    this.scheduleCacheSave();
  }

  /**
   * 终态丢弃时连带同 splitId 的排队兄弟一起丢掉。
   * overflow 路径已有整组淘汰；no-retry / max-retries 也必须如此，否则后端收残片。
   */
  private dropWithSplitCascade(
    item: QueuedLog,
    info: Omit<UploadDropInfo, 'source'> & { source?: string },
  ): void {
    const splitId = getSdkSplitId(item.log);
    if (splitId === undefined) {
      this.reportDrop(item, info);
      return;
    }
    const sid = splitId;
    const siblings = [...this.queue, ...this.parked.values()].filter(
      (it) => getSdkSplitId(it.log) === sid,
    );
    this.queue = this.queue.filter((it) => getSdkSplitId(it.log) !== sid);
    for (const [id, parked] of this.parked) {
      if (getSdkSplitId(parked.log) === sid) this.parked.delete(id);
    }
    this.scheduleParkWake();
    // 先让整组失去内部所有权，再发任何回调；同步重入只能看到提交后的状态。
    this.reportDrop(item, info);
    for (const sibling of siblings) {
      this.reportDrop(sibling, {
        ...info,
        error: info.error ?? 'split-sibling-dropped',
      });
    }
  }

  private async dropCoordinatedWithSplitCascade(
    item: QueuedLog,
    info: Omit<UploadDropInfo, 'source'> & { source?: string },
  ): Promise<void> {
    const splitId = getSdkSplitId(item.log);
    const siblings =
      splitId === undefined
        ? []
        : [...this.queue, ...this.parked.values()].filter(
            (candidate) => getSdkSplitId(candidate.log) === splitId,
          );
    if (splitId !== undefined) {
      this.queue = this.queue.filter(
        (candidate) => getSdkSplitId(candidate.log) !== splitId,
      );
      for (const [logId, parked] of this.parked) {
        if (getSdkSplitId(parked.log) === splitId) this.parked.delete(logId);
      }
      this.scheduleParkWake();
    }

    const members = [item, ...siblings].filter(
      (candidate, index, all) =>
        all.findIndex((entry) => entry.log.logId === candidate.log.logId) ===
        index,
    );
    for (const member of members) {
      if (member.deliveryReceipt) {
        let current = false;
        try {
          current = await member.deliveryReceipt.terminal();
        } catch (error) {
          this.warn('Failed to commit coordinated terminal outcome:', error);
          this.retryReceiptTransition(
            'terminal outcome',
            () => member.deliveryReceipt!.terminal(),
            () =>
              this.reportDrop(member, {
                ...info,
                error:
                  member === item
                    ? info.error
                    : (info.error ?? 'split-sibling-dropped'),
              }),
          );
          continue;
        }
        if (!current) continue;
      }
      this.reportDrop(member, {
        ...info,
        error:
          member === item
            ? info.error
            : (info.error ?? 'split-sibling-dropped'),
      });
    }
  }

  /**
   * 持久状态转移失败时只重试状态提交，绝不重新发网络请求。
   *
   * 重试链锚定发起时的生命周期：uninstall/remount 之后停止重试并放弃
   * onCommitted —— 把旧 attempt 的项塞进新生命周期的队列会造成双所有权，
   * 而未提交的持久状态有 lease 硬截止时间，到期由下一任 coordinator 接管。
   */
  private retryReceiptTransition(
    label: string,
    operation: () => Promise<boolean>,
    onCommitted: () => void | Promise<void>,
  ): void {
    const epoch = this.lifecycleEpoch;
    let delay = 1000;
    const alive = (): boolean =>
      !this.destroyed && this.lifecycleEpoch === epoch;
    const schedule = (ms: number): void => {
      if (!alive()) return;
      const timer = setTimeout(() => {
        this.receiptRetryTimers.delete(timer);
        void run();
      }, ms);
      this.receiptRetryTimers.add(timer);
    };
    const run = async (): Promise<void> => {
      if (!alive()) return;
      try {
        const current = await operation();
        if (!current) return;
        if (!alive()) return;
        await onCommitted();
      } catch (error) {
        this.warn(`Failed to persist coordinated ${label}; retrying:`, error);
        const nextDelay = delay;
        delay = Math.min(delay * 2, 60_000);
        schedule(nextDelay);
      }
    };
    schedule(delay);
  }

  private clearReceiptRetryTimers(): void {
    for (const timer of this.receiptRetryTimers) clearTimeout(timer);
    this.receiptRetryTimers.clear();
  }

  /**
   * 将回调的多种失败形态收敛成稳定语义。
   *
   * 兼容规则：裸 `{ success:false }` 仍表示不重试；但 `shouldRetry:true` 即使没有
   * retryReason 也表示明确的重试意图，原因只影响调度，不能决定日志是否有资格保留。
   */
  private normalizeFailure(
    result: UploadResult | undefined,
    thrown: unknown,
  ): NormalizedUploadFailure {
    const error =
      thrown !== undefined
        ? String((thrown as { message?: unknown })?.message ?? thrown)
        : result?.error || 'Unknown error';

    if (thrown !== undefined) {
      const name = String((thrown as { name?: unknown })?.name ?? '');
      const status = getHttpStatus(thrown);
      if (status !== undefined) {
        const retryAfter = getHttpRetryAfter(thrown);
        const classified = classifyHttpUploadResponse(status, retryAfter);
        if (classified.success) {
          return { terminal: false, reason: 'callback-error', error };
        }
        const reason = classified.retryReason ?? 'unknown';
        return {
          terminal: classified.shouldRetry === false || reason === 'payload',
          reason,
          error,
          retryAfterMs: parseRetryAfter(retryAfter),
        };
      }
      if (isNetworkError(thrown)) {
        return { terminal: false, reason: 'network', error };
      }
      if (name === 'AbortError') {
        return { terminal: false, reason: 'cancelled', error };
      }
      return { terminal: false, reason: 'callback-error', error };
    }

    if (result?.shouldRetry === false || result?.retryReason === 'payload') {
      return {
        terminal: true,
        reason: result?.retryReason ?? 'unknown',
        error,
      };
    }

    const explicitReason = result?.retryReason;
    const hasRetryIntent =
      result?.shouldRetry === true || explicitReason !== undefined;
    if (!hasRetryIntent) {
      return { terminal: true, reason: explicitReason ?? 'unknown', error };
    }

    return {
      terminal: false,
      reason: explicitReason ?? 'unknown',
      error,
      retryAfterMs:
        normalizeRetryAfterMs(result?.retryAfterMs) ??
        parseRetryAfter(result?.retryAfter),
    };
  }

  /**
   * remount 之后才 settle 的旧 attempt：服务端可能已经收到，必须扇出终态；
   * 但队列/暂停/重试归新生命周期管。
   */
  private async settleStaleAttempt(
    item: QueuedLog,
    result: UploadResult | undefined,
    thrown: unknown,
  ): Promise<'done'> {
    if (result?.success) {
      this.recordAttemptOutcome('success');
      if (item.deliveryReceipt) {
        try {
          await item.deliveryReceipt.succeed();
        } catch (error) {
          this.warn(
            'Failed to commit stale coordinated delivery success:',
            error,
          );
        }
      }
      this.queue = this.queue.filter((q) => q.log.logId !== item.log.logId);
      this.parked.delete(item.log.logId);
      this.emit('upload:success', {
        log: item.log,
        source: item.source,
      });
      this.scheduleCacheSave();
      this.scheduleNextRun();
      return 'done';
    }

    const failure = this.normalizeFailure(result, thrown);
    this.recordAttemptOutcome(failure.reason);
    if (failure.terminal) {
      if (item.deliveryReceipt) {
        await this.dropCoordinatedWithSplitCascade(item, {
          reason: 'no-retry',
          retryCount: item.retryCount,
          error: failure.error,
        });
        this.scheduleCacheSave();
        this.scheduleNextRun();
        return 'done';
      }
      // 只 emit，不调宿主 onDrop（与 destroyed 路径一致）；但仍要级联摘掉兄弟分片
      this.emitStaleDrop(item, 'no-retry', failure.error);
      const splitId = getSdkSplitId(item.log);
      if (splitId !== undefined) {
        const sid = splitId;
        const siblings = [...this.queue, ...this.parked.values()].filter(
          (q) => getSdkSplitId(q.log) === sid,
        );
        this.queue = this.queue.filter((q) => getSdkSplitId(q.log) !== sid);
        for (const [id, parked] of this.parked) {
          if (getSdkSplitId(parked.log) === sid) this.parked.delete(id);
        }
        for (const sibling of siblings) {
          this.emitStaleDrop(sibling, 'no-retry', failure.error);
        }
      } else {
        this.queue = this.queue.filter((q) => q.log.logId !== item.log.logId);
      }
      this.scheduleCacheSave();
      this.scheduleNextRun();
      return 'done';
    }

    // 可重试失败：item 早已出队；cache=off 时若这里不回队，日志会静默消失。
    // 新生命周期若已从 cache / 其它路径恢复了同 id，则勿重复入队。
    if (!this.destroyed && !this.isPending(item.log.logId)) {
      item.nextAttemptAt = undefined;
      this.addToQueue(item, { announce: true });
      this.scheduleProcessQueue(true);
    }
    return 'done';
  }

  private emitStaleDrop(
    item: QueuedLog,
    reason: UploadDropReason,
    error: string,
  ): void {
    this.emit('upload:drop', {
      log: item.log,
      reason,
      retryCount: item.retryCount,
      error,
      source: item.source,
    });
  }

  /** 半开探测已经拿到非网络结果：证明链路可达，恢复常规消费。 */
  private completeReachableProbe(): void {
    if (!this.halfOpen) return;
    this.halfOpen = false;
    this.probeDelay = 0;
    this.clearProbeTimer();
    this.emit('upload:resumed', { queued: this.queue.length });
    this.scheduleParkWake();
  }

  /**
   * 处理队列（按 concurrency 分批并发上传）
   *
   * 与 v2.4 的关键差异：
   * 1. 判定离线时**暂停**而不是继续打空枪 —— 断网不再秒级耗尽重试预算。
   * 2. 重试之间有指数退避，`nextAttemptAt` 未到期的条目会被跳过。
   * 3. 传输层失败（超时 / 明确网络异常 / `retryReason: 'network'`）不消耗重试预算。
   */
  private async processQueue(): Promise<void> {
    if (this.destroyed) return;
    if (this.callbackPaused) return;
    // parked 恢复必须一次只放行一个探针。其余由 parkWakeTimer 在本次结果明确后唤醒。
    if (this.queue.length === 0 && !this.halfOpen && this.parked.size > 0) {
      this.halfOpen = true;
      if (this.unparkDue(false, 1) === 0) {
        this.halfOpen = false;
        this.scheduleParkWake();
      }
    }
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    if (!this.forceRun) {
      if (this.paused) return;
      if (this.isDefinitelyOffline()) {
        this.pause('offline');
        return;
      }
    }

    const epoch = this.lifecycleEpoch;
    this.isProcessing = true;
    let attempts = 0;
    let crashed = false;
    // 本轮若由 parked 触发半开探测，即使首条成功在 attemptUpload 内清掉 halfOpen，
    // 也必须保持“只探一条”，不能继续把其余 parked 作为普通并发批次放出。
    const probeOnlyRun = this.halfOpen && !this.forceRun;
    // 一轮之内每条日志最多尝试一次。
    //
    // forceRun 会让 takeNextDueItem 无视 nextAttemptAt，而失败的条目是在这个
    // 循环**内部**重新入队的 —— 少了这道闸，一次 flush() 就会贴着 CPU 把每条
    // 日志的 maxRetries 一次烧光（实测 1.2 秒内 12 次请求、三条日志全部丢弃）。
    const attemptedInThisRun = new Set<string>();

    try {
      // 🎯 处理前先对队列进行去重，保留信息最完整的日志
      this.deduplicateQueue();

      // 按批次处理队列；每批请求数由 concurrency 控制。
      while (this.queue.length > 0) {
        if (this.destroyed || this.lifecycleEpoch !== epoch) break;
        // setOnUpload(null) 可能在上一条请求飞行期间发生。只在 processQueue 入口
        // 检查会让这个已经启动的循环继续取下一条，并沿用旧 callback/endpoint。
        // 业务暂停高于 flush，因此即使 forceRun 已开启也必须在这里停住。
        if (this.callbackPaused) break;
        if (!this.forceRun) {
          if (this.paused) break;
          // 半开状态下只放行一次探测性上传
          if (this.halfOpen && attempts >= 1) break;
          if (this.isDefinitelyOffline()) {
            this.pause('offline');
            break;
          }
        }

        const batchSize = probeOnlyRun ? 1 : this.config.queue.concurrency;
        const batch: QueuedLog[] = [];
        // 分片组共享一条逻辑日志的终态与 Retry-After。不同逻辑日志可以并发，
        // 但同一 splitId 一批只能取一片；否则第一片永久拒收时，兄弟请求已经发出，
        // drop cascade 再完整也只能清内存，无法撤回网络请求。
        const batchSplitIds = new Set<string>();
        while (batch.length < batchSize) {
          const item = this.takeNextDueItem(attemptedInThisRun, batchSplitIds);
          if (!item) break;
          attemptedInThisRun.add(item.log.logId);
          const splitId = getSdkSplitId(item.log);
          if (splitId !== undefined) {
            batchSplitIds.add(splitId);
          }
          batch.push(item);
        }
        if (batch.length === 0) break;
        attempts += batch.length;

        const outcomes = await Promise.all(
          batch.map((item) => this.attemptUpload(item)),
        );
        if (this.lifecycleEpoch !== epoch) break;
        if (outcomes.includes('paused')) break;
        if (probeOnlyRun) break;

        // 控制并发（虽然默认是 1，但保留扩展性）
        if (batchSize === 1) {
          // 串行模式，每次只处理一个
          // 可以在这里添加延迟，避免请求过快
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    } catch (err) {
      // 必须 catch，不能只 finally。
      //
      // processQueue 在六处以浮动 Promise 的方式被调用（定时器、online 事件、
      // 缓存恢复…），没人 await、没人 .catch。一旦抛出：
      //   1. 变成 unhandledrejection；
      //   2. 被本 SDK 自己的 ErrorCapturePlugin 当作宿主错误捕获并上报；
      //   3. finally 里的 scheduleNextRun 以 0 延迟立刻重入，再抛。
      // 三者合流就是一个自噬的热循环 —— 实测 300ms 内 216 条自造日志，
      // 缓存以 ~160KB/s 增长。
      crashed = true;
      markInternalError(err);
      this.warn('processQueue crashed; backing off to avoid a hot loop:', err);
    } finally {
      // remount 后 install 已把 isProcessing 置 false 并可能开了新一轮；
      // 旧循环不得再清掉新轮的加工中标记，也不得替新轮排程。
      if (this.lifecycleEpoch === epoch) {
        this.isProcessing = false;
        const waiters = this.processingWaiters.splice(0);
        for (const w of waiters) w();
        // 崩溃后不能按正常节奏立刻重排：那正是热循环的燃料
        this.scheduleNextRun(crashed ? CRASH_BACKOFF_MS : undefined);
      }
    }
  }

  private whenNotProcessing(): Promise<void> {
    if (!this.isProcessing) return Promise.resolve();
    return new Promise((resolve) => {
      this.processingWaiters.push(resolve);
    });
  }

  /**
   * 取出下一条到期可尝试的日志
   *
   * 队列已按优先级排序，这里在此基础上跳过还在退避期内的条目。
   */
  private takeNextDueItem(
    attempted: Set<string>,
    excludedSplitIds: ReadonlySet<string>,
  ): QueuedLog | undefined {
    const now = Date.now();
    const inFlightSplitIds = new Set(
      Array.from(this.inFlight.values(), (item) =>
        getSdkSplitId(item.log),
      ).filter((value): value is string => value !== undefined),
    );
    const index = this.queue.findIndex((it) => {
      const splitId = getSdkSplitId(it.log);
      return (
        !attempted.has(it.log.logId) &&
        (splitId === undefined ||
          (!excludedSplitIds.has(splitId) && !inFlightSplitIds.has(splitId))) &&
        (it.serverNotBefore ?? 0) <= now &&
        (this.forceRun || (it.nextAttemptAt ?? 0) <= now)
      );
    });
    if (index === -1) return undefined;
    return this.queue.splice(index, 1)[0];
  }

  /**
   * 尝试上传一条日志，并根据结果决定重试 / 丢弃 / 暂停
   *
   * @returns `paused` 表示队列已进入暂停状态，调用方应停止本轮循环
   */
  private async attemptUpload(item: QueuedLog): Promise<'done' | 'paused'> {
    let result: UploadResult | undefined;
    let thrown: unknown;
    const epoch = this.lifecycleEpoch;

    let deliveryAttempt: number | undefined;
    if (item.deliveryReceipt) {
      try {
        const persistedAttempt = await item.deliveryReceipt.beginAttempt();
        if (persistedAttempt === null) {
          // 领导权/记录租约已经被接管。旧标签不得再发出网络请求。
          return 'done';
        }
        deliveryAttempt = persistedAttempt;
      } catch (error) {
        // 在真实请求前无法提交 attempt fencing 时 fail closed：保留当前 lease，
        // 有界等待后重试；页面崩溃则由 lease expiry 接管。
        item.nextAttemptAt = Date.now() + 1_000;
        this.addToQueue(item);
        this.warn('Failed to commit coordinated delivery attempt:', error);
        this.scheduleNextRun(1_000);
        return 'done';
      }
    }
    item.deliveryAttempt = deliveryAttempt;

    this.inFlight.set(item.log.logId, item);
    this.attemptStats.total++;
    this.emit('upload:attempt', {
      log: item.log,
      source: item.source,
      retryCount: item.retryCount,
    });
    // 忽略窗口必须在「调用 onUpload」之前抬起，并在本方法退出时成对揭开：
    // - 同步 throw：Promise.resolve(fn()) 会先执行 fn，异常若在 begin 之后、
    //   内层 finally 之外，会永久泄漏全局忽略计数并让本条既不重试也不 onDrop；
    // - uninstall：见 releaseIgnoreNetworkCapture 与 ignoreHolds。
    this.holdIgnoreNetworkCapture();
    // 超时后若立刻揭开忽略窗口，迟到的上报 I/O（token 刷新后再 POST）会被
    // NetworkPlugin 记成业务流量；若一直等到 onUpload settle，挂死的回调又会
    // 把整页抓包永久致盲。折中：超时后继续忽略，但最多再宽限 UPLOAD_TIMEOUT_MS。
    let deferIgnoreRelease = false;
    const releaseIgnoreOnce = (): void => {
      // remount 后 uninstall 已强制揭开旧 hold；绝不能再 endIgnore 新生命周期的窗口
      if (this.lifecycleEpoch !== epoch) return;
      if (deferIgnoreRelease) {
        deferIgnoreRelease = false;
        this.releaseIgnoreNetworkCapture();
      }
    };
    try {
      const logWithRequestId = this.decorateForUpload(
        item.log,
        deliveryAttempt,
      );
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let uploadPromise: Promise<UploadResult> | undefined;
      try {
        // 同步抛错必须落成 rejected Promise，不能冒泡出 attemptUpload
        try {
          uploadPromise = Promise.resolve(
            this.config.onUpload(logWithRequestId),
          );
        } catch (syncError) {
          uploadPromise = Promise.reject(syncError);
        }

        result = await Promise.race([
          uploadPromise,
          new Promise<UploadResult>((_, reject) => {
            timeoutId = setTimeout(() => {
              const timeout = new Error(
                `Upload timeout (${UPLOAD_TIMEOUT_MS}ms)`,
              );
              (timeout as unknown as Record<string, unknown>)[
                UPLOAD_TIMEOUT_TAG
              ] = true;
              reject(timeout);
            }, UPLOAD_TIMEOUT_MS);
          }),
        ]);
      } catch (error) {
        // 🛡️ 标记为日志系统内部错误，避免被 ErrorCapturePlugin 捕获。
        // 不加 instanceof Error 前置判断：跨 realm 时它会返回 false，
        // 而那正是最需要这层保护的场景
        markInternalError(error);
        thrown = error;
        this.warn('Upload callback threw error:', error);
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        // 超时只结束等待，不会取消已发出的请求；吞掉晚到的 settle，
        // 避免 unhandledrejection，也不要把晚到的成功再走一遍成功路径
        // （队列已按失败处理，可能已经重试/丢弃）。
        if (isUploadTimeoutError(thrown) && uploadPromise) {
          deferIgnoreRelease = true;
          // 宽限与本次超时同量级：挡住紧随超时的迟到 I/O，又不会把抓包致盲拖太久
          const graceMs = UPLOAD_TIMEOUT_MS;
          const graceTimer = setTimeout(() => releaseIgnoreOnce(), graceMs);
          void uploadPromise
            .finally(() => {
              clearTimeout(graceTimer);
              releaseIgnoreOnce();
            })
            .then(
              () => {
                this.warn(
                  'onUpload resolved after upload timeout; the late result is ignored to avoid double-handling',
                );
              },
              () => undefined,
            );
        }
      }
    } finally {
      if (this.lifecycleEpoch === epoch) {
        if (!deferIgnoreRelease) {
          this.releaseIgnoreNetworkCapture();
        }
        this.inFlight.delete(item.log.logId);
      } else if (this.inFlight.get(item.log.logId) === item) {
        // remount 后若新生命周期尚未用同 id 占坑，清掉自己留下的幽灵 inFlight
        this.inFlight.delete(item.log.logId);
      }
    }

    // emit 必须发生在清掉 emitTarget 之前：uninstall 后 logger 已空，
    // 飞行中的终态只靠 emitTarget 送达 OfflinePersistence。
    try {
      // 同实例 remount：只扇出终态事件，不改新生命周期的队列/暂停/重试账本
      if (this.lifecycleEpoch !== epoch) {
        return await this.settleStaleAttempt(item, result, thrown);
      }

      if (result?.success) {
        this.recordAttemptOutcome('success');
        if (item.deliveryReceipt) {
          try {
            await item.deliveryReceipt.succeed();
          } catch (error) {
            // 真实成功仍然有效；常规 success 事件会进入持久删除重试链。
            this.warn('Failed to commit coordinated delivery success:', error);
          }
        }
        this.onUploadSucceeded(item);
        return 'done';
      }

      const failure = this.normalizeFailure(result, thrown);
      this.recordAttemptOutcome(failure.reason);

      if (thrown === undefined) {
        this.warn('Upload failed:', failure.error);
      }

      // 明确不需要重试 / 已拿到永久失败证据 → 立即结束生命周期
      if (failure.terminal) {
        this.consecutiveFailures = 0;
        // 服务端明确拒收，说明链路是通的 —— 探测成功了，只是这条日志不受欢迎。
        // 不在这里收尾的话 halfOpen 一直挂着、探测定时器已自我清空，队列就永久
        // 停在 paused：既不再上传，也永远不发 upload:resumed，
        // 于是 OfflinePersistencePlugin 的补传也再不会被触发。
        this.completeReachableProbe();
        if (item.deliveryReceipt) {
          await this.dropCoordinatedWithSplitCascade(item, {
            reason: 'no-retry',
            retryCount: item.retryCount,
            error: failure.error,
          });
        } else {
          this.dropWithSplitCascade(item, {
            reason: 'no-retry',
            retryCount: item.retryCount,
            error: failure.error,
          });
        }
        return 'done';
      }

      const legacy = this.config.queue.offlinePolicy === 'legacy';

      // 传输层失败：请求根本没到达服务端，与这条日志的内容无关，因此不消耗重试预算，
      // 而是作为"链路可能断了"的证据。
      //
      // 这个豁免的前提是"迟早会被暂停接住"。legacy 模式压根不会暂停，豁免就成了没有
      // 终止条件的重试 —— 所以那里一律按 v2.4 语义处理：任何失败都消耗预算。
      const transportFailure =
        !legacy && (failure.reason === 'network' || this.isDefinitelyOffline());

      if (transportFailure) {
        this.consecutiveFailures++;
        item.transportAttempts = (item.transportAttempts ?? 0) + 1;
      } else {
        // 服务端明确回了失败，恰恰证明链路是通的。把它算作离线证据会让"后端挂了"
        // 被误判成"用户断网"：队列白白暂停，maxRetries 永远耗不完，日志堆到溢出。
        this.consecutiveFailures = 0;
        item.transportAttempts = 0;
      }

      // 全局计数负责"整条链路断了"，单条计数负责"这一条一直发不出去"。
      // 少了后者，穿插的其它日志会不断把全局计数清零，让前者永远触发不了。
      const threshold = this.config.queue.suspectedOfflineThreshold;
      const suspectedOffline =
        transportFailure &&
        (this.consecutiveFailures >= threshold ||
          (item.transportAttempts ?? 0) >= threshold);

      if (suspectedOffline || this.isDefinitelyOffline()) {
        // 普通项仍由 Upload 内存队列持有。协调项则把所有权显式归还持久队列：
        // beginAttempt 已把 receipt 推进到 in-flight，若原样塞回内存，恢复后再次
        // beginAttempt 会被状态机拒绝并形成永久续租的幽灵项。
        if (item.deliveryReceipt) {
          const update = {
            nextEligibleAt: Date.now(),
            lastRetryReason: this.isDefinitelyOffline()
              ? 'offline'
              : 'suspected-offline',
          };
          try {
            await item.deliveryReceipt.retry(update);
          } catch (error) {
            this.warn(
              'Failed to return coordinated item after offline detection:',
              error,
            );
            this.retryReceiptTransition(
              'offline handoff',
              () => item.deliveryReceipt!.retry(update),
              () => undefined,
            );
          }
        } else {
          item.nextAttemptAt = undefined;
          this.addToQueue(item);
        }
        this.pause(
          this.isDefinitelyOffline() ? 'offline' : 'suspected-offline',
        );
        return 'paused';
      }

      item.retryCount = Number.isFinite(item.retryCount)
        ? Math.max(0, Math.floor(item.retryCount))
        : 0;
      // 退避按"这是第几次失败"计算，所以要在 retryCount 自增之前取值
      const attemptIndex = item.retryCount;

      if (!transportFailure) {
        if (item.retryCount >= this.config.queue.maxRetries) {
          if (legacy) {
            if (item.deliveryReceipt) {
              await this.dropCoordinatedWithSplitCascade(item, {
                reason: 'max-retries',
                retryCount: item.retryCount,
                error: failure.error,
              });
            } else
              this.dropWithSplitCascade(item, {
                reason: 'max-retries',
                retryCount: item.retryCount,
                error: failure.error,
              });
          } else {
            if (item.deliveryReceipt) await this.parkCoordinated(item, failure);
            else this.park(item, failure);
          }
          // 即使该条恰好在此进入 parked，这次非网络响应也已经证明链路恢复。
          this.completeReachableProbe();
          return 'done';
        }
        item.retryCount++;
        // 降低 10 个优先级单位
        item.priority = Math.max(1, item.priority - 10);
      }

      item.lastRetryReason = failure.reason as RetryableUploadReason;
      const now = Date.now();
      const localNotBefore = deadlineAfter(
        this.computeBackoff(attemptIndex),
        now,
      );
      item.serverNotBefore =
        failure.retryAfterMs === undefined
          ? undefined
          : deadlineAfter(failure.retryAfterMs, now);
      item.nextAttemptAt = Math.max(localNotBefore, item.serverNotBefore ?? 0);
      if (item.deliveryReceipt) {
        const update = {
          nextEligibleAt: item.nextAttemptAt,
          serverNotBefore: item.serverNotBefore,
          lastRetryReason: failure.reason,
        };
        try {
          const current = await item.deliveryReceipt.retryScheduled(update);
          if (!current) return 'done';
        } catch (error) {
          this.warn('Failed to persist coordinated retry deadline:', error);
          this.retryReceiptTransition(
            'retry deadline',
            () => item.deliveryReceipt!.retryScheduled(update),
            () => {
              this.finishRetrySchedule(item, failure, transportFailure);
              this.scheduleNextRun();
            },
          );
          return 'done';
        }
      }
      this.finishRetrySchedule(item, failure, transportFailure);
      return this.paused ? 'paused' : 'done';
    } finally {
      if (this.destroyed && this.inFlight.size === 0) {
        this.emitTarget = null;
      }
    }
  }

  private finishRetrySchedule(
    item: QueuedLog,
    failure: NormalizedUploadFailure,
    transportFailure: boolean,
  ): void {
    this.addToQueue(item);
    this.deferQueuedSplitSiblings(
      item,
      item.nextAttemptAt!,
      item.serverNotBefore,
    );
    this.emit('upload:retry-scheduled', {
      log: item.log,
      priority: item.priority,
      source: item.source,
      reason: failure.reason,
      retryCount: item.retryCount,
      nextAttemptAt: item.nextAttemptAt!,
      serverNotBefore: item.serverNotBefore,
    });
    if (!this.halfOpen) return;
    if (transportFailure) this.pause('suspected-offline');
    else this.completeReachableProbe();
  }

  /** 上传成功后的收尾：清零失败计数、退出暂停、刷新缓存 */
  private onUploadSucceeded(item: QueuedLog): void {
    const wasDegraded =
      this.halfOpen || this.paused || this.consecutiveFailures > 0;
    this.consecutiveFailures = 0;
    this.probeDelay = 0;
    this.pendingDropCount = 0;
    this.parked.delete(item.log.logId);
    if (this.halfOpen || this.paused) {
      this.clearProbeTimer();
      this.paused = false;
      this.halfOpen = false;
      this.emit('upload:resumed', { queued: this.queue.length });
      this.scheduleParkWake();
    } else if (wasDegraded) {
      this.clearProbeTimer();
    }

    this.emit('upload:success', {
      log: item.log,
      source: item.source,
    });

    // 上传成功，更新缓存
    if (this.config.cache.enabled && !this.destroyed) {
      this.scheduleCacheSave();
    }
    if (this.destroyed && this.inFlight.size === 0) {
      this.emitTarget = null;
    }
  }

  /**
   * 给即将发出的副本补上上报期元数据
   *
   * 只影响发出去的这一份拷贝，队列里的原始 entry 不变：
   * - `requestId`：每次尝试都不同，用于一次请求的关联追踪；跨重试去重请用 `logId`
   * - `tags.uploadedAt`：**发出时刻**；与 `timestamp`（捕获时刻）配合，
   *   一眼能看出这条日志是实时上报还是断网后补传的
   * - `tags.droppedSinceLastReport`：上一次成功上报以来丢了多少条，
   *   让后端看到的不再是一段无法解释的空白，而是"这里有个洞，深度 N"
   */
  private decorateForUpload(
    log: LogEntry,
    deliveryAttempt?: number,
  ): UploadPayload {
    const tags: LogTags = { ...log.tags, uploadedAt: Date.now() };
    if (this.pendingDropCount > 0) {
      tags.droppedSinceLastReport = this.pendingDropCount;
    }
    const decorated = { ...log, requestId: generateId(), tags };
    return deliveryAttempt === undefined
      ? decorated
      : { ...decorated, deliveryAttempt };
  }

  /** 指数退避：base * 2^retryCount，上限 maxMs */
  private computeBackoff(retryCount: number): number {
    const base = this.config.queue.backoffBaseMs;
    if (base <= 0) return 0;
    const exponent = Math.min(retryCount, 16);
    return Math.min(
      base * Math.pow(2, exponent),
      this.config.queue.backoffMaxMs,
    );
  }

  /**
   * 安排下一轮处理
   *
   * 取代旧版无条件的 `setTimeout(..., 0)`：所有条目都在退避期内时，
   * 会精确等到最早到期的时刻，而不是空转。
   */
  private scheduleNextRun(minDelayMs?: number): void {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    if (
      this.destroyed ||
      this.callbackPaused ||
      this.paused ||
      this.queue.length === 0
    )
      return;

    const now = Date.now();
    const inFlightSplitIds = new Set(
      Array.from(this.inFlight.values(), (item) =>
        getSdkSplitId(item.log),
      ).filter((value): value is string => value !== undefined),
    );
    let earliest = Infinity;
    for (const item of this.queue) {
      const splitId = getSdkSplitId(item.log);
      if (splitId !== undefined && inFlightSplitIds.has(splitId)) continue;
      earliest = Math.min(
        earliest,
        Math.max(item.nextAttemptAt ?? 0, item.serverNotBefore ?? 0),
      );
    }
    if (earliest === Infinity) return;
    const delay = Math.max(minDelayMs ?? 0, Math.max(0, earliest - now));
    this.wakeTimer = setTimeout(
      () => {
        this.wakeTimer = null;
        this.processQueue();
      },
      Math.min(delay, MAX_TIMER_DELAY_MS),
    );
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
    // 补传进来的条目不参与去重：它们由 OfflinePersistencePlugin 按 logId 记账，
    // 被合并掉就再也等不到 upload:success，持久层里会留下永远删不掉的残留
    const exempt: QueuedLog[] = [];
    // 分片按 splitId 归拢，整组一起比对
    const splitGroups = new Map<string, QueuedLog[]>();

    for (const item of this.queue) {
      if (item.source) {
        exempt.push(item);
        continue;
      }
      const splitId = getSdkSplitId(item.log);
      if (splitId !== undefined) {
        const bucket = splitGroups.get(splitId) || [];
        bucket.push(item);
        splitGroups.set(splitId, bucket);
        continue;
      }
      const hash = this.generateLogHash(item.log);
      const group = groups.get(hash) || [];
      group.push(item);
      groups.set(hash, group);
    }

    // 分片必须整组去重，不能逐片去重。
    //
    // 逐片比对时，两组内容相同的分片会各自独立合并，胜出的分片可能来自不同的
    // splitId —— 后端拿到一堆 splitId 互不相同的碎片，哪一组都拼不回来。
    // 整组比对则要么整组留下、要么整组丢掉，始终自洽。
    const deduplicatedSplits: QueuedLog[] = [];
    const dropped: QueuedLog[] = [];
    let splitDuplicateCount = 0;
    const seenSplitSignatures = new Map<string, string>();
    for (const [splitId, bucket] of splitGroups) {
      const signature = bucket
        .map((it) => this.generateLogHash(it.log))
        .sort()
        .join('|');
      const owner = seenSplitSignatures.get(signature);
      if (owner === undefined) {
        seenSplitSignatures.set(signature, splitId);
        deduplicatedSplits.push(...bucket);
      } else {
        splitDuplicateCount += bucket.length;
        dropped.push(...bucket);
      }
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
          for (const duplicate of group) {
            if (duplicate === best) continue;
            dropped.push(duplicate);
          }
        }
      }
    }

    const totalDuplicates = duplicateCount + splitDuplicateCount;
    const previousLength = this.queue.length;
    const next = deduplicated.concat(deduplicatedSplits, exempt);
    // 队列替换是提交边界。必须先提交，再通知外部；否则 onDrop 内同步 requeue
    // 的自救日志会被下面这次赋值静默覆盖。
    this.queue = next;
    this.queue.sort((a, b) => b.priority - a.priority);
    if (totalDuplicates > 0) {
      this.log(
        `Deduplicated ${totalDuplicates} logs, ${previousLength} -> ${next.length}`,
      );
    }
    for (const duplicate of dropped) {
      this.reportDrop(duplicate, {
        reason: 'deduplicated',
        retryCount: duplicate.retryCount,
      });
    }
  }

  /**
   * 生成无碰撞的结构键（用于去重）
   *
   * 使用 message + 第一个 stack 帧 进行 hash
   */
  private generateLogHash(log: LogEntry): string {
    const parts: string[] = [];

    // 0. 分片：同一条日志拆出的分片内容各不相同，必须各自独立上报。
    //
    // 只掺 序号/总数，**不掺 splitId** —— 后者是随机值，掺进来会让两条内容完全相同
    // 的日志算出互不相交的 hash，去重彻底失效（实测 1 次上报变 6 次）。
    // 跨分组的误合并由 deduplicateQueue 按整组比对来防，不靠这里的随机数。
    if (getSdkSplitId(log) !== undefined) {
      parts.push(
        `split:${String(log.tags?.splitIndex ?? '')}/${String(log.tags?.splitTotal ?? '')}`,
      );
    }

    // 1. 日志级别
    parts.push(log.level);

    // 2. 消息
    parts.push(log.message || '');

    // 3. 如果有 error，提取第一个 stack 帧
    const error = log.error;
    if (error) {
      // 缓存与 requeue() 都是外部可写的入口，stack 不一定是字符串。
      // 不校验的话下面的 split 会抛，而这个抛发生在没人 catch 的 processQueue 里
      if (typeof error.stack === 'string') {
        const firstFrame = this.extractFirstStackFrame(error.stack);
        if (firstFrame) {
          parts.push(firstFrame);
        }
      } else {
        parts.push(error.value);
      }
    }

    // 可靠投递不能用 32-bit 摘要决定“永久丢弃”。队列上限很小，直接保留结构化
    // 字符串键的内存成本可控，并消除了哈希碰撞与分隔符歧义造成的误去重。
    return JSON.stringify(parts);
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
      return typeof error.stack === 'string'
        ? error.stack.split('\n').length
        : 0;
    }
    return 0;
  }

  /**
   * 立即上传所有日志
   *
   * 会忽略 SDK 的本地退避与网络暂停状态，但绝不越过服务端 Retry-After。
   */
  async flush(): Promise<void> {
    // 业务显式暂停比 flush 更强：此时没有获准使用的上传回调，绝不能偷偷沿用旧端点。
    if (this.callbackPaused) return;
    // 用计数而不是布尔量。
    //
    // 布尔量下，并发的第二次 flush() 会在 isProcessing 处立刻返回，然后它的
    // finally 把 forceRun 清掉 —— 而第一次 flush 还在循环里，下一圈就撞上
    // `if (!this.forceRun && this.paused) break`，半途而废（实测三条日志只尝试了
    // 一次就退出，promise 还宣称完成了）。反向的泄漏同样存在：flush 会把
    // forceRun 漏进一个已在运行的定时轮次，把人家的退避一起绕过。
    this.forceRunDepth++;
    this.forceRun = true;
    try {
      this.unparkDue(true);
      // 当前轮可能卡在 await onUpload：先等它结束，再强制开一轮。
      // 否则 processQueue 在 isProcessing 处早退，flush 会谎称已刷完。
      await this.whenNotProcessing();
      await this.processQueue();
      await this.whenNotProcessing();
    } finally {
      this.forceRunDepth--;
      if (this.forceRunDepth <= 0) {
        this.forceRunDepth = 0;
        this.forceRun = false;
      }
    }
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
    const pending = this.queue.length + this.parked.size + this.inFlight.size;
    if (pending === 0) return;

    // 保存到 localStorage，下次启动时恢复并重试
    if (this.config.cache.enabled) {
      this.log(`Page unloading, saving ${pending} pending logs to cache`);
      // 飞行中的那条也要带上：页面即将消失，它的响应永远等不到了
      this.saveToCache({ includeInFlight: true });
    }
  }

  /**
   * 保存到本地缓存
   */
  /**
   * 合并多次缓存写入
   *
   * 同一轮里连续丢弃（典型是队列溢出）会触发很多次全量序列化，
   * 攒到本轮结束一次写完即可。
   */
  private scheduleCacheSave(): void {
    if (!this.config.cache.enabled || this.destroyed || this.cacheSaveTimer)
      return;
    this.cacheSaveTimer = setTimeout(() => {
      this.cacheSaveTimer = null;
      this.saveToCache();
    }, 0);
  }

  private saveToCache(opts: { includeInFlight?: boolean } = {}): void {
    if (!this.config.cache.enabled) return;
    // 缓存 key 是确定性的，因此是**跨实例共享**的。已卸载的实例若在飞行请求
    // 落地时回写，会把接任实例刚存的队列整个覆盖掉（实测两条在途日志被一条
    // 陈旧日志抹平）。
    if (this.destroyed) return;

    try {
      // 只保存必要信息，避免缓存过大
      const cachedAt = Date.now();
      // 卸载时把飞行中的那条也一并存下。它已经不在队列里，请求结果又永远等不到了，
      // 不存就是彻底丢失。代价是可能重复上报一次 —— 而 logId 稳定，服务端可以去重。
      // 相比之下"静默丢失"没有任何补救手段。
      // 带持久回执的恢复项以 OfflineStore 为唯一权威，不能再写入第二份 cache。
      // 所有权转移未提交时，旧 cache 是转移项唯一崩溃恢复点：把转移中的条目
      // 一并写入（而不是整体禁写），转移窗口内新入队的日志才不会失去恢复点。
      // 转移快照放最前：飞行失败重回队列的同 logId 项以活跃状态覆盖旧快照。
      const resident = Array.from(
        new Map(
          [
            ...(this.recoveryCacheTransfer ?? []),
            ...this.queue,
            ...this.parked.values(),
          ]
            .filter((item) => !item.deliveryReceipt)
            .map((item) => [item.log.logId, item] as const),
        ).values(),
      );
      const items = opts.includeInFlight
        ? Array.from(
            new Map(
              [
                ...resident,
                ...Array.from(this.inFlight.values()).filter(
                  (item) => !item.deliveryReceipt,
                ),
              ].map((item) => [item.log.logId, item]),
            ).values(),
          )
        : resident;
      const cacheData = items.map((item) => ({
        log: item.log,
        priority: item.priority,
        retryCount: item.retryCount,
        timestamp: item.timestamp,
        // TTL 基准是"写入缓存的时刻"而不是"日志入队的时刻"：
        // 后者会让一条断网 59 分钟才存盘的日志下次打开只剩 1 分钟有效期
        cachedAt,
        source: item.source,
        parkCount: item.parkCount,
        parkedUntil: item.parkedUntil,
        lastRetryReason: item.lastRetryReason,
        // Retry-After / 指数退避是服务端协议的一部分，刷新页面不能提前清零。
        nextAttemptAt: item.nextAttemptAt,
        serverNotBefore: item.serverNotBefore,
      }));

      const serialized = JSON.stringify(cacheData);
      this.platform.storage.setItem(this.config.cache.key, serialized);
      if (this.platform.storage.getItem(this.config.cache.key) !== serialized) {
        throw new Error('upload cache write did not stick');
      }
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
      const data = this.platform.storage.getItem(this.config.cache.key);
      if (data) {
        const parsed = JSON.parse(data, (key, value) => {
          if (
            key === '__proto__' ||
            key === 'constructor' ||
            key === 'prototype'
          )
            return undefined;
          return value;
        });
        if (!Array.isArray(parsed)) {
          this.removeCacheEntry();
          return;
        }

        const now = Date.now();
        const validLogs: QueuedLog[] = [];
        for (const raw of parsed) {
          if (
            raw == null ||
            typeof raw !== 'object' ||
            !('log' in raw) ||
            (raw as { log?: unknown }).log == null ||
            typeof (raw as { log?: unknown }).log !== 'object'
          ) {
            continue;
          }
          const item = raw as QueuedLog & { cachedAt?: number };
          if (
            typeof item.log.message !== 'string' ||
            !['debug', 'info', 'track', 'warn', 'error'].includes(
              String(item.log.level),
            ) ||
            (item.log.tags !== undefined &&
              (item.log.tags === null || typeof item.log.tags !== 'object'))
          ) {
            continue;
          }
          // 旧版本缓存没有 cachedAt，退回用入队时间判断，保持向后兼容
          const hasCachedAt = Object.prototype.hasOwnProperty.call(
            item,
            'cachedAt',
          );
          const ttlBase = hasCachedAt
            ? Number.isFinite(item.cachedAt)
              ? item.cachedAt
              : undefined
            : Number.isFinite(item.timestamp)
              ? item.timestamp
              : undefined;
          // 缓存是可写输入。无法证明新鲜的数据按过期处理，不能让 NaN 绕过 TTL。
          if (ttlBase === undefined || ttlBase > now + 5 * 60 * 1000) {
            this.reportDrop(item, {
              reason: 'cache-expired',
              retryCount: item.retryCount,
              source: 'upload-cache',
            });
            continue;
          }
          const age = now - ttlBase;
          if (age >= this.config.cache.ttl) {
            this.reportDrop(item, {
              reason: 'cache-expired',
              retryCount: item.retryCount,
              source: 'upload-cache',
            });
            continue;
          }
          // capturedAt 不是 TTL 事实源；cachedAt 有效时可安全修复损坏的业务时间戳，
          // 避免状态年龄变 NaN。明显来自未来的值同样收敛到已验证的缓存时刻。
          if (
            !Number.isFinite(item.log.timestamp) ||
            item.log.timestamp < 0 ||
            item.log.timestamp > now + 5 * 60 * 1000
          ) {
            item.log.timestamp = Math.min(ttlBase, now);
          }
          this.normalizeQueuedItem(item);
          // 只在内存中标记 cache 来源，对外 source 保持 2.5.2 语义。
          item.restoredFromCache = true;
          item.parkCount = Number.isFinite(item.parkCount)
            ? Math.max(0, Math.floor(item.parkCount!))
            : undefined;
          item.nextAttemptAt =
            Number.isFinite(item.nextAttemptAt) &&
            (item.nextAttemptAt ?? 0) > now
              ? item.nextAttemptAt
              : undefined;
          item.serverNotBefore =
            Number.isFinite(item.serverNotBefore) &&
            (item.serverNotBefore ?? 0) > now
              ? item.serverNotBefore
              : undefined;
          if (item.serverNotBefore !== undefined) {
            item.nextAttemptAt = Math.max(
              item.nextAttemptAt ?? 0,
              item.serverNotBefore,
            );
          }
          item.transportAttempts = 0;
          if (
            !Number.isFinite(item.parkedUntil) ||
            (item.parkedUntil ?? 0) <= now
          ) {
            item.parkedUntil = undefined;
          }
          validLogs.push(item);
        }

        const groups = new Map<string, QueuedLog[]>();
        for (const item of validLogs) {
          const splitId = item.log.tags?.splitId;
          const hasCoordinates =
            item.log.tags?.splitIndex !== undefined ||
            item.log.tags?.splitTotal !== undefined;
          const key =
            splitId !== undefined && hasCoordinates
              ? `split:${String(splitId)}`
              : `log:${item.log.logId}`;
          const group = groups.get(key);
          if (group) group.push(item);
          else groups.set(key, [item]);
        }

        for (const [key, group] of groups) {
          if (key.startsWith('split:')) {
            const expectedTotal = Number(group[0]?.log.tags?.splitTotal);
            const indices = new Set(
              group.map((item) => Number(item.log.tags?.splitIndex)),
            );
            const logIds = new Set(group.map((item) => item.log.logId));
            const complete =
              Number.isSafeInteger(expectedTotal) &&
              expectedTotal > 0 &&
              group.length === expectedTotal &&
              indices.size === expectedTotal &&
              logIds.size === expectedTotal &&
              group.every((item) => {
                const index = Number(item.log.tags?.splitIndex);
                return (
                  Number(item.log.tags?.splitTotal) === expectedTotal &&
                  Number.isSafeInteger(index) &&
                  index >= 1 &&
                  index <= expectedTotal
                );
              });
            if (!complete || group.length > this.config.queue.maxSize) {
              this.warn(
                `Ignoring incomplete or invalid cached split group "${key.slice(6)}"`,
              );
              continue;
            }
          }
          if (key.startsWith('split:')) {
            const sid = key.slice(6);
            // 实时 queue/parked/inFlight/admission 比缓存镜像权威。即使 logId 看似相同，
            // 也不把缓存残片“补进”实时生命周期，否则成功过的分片可能被复活。
            if (this.hasActiveSplitOwner(sid)) {
              this.warn(
                `Ignoring cached split group "${sid}" with an active owner`,
              );
              continue;
            }
            // 完整分片组是一个身份原子单元。只要其中一个 logId 已被实时普通日志
            // 或其它生命周期持有，就不能过滤掉冲突片后把剩余缓存片直接提交；
            // 那会绕过 admission 的完整性校验，制造一个永远无法重组的残组。
            if (group.some((item) => this.isPending(item.log.logId))) {
              this.warn(
                `Ignoring cached split group "${sid}" with a live logId owner`,
              );
              continue;
            }
          }
          const incoming = Array.from(
            new Map(
              group
                .filter((item) => !this.isPending(item.log.logId))
                .map((item) => [item.log.logId, item]),
            ).values(),
          );
          if (incoming.length === 0) continue;
          if (key.startsWith('split:')) {
            if (
              !this.makeRoomForCapacityUnit(incoming, key, () =>
                this.commitQueueItems(incoming),
              )
            ) {
              for (const item of incoming) {
                this.reportDrop(item, {
                  reason: 'queue-overflow',
                  retryCount: item.retryCount,
                  source: 'upload-cache',
                });
              }
            }
            continue;
          }
          for (const item of incoming) this.addToQueue(item);
        }

        for (const item of validLogs) {
          if (item.parkedUntil === undefined) continue;
          const index = this.queue.findIndex((queued) => queued === item);
          if (index === -1) continue;
          this.queue.splice(index, 1);
          this.parked.set(item.log.logId, item);
        }

        // 按优先级排序
        this.queue.sort((a, b) => b.priority - a.priority);

        // 恢复后立即触发上传
        if (this.queue.length > 0) {
          // 多标签插件必须先于 Upload 安装；只有这个显式 opt-in 才留出接管 cache
          // 的任务窗口。默认路径与 2.5.2 一样在 restoreFromCache 内立即开传。
          if (this.isCrossTabRecoveryOptedIn()) this.scheduleProcessQueue(true);
          else void this.processQueue();
        }
        this.scheduleParkWake();
        this.scheduleCacheSave();
      }
    } catch (error) {
      this.removeCacheEntry();
      this.warn('Failed to restore from cache:', error);
    }
  }

  private isCrossTabRecoveryOptedIn(): boolean {
    return getCrossTabDeliveryCapability(this.logger) !== null;
  }

  /**
   * 获取队列状态
   *
   * 事件是"推"，这个方法是"拉"：任何时刻都能问清楚队列有多长、是不是因为
   * 断网停住了、这个会话丢了多少条。适合做宿主 UI 提示、真机排障和集成测试断言。
   */
  getQueueStatus(): UploadQueueStatus {
    this.purgeSettledCoordinatedItems();
    const now = Date.now();
    const toStatusItem = (
      item: QueuedLog,
      state: UploadQueueStatusItem['state'],
    ): UploadQueueStatusItem => ({
      logId: item.log.logId,
      // cache / requeue 都可能带入外部可写数据；两个时间戳都损坏时按“刚观测到”
      // 处理，不能让一个 NaN 污染整个 oldestPendingAgeMs 状态快照。
      capturedAt: Number.isFinite(item.log.timestamp)
        ? item.log.timestamp
        : Number.isFinite(item.timestamp)
          ? item.timestamp
          : now,
      priority: item.priority,
      retryCount: item.retryCount,
      level: item.log.level,
      state,
    });
    const items = this.queue.map((item) => toStatusItem(item, 'queued'));
    const admittingItems = Array.from(
      this.pendingSplitAdmissions.values(),
      (admission) => Array.from(admission.items.values()),
    )
      .flat()
      .map((item) => toStatusItem(item, 'admitting'));
    const pendingItems = [
      ...items,
      ...admittingItems,
      ...Array.from(this.inFlight.values(), (item) =>
        toStatusItem(item, 'in-flight'),
      ),
      ...Array.from(this.parked.values(), (item) =>
        toStatusItem(item, 'parked'),
      ),
    ];
    const oldest = pendingItems.reduce(
      (min, item) => Math.min(min, item.capturedAt),
      Number.POSITIVE_INFINITY,
    );
    return {
      length: this.queue.length,
      inFlight: this.inFlight.size,
      parked: this.parked.size,
      admitting: admittingItems.length,
      maxSize: this.config.queue.maxSize,
      isProcessing: this.isProcessing,
      paused: this.isHeld(),
      consecutiveFailures: this.consecutiveFailures,
      drops: {
        total: this.dropStats.total,
        byReason: { ...this.dropStats.byReason },
      },
      attempts: {
        total: this.attemptStats.total,
        byReason: { ...this.attemptStats.byReason },
      },
      oldestPendingAgeMs:
        oldest === Number.POSITIVE_INFINITY ? 0 : Math.max(0, now - oldest),
      items,
      pendingItems,
    };
  }

  /**
   * 供 OfflinePersistence 在 store ready 后补齐「暂停快照」错过的队列条目
   *
   * Offline 监听器挂上之前 Upload 可能已发过 `upload:paused`；此时只能拉队列兜底。
   */
  peekQueuedForPersist(): Array<{ log: LogEntry; priority: number }> {
    return [...this.queue, ...this.parked.values()].map((item) => ({
      log: item.log,
      priority: item.priority,
    }));
  }
}
