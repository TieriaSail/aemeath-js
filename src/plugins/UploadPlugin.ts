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
} from '../types';
import { PluginPriority } from '../types';
import { generateId } from '../utils/generateId';
import {
  beginIgnoreNetworkCapture,
  endIgnoreNetworkCapture,
} from '../utils/ignoreNetworkCapture';

/**
 * UploadPlugin 发出的事件载荷（1.x 无全局 AemeathEventMap，在此本地约束）
 */
interface UploadPluginEventMap {
  'upload:drop': {
    log: LogEntry;
    reason: string;
    error?: string;
    retryCount?: number;
    source?: string;
  };
  'upload:enqueued': {
    log: LogEntry;
    priority: number;
    source?: string;
    paused: boolean;
  };
  'upload:success': { log: LogEntry; source?: string };
  'upload:paused': {
    reason: string;
    queued: number;
    logs: Array<{ log: LogEntry; priority: number }>;
  };
  'upload:resumed': { queued: number };
}

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
}

/**
 * 失败原因语义
 *
 * - `network`：传输层失败（不可达 / 超时 / DNS），与日志内容无关，**不消耗重试预算**
 * - `server`：服务端明确响应了失败（5xx / 业务错误码），消耗重试预算
 * - `payload`：日志本身有问题（400 / 413 / 字段非法），重试无意义
 */
export type UploadRetryReason = 'network' | 'server' | 'payload';

/**
 * 日志被丢弃的原因
 */
export type UploadDropReason =
  /** 服务端明确表示不必重试（`shouldRetry: false` 或 `retryReason: 'payload'`） */
  | 'no-retry'
  /** 重试预算耗尽 */
  | 'max-retries'
  /** 队列超过 maxSize，挤掉了优先级最低的日志 */
  | 'queue-overflow'
  /** 本地缓存中的日志已超过 TTL */
  | 'cache-expired'
  /** 离线持久化存储配额已满（由 OfflinePersistencePlugin 触发） */
  | 'storage-quota'
  /**
   * 离线持久化写入被拒绝（如结构化克隆失败），与配额无关
   * （由 OfflinePersistencePlugin 触发）
   */
  | 'storage-rejected'
  /** 单字段体积超限，无法上报（由 PayloadSanitizePlugin 触发） */
  | 'payload-too-large'
  /** 离线补传反复失败，放弃该条（由 OfflinePersistencePlugin 触发） */
  | 'offline-give-up';

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
   * 失败语义（可选，不传时按 `server` 处理，与旧版行为一致）
   *
   * 传 `network` 可以让这次失败**不消耗重试预算** —— 断网时尤其重要。
   */
  retryReason?: UploadRetryReason;
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
     * 上传失败后会降低优先级、按指数退避重试；预算耗尽才丢弃。
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
     * 网络不可用时的策略（默认：`'legacy'`，1.x  backport 保持与旧主线一致）
     *
     * - `'legacy'`：不感知在线状态，失败即消耗重试预算，预算耗尽就丢弃。
     * - `'pause'`：判定离线时**暂停队列** —— 不调用 `onUpload`、不消耗重试预算、
     *   不丢弃任何日志；网络恢复（`online` 事件或定时探测成功）后自动继续。
     *   需显式设置 `queue.offlinePolicy: 'pause'` 才会启用。
     *
     * `'legacy'` 时 `retryBackoff` 默认关闭；`'pause'` 时默认开启（除非显式指定）。
     */
    offlinePolicy?: 'pause' | 'legacy';

    /**
     * 重试退避（默认随 `offlinePolicy`：`legacy` 关闭 / `pause` 开启，base 1s / max 30s）
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

    /**
     * 单次 `onUpload` 等待上限（毫秒，默认：`0` = 不限制）
     *
     * 1.x 默认关闭，与 1.9 行为一致。设为例如 `30000` 后，超时会按传输层
     * 失败处理（`pause` 策略下可触发暂停；`legacy` 下消耗重试预算）。
     *
     * 超时只结束**等待**，不会取消已发出的请求；忽略网络捕获的窗口会在
     * 超时当场揭开，避免挂起的上报把全局业务抓包无限期关掉。
     */
    uploadTimeoutMs?: number;
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

/**
 * 标记本插件自己抛出的上传超时
 *
 * 用打标而不是匹配错误文案：文案是给人看的，随时可能被改写或本地化，
 * 而它一旦和判定逻辑失配，超时就会从"暂停等网络"悄悄退化成"消耗重试预算"，
 * 且没有任何测试会红。
 */
const UPLOAD_TIMEOUT_TAG = '__aemeathUploadTimeout';

function isUploadTimeoutError(err: unknown): boolean {
  return (
    err != null &&
    typeof err === 'object' &&
    (err as Record<string, unknown>)[UPLOAD_TIMEOUT_TAG] === true
  );
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
  if (err == null || (typeof err !== 'object' && typeof err !== 'function')) return;
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
 * - 误判成服务端失败 → 消耗重试预算，耗尽后以 `max-retries` 明确丢弃。有界、可观测。
 * - 误判成离线 → 整个队列暂停，上报静默停摆。无界、无声。
 *
 * 后者严重得多，所以举证责任在"离线"这一侧。这也堵住了最常见的一类误判：
 * axios / ky / got 默认对 4xx-5xx 抛异常 —— 那恰恰证明服务端回了话。
 *
 * 想要确定性而不是启发式，在 `onUpload` 里显式返回 `retryReason`。
 */
function isNetworkError(err: unknown): boolean {
  if (err == null) return false;
  const e = err as { name?: unknown; message?: unknown; code?: unknown; response?: unknown };

  // 异常上挂着 response/status → 服务端答复过了，链路是通的
  if (e.response != null) return false;

  const name = String(e.name ?? '');
  // fetch 规范：只有网络层失败才 reject，且一定是 TypeError
  if (name === 'TypeError') return true;
  // 主动中止与超时（含本插件自己的上传超时）
  if (name === 'AbortError' || name === 'TimeoutError') return true;

  // axios / node 风格的错误码
  const code = String(e.code ?? '');
  if (/^(ERR_NETWORK|ECONNABORTED|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)$/.test(code)) {
    return true;
  }

  return isUploadTimeoutError(err);
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
  readonly version = '1.10.0';
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
      /** 0 = 不限制（1.x 默认） */
      uploadTimeoutMs: number;
    };
    cache: { enabled: boolean; key: string; ttl: number };
    saveOnUnload: boolean;
    debug: boolean;
    onDrop: UploadDropCallback | null;
  };
  private queue: QueuedLog[] = [];
  private isProcessing = false;
  private destroyed = false;
  /**
   * 同实例 remount 世代：仅在 install 时递增。
   * uninstall 不递增——飞行中的 settle 仍需经 emitTarget 发出 success/drop。
   * remount 后旧 attempt 不得再改新生命周期的队列 / ignore / pause。
   */
  private lifecycleEpoch = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private deduplicationTimer: ReturnType<typeof setTimeout> | null = null;
  private debugEnabled: boolean;

  /** 队列因判定离线而暂停 */
  private paused = false;
  /** 半开状态：只允许一次探测性上传，成功才完全恢复 */
  private halfOpen = false;
  /** 当前探测间隔（指数增长，上限 PROBE_MAX_MS） */
  private probeDelay = 0;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  /** 退避唤醒定时器 */
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
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

  /** 本实例实际认领到的缓存 key，卸载时要归还 */
  private claimedCacheKey: string | null = null;

  /** 用户声明的 cache.enabled，撞车让位后据此复位 */
  private readonly cacheEnabledByConfig: boolean;

  /** 正在上传中的 logId（已出队但请求未回来） */
  /**
   * 正在飞行中的条目
   *
   * 存整条而不只是 id：卸载时它已经被 splice 出队列，只留 id 的话既进不了缓存、
   * 也没送达服务端 —— 这条日志就凭空消失了。
   */
  private readonly inFlight = new Map<string, QueuedLog>();
  /**
   * 已被 queue-overflow 整组淘汰、但仍在飞的分片 logId → 标记时的 lifecycleEpoch
   *
   * 请求无法取消；同世代 settle 后跳过 success/重试，避免后端收到残组。
   * 必须带世代：remount 后同 logId 的新 attempt 不能被旧标记误吞。
   */
  private readonly overflowDroppedInFlight = new Map<string, number>();
  /**
   * 已因 overflow 整组放弃的 splitId
   *
   * 组被清出队列后，同一次扇出里的后续分片还会继续 addToQueue；
   * 不记拒绝集的话会留下 p4/p5 这类独苗残组。
   */
  private readonly overflowRejectedSplitIds = new Set<string>();

  /** 自上次成功上报以来丢弃的条数（随下一条成功上报的日志带出） */
  private pendingDropCount = 0;
  private dropStats: { total: number; byReason: Record<string, number> } = {
    total: 0,
    byReason: {},
  };

  // 绑定后的事件处理函数引用（用于正确移除监听器）
  private boundHandleLog: ((entry: LogEntry) => void) | null = null;
  private boundHandleBeforeUnload: (() => void) | null = null;
  private boundHandleOnline: (() => void) | null = null;
  private logger: AemeathInterface | null = null;
  /**
   * uninstall 后仍用于飞行中完成事件的 emit 目标
   *
   * `logger` 在 uninstall 时置空以停止收新日志；但已在飞的 onUpload settle 后
   * 仍需发出 `upload:success`，供 OfflinePersistence 记下待删盘墓碑。
   */
  private emitTarget: AemeathInterface | null = null;
  /**
   * 本实例当前持有的 ignoreNetworkCapture 引用数
   *
   * uninstall 时必须全部释放：否则挂起的 onUpload 会把全局忽略计数留在 >0，
   * NetworkPlugin 仍在的话整页业务抓包永久致盲。
   */
  private ignoreHolds = 0;

  constructor(options: UploadPluginOptions) {
    this.debugEnabled = options.debug ?? false;
    const clamp = (v: number | undefined, fallback: number, min: number) =>
      v != null && Number.isFinite(v) && v >= min ? v : fallback;

    // 1.x 默认 legacy，与旧主线行为一致；仅显式设 pause 才启用暂停策略
    const offlinePolicy = options.queue?.offlinePolicy === 'pause' ? 'pause' : 'legacy';
    // legacy 模式默认同时关闭退避；pause 模式默认开启
    const backoffOption = options.queue?.retryBackoff ?? offlinePolicy !== 'legacy';
    const backoffEnabled = backoffOption !== false;
    const backoffConfig = typeof backoffOption === 'object' ? backoffOption : {};

    this.config = {
      onUpload: options.onUpload,
      getPriority: options.getPriority || defaultGetPriority,
      queue: {
        maxSize: clamp(options.queue?.maxSize, 100, 1),
        concurrency: clamp(options.queue?.concurrency, 1, 1),
        maxRetries: clamp(options.queue?.maxRetries, 3, 0),
        uploadInterval: clamp(options.queue?.uploadInterval, 30000, 1000),
        deduplicationDelay: clamp(options.queue?.deduplicationDelay, 50, 0),
        offlinePolicy,
        backoffBaseMs: backoffEnabled ? clamp(backoffConfig.baseMs, 1000, 0) : 0,
        backoffMaxMs: backoffEnabled ? clamp(backoffConfig.maxMs, 30000, 0) : 0,
        suspectedOfflineThreshold: clamp(options.queue?.suspectedOfflineThreshold, 3, 1),
        // 1.x 默认关闭：1.9 没有上传超时，硬编码 30s 会把慢上报打成失败
        uploadTimeoutMs: clamp(options.queue?.uploadTimeoutMs, 0, 0),
      },
      cache: {
        enabled: options.cache?.enabled !== false,
        key: options.cache?.key || '__logger_upload_queue__',
        ttl: clamp(options.cache?.ttl, DEFAULT_CACHE_TTL, 0),
      },
      saveOnUnload: options.saveOnUnload !== false,
      debug: options.debug ?? false,
      onDrop: options.onDrop ?? null,
    };
    this.cacheEnabledByConfig = this.config.cache.enabled;
  }

  /**
   * 在运行时替换 `onUpload` 回调
   *
   * 适用于：endpoint / token / authorization header 在 logger 初始化之后才能
   * 拿到的场景（典型：用户登录后才能拿到 access token；多租户应用按租户切换
   * upload endpoint）。
   *
   * **保留状态**：队列里已经在排队的日志会用新的回调上报；正在飞行的 in-flight
   * 请求仍走旧回调（不打断它）。getPriority / queue / cache 等其他配置不变。
   *
 * 如果传 `null`，会替换成一个永远 `success: true` 的 no-op 回调（**注意**：
 * 队列项以此被**成功**出队并被丢弃，并非「失败→重试」，也不等于冻结
 * 整块持久化缓存 —— 这是 "暂停上报（吞掉）" 而不是 "上报失败"）。
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
   *   return { success: res.ok };
   * });
   * ```
   */
  public setOnUpload(callback: UploadCallback | null): void {
    if (callback === null) {
      // no-op：返回 success 让队列消化掉 → 不上报，也不残留 retry
      this.config.onUpload = async () => ({ success: true });
    } else {
      this.config.onUpload = callback;
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
    this.config.cache.enabled = this.cacheEnabledByConfig;
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
        'They would overwrite each other and could restore one project\'s logs into the other\'s ' +
        'endpoint, so caching is now disabled for this instance (uploading is unaffected). ' +
        'Give each instance its own `cache.key` to keep offline caching on both.'
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
    // uninstall 会清探针但不清 paused；若 remount 后仍 paused 且探针已无，
    // processQueue 会永久早退，pause 模式下队列静默死掉。
    this.paused = false;
    this.halfOpen = false;
    this.probeDelay = 0;
    this.consecutiveFailures = 0;
    this.clearProbeTimer();
    // remount 后旧 split 拒绝集无意义；新扇出会用新的 splitId
    this.overflowRejectedSplitIds.clear();
    this.logger = logger;
    this.emitTarget = logger;

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

    // 监听页面卸载，保存队列到缓存（1.x 无 PlatformAdapter，直接用 window）
    if (this.config.saveOnUnload && typeof window !== 'undefined') {
      try {
        window.addEventListener('beforeunload', this.boundHandleBeforeUnload);
      } catch {
        this.warn('Failed to register beforeunload handler');
      }
    }

    this.registerOnlineListener();
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

    this.clearProbeTimer();
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    if (this.cacheSaveTimer) {
      clearTimeout(this.cacheSaveTimer);
      this.cacheSaveTimer = null;
    }

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

    // 移除页面卸载事件监听（使用保存的引用）
    if (typeof window !== 'undefined' && this.boundHandleBeforeUnload) {
      try {
        window.removeEventListener('beforeunload', this.boundHandleBeforeUnload);
      } catch (err) {
        this.warn('Failed to detach beforeunload handler:', err);
      }
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
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    this.boundHandleOnline = () => {
      this.log('online event received, resuming queue');
      this.resume();
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
    return this.paused || this.halfOpen;
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
        logs: this.queue.map((item) => ({ log: item.log, priority: item.priority })),
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
      this.probeDelay === 0 ? PROBE_BASE_MS : Math.min(this.probeDelay * 2, PROBE_MAX_MS);
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

  /** 完全恢复队列处理 */
  private resume(): void {
    if (this.destroyed) return;
    const wasPaused = this.paused || this.halfOpen;
    this.clearProbeTimer();
    this.paused = false;
    this.halfOpen = false;
    this.probeDelay = 0;
    this.consecutiveFailures = 0;
    if (wasPaused) {
      this.emit('upload:resumed', { queued: this.queue.length });
    }
    this.processQueue();
  }

  /**
   * 发事件
   *
   * 1.x 无全局 AemeathEventMap，用本地 UploadPluginEventMap 约束载荷形状。
   */
  private emit<K extends keyof UploadPluginEventMap>(
    event: K,
    payload: UploadPluginEventMap[K],
  ): void {
    (this.logger ?? this.emitTarget)?.emit(event, payload);
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
    this.addToQueue(
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
    options: { source?: string; priority?: number } = {},
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
      this.addToQueue(
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

  /**
   * 添加到队列（按优先级排序）
   */
  private addToQueue(item: QueuedLog, opts: { announce?: boolean } = {}): void {
    // 已卸载的实例不再收日志。
    //
    // `plugin.uninstall()`（不带参数直接调，正是框架 teardown 钩子的写法）
    // 不会摘掉 logger 上的 log 监听器，于是这个"墓碑"实例会继续攒日志、
    // 攒到 maxSize 后还朝宿主发 queue-overflow 的 onDrop —— 而它一条都发不出去。
    if (this.destroyed) return;

    const incomingSplitId = item.log.tags?.splitId;
    // 拒绝集只挡同一次入队风暴里的后续独苗；offline-replay 必须放行，
    // 否则 overflow 落盘后的补传会被同一 splitId 永久拒收。
    if (
      incomingSplitId !== undefined &&
      item.source !== 'offline-replay' &&
      this.overflowRejectedSplitIds.has(String(incomingSplitId))
    ) {
      this.reportDrop(item, { reason: 'queue-overflow', retryCount: item.retryCount });
      return;
    }

    // 检查队列长度
    if (this.queue.length >= this.config.queue.maxSize) {
      // 移除优先级最低的日志
      this.queue.sort((a, b) => a.priority - b.priority);
      const evicted = this.queue.shift();
      if (evicted) {
        this.reportDrop(evicted, { reason: 'queue-overflow', retryCount: evicted.retryCount });
        // 淘汰的是某个分片 → 同组其余分片一起淘汰。
        //
        // 拆分让一条日志占了 N 个槽位，因此溢出更容易发生，而单独踢掉一片会让
        // 后端收到一组永远拼不回来的碎片。要么整组到齐，要么整组不发。
        // 已出队 inFlight 的分片也必须算进整组：否则队列残片被踢、飞行片仍 success。
        // 触发本次入队的新条目若同属该 splitId，也必须丢掉——否则会出现
        // 「组内旧片全丢、新片独苗入队」的残组。
        const splitId = evicted.log.tags?.splitId;
        if (splitId !== undefined) {
          this.overflowRejectedSplitIds.add(String(splitId));
          const siblings = this.queue.filter((it) => it.log.tags?.splitId === splitId);
          if (siblings.length > 0) {
            this.queue = this.queue.filter((it) => it.log.tags?.splitId !== splitId);
            for (const sibling of siblings) {
              this.reportDrop(sibling, {
                reason: 'queue-overflow',
                retryCount: sibling.retryCount,
              });
            }
          }
          for (const [logId, flying] of this.inFlight) {
            if (flying.log.tags?.splitId !== splitId) continue;
            if (this.overflowDroppedInFlight.has(logId)) continue;
            this.overflowDroppedInFlight.set(logId, this.lifecycleEpoch);
            this.reportDrop(flying, {
              reason: 'queue-overflow',
              retryCount: flying.retryCount,
            });
          }
          if (item.log.tags?.splitId === splitId) {
            this.reportDrop(item, {
              reason: 'queue-overflow',
              retryCount: item.retryCount,
            });
            return;
          }
        }
      }
    }

    // 添加到队列
    this.queue.push(item);

    // 按优先级排序（高优先级在前）
    this.queue.sort((a, b) => b.priority - a.priority);

    if (opts.announce) {
      this.emit('upload:enqueued', {
        log: item.log,
        priority: item.priority,
        source: item.source,
        // 与 getQueueStatus() 用同一个判据。两处不一致的话，半开期间入队的日志
        // 会被 OfflinePersistencePlugin 当成"队列正常"而不落盘 —— 而半开恰恰
        // 是最可能发不出去的时刻。
        paused: this.isHeld(),
      });
    }

    // 保存到缓存
    if (this.config.cache.enabled) {
      this.saveToCache();
    }
  }

  /** 是否正在飞行中（已出队、等待 onUpload settle）——比 `isPending` 更窄 */
  public isInFlight(logId: string): boolean {
    return this.inFlight.has(logId);
  }

  /**
   * 某条日志是否仍由本插件持有（排队中、退避等待中，或正在上传）
   *
   * 供 OfflinePersistencePlugin 判断"这条还在内存队列里、不需要从持久层再投一次"。
   * 必须把**正在上传**也算进来：网络恢复的那一瞬间，条目已经被取出队列但请求
   * 还没回来，只看队列数组就会把它当成"丢了"而重复补投。
   */
  public isPending(logId: string): boolean {
    return this.inFlight.has(logId) || this.queue.some((item) => item.log.logId === logId);
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
    this.reportDrop({ log, priority: 0, retryCount: 0, timestamp: Date.now() }, info);
    return true;
  }

  /**
   * 统一的丢弃出口：计数 + 回调 + 事件
   *
   * 所有放弃日志的路径都必须走这里，否则宿主又会回到"日志静默消失"的状态。
   */
  private reportDrop(item: QueuedLog, info: Omit<UploadDropInfo, 'source'> & { source?: string }): void {
    const payload: UploadDropInfo = { ...info, source: info.source ?? item.source };
    this.dropStats.total++;
    this.dropStats.byReason[payload.reason] = (this.dropStats.byReason[payload.reason] ?? 0) + 1;
    this.pendingDropCount++;

    this.warn(`Dropping log (${payload.reason}, retryCount=${item.retryCount})`);

    // 卸载之后仍经 emitTarget 扇出 drop：OfflinePersistence 要靠它撤掉乐观墓碑 /
    // 清盘。但不再调宿主 onDrop、也不再写 cache——宿主上下文可能已拆掉。
    if (this.destroyed) {
      this.emit('upload:drop', { log: item.log, ...payload });
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
   * 处理队列（串行上传）
   *
   * 与 v2.4 的关键差异：
   * 1. 判定离线时**暂停**而不是继续打空枪 —— 断网不再秒级耗尽重试预算。
   * 2. 重试之间有指数退避，`nextAttemptAt` 未到期的条目会被跳过。
   * 3. 传输层失败（抛错 / 超时 / `retryReason: 'network'`）不消耗重试预算。
   */
  private async processQueue(): Promise<void> {
    if (this.destroyed || this.isProcessing || this.queue.length === 0) {
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
    // 一轮之内每条日志最多尝试一次。
    //
    // forceRun 会让 takeNextDueItem 无视 nextAttemptAt，而失败的条目是在这个
    // 循环**内部**重新入队的 —— 少了这道闸，一次 flush() 就会贴着 CPU 把每条
    // 日志的 maxRetries 一次烧光（实测 1.2 秒内 12 次请求、三条日志全部丢弃）。
    const attemptedInThisRun = new Set<string>();

    try {
      // 🎯 处理前先对队列进行去重，保留信息最完整的日志
      this.deduplicateQueue();

      // 依次处理队列中的日志（串行，确保同一时间只有一个请求）
      while (this.queue.length > 0) {
        if (this.destroyed || this.lifecycleEpoch !== epoch) break;
        if (!this.forceRun) {
          if (this.paused) break;
          // 半开状态下只放行一次探测性上传
          if (this.halfOpen && attempts >= 1) break;
          if (this.isDefinitelyOffline()) {
            this.pause('offline');
            break;
          }
        }

        const item = this.takeNextDueItem(attemptedInThisRun);
        if (!item) break;
        attempts++;
        attemptedInThisRun.add(item.log.logId);
        // 出队后立刻占坑：否则 OfflinePersistence 的 isPending 会在
        // attemptUpload 入口之前返回 false，联网瞬间内存队列与补传会双发。
        this.inFlight.set(item.log.logId, item);

        const outcome = await this.attemptUpload(item);
        if (this.lifecycleEpoch !== epoch) break;
        if (outcome === 'paused') break;

        // 控制并发（虽然默认是 1，但保留扩展性）
        if (this.config.queue.concurrency === 1) {
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
        // 崩溃后不能按正常节奏立刻重排：那正是热循环的燃料
        this.scheduleNextRun(crashed ? CRASH_BACKOFF_MS : undefined);
      }
    }
  }

  /**
   * 取出下一条到期可尝试的日志
   *
   * 队列已按优先级排序，这里在此基础上跳过还在退避期内的条目。
   */
  private takeNextDueItem(attempted: Set<string>): QueuedLog | undefined {
    const now = Date.now();
    const index = this.queue.findIndex(
      (it) =>
        !attempted.has(it.log.logId) && (this.forceRun || (it.nextAttemptAt ?? 0) <= now),
    );
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

    this.inFlight.set(item.log.logId, item);
    // 忽略窗口必须在「调用 onUpload」之前抬起，并在本方法退出时成对揭开：
    // - 同步 throw：Promise.resolve(fn()) 会先执行 fn，异常若在 begin 之后、
    //   内层 finally 之外，会永久泄漏全局忽略计数并让本条既不重试也不 onDrop；
    // - uninstall：见 releaseIgnoreNetworkCapture 与 ignoreHolds。
    this.holdIgnoreNetworkCapture();
    // 超时后若立刻揭开忽略窗口，迟到的上报 I/O（token 刷新后再 POST）会被
    // NetworkPlugin 记成业务流量；若一直等到 onUpload settle，挂死的回调又会
    // 把整页抓包永久致盲。折中：超时后继续忽略，但最多再宽限 uploadTimeoutMs。
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
      const logWithRequestId = this.decorateForUpload(item.log);
      const timeoutMs = this.config.queue.uploadTimeoutMs;

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let uploadPromise: Promise<UploadResult> | undefined;
      try {
        // 同步抛错必须落成 rejected Promise，不能冒泡出 attemptUpload
        try {
          uploadPromise = Promise.resolve(this.config.onUpload(logWithRequestId));
        } catch (syncError) {
          uploadPromise = Promise.reject(syncError);
        }

        if (timeoutMs > 0) {
          result = await Promise.race([
            uploadPromise,
            new Promise<UploadResult>((_, reject) => {
              timeoutId = setTimeout(() => {
                const timeout = new Error(`Upload timeout (${timeoutMs}ms)`);
                (timeout as unknown as Record<string, unknown>)[UPLOAD_TIMEOUT_TAG] = true;
                reject(timeout);
              }, timeoutMs);
            }),
          ]);
        } else {
          result = await uploadPromise;
        }
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
          const graceMs = timeoutMs;
          const graceTimer = setTimeout(() => releaseIgnoreOnce(), graceMs);
          void uploadPromise.finally(() => {
            clearTimeout(graceTimer);
            releaseIgnoreOnce();
          }).then(
            () => {
              this.warn(
                'onUpload resolved after uploadTimeoutMs; the late result is ignored to avoid double-handling',
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

    // 同组已被 queue-overflow 整组丢掉：请求无法取消，settle 后既不 success 也不重试。
    // 只压制「标记时的同一世代」——remount 后同 logId 的新 attempt 必须还能 success。
    const overflowAt = this.overflowDroppedInFlight.get(item.log.logId);
    if (overflowAt !== undefined && overflowAt === epoch) {
      this.overflowDroppedInFlight.delete(item.log.logId);
      // success 被抑制，Offline 收不到 upload:success；飞完后发 resumed
      // 让盘上刚落盘的 overflow 副本有机会补传。
      if (!this.destroyed) {
        this.emit('upload:resumed', { queued: this.queue.length });
      }
      if (this.destroyed && this.inFlight.size === 0) {
        this.emitTarget = null;
      }
      return 'done';
    }

    // 同实例 remount：只扇出终态事件，不改新生命周期的队列/暂停/重试账本
    if (this.lifecycleEpoch !== epoch) {
      return this.settleStaleAttempt(item, result, thrown);
    }

    // emit 必须发生在清掉 emitTarget 之前：uninstall 后 logger 已空，
    // 飞行中的 success 只靠 emitTarget 送达 OfflinePersistence。
    try {
      if (result?.success) {
        this.onUploadSucceeded(item);
        return 'done';
      }

      const errorMessage =
        thrown !== undefined
          ? String((thrown as { message?: unknown })?.message ?? thrown)
          : result?.error || 'Unknown error';

      if (thrown === undefined) {
        this.warn('Upload failed:', errorMessage);
      }

      // 明确不需要重试 → 立即丢弃（日志本身有问题，重试无意义）
      const noRetry =
        thrown === undefined && (result?.shouldRetry !== true || result?.retryReason === 'payload');
      if (noRetry) {
        this.consecutiveFailures = 0;
        // 服务端明确拒收，说明链路是通的 —— 探测成功了，只是这条日志不受欢迎。
        // 不在这里收尾的话 halfOpen 一直挂着、探测定时器已自我清空，队列就永久
        // 停在 paused：既不再上传，也永远不发 upload:resumed，
        // 于是 OfflinePersistencePlugin 的补传也再不会被触发。
        if (this.halfOpen) {
          this.halfOpen = false;
          this.clearProbeTimer();
          this.probeDelay = 0;
          this.emit('upload:resumed', { queued: this.queue.length });
        }
        this.reportDrop(item, {
          reason: 'no-retry',
          retryCount: item.retryCount,
          error: errorMessage,
        });
        return 'done';
      }

      const legacy = this.config.queue.offlinePolicy === 'legacy';

      // 传输层失败：请求根本没到达服务端，与这条日志的内容无关，因此不消耗重试预算，
      // 而是作为"链路可能断了"的证据。
      //
      // 这个豁免的前提是"迟早会被暂停接住"。legacy 模式压根不会暂停，豁免就成了没有
      // 终止条件的重试 —— 所以那里一律按 v2.4 语义处理：任何失败都消耗预算。
      const transportFailure =
        !legacy &&
        (result?.retryReason === 'network' ||
          this.isDefinitelyOffline() ||
          (thrown !== undefined && isNetworkError(thrown)));

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
        (this.consecutiveFailures >= threshold || (item.transportAttempts ?? 0) >= threshold);

      if (suspectedOffline || this.isDefinitelyOffline()) {
        // 判定为网络问题：原样放回队列（不计重试、不降优先级），暂停等待恢复
        item.nextAttemptAt = undefined;
        this.addToQueue(item);
        this.pause(this.isDefinitelyOffline() ? 'offline' : 'suspected-offline');
        return 'paused';
      }

      // 退避按"这是第几次失败"计算，所以要在 retryCount 自增之前取值
      const attemptIndex = item.retryCount;

      if (!transportFailure) {
        // 缓存被外部改坏时 retryCount 可能不是数字；`NaN >= n` 恒为 false，
        // 不兜住的话这条日志会永远耗不完预算
        if (!Number.isFinite(item.retryCount)) item.retryCount = 0;
        if (item.retryCount >= this.config.queue.maxRetries) {
          this.reportDrop(item, {
            reason: 'max-retries',
            retryCount: item.retryCount,
            error: errorMessage,
          });
          return 'done';
        }
        item.retryCount++;
        // 降低 10 个优先级单位
        item.priority = Math.max(1, item.priority - 10);
      }

      item.nextAttemptAt = Date.now() + this.computeBackoff(attemptIndex);
      this.addToQueue(item);

      if (this.halfOpen) {
        if (transportFailure) {
          // 探测仍然发不出去 → 回到暂停，探测间隔翻倍
          this.pause('suspected-offline');
          return 'paused';
        }
        // 探测拿到了服务端响应：链路已经通了，哪怕这次响应本身是失败的
        this.halfOpen = false;
        this.clearProbeTimer();
        this.emit('upload:resumed', { queued: this.queue.length });
      }
      return 'done';
    } finally {
      if (this.destroyed && this.inFlight.size === 0) {
        this.emitTarget = null;
      }
    }
  }

  /**
   * remount 之后才 settle 的旧 attempt：服务端可能已经收到，必须扇出终态；
   * 但队列/暂停/重试/onDrop/cache 归新生命周期管——旧路径再 addToQueue 或
   * releaseIgnore 会污染新实例（重复上报、偷揭 ignore 窗口）。
   */
  private settleStaleAttempt(
    item: QueuedLog,
    result: UploadResult | undefined,
    thrown: unknown,
  ): 'done' {
    if (result?.success) {
      this.queue = this.queue.filter((q) => q.log.logId !== item.log.logId);
      this.emit('upload:success', { log: item.log, source: item.source });
      if (this.config.cache.enabled && !this.destroyed) {
        this.scheduleCacheSave();
      }
      return 'done';
    }

    const errorMessage =
      thrown !== undefined
        ? String((thrown as { message?: unknown })?.message ?? thrown)
        : result?.error || 'Unknown error';
    const noRetry =
      thrown === undefined && (result?.shouldRetry !== true || result?.retryReason === 'payload');
    if (noRetry) {
      this.queue = this.queue.filter((q) => q.log.logId !== item.log.logId);
      // 与 destroyed 路径一致：只 emit，不调宿主 onDrop
      this.emit('upload:drop', {
        log: item.log,
        reason: 'no-retry' as const,
        retryCount: item.retryCount,
        error: errorMessage,
        source: item.source,
      });
      if (this.config.cache.enabled && !this.destroyed) {
        this.scheduleCacheSave();
      }
    }
    // 传输层失败 / 可重试：新生命周期若已从 cache 恢复会自己再传，这里不重入队
    return 'done';
  }

  /** 上传成功后的收尾：清零失败计数、退出暂停、刷新缓存 */
  private onUploadSucceeded(item: QueuedLog): void {
    const wasDegraded = this.halfOpen || this.paused || this.consecutiveFailures > 0;
    this.consecutiveFailures = 0;
    this.probeDelay = 0;
    this.pendingDropCount = 0;
    if (this.halfOpen || this.paused) {
      this.clearProbeTimer();
      this.paused = false;
      this.halfOpen = false;
      this.emit('upload:resumed', { queued: this.queue.length });
    } else if (wasDegraded) {
      this.clearProbeTimer();
    }

    this.emit('upload:success', { log: item.log, source: item.source });

    // 上传成功，更新缓存
    if (this.config.cache.enabled) {
      this.saveToCache();
    }
  }

  /**
   * 给即将发出的副本补上上报期元数据
   *
   * 只影响发出去的这一份拷贝，队列里的原始 entry 不变：
   * - `requestId`：每次尝试都不同，供消费端幂等去重
   * - `tags.uploadedAt`：**发出时刻**；与 `timestamp`（捕获时刻）配合，
   *   一眼能看出这条日志是实时上报还是断网后补传的
   * - `tags.droppedSinceLastReport`：上一次成功上报以来丢了多少条，
   *   让后端看到的不再是一段无法解释的空白，而是"这里有个洞，深度 N"
   */
  private decorateForUpload(log: LogEntry): LogEntry {
    const tags: LogTags = { ...log.tags, uploadedAt: Date.now() };
    if (this.pendingDropCount > 0) {
      tags.droppedSinceLastReport = this.pendingDropCount;
    }
    return { ...log, requestId: generateId(), tags };
  }

  /** 指数退避：base * 2^retryCount，上限 maxMs */
  private computeBackoff(retryCount: number): number {
    const base = this.config.queue.backoffBaseMs;
    if (base <= 0) return 0;
    const exponent = Math.min(retryCount, 16);
    return Math.min(base * Math.pow(2, exponent), this.config.queue.backoffMaxMs);
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
    if (this.destroyed || this.paused || this.queue.length === 0) return;

    const now = Date.now();
    let earliest = Infinity;
    for (const item of this.queue) {
      earliest = Math.min(earliest, item.nextAttemptAt ?? 0);
    }
    const delay = Math.max(
      minDelayMs ?? 0,
      Math.max(0, (earliest === Infinity ? now : earliest) - now),
    );
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.processQueue();
    }, delay);
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
      const splitId = item.log.tags?.splitId;
      if (splitId !== undefined) {
        const key = String(splitId);
        const bucket = splitGroups.get(key) || [];
        bucket.push(item);
        splitGroups.set(key, bucket);
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
        }
      }
    }

    const totalDuplicates = duplicateCount + splitDuplicateCount;
    const next = deduplicated.concat(deduplicatedSplits, exempt);
    if (totalDuplicates > 0) {
      this.log(`Deduplicated ${totalDuplicates} logs, ${this.queue.length} -> ${next.length}`);
    }

    // 更新队列，保持优先级排序
    this.queue = next;
    this.queue.sort((a, b) => b.priority - a.priority);
  }

  /**
   * 生成日志的 hash（用于去重）
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
    if (log.tags?.splitId !== undefined) {
      parts.push(`split:${String(log.tags?.splitIndex ?? '')}/${String(log.tags?.splitTotal ?? '')}`);
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
      return typeof error.stack === 'string' ? error.stack.split('\n').length : 0;
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
   *
   * 会**忽略退避与暂停状态**强制尝试一轮 —— 这是显式 API，调用方要的就是"现在就发"。
   */
  async flush(): Promise<void> {
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
      await this.processQueue();
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
    const pending = this.queue.length + this.inFlight.size;
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
    if (!this.config.cache.enabled || this.destroyed || this.cacheSaveTimer) return;
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
      const items = opts.includeInFlight
        ? [...this.queue, ...this.inFlight.values()]
        : this.queue;
      const cacheData = items.map((item) => ({
        log: item.log,
        priority: item.priority,
        retryCount: item.retryCount,
        timestamp: item.timestamp,
        // TTL 基准是"写入缓存的时刻"而不是"日志入队的时刻"：
        // 后者会让一条断网 59 分钟才存盘的日志下次打开只剩 1 分钟有效期
        cachedAt,
        source: item.source,
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
        const parsed = JSON.parse(data, (key, value) => {
          if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
          return value;
        });
        if (!Array.isArray(parsed)) return;

        const now = Date.now();
        const wellFormed = parsed.filter(
          (item: unknown): item is QueuedLog & { cachedAt?: number } =>
            item != null &&
            typeof item === 'object' &&
            'log' in item &&
            (item as { log?: unknown }).log != null &&
            typeof (item as { log?: unknown }).log === 'object' &&
            'priority' in item &&
            'timestamp' in item,
        );

        const validLogs: QueuedLog[] = [];
        for (const item of wellFormed) {
          // 旧版本缓存没有 cachedAt，退回用入队时间判断，保持向后兼容
          const age = now - (item.cachedAt ?? item.timestamp);
          if (age >= this.config.cache.ttl) {
            this.reportDrop(item, { reason: 'cache-expired', retryCount: item.retryCount });
            continue;
          }
          if (!item.log.logId) {
            item.log.logId = generateId();
          }
          // 缓存是可被外部篡改的输入，字段缺失 / 类型不对都要在这里收敛，
          // 否则坏数据会一路带到重试预算判断里
          if (!Number.isFinite(item.retryCount)) item.retryCount = 0;
          if (!Number.isFinite(item.priority)) item.priority = 0;
          // 退避状态不跨会话保留：新的一次页面加载往往意味着新的网络环境
          item.nextAttemptAt = undefined;
          item.transportAttempts = 0;
          validLogs.push(item);
        }

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
   * 获取队列状态
   *
   * 事件是"推"，这个方法是"拉"：任何时刻都能问清楚队列有多长、是不是因为
   * 断网停住了、这个会话丢了多少条。适合做宿主 UI 提示、真机排障和集成测试断言。
   */
  getQueueStatus(): {
    length: number;
    /** 队列容量上限（供 OfflinePersistence 按空位补传，避免批量 requeue 自己把自己挤爆） */
    maxSize: number;
    isProcessing: boolean;
    /** 是否因判定离线而暂停 */
    paused: boolean;
    /** 连续传输层失败次数（成功或收到服务端响应即清零） */
    consecutiveFailures: number;
    /** 本会话的丢弃统计 */
    drops: { total: number; byReason: Record<string, number> };
    items: Array<{ priority: number; retryCount: number; level: string }>;
  } {
    return {
      length: this.queue.length,
      maxSize: this.config.queue.maxSize,
      isProcessing: this.isProcessing,
      paused: this.isHeld(),
      consecutiveFailures: this.consecutiveFailures,
      drops: { total: this.dropStats.total, byReason: { ...this.dropStats.byReason } },
      items: this.queue.map((item) => ({
        priority: item.priority,
        retryCount: item.retryCount,
        level: item.log.level,
      })),
    };
  }
}
