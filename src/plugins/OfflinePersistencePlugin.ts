/**
 * OfflinePersistence 插件 — 断网期间落盘，联网后自动补传
 *
 * `UploadPlugin` 自带的 localStorage 缓存只解决"页面重载"（刷新、关闭后重开），
 * 它是队列镜像，日志一旦被丢弃就不在缓存里。真正的断网续传由本插件提供，
 * 并且刻意做成独立插件。标准入口配置 upload 时默认安装，可显式关闭。
 *
 * 工作方式（全部基于事件，不侵入 UploadPlugin 内部）：
 *
 * ```
 * upload:paused  → 之后 upload:enqueued 的日志镜像落盘
 * upload:drop    → 兜底落盘（队列溢出 / 重试耗尽）
 * online / upload:resumed → 分批 upload.requeue(..., source: 'offline-replay')
 * upload:success → 按 logId 删除持久副本
 * ```
 *
 * 关键约束：
 * - **成功才删**。入队即删会在上传失败时丢掉唯一的持久副本。
 * - 补传走 `UploadPlugin.requeue()` 而不是 `logger.log()`，因此其它插件、
 *   `beforeSend` 和业务侧的 `logger.on('log')` 都不会被重放打扰。
 * - 补传失败超过 `maxReplayAttempts` 就放弃并清理，避免僵尸记录无限占位。
 * - 1.x 无 PlatformAdapter；存储降级为 IndexedDB → localStorage → noop。
 */

import type { AemeathPlugin, AemeathInterface, LogEntry, LogTags } from '../types';
import { PluginPriority } from '../types';
import type { UploadPlugin, UploadDropReason } from './UploadPlugin';
import { jsonBytes } from '../utils/payloadSanitize';
import { getSdkSplitId as getSplitId } from '../utils/splitIdentity';
import {
  createNoopStore,
  createOfflineStore,
  type OfflineBackend,
  type OfflineRecord,
  type OfflineRecordMeta,
  type OfflineStore,
} from './offline/OfflineStore';

/** 补传时打在日志上的来源标记，用于防止"补传失败 → 再次落盘"的死循环 */
export const OFFLINE_REPLAY_SOURCE = 'offline-replay';

/**
 * 持久层自身丢弃时的来源标记
 *
 * 与 `offline-replay` 区分开：配额淘汰、TTL 过期发生在"存"这一侧，这些日志
 * 一次都没补传过，标成 replay 会让宿主误以为补传失败了。
 */
export const OFFLINE_STORE_SOURCE = 'offline-store';

/**
 * 写入失败是不是"空间不够"
 *
 * 只有空间不够才值得腾地方重试。像 `DataCloneError`（值无法结构化克隆）这类
 * 失败换多少空间都一样会失败，误判成配额问题就会白白淘汰掉一批健康日志。
 *
 * 各家浏览器对配额错误的命名并不统一，所以 name 和 message 都要看。
 */
function isQuotaError(err: unknown): boolean {
  if (err == null) return false;
  const name = String((err as { name?: unknown }).name ?? '');
  const message = String((err as { message?: unknown }).message ?? '');
  return /quota|storage[ _]?full|NS_ERROR_DOM_QUOTA/i.test(`${name} ${message}`);
}

/** 只有确定由记录内容造成、重试也不会改变的错误才可判为永久不可存储。 */
function isPermanentRecordError(err: unknown): boolean {
  if (err == null) return false;
  const name = String((err as { name?: unknown }).name ?? '');
  const message = String((err as { message?: unknown }).message ?? '');
  return name === 'DataCloneError'
    || /could not be cloned|record is invalid|cyclic object|circular structure/i.test(message);
}

/** IndexedDB 后端的默认容量 */
const IDB_DEFAULT_MAX_ENTRIES = 500;
const IDB_DEFAULT_MAX_BYTES = 2_000_000;

/** KV 后端容量小得多（localStorage 通常整源只有 ~5MB），默认收紧 */
/** 当前页面上已被占用的实际存储资源。 */
const CLAIMED_OFFLINE_RESOURCES = new Set<string>();
const PENDING_RESOURCE_PURGES = new Map<string, Promise<void>>();

function offlineResourceKeys(options: {
  storage: 'auto' | 'indexeddb' | 'localstorage';
  dbName: string;
  key: string;
}): string[] {
  const resources = [`kv:${options.key}`];
  if (options.storage !== 'localstorage') resources.push(`idb:${options.dbName}`);
  return resources;
}

function backendResourceKeys(
  options: { dbName: string; key: string },
  backend: OfflineBackend,
): string[] {
  if (backend === 'indexeddb') return [`idb:${options.dbName}`];
  if (backend === 'localstorage') return [`kv:${options.key}`];
  return [];
}

function pendingResourcePurges(resources: readonly string[]): Promise<void>[] {
  const tasks = new Set<Promise<void>>();
  for (const resource of resources) {
    const task = PENDING_RESOURCE_PURGES.get(resource);
    if (task) tasks.add(task);
  }
  return Array.from(tasks);
}

function trackResourcePurge(
  resources: readonly string[],
  run: () => Promise<void>,
): Promise<void> {
  const previous = pendingResourcePurges(resources);
  // 任务必须在前序 settle 后才创建/执行；只把 eager Promise 塞进登记表并不能
  // 阻止两个 clear 同时操作同一索引。前序失败也不应阻止下一次修复性清盘。
  const tracked = Promise.all(previous.map((task) => task.catch(() => undefined)))
    .then(run);
  for (const resource of resources) PENDING_RESOURCE_PURGES.set(resource, tracked);
  const cleanup = (): void => {
    for (const resource of resources) {
      if (PENDING_RESOURCE_PURGES.get(resource) === tracked) PENDING_RESOURCE_PURGES.delete(resource);
    }
  };
  void tracked.then(cleanup, cleanup);
  return tracked;
}

/**
 * 已送达、但异步删盘尚未完成的 logId（按存储位）
 *
 * uninstall 会打断 enqueueOp 链并关掉 store，未完成的 delete 会丢掉。
 * 这些 id 挂在模块级，同 slot 的下一次 install/hydrate 会先清掉，避免
 * remount / 下次打开把已送达日志再补传一遍。
 */
const PENDING_RECORD_DELETES = new Map<string, Set<string>>();

function notePendingRecordDelete(resources: readonly string[], logId: string): void {
  for (const resource of resources) {
    let set = PENDING_RECORD_DELETES.get(resource);
    if (!set) {
      set = new Set();
      PENDING_RECORD_DELETES.set(resource, set);
    }
    set.add(logId);
  }
}

function clearPendingRecordDelete(resources: readonly string[], logId: string): void {
  for (const resource of resources) {
    const set = PENDING_RECORD_DELETES.get(resource);
    if (!set) continue;
    set.delete(logId);
    if (set.size === 0) PENDING_RECORD_DELETES.delete(resource);
  }
}

function hasPendingRecordDelete(resources: readonly string[], logId: string): boolean {
  return resources.some((resource) => PENDING_RECORD_DELETES.get(resource)?.has(logId) === true);
}

function hasPendingRecordDeletes(resources: readonly string[]): boolean {
  return resources.some((resource) => (PENDING_RECORD_DELETES.get(resource)?.size ?? 0) > 0);
}

function clearPendingDeletesForResources(resources: readonly string[]): void {
  for (const resource of resources) PENDING_RECORD_DELETES.delete(resource);
}

const KV_DEFAULT_MAX_ENTRIES = 100;
const KV_DEFAULT_MAX_BYTES = 512_000;
const REJECTED_SPLIT_TTL_MS = 60_000;
const MAX_REJECTED_SPLIT_IDS = 1024;

/** 只有这些原因的丢弃值得留到下次再传；其余要么不可送达，要么是我们自己发出的 */
const PERSISTABLE_DROP_REASONS: ReadonlySet<UploadDropReason> = new Set<UploadDropReason>([
  'max-retries',
  'queue-overflow',
]);

/**
 * Upload 已经给出不可恢复结论的终态。
 *
 * 这个集合同时用于在线监听、offline-replay 和卸载后的晚到事件，避免三个入口
 * 对同一个 reason 作出不同决定：终态必须删除持久副本，不能再消耗补传预算。
 */
const TERMINAL_UPLOAD_DROP_REASONS: ReadonlySet<UploadDropReason> =
  new Set<UploadDropReason>([
    'no-retry',
    'payload-too-large',
    'storage-rejected',
    'deduplicated',
    'offline-give-up',
  ]);

/** 一条持久副本尚待提交的可合并状态；所有字段都只能单调前进。 */
interface PersistStateUpdate {
  notBefore?: number;
  serverNotBefore?: number;
  parkCount?: number;
  replayAttempts?: number;
  lastRetryReason?: string;
}

function mergePersistStateUpdate(
  previous: PersistStateUpdate | undefined,
  incoming: PersistStateUpdate | undefined,
): PersistStateUpdate | undefined {
  if (!previous) return incoming;
  if (!incoming) return previous;
  const later = (a: number | undefined, b: number | undefined): number | undefined => {
    const values = [a, b].filter((value): value is number => Number.isFinite(value));
    return values.length > 0 ? Math.max(...values) : undefined;
  };
  return {
    notBefore: later(previous.notBefore, incoming.notBefore),
    serverNotBefore: later(previous.serverNotBefore, incoming.serverNotBefore),
    parkCount: later(previous.parkCount, incoming.parkCount),
    replayAttempts: later(previous.replayAttempts, incoming.replayAttempts),
    lastRetryReason: incoming.lastRetryReason ?? previous.lastRetryReason,
  };
}

/** 校验 SDK 分片组的声明数量与 1-based 索引，阻止残片被当作完整组补传。 */
function isCompleteSplitGroup(records: readonly OfflineRecord[], splitId: string): boolean {
  if (records.length === 0) return false;
  const hasCoordinates = records.some(
    (record) => record.log.tags?.splitIndex !== undefined || record.log.tags?.splitTotal !== undefined,
  );
  // 兼容旧业务把 splitId 当普通标签使用的记录；SDK 生成的分片一定带坐标。
  if (!hasCoordinates) return true;

  let expectedTotal: number | undefined;
  const indices = new Set<number>();
  for (const record of records) {
    if (getSplitId(record.log) !== splitId) return false;
    const index = Number(record.log.tags?.splitIndex);
    const total = Number(record.log.tags?.splitTotal);
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || total <= 0) return false;
    if (index < 1 || index > total) return false;
    if (expectedTotal === undefined) expectedTotal = total;
    else if (expectedTotal !== total) return false;
    if (indices.has(index)) return false;
    indices.add(index);
  }
  return expectedTotal === records.length && indices.size === expectedTotal;
}

export interface OfflinePersistencePluginOptions {
  /**
   * 存储后端（默认 `'auto'`：IndexedDB → localStorage → noop）
   *
   * 指定 `'indexeddb'` 表示"优先用"，宿主不支持时仍会降级。
   */
  storage?: 'auto' | 'indexeddb' | 'localstorage';

  /** 持久副本的有效期（毫秒，默认 7 天），从落盘时刻算起 */
  ttl?: number;

  /**
   * 最多保留多少条（IndexedDB 默认 500，KV 后端默认 100）
   *
   * 约束已提交副本，并作为存储暂时失败时未提交写意图的有界预算基数。
   * UploadPlugin 的内存队列仍独立；想限制同页上传积压请调 `queue.maxSize`。
   */
  maxEntries?: number;

  /**
   * 最多占用多少字节（IndexedDB 默认 2MB，KV 后端默认 512KB）
   *
   * 语义同 `maxEntries`：约束持久化子系统，不约束 UploadPlugin 内存队列。
   */
  maxTotalBytes?: number;

  /** 每轮补传最多取多少条（默认 10），避免恢复瞬间打爆服务端 */
  replayBatchSize?: number;

  /** 单条日志补传失败多少次后放弃（默认 3） */
  maxReplayAttempts?: number;

  /** 补传对账超时（毫秒，默认 60000）：既没成功也没失败的记录多久后可以重试 */
  replayTimeoutMs?: number;

  /** IndexedDB 数据库名 */
  dbName?: string;

  /** KV 后端的 key 前缀 */
  key?: string;

  /** 输出调试日志 */
  debug?: boolean;
}

export interface OfflinePersistenceStatus {
  /** 实际使用的存储后端；`noop` 表示宿主两种存储都不可用 */
  backend: OfflineBackend | 'initializing';
  /** 当前待补传条数 */
  pending: number;
  /** 尚在内存中等待持久层提交/重试的写意图数（按 logId 合并） */
  buffered: number;
  /** 当前占用字节（估算） */
  bytes: number;
  /** 正在补传中的条数 */
  replaying: number;
  /** 因配额写入失败而丢弃的条数 */
  quotaDrops: number;
  /** 因反复补传失败而放弃的条数 */
  giveUps: number;
  /** 成功补传的条数 */
  replayed: number;
  /** 供统一 Delivery 状态按 logId 去重的持久化快照 */
  items: Array<{
    logId: string;
    capturedAt: number;
    state: 'persisted' | 'replaying' | 'buffering';
  }>;
}

/** 显式关闭持久化时清除 IDB 与 localStorage 中的历史副本。 */
export async function purgeOfflinePersistenceStorage(
  options: OfflinePersistencePluginOptions = {},
): Promise<void> {
  const claimedBeforePurge = new Set(CLAIMED_OFFLINE_RESOURCES);
  const normalized = {
    storage: options.storage ?? 'auto' as const,
    dbName: options.dbName ?? 'aemeath-offline',
    key: options.key ?? '__aemeath_offline__',
  };
  const resources = offlineResourceKeys(normalized);
  const runPurge = async (): Promise<void> => {
    const failures: unknown[] = [];
    const preferences: Array<'indexeddb' | 'localstorage'> = normalized.storage === 'localstorage'
      ? ['localstorage']
      : ['indexeddb', 'localstorage'];
    for (const preference of preferences) {
      // “宿主根本不提供该后端”表示没有可清资源，不应制造清盘失败告警；只有后端
      // 存在、但打开/事务/删除失败时才必须 reject。
      if (preference === 'indexeddb') {
        try {
          if (typeof indexedDB === 'undefined' || indexedDB === null) continue;
        } catch {
          continue;
        }
      } else {
        try {
          if (typeof localStorage === 'undefined' || localStorage === null) continue;
        } catch {
          continue;
        }
      }
      let store: OfflineStore | null = null;
      try {
        store = await createOfflineStore({
          preference,
          dbName: normalized.dbName,
          keyPrefix: normalized.key,
          allowFallback: false,
        });
        const actualResources = backendResourceKeys(normalized, store.backend);
        if (actualResources.some((resource) => claimedBeforePurge.has(resource))) continue;
        await store.clear();
        clearPendingDeletesForResources(actualResources);
      } catch (error) {
        failures.push(error);
      } finally {
        store?.close();
      }
    }
    if (failures.length > 0) {
      throw failures[0];
    }
  };
  await trackResourcePurge(resources, runPurge);
}

export class OfflinePersistencePlugin implements AemeathPlugin {
  readonly name = 'offline-persistence';
  readonly version = '1.10.1';
  /** 不参与日志管道，优先级仅用于安装顺序的可预期性 */
  readonly priority: number = PluginPriority.LATE + 1;
  readonly description = '断网期间日志落盘，联网后自动补传';

  private readonly options: Required<
    Omit<OfflinePersistencePluginOptions, 'maxEntries' | 'maxTotalBytes'>
  > & { maxEntries?: number; maxTotalBytes?: number };

  private logger: AemeathInterface | null = null;
  private store: OfflineStore | null = null;
  private ready: Promise<void> | null = null;
  private destroyed = false;

  /** 实际认领的 IDB/KV 资源。 */
  private claimedResources: string[] = [];
  /** 显式关闭请求按生命周期世代绑定，避免 remount 把旧清盘意图带进新实例。 */
  private readonly purgeEpochs = new Set<number>();

  /** 内存索引：避免每次写入都去扫存储 */
  private index = new Map<string, OfflineRecordMeta>();
  /**
   * 索引建好之前就已上传成功的 logId（墓碑）
   *
   * UploadPlugin.install() 是同步就从缓存恢复并立刻开传的，而本插件要 await
   * createOfflineStore()。于是"上传成功"往往早于"索引建好"，此时清理动作查空索引
   * 直接返回，落盘的副本就没人删了；等索引建好又把它读回来，补传再发一遍。
   * 把这些 id 记成墓碑，hydration 时一并清掉。
   */
  private readonly preHydrationDeletes = new Set<string>();
  /**
   * 已上传成功、磁盘删除尚未跑完的 logId
   *
   * `handleSuccess` 的删盘在串行队列里，而 `online` 触发的 `replay` 也可能已在
   * 队列中。上传变快时会出现：replay 在删盘之前执行、`isPending` 已是 false、
   * 索引里还有这条 → 再补传一次。墓碑让 replay 在删盘完成前跳过它们。
   */
  private readonly deliveredTombstones = new Set<string>();
  /**
   * store 尚未打开时收到的落盘请求
   *
   * `createOfflineStore` 是异步的；`upload:paused` / pause 期 `enqueued` 可能
   * 抢在 store 赋值之前到达。若直接丢弃，断网窗口里最早一批日志会永远落不了盘。
   */
  private pendingPersists: Array<{
    log: LogEntry;
    priority?: number;
    state?: PersistStateUpdate;
  }> = [];
  /** 索引是否已建好（含"没有可用后端"这种提前定论的情况） */
  private hydrated = false;
  /** hydrate 成功前持久层只允许终态删除，不能按空索引继续写入或补传。 */
  private storageOperational = false;
  /** 补传中的 logId → 发起时刻（用于对账超时） */
  private inFlight = new Map<string, number>();
  /** 串行化所有持久化操作，杜绝并发读改写造成的错乱 */
  private chain: Promise<unknown> = Promise.resolve();

  private maxEntries = IDB_DEFAULT_MAX_ENTRIES;
  private maxTotalBytes = IDB_DEFAULT_MAX_BYTES;
  private totalBytes = 0;

  private stats = { quotaDrops: 0, giveUps: 0, replayed: 0 };
  private storageWarned = false;

  private handlers: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];
  private boundOnline: (() => void) | null = null;
  /**
   * 生命周期世代：同实例 remount 时递增，作废上一轮还挂在 chain / 定时器上的工作，
   * 避免 uninstall→install 之间 destroyed 被翻回 false 后旧 op 误跑。
   */
  private epoch = 0;
  /** queue-overflow 后的冷却唤醒（避免立刻 scheduleReplay 热循环） */
  private overflowReplayTimer: ReturnType<typeof setTimeout> | null = null;
  /** Retry-After / parked 到期后的精确唤醒。 */
  private deferredReplayTimer: ReturnType<typeof setTimeout> | null = null;
  /** 持久层瞬时读取失败后的有界重试；与队列容量冷却分开记账。 */
  private storageRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private storageRetryDelay = 0;
  /** 已确认无法整组落盘的 splitId；本生命周期内后续分片也必须拒绝。 */
  private readonly rejectedPersistSplitIds = new Map<
    string,
    { reason: 'storage-quota' | 'storage-rejected'; expiresAt: number }
  >();

  constructor(options: OfflinePersistencePluginOptions = {}) {
    const positive = (value: number | undefined, fallback: number, min = 1): number =>
      typeof value === 'number' && Number.isFinite(value) && value >= min ? value : fallback;
    const positiveInteger = (value: number | undefined, fallback: number, min = 1): number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= min ? value : fallback;
    this.options = {
      storage: options.storage ?? 'auto',
      ttl: positive(options.ttl, 7 * 24 * 60 * 60 * 1000, 0),
      replayBatchSize: positiveInteger(options.replayBatchSize, 10),
      maxReplayAttempts: positiveInteger(options.maxReplayAttempts, 3),
      replayTimeoutMs: positive(options.replayTimeoutMs, 60000, 1000),
      dbName: options.dbName ?? 'aemeath-offline',
      key: options.key ?? '__aemeath_offline__',
      debug: options.debug ?? false,
      maxEntries: options.maxEntries == null ? undefined : positiveInteger(options.maxEntries, 1),
      maxTotalBytes: options.maxTotalBytes == null ? undefined : positive(options.maxTotalBytes, 1),
    };
  }

  install(logger: AemeathInterface): void {
    // 同 UploadPlugin：不清墓碑标记的话，复装后 init() 会把刚打开的 store
    // 立刻关掉，backend 永远停在 'initializing'
    this.epoch++;
    this.clearOverflowReplayTimer();
    this.clearDeferredReplayTimer();
    this.clearStorageRetryTimer(true);
    this.destroyed = false;
    this.logger = logger;

    // 同实例 remount 必须丢掉上一轮内存态：hydrated 若仍为 true，
    // handleSuccess 进不了 preHydrationDeletes，store 未挂上时 safeDelete 空操作，
    // 随后 hydrate 又把盘上副本读回补传 → 与 Upload 缓存恢复叠成重复上报。
    this.hydrated = false;
    this.storageOperational = false;
    this.index.clear();
    this.totalBytes = 0;
    this.inFlight.clear();
    this.pendingPersists = [];
    this.deliveredTombstones.clear();
    this.preHydrationDeletes.clear();
    this.rejectedPersistSplitIds.clear();
    this.store = null;
    this.chain = Promise.resolve();
    this.ready = null;

    // 库名同样有确定性默认值。两个实例共用一个库时，A 攒下的离线日志会被
    // B 补传到 B 的上报地址上 —— 和缓存 key 撞车是同一类串台，只是更隐蔽，
    // 因为补传是自动发生的。
    const resources = offlineResourceKeys(this.options);
    const conflictingResource = resources.find((resource) =>
      CLAIMED_OFFLINE_RESOURCES.has(resource),
    );
    if (conflictingResource) {
      this.destroyed = true;
      // 让位也要报得清楚：backend 停在 'initializing' 的话，用户看 getStatus()
      // 只会以为还没初始化完，而不是"这个实例被让位了"
      this.store = createNoopStore();
      this.hydrated = true;
      this.ready = Promise.resolve();
      console.warn(
        `[Aemeath] Two OfflinePersistencePlugin instances on this page share the store resource "${conflictingResource}". ` +
          "One project's offline logs could be replayed to the other's endpoint, so this instance " +
          'is inactive. Give each instance its own `dbName` and `key` to run both safely, including fallback.'
      );
      return;
    }
    for (const resource of resources) CLAIMED_OFFLINE_RESOURCES.add(resource);
    this.claimedResources = resources;

    this.on('upload:drop', (payload) => this.handleDrop(payload));
    this.on('upload:parked', (payload) => this.handleParked(payload));
    this.on('upload:retry-scheduled', (payload) => this.handleRetryScheduled(payload));
    this.on('upload:paused', (payload) => this.handlePaused(payload));
    this.on('upload:enqueued', (payload) => this.handleEnqueued(payload));
    this.on('upload:success', (payload) => this.handleSuccess(payload));
    this.on('upload:resumed', () => this.scheduleReplay());

    // Upload 被单独 uninstall→use 时不会走 online / upload:resumed，
    // 盘上 pending 会永久饿死。plugin:install 的载荷是字符串，不能走 this.on
    // （它要求 object payload）。
    // 若补传已 inFlight.set 而 Upload 被拆掉，这些坑位是孤儿——必须清掉再播，
    // 否则 replay 会一直 skip，且 candidates 为空时不会自唤醒。
    const onPluginInstall = (...args: unknown[]): void => {
      if (this.destroyed) return;
      if (args[0] !== 'upload') return;
      this.inFlight.clear();
      this.scheduleReplay();
    };
    this.handlers.push({ event: 'plugin:install', fn: onPluginInstall });
    logger.on('plugin:install', onPluginInstall);

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this.boundOnline = () => this.scheduleReplay();
      try {
        window.addEventListener('online', this.boundOnline);
      } catch {
        this.boundOnline = null;
      }
    }

    // 初始化与 hydrate 都是异步的，绝不阻塞 Logger 启动
    this.ready = this.init();
  }

  uninstall(logger?: AemeathInterface): void {
    const uninstallEpoch = this.epoch;
    const purgeRequested = this.purgeEpochs.has(uninstallEpoch);
    const resources = [...this.claimedResources];
    const terminalResources = this.deletionResourceKeys();
    const host = logger ?? this.logger;
    const upload = this.getUploadPlugin();

    // 卸载时可能已有日志在 Upload **真正飞行中**（已出队、等 onUpload）。
    // 只认 upload.isInFlight——本插件 replay 的 inFlight 在 requeue 当下就 set，
    // 那时条目往往还在 Upload 队列里，绝不能当已送达记墓碑，否则 remount 会误删唯一副本。
    // destroy 会清掉 late listener，所以对 isInFlight 先乐观 note；若随后失败，
    // late drop（Offline 单独卸载时）或下面的 drop 监听会 clearPending。
    const watchIds = new Set<string>();
    if (!purgeRequested && resources.length > 0 && upload) {
      for (const logId of this.index.keys()) {
        if (upload.isInFlight(logId)) watchIds.add(logId);
      }
    }

    this.epoch++;
    this.clearOverflowReplayTimer();
    this.clearDeferredReplayTimer();
    this.clearStorageRetryTimer(true);
    this.destroyed = true;
    for (const resource of this.claimedResources) CLAIMED_OFFLINE_RESOURCES.delete(resource);
    this.claimedResources = [];

    for (const { event, fn } of this.handlers) {
      // 逐个兜异常：一个 off 抛出就会跳过后面所有清理 —— 剩下的监听器留在 logger 上，
      // store 不关、引用不断，整个 logger 连同它的插件都回收不掉
      try {
        host?.off(event, fn);
      } catch (err) {
        this.debug('failed to detach handler:', err);
      }
    }
    this.handlers = [];
    if (this.boundOnline) {
      try {
        window.removeEventListener('online', this.boundOnline);
      } catch {
        /* ignore */
      }
      this.boundOnline = null;
    }

    // Offline 单独卸载而 Upload/logger 还在时：补听真正飞行请求的晚到终态。
    // success 或永久拒收 → 留下跨 remount 删除意图；可恢复失败不记终态。
    if (!purgeRequested && host && resources.length > 0 && watchIds.size > 0) {
      const detachLate = (fn: (...args: unknown[]) => void, event: string): void => {
        try {
          host.off(event, fn);
        } catch {
          /* ignore */
        }
      };
      const onLateSuccess = (...args: unknown[]): void => {
        const payload = args[0] as { log?: { logId?: string } } | undefined;
        const logId = payload?.log?.logId;
        if (!logId || !watchIds.has(logId)) return;
        watchIds.delete(logId);
        notePendingRecordDelete(terminalResources, logId);
        if (watchIds.size === 0) {
          detachLate(onLateSuccess, 'upload:success');
          detachLate(onLateDrop, 'upload:drop');
        }
      };
      const onLateDrop = (...args: unknown[]): void => {
        const payload = args[0] as {
          log?: { logId?: string };
          reason?: string;
        } | undefined;
        const logId = payload?.log?.logId;
        if (!logId || !watchIds.has(logId)) return;
        watchIds.delete(logId);
        if (TERMINAL_UPLOAD_DROP_REASONS.has(payload?.reason as UploadDropReason)) {
          notePendingRecordDelete(terminalResources, logId);
        }
        if (watchIds.size === 0) {
          detachLate(onLateSuccess, 'upload:success');
          detachLate(onLateDrop, 'upload:drop');
        }
      };
      try {
        host.on('upload:success', onLateSuccess);
        host.on('upload:drop', onLateDrop);
      } catch {
        /* ignore */
      }
    }

    const store = this.store;
    const chain = this.chain;
    if (purgeRequested && store) {
      const runPurge = async (): Promise<void> => {
        try {
          await chain.catch(() => undefined);
          await store.clear();
          clearPendingDeletesForResources(backendResourceKeys(this.options, store.backend));
        } finally {
          this.purgeEpochs.delete(uninstallEpoch);
          try {
            store.close();
          } catch {
            /* ignore */
          }
        }
      };
      void trackResourcePurge(resources, runPurge).catch((err) => {
        this.debug('failed to purge store:', err);
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[Aemeath] Failed to purge offline persistence:', err);
        }
      });
    } else if (purgeRequested && this.ready) {
      const ready = this.ready;
      const runPurge = async (): Promise<void> => {
        try {
          await ready;
        } finally {
          this.purgeEpochs.delete(uninstallEpoch);
        }
      };
      void trackResourcePurge(resources, runPurge).catch((err) => {
        this.debug('failed to purge store opened during uninstall:', err);
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[Aemeath] Failed to purge offline persistence:', err);
        }
      });
    } else {
      if (purgeRequested) this.purgeEpochs.delete(uninstallEpoch);
      try {
        store?.close();
      } catch (err) {
        this.debug('failed to close store:', err);
      }
    }
    this.store = null;
    this.pendingPersists = [];
    this.deliveredTombstones.clear();
    this.logger = null;
  }

  // ==================== 对外查询 ====================

  /** 当前后端、待补传条数、占用字节与各类计数 */
  getStatus(): OfflinePersistenceStatus {
    const persistedItems: OfflinePersistenceStatus['items'] = Array.from(
      this.index.values(),
      (meta) => ({
        logId: meta.logId,
        capturedAt: meta.capturedAt,
        state: this.inFlight.has(meta.logId) ? 'replaying' as const : 'persisted' as const,
      }),
    );
    const bufferedItems: OfflinePersistenceStatus['items'] = this.pendingPersists.map(
      (item) => ({
        logId: item.log.logId,
        capturedAt: item.log.timestamp,
        state: 'buffering' as const,
      }),
    );
    return {
      backend: !this.hydrated
        ? 'initializing'
        : this.storageOperational ? (this.store?.backend ?? 'noop') : 'noop',
      pending: this.index.size,
      buffered: this.pendingPersists.length,
      bytes: this.totalBytes,
      replaying: this.inFlight.size,
      quotaDrops: this.stats.quotaDrops,
      giveUps: this.stats.giveUps,
      replayed: this.stats.replayed,
      // 同一 logId 可能同时有已提交副本和 deadline 更新意图；保留两层条目，
      // 统一状态中心再按 logId 去重，同时仍能正确核对各层原始计数。
      items: [...persistedItems, ...bufferedItems],
    };
  }

  /** 等待初始化与首轮 hydrate 完成（主要供测试使用） */
  async whenReady(): Promise<void> {
    await this.ready;
    await this.chain.catch(() => undefined);
  }

  /** 清空所有持久副本 */
  async clear(): Promise<void> {
    await this.ready;
    await this.enqueueOp(async () => {
      try {
        await this.clearConfiguredBackends();
      } catch (error) {
        // 跨后端清理可能部分完成；此时原索引已不再是可信事实，禁止继续写/播。
        this.storageOperational = false;
        throw error;
      }
      clearPendingDeletesForResources(this.claimedResources);
      this.storageOperational = this.store?.backend !== undefined
        && this.store.backend !== 'noop';
      this.index.clear();
      this.inFlight.clear();
      this.pendingPersists = [];
      this.deliveredTombstones.clear();
      this.preHydrationDeletes.clear();
      this.rejectedPersistSplitIds.clear();
      this.totalBytes = 0;
      this.clearStorageRetryTimer(true);
    }, true);
  }

  /** `clear()` 的语义覆盖当前后端和可能休眠的 fallback，不能只清半边后宣称修复。 */
  private async clearConfiguredBackends(): Promise<void> {
    const active = this.store;
    if (active && active.backend !== 'noop') await active.clear();
    if (this.options.storage === 'localstorage') return;

    const targets: Array<'indexeddb' | 'localstorage'> = ['indexeddb', 'localstorage'];
    for (const preference of targets) {
      if (active?.backend === preference) continue;
      // 宿主根本不提供 API 时不存在当前可访问的资源；API 存在但打开/清理失败则
      // 必须 reject，尤其是 reconciliation 降级后，不能把“只清了主库”说成成功。
      try {
        if (preference === 'indexeddb') {
          if (typeof indexedDB === 'undefined' || indexedDB === null) continue;
        } else if (typeof localStorage === 'undefined' || localStorage === null) {
          continue;
        }
      } catch {
        continue;
      }
      const dormant = await createOfflineStore({
        preference,
        dbName: this.options.dbName,
        keyPrefix: this.options.key,
        allowFallback: false,
      });
      try {
        if (dormant.backend === preference) await dormant.clear();
      } finally {
        dormant.close();
      }
    }
  }

  /** 下一次 uninstall 代表显式关闭持久化，应清除所有副本。 */
  requestPurgeOnUninstall(): void {
    this.purgeEpochs.add(this.epoch);
  }

  // ==================== 初始化 ====================

  private isEpoch(epoch: number): boolean {
    return !this.destroyed && this.epoch === epoch;
  }

  private async init(): Promise<void> {
    // 任何逃逸都必须让 hydrated 落定，否则墓碑集合会无限增长、已上传的日志
    // 也永远不会从盘上删掉（详见 hydration 里的注释）。init() 本身也不能把
    // 异常抛出去：this.ready 常常没人 await，抛出去就是未处理 rejection。
    //
    // 同实例 remount 会递增 epoch：陈旧 init 的 finally 绝不能清掉新生命周期
    // 已写入的 preHydrationDeletes，否则已送达日志会被 hydrate 再补传。
    const epoch = this.epoch;
    try {
      await this.initInternal(epoch);
    } catch (err) {
      // 显式关闭发生在开库期间时，陈旧 init 承担清盘任务；该任务失败必须让
      // uninstall 注册的 PENDING_RESOURCE_PURGES 看见，不能在这里吃掉后谎报完成。
      if (!this.isEpoch(epoch) && this.purgeEpochs.has(epoch)) throw err;
      if (this.isEpoch(epoch)) {
        this.debug('init failed:', err);
        try {
          this.store?.close();
        } catch {
          /* ignore */
        }
        this.store = createNoopStore();
        this.storageOperational = false;
        this.index.clear();
        this.inFlight.clear();
        this.totalBytes = 0;
        this.pendingPersists = [];
        this.warnStorageUnavailable();
        try {
          this.logger?.emit('upload:offline-unavailable', { reason: 'initialization-failed' });
        } catch (emitErr) {
          this.debug('failed to report offline initialization failure:', emitErr);
        }
      }
    } finally {
      if (this.isEpoch(epoch)) {
        this.hydrated = true;
        this.preHydrationDeletes.clear();
        this.notifyDeliveryStatus();
      }
    }
  }

  private async initInternal(epoch: number): Promise<void> {
    const logger = this.logger;
    if (!logger || !this.isEpoch(epoch)) return;

    const purges = pendingResourcePurges(this.claimedResources);
    if (purges.length > 0) await Promise.all(purges);
    if (!this.isEpoch(epoch)) return;

    const store = await createOfflineStore({
      preference: this.options.storage,
      dbName: this.options.dbName,
      keyPrefix: this.options.key,
      onFallback: (from, reason) =>
        this.debug(`storage backend "${from}" unavailable, falling back:`, reason),
    });

    // 打开库期间可能已卸载或同实例 remount：挂上陈旧 store 会泄漏连接，
    // 继续 hydrate 还会清掉新生命周期的墓碑。
    if (!this.isEpoch(epoch)) {
      if (this.purgeEpochs.has(epoch)) {
        try {
          await store.clear();
          clearPendingDeletesForResources(backendResourceKeys(this.options, store.backend));
        } catch (error) {
          store.close();
          throw error;
        }
      }
      store.close();
      return;
    }
    this.store = store;

    if (this.store.backend === 'noop') {
      // 也算"定论"：不置位的话墓碑集合会随每次上传成功无限增长
      this.hydrated = true;
      this.storageOperational = false;
      this.preHydrationDeletes.clear();
      this.pendingPersists = [];
      this.warnStorageUnavailable();
      try {
        logger.emit('upload:offline-unavailable', { reason: 'no-storage-backend' });
      } catch (err) {
        this.debug('failed to report unavailable storage:', err);
      }
      return;
    }

    // `auto/indexeddb` 可能在上次启动时因 IDB 暂时不可用而降级到 KV。IDB 恢复后
    // 若只 hydrate 当前首选后端，那批 KV 日志会被永久搁置。先做提交后删除式迁移，
    // 再建立唯一索引；迁移失败则整体降级，绝不假装只有半边数据。
    try {
      await this.reconcileFallbackStore(this.store, epoch);
    } catch (err) {
      // 两个后端无法形成可信并集时保留主 store 供精确终态删除，但禁止写入/补传。
      // 把 store 换成 noop 会让随后按 logId 到达的 success 永远删不掉真实记录。
      this.debug('fallback reconciliation failed:', err);
      this.storageOperational = false;
      this.pendingPersists = [];
      for (const logId of this.preHydrationDeletes) {
        if (!this.isEpoch(epoch)) return;
        await this.safeDelete(logId);
      }
      this.warnStorageUnavailable();
      try {
        logger.emit('upload:offline-unavailable', { reason: 'reconciliation-failed' });
      } catch (emitErr) {
        this.debug('failed to report reconciliation failure:', emitErr);
      }
      return;
    }
    if (!this.isEpoch(epoch)) return;

    const isKv = this.store.backend === 'localstorage';
    this.maxEntries =
      this.options.maxEntries ?? (isKv ? KV_DEFAULT_MAX_ENTRIES : IDB_DEFAULT_MAX_ENTRIES);
    this.maxTotalBytes =
      this.options.maxTotalBytes ?? (isKv ? KV_DEFAULT_MAX_BYTES : IDB_DEFAULT_MAX_BYTES);

    if (!this.isEpoch(epoch)) {
      store.close();
      if (this.store === store) this.store = null;
      return;
    }

    // 上一次实例 uninstall 时未完成的删盘：先清掉，再 hydrate，避免把已送达日志
    // 读回 index 再补传。
    await this.enqueueOp(async () => {
      if (!this.isEpoch(epoch)) return;
      await this.flushPendingRecordDeletes();
    });

    await this.enqueueOp(async () => {
      if (!this.isEpoch(epoch)) return;
      // hydrated 必须在**所有**出口置位，包括读盘失败这条。留在 false 上有两个
      // 后果，都不会报错：墓碑集合随每次上传成功无限增长；而且 handleSuccess
      // 只记墓碑不删盘，已经传成功的日志会一直躺在库里等着被补传 —— 正是第七轮
      // 修掉的重复上报，从另一扇门又走回来了。
      //
      // 读盘失败时：先尽力把已知已送达的 id 从盘上删掉，再落定 hydrated；
      // 之后 handleSuccess 在 !index.has 时也会直接 safeDelete。
      try {
        let metas: OfflineRecordMeta[] = [];
        let loadFailed = false;
        try {
          metas = await this.store!.loadMeta();
        } catch (err) {
          this.debug('loadMeta failed:', err);
          loadFailed = true;
        }

        if (!this.isEpoch(epoch)) return;

        if (loadFailed) {
          for (const logId of this.preHydrationDeletes) {
            if (!this.isEpoch(epoch)) return;
            await this.safeDelete(logId);
          }
          // 索引是容量、去重和 replay 的唯一事实来源。扫描失败后把它当空库继续
          // 写，只会突破配额并制造无法对账的正文；本生命周期降级为只删不写。
          this.storageOperational = false;
          this.pendingPersists = [];
          this.warnStorageUnavailable();
          try {
            logger.emit('upload:offline-unavailable', { reason: 'hydration-failed' });
          } catch (err) {
            this.debug('failed to report hydration failure:', err);
          }
          return;
        }

        const now = Date.now();
        for (const meta of metas) {
          if (!this.isEpoch(epoch)) return;
          if (
            !meta ||
            typeof meta.logId !== 'string' ||
            meta.logId.length === 0 ||
            !Number.isFinite(meta.storedAt) ||
            !Number.isFinite(meta.capturedAt) ||
            !Number.isFinite(meta.bytes) ||
            meta.bytes < 0
          ) {
            if (meta && typeof meta.logId === 'string') await this.safeDelete(meta.logId);
            continue;
          }
          if (meta.terminal === true) {
            await this.safeDelete(meta.logId);
            continue;
          }
          if (meta.storedAt > now + 5 * 60 * 1000 || now - meta.storedAt >= this.options.ttl) {
            await this.safeDelete(meta.logId);
            continue;
          }
          // 已送达墓碑（本会话 preHydration 或跨实例 PENDING）：只删不播。
          // flush 失败时盘上可能还在——绝不能 index.set 后再 scheduleReplay。
          const delivered = meta.terminal === true ||
            this.preHydrationDeletes.has(meta.logId) ||
            hasPendingRecordDelete(this.claimedResources, meta.logId);
          if (delivered) {
            this.index.set(meta.logId, meta);
            this.totalBytes += meta.bytes;
            await this.safeDelete(meta.logId);
            // 删仍失败：从 index 摘掉（safeDelete 已 removeFromIndex），继续扣着 PENDING
            if (hasPendingRecordDelete(this.claimedResources, meta.logId)) {
              this.debug(
                'delivered tombstone still on disk after hydrate delete; withholding from replay:',
                meta.logId,
              );
            }
            continue;
          }
          meta.priority = Number.isFinite(meta.priority) ? meta.priority : 0;
          meta.replayAttempts = Number.isFinite(meta.replayAttempts)
            ? Math.max(0, Math.floor(meta.replayAttempts))
            : 0;
          // 新记录会把 splitId 冗余进 meta，避免每轮 replay 为分组读取全部正文。
          // 旧 localStorage 索引没有这个字段，只在 hydrate 时补读一次。
          if (
            meta.splitId !== null
            && (typeof meta.splitId !== 'string' || this.store!.backend === 'localstorage')
          ) {
            const legacyRecord = await this.safeGet(meta.logId);
            const canonicalSplitId = legacyRecord ? (getSplitId(legacyRecord.log) ?? null) : null;
            if (legacyRecord && legacyRecord.splitId !== canonicalSplitId) {
              // 旧 KV 索引曾把裸业务 splitId 写进分组字段；在 hydrate 边界一次性
              // 规范化正文和索引，后续生命周期就不会再把普通日志误绑成原子组。
              await this.store!.put({ ...legacyRecord, splitId: canonicalSplitId });
            }
            meta.splitId = canonicalSplitId;
          }
          meta.notBefore = Number.isFinite(meta.notBefore) ? meta.notBefore : undefined;
          meta.serverNotBefore = Number.isFinite(meta.serverNotBefore)
            ? meta.serverNotBefore
            : undefined;
          meta.parkCount = Number.isFinite(meta.parkCount) ? meta.parkCount : undefined;
          this.index.set(meta.logId, meta);
          this.totalBytes += meta.bytes;
        }
        this.debug(
          `hydrated ${this.index.size} pending logs from ${this.store!.backend} (${this.totalBytes} bytes)`,
        );
        this.storageOperational = true;
      } catch (err) {
        // loadMeta 之外的正文读取同样属于 hydrate 事务（典型是旧索引补读
        // splitId）。任何一步无法确认，部分索引就不再是可信快照：统一清空并
        // fail-closed，绝不能让 enqueueOp 的通用兜底把它吞成一个“半成功”。
        this.debug('hydration scan failed:', err);
        this.index.clear();
        this.totalBytes = 0;
        this.storageOperational = false;
        this.pendingPersists = [];
        this.warnStorageUnavailable();
        try {
          logger.emit('upload:offline-unavailable', { reason: 'hydration-failed' });
        } catch (emitErr) {
          this.debug('failed to report hydration failure:', emitErr);
        }
      } finally {
        if (this.isEpoch(epoch)) {
          this.hydrated = true;
          this.preHydrationDeletes.clear();
        }
      }
    });

    if (!this.isEpoch(epoch)) return;

    // store 打开前缓冲的落盘请求：排在 hydrate 之后写盘，避免与索引重建交错。
    // 已送达的在 handleSuccess 里已被踢出 pending；这里再过滤一次双保险。
    await this.enqueueOp(async () => {
      if (!this.isEpoch(epoch)) return;
      await this.drainPendingPersists(epoch);
    });

    if (!this.isEpoch(epoch)) return;
    this.catchUpPausedQueue();
    this.scheduleReplay();
  }

  /** 把历史 KV fallback 与恢复后的 IndexedDB 收敛成一个权威后端。 */
  private async reconcileFallbackStore(primary: OfflineStore, epoch: number): Promise<void> {
    if (primary.backend !== 'indexeddb' || this.options.storage === 'localstorage') return;

    let fallback: OfflineStore;
    try {
      fallback = await createOfflineStore({
        preference: 'localstorage',
        dbName: this.options.dbName,
        keyPrefix: this.options.key,
        allowFallback: false,
      });
    } catch {
      // KV 根本不可用表示没有当前可访问的 fallback 需要迁移，不影响 IDB 主后端。
      return;
    }
    if (fallback.backend !== 'localstorage') {
      fallback.close();
      return;
    }

    const resources = [
      ...backendResourceKeys(this.options, 'indexeddb'),
      ...backendResourceKeys(this.options, 'localstorage'),
    ];
    const maxOptional = (a: number | undefined, b: number | undefined): number | undefined => {
      const values = [a, b].filter((value): value is number => Number.isFinite(value));
      return values.length === 0 ? undefined : Math.max(...values);
    };
    try {
      const metas = await fallback.loadMeta();
      for (const meta of metas) {
        if (!this.isEpoch(epoch)) return;
        const secondaryRecord = await fallback.get(meta.logId);
        if (!secondaryRecord) {
          await fallback.delete(meta.logId);
          continue;
        }
        const secondary: OfflineRecord = {
          ...secondaryRecord,
          splitId: getSplitId(secondaryRecord.log) ?? null,
        };
        const currentRecord = await primary.get(meta.logId);
        const current: OfflineRecord | null = currentRecord
          ? { ...currentRecord, splitId: getSplitId(currentRecord.log) ?? null }
          : null;
        const terminal = secondary.terminal === true
          || current?.terminal === true
          || hasPendingRecordDelete(resources, meta.logId);
        if (terminal) {
          await primary.delete(meta.logId);
          await fallback.delete(meta.logId);
          clearPendingRecordDelete(resources, meta.logId);
          continue;
        }

        let migrated = secondary;
        if (current) {
          // 同一稳定 logId 只能代表同一条捕获记录。冲突时不能静默任选一份并发送到
          // 后端；保留两边原件并让初始化降级，交给宿主清理或下一版本修复。
          if (
            current.capturedAt !== secondary.capturedAt
            || (current.splitId ?? null) !== (secondary.splitId ?? null)
            || JSON.stringify(current.log) !== JSON.stringify(secondary.log)
          ) {
            throw new Error(`offline backend identity conflict: ${meta.logId}`);
          }
          migrated = {
            ...current,
            storedAt: Math.min(current.storedAt, secondary.storedAt),
            priority: Math.max(current.priority, secondary.priority),
            replayAttempts: Math.max(current.replayAttempts, secondary.replayAttempts),
            notBefore: maxOptional(current.notBefore, secondary.notBefore),
            serverNotBefore: maxOptional(
              current.serverNotBefore,
              secondary.serverNotBefore,
            ),
            parkCount: maxOptional(current.parkCount, secondary.parkCount),
            lastRetryReason: secondary.lastRetryReason ?? current.lastRetryReason,
          };
        }
        // 先等待 IDB 事务真正提交，再删除 KV。任一步失败时，至少有一份完整副本。
        await primary.put(migrated);
        await fallback.delete(meta.logId);
      }
    } finally {
      fallback.close();
    }
  }

  // ==================== 事件处理 ====================

  private on(event: string, handler: (payload: Record<string, unknown>) => void): void {
    const fn = (...args: unknown[]) => {
      if (this.destroyed) return;
      const payload = args[0];
      if (payload && typeof payload === 'object') {
        handler(payload as Record<string, unknown>);
      }
    };
    this.handlers.push({ event, fn });
    this.logger?.on(event, fn);
  }

  private handleDrop(payload: Record<string, unknown>): void {
    const log = payload['log'] as LogEntry | undefined;
    const reason = payload['reason'] as UploadDropReason | undefined;
    if (!log || !reason) return;

    // Upload 的短 TTL 队列镜像过期，不代表 Offline 的 7 天副本也该删除。
    if (reason === 'cache-expired' && payload['source'] === 'upload-cache') return;

    // 补传出来的条目又被丢弃 → 计入失败次数，不再当作新日志重新落盘
    if (payload['source'] === OFFLINE_REPLAY_SOURCE) {
      // 但队列溢出不算"补传失败"：那是本地内存队列被别的日志挤爆了，
      // 这条根本没上过网。照算的话，补传预算会被本地拥挤白白耗光，
      // 日志明明还在盘上却被判了死刑（实测被挤掉四次后直接放弃）。
      if (reason === 'queue-overflow') {
        // 溢出不是补传失败：立刻 scheduleReplay 会热循环（队列仍满），
        // 又不清 inFlight 的话 replay() 会一直跳过这条，而超时清理只在
        // **再次进入** replay() 时发生——没有 success/online/resumed 就永远醒不来。
        this.inFlight.delete(log.logId);
        this.armOverflowReplayWake();
        return;
      }
      if (TERMINAL_UPLOAD_DROP_REASONS.has(reason)) {
        this.inFlight.delete(log.logId);
        this.enqueueOp(() => this.safeDelete(log.logId));
        return;
      }
      this.enqueueOp(() => this.registerReplayFailure(log));
      return;
    }

    if (!PERSISTABLE_DROP_REASONS.has(reason)) {
      // 服务端明确拒收（no-retry / payload）：补传只会被再拒一次。
      // 之前落过盘的话必须就地清掉，否则这份副本没人再管，会一直占着配额，
      // 还会在下次上线 / 下次打开页面时被翻出来重投。
      const logId = log.logId;
      this.deliveredTombstones.add(logId);
      this.inFlight.delete(logId);
      this.pendingPersists = this.pendingPersists.filter((item) => item.log.logId !== logId);
      notePendingRecordDelete(this.deletionResourceKeys(), logId);
      if (!this.hydrated) this.preHydrationDeletes.add(logId);
      this.enqueueOp(async () => {
        try {
          // 不能以 index.has 为前置条件：hydrate 尚未完成或 loadMeta 失败时，
          // 磁盘可能有记录而内存索引为空。safeDelete 会保留跨 remount 删除意图。
          await this.safeDelete(logId);
        } finally {
          this.deliveredTombstones.delete(logId);
        }
      });
      return;
    }
    this.enqueueOp(async () => {
      await this.persist(log, payload['priority'] as number | undefined);
      // inFlight 整组 overflow 后 settle 不再发 upload:success，原来靠 success
      // 叫醒的补传会饿死。落盘后冷却唤醒，等 Upload 队列有空位再播。
      if (reason === 'queue-overflow') {
        this.armOverflowReplayWake();
      }
    });
  }

  private handleParked(payload: Record<string, unknown>): void {
    const log = payload['log'] as LogEntry | undefined;
    if (!log) return;
    const state: PersistStateUpdate = {
      notBefore: payload['parkedUntil'] as number | undefined,
      serverNotBefore: payload['serverNotBefore'] as number | undefined,
      parkCount: payload['parkCount'] as number | undefined,
      lastRetryReason: payload['reason'] as string | undefined,
    };
    if (payload['source'] === OFFLINE_REPLAY_SOURCE) this.inFlight.delete(log.logId);
    this.enqueueOp(() =>
      this.persist(log, payload['priority'] as number | undefined, state),
    );
  }

  /** 热重试也持久化 Retry-After；关闭 Upload cache 时仍能跨页面守约。 */
  private handleRetryScheduled(payload: Record<string, unknown>): void {
    const log = payload['log'] as LogEntry | undefined;
    if (!log) return;
    if (payload['source'] === OFFLINE_REPLAY_SOURCE && !this.index.has(log.logId)) return;
    this.enqueueOp(() =>
      this.persist(log, payload['priority'] as number | undefined, {
        notBefore: payload['nextAttemptAt'] as number | undefined,
        serverNotBefore: payload['serverNotBefore'] as number | undefined,
        lastRetryReason: payload['reason'] as string | undefined,
      }),
    );
  }

  /**
   * 队列刚进入暂停：把此刻还扣在队列里的日志一起落盘
   *
   * 断网后产生的第一条日志是先入队、再触发暂停的，它拿不到
   * `upload:enqueued { paused: true }`，只能靠这份快照兜住。
   */
  private handlePaused(payload: Record<string, unknown>): void {
    const logs = payload['logs'];
    if (!Array.isArray(logs)) return;
    for (const item of logs) {
      const entry = item as { log?: LogEntry; priority?: number };
      if (!entry?.log) continue;
      this.enqueueOp(() => this.persist(entry.log!, entry.priority));
    }
  }

  private handleEnqueued(payload: Record<string, unknown>): void {
    // 只镜像"暂停期间新产生"的日志：这是断网续传的主路径，
    // 正常在线时日志几秒内就发走了，落盘纯属浪费配额
    if (payload['paused'] !== true) return;
    if (payload['source'] === OFFLINE_REPLAY_SOURCE) return;
    const log = payload['log'] as LogEntry | undefined;
    if (!log) return;
    this.enqueueOp(() => this.persist(log, payload['priority'] as number | undefined));
  }

  private handleSuccess(payload: Record<string, unknown>): void {
    const log = payload['log'] as LogEntry | undefined;
    if (!log) return;
    const logId = log.logId;
    if (payload['source'] === OFFLINE_REPLAY_SOURCE) {
      this.stats.replayed++;
    }
    // 同步占墓碑 + 清补传 inFlight + 踢掉尚未 flush 的 pending：
    // 必须在 enqueueOp 之外完成，否则已排队的 replay / 稍后的 pending flush
    // 仍会把已送达日志再写盘、再补传。
    this.deliveredTombstones.add(logId);
    this.inFlight.delete(logId);
    this.pendingPersists = this.pendingPersists.filter((p) => p.log.logId !== logId);
    notePendingRecordDelete(this.deletionResourceKeys(), logId);
    if (!this.hydrated) {
      this.preHydrationDeletes.add(logId);
    }
    // 删除动作必须排进串行队列：同一 tick 里 "入队镜像" 的写入可能还没执行，
    // 抢跑就会留下永远删不掉的孤儿
    this.enqueueOp(async () => {
      try {
        if (this.index.has(logId)) {
          await this.safeDelete(logId);
          return;
        }
        if (!this.hydrated) {
          // 墓碑已在上面同步写入；hydration 时对账删除
          return;
        }
        // hydrated 但对不了账（如 loadMeta 失败）：注释承诺是直接尝试删盘，
        // 不能只 return，否则已送达副本会躺到下次成功 hydrate 再被补传。
        await this.safeDelete(logId);
      } finally {
        this.deliveredTombstones.delete(logId);
      }
    });
    // 上一批消化完了就继续下一批
    this.scheduleReplay();
  }

  /** Offline 初始化较慢时，补齐此前已经进入 paused/parked 的 Upload 队列。 */
  private catchUpPausedQueue(): void {
    const upload = this.getUploadPlugin();
    if (!upload || !upload.getQueueStatus().paused) return;
    for (const item of upload.peekQueuedForPersist()) {
      this.enqueueOp(() => this.persist(item.log, item.priority));
    }
  }

  // ==================== 持久化 ====================

  private getRejectedPersistReason(
    splitId: string,
  ): 'storage-quota' | 'storage-rejected' | undefined {
    const entry = this.rejectedPersistSplitIds.get(splitId);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.rejectedPersistSplitIds.delete(splitId);
      return undefined;
    }
    return entry.reason;
  }

  private rememberRejectedPersistSplit(
    splitId: string,
    reason: 'storage-quota' | 'storage-rejected',
  ): void {
    const now = Date.now();
    for (const [id, entry] of this.rejectedPersistSplitIds) {
      if (entry.expiresAt <= now) this.rejectedPersistSplitIds.delete(id);
    }
    while (this.rejectedPersistSplitIds.size >= MAX_REJECTED_SPLIT_IDS) {
      const oldest = this.rejectedPersistSplitIds.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.rejectedPersistSplitIds.delete(oldest);
    }
    this.rejectedPersistSplitIds.set(splitId, {
      reason,
      expiresAt: now + REJECTED_SPLIT_TTL_MS,
    });
  }

  /**
   * 暂存尚未提交的写意图，并按 logId 合并。
   *
   * 初始化窗口、短暂存储故障和 retry deadline 更新都走同一缓冲区；同一日志
   * 只占一个槽位，协议期限只向后合并，避免重复事件无界增长或把较新的
   * Retry-After 覆盖回旧值。
   */
  private bufferPersist(
    log: LogEntry,
    priority?: number,
    state?: PersistStateUpdate,
  ): void {
    const splitId = getSplitId(log);
    const rejectedReason = splitId === undefined
      ? undefined
      : this.getRejectedPersistReason(splitId);
    if (rejectedReason) {
      if (rejectedReason === 'storage-quota') this.stats.quotaDrops++;
      this.reportDrop(log, rejectedReason);
      return;
    }
    const index = this.pendingPersists.findIndex((item) => item.log.logId === log.logId);
    // 退避缓冲不能成为绕过持久层配额的第二个无界队列。允许至多一份当前
    // 持久索引量 + 一份新写预算；超过时拒绝新原子单元，保留更早的写意图。
    const bytes = jsonBytes(log);
    const entryLimit = Math.max(1, this.index.size + this.maxEntries);
    const byteLimit = Math.max(1, this.totalBytes + this.maxTotalBytes);
    const pendingBytes = this.pendingPersists.reduce((total, item) => {
      const size = jsonBytes(item.log);
      return Number.isFinite(size) ? total + size : Number.POSITIVE_INFINITY;
    }, 0);
    const previousBytes = index === -1 ? 0 : jsonBytes(this.pendingPersists[index]!.log);
    const projectedBytes = pendingBytes
      - (Number.isFinite(previousBytes) ? previousBytes : 0)
      + bytes;
    const reason: 'storage-quota' | 'storage-rejected' | undefined =
      !Number.isFinite(bytes)
        ? 'storage-rejected'
        : this.pendingPersists.length + (index === -1 ? 1 : 0) > entryLimit
          || projectedBytes > byteLimit
          ? 'storage-quota'
          : undefined;
    if (reason) {
      const rejected = splitId === undefined
        ? []
        : this.pendingPersists.filter((item) => getSplitId(item.log) === splitId);
      if (splitId !== undefined) {
        this.pendingPersists = this.pendingPersists.filter(
          (item) => getSplitId(item.log) !== splitId,
        );
        this.rememberRejectedPersistSplit(splitId, reason);
      }
      const victims = [...rejected, { log, priority, state }]
        .filter((item, offset, all) =>
          all.findIndex((candidate) => candidate.log.logId === item.log.logId) === offset);
      for (const victim of victims) {
        if (reason === 'storage-quota') this.stats.quotaDrops++;
        this.reportDrop(victim.log, reason);
      }
      return;
    }
    if (index === -1) {
      this.pendingPersists.push({ log, priority, state });
    } else {
      const previous = this.pendingPersists[index]!;
      this.pendingPersists[index] = {
        log,
        priority: priority ?? previous.priority,
        state: mergePersistStateUpdate(previous.state, state),
      };
    }
  }

  private deferPersistAfterStorageError(
    log: LogEntry,
    priority: number | undefined,
    state: PersistStateUpdate | undefined,
    error: unknown,
  ): void {
    if (this.destroyed) return;
    this.debug('transient offline persistence failure; retrying with backoff:', error);
    this.bufferPersist(log, priority, state);
    this.armStorageRetryWake();
  }

  private async persist(
    log: LogEntry,
    priority?: number,
    state?: PersistStateUpdate,
  ): Promise<void> {
    const epoch = this.epoch;
    if (!this.isEpoch(epoch)) return;
    // store 句柄可在 hydrate 之前先赋值；这不代表索引已经可用于容量/去重决策。
    // 初始化完成前一律缓冲，禁止任何事件在“可写 store + 空 index”窗口抢跑。
    if (!this.hydrated) {
      this.bufferPersist(log, priority, state);
      return;
    }
    if (!this.storageOperational) return;
    const splitId = getSplitId(log);
    const rejectedReason = splitId === undefined
      ? undefined
      : this.getRejectedPersistReason(splitId);
    if (rejectedReason) {
      if (rejectedReason === 'storage-quota') this.stats.quotaDrops++;
      this.reportDrop(log, rejectedReason);
      return;
    }
    // 已送达的绝不能再进缓冲 / 再写盘
    if (
      this.deliveredTombstones.has(log.logId) ||
      this.preHydrationDeletes.has(log.logId) ||
      hasPendingRecordDelete(this.claimedResources, log.logId)
    ) {
      return;
    }
    if (!this.store) return;
    if (this.store.backend === 'noop') return;
    if (this.index.has(log.logId)) {
      if (!state) return;
      let existing: OfflineRecord | null;
      try {
        existing = await this.safeGet(log.logId);
      } catch (error) {
        this.deferPersistAfterStorageError(log, priority, state, error);
        return;
      }
      if (!existing || existing.terminal) return;
      const merged = mergePersistStateUpdate({
        notBefore: existing.notBefore,
        serverNotBefore: existing.serverNotBefore,
        parkCount: existing.parkCount,
        replayAttempts: existing.replayAttempts,
        lastRetryReason: existing.lastRetryReason,
      }, state)!;
      existing.notBefore = merged.notBefore;
      existing.serverNotBefore = merged.serverNotBefore;
      existing.parkCount = Number.isFinite(merged.parkCount)
        ? Math.max(0, Math.floor(merged.parkCount!))
        : undefined;
      existing.replayAttempts = Number.isFinite(merged.replayAttempts)
        ? Math.max(0, Math.floor(merged.replayAttempts!))
        : existing.replayAttempts;
      existing.lastRetryReason = merged.lastRetryReason;
      try {
        await this.store.put(existing);
        const meta = this.index.get(log.logId);
        if (meta) {
          meta.notBefore = existing.notBefore;
          meta.serverNotBefore = existing.serverNotBefore;
          meta.parkCount = existing.parkCount;
          meta.replayAttempts = existing.replayAttempts;
          meta.lastRetryReason = existing.lastRetryReason;
        }
      } catch (err) {
        // 旧副本仍是最后一次已提交状态；保留更新意图并退避，不能静默丢掉
        // Retry-After，否则刷新页面后可能提前请求服务端。
        this.deferPersistAfterStorageError(log, priority, state, err);
      }
      return;
    }

    const bytes = jsonBytes(log);
    if (!Number.isFinite(bytes)) {
      // 与 DataCloneError 同语义：这条本身存不下，必须可观测地丢掉，
      // 不能静默 return（断网侧以为落了盘，刷新即丢且无 onDrop）。
      await this.rejectPersistRecord(log, 'storage-rejected', epoch);
      return;
    }

    const record: OfflineRecord = {
      logId: log.logId,
      storedAt: Date.now(),
      capturedAt: log.timestamp,
      priority: priority ?? 0,
      bytes,
      replayAttempts: Number.isFinite(state?.replayAttempts)
        ? Math.max(0, Math.floor(state!.replayAttempts!))
        : 0,
      splitId: splitId ?? null,
      notBefore: Number.isFinite(state?.notBefore) ? state?.notBefore : undefined,
      serverNotBefore: Number.isFinite(state?.serverNotBefore)
        ? state?.serverNotBefore
        : undefined,
      parkCount: Number.isFinite(state?.parkCount)
        ? Math.max(0, Math.floor(state!.parkCount!))
        : undefined,
      lastRetryReason: state?.lastRetryReason,
      log,
    };

    if (bytes > this.maxTotalBytes || this.maxEntries < 1) {
      await this.rejectPersistRecord(log, 'storage-quota', epoch);
      return;
    }

    let hasRoom: boolean;
    try {
      hasRoom = await this.makeRoomFor(bytes, epoch, splitId);
    } catch (error) {
      this.deferPersistAfterStorageError(log, priority, state, error);
      return;
    }
    if (!hasRoom) {
      await this.rejectPersistRecord(log, 'storage-quota', epoch);
      return;
    }
    if (!this.isEpoch(epoch) || !this.store) return;

    try {
      await this.store.put(record);
    } catch (err) {
      if (!this.isEpoch(epoch)) return;
      if (!isQuotaError(err)) {
        if (isPermanentRecordError(err)) {
          // 只有 DataClone/结构本身无效才是记录终态；UnknownError、事务中止等
          // 都可能在下一次事务恢复，不能把暂态故障伪装成 payload 拒收。
          this.debug('record is not storable, dropping:', err);
          await this.rejectPersistRecord(log, 'storage-rejected', epoch);
        } else {
          this.deferPersistAfterStorageError(log, priority, state, err);
        }
        return;
      }
      // 确实是配额：再淘汰一批后重试一次，仍失败就明确丢弃
      this.debug('quota hit, evicting and retrying:', err);
      const evicted = await this.evictOldest(
        Math.max(1, Math.ceil(this.index.size * 0.2)),
        epoch,
        splitId,
      );
      if (splitId !== undefined && evicted === 0) {
        await this.rejectPersistRecord(log, 'storage-quota', epoch);
        return;
      }
      if (!this.isEpoch(epoch) || !this.store) return;
      try {
        await this.store.put(record);
      } catch (retryErr) {
        if (!this.isEpoch(epoch)) return;
        if (isQuotaError(retryErr)) {
          this.debug('put failed after eviction, dropping:', retryErr);
          await this.rejectPersistRecord(log, 'storage-quota', epoch);
        } else if (isPermanentRecordError(retryErr)) {
          this.debug('record is not storable after quota recovery:', retryErr);
          await this.rejectPersistRecord(log, 'storage-rejected', epoch);
        } else {
          this.deferPersistAfterStorageError(log, priority, state, retryErr);
        }
        return;
      }
    }

    if (!this.isEpoch(epoch)) return;
    this.index.set(record.logId, {
      logId: record.logId,
      storedAt: record.storedAt,
      capturedAt: record.capturedAt,
      priority: record.priority,
      bytes: record.bytes,
      replayAttempts: record.replayAttempts,
      splitId: record.splitId,
      notBefore: record.notBefore,
      serverNotBefore: record.serverNotBefore,
      parkCount: record.parkCount,
      lastRetryReason: record.lastRetryReason,
    });
    this.totalBytes += bytes;
    const backend = this.store.backend;
    if (backend === 'indexeddb' || backend === 'localstorage') {
      try {
        this.logger?.emit('delivery:persisted', {
          logId: record.logId,
          capturedAt: record.capturedAt,
          bytes: record.bytes,
          backend,
        });
      } catch (err) {
        this.debug('delivery:persisted listener failed:', err);
      }
    }
  }

  /** 为新记录腾出条数与字节配额 */
  private async makeRoomFor(
    bytes: number,
    epoch: number,
    protectedSplitId?: string,
  ): Promise<boolean> {
    while (
      this.isEpoch(epoch) &&
      this.index.size > 0 &&
      (this.index.size >= this.maxEntries || this.totalBytes + bytes > this.maxTotalBytes)
    ) {
      const evicted = await this.evictOldest(1, epoch, protectedSplitId);
      if (evicted === 0) break;
    }
    return this.index.size < this.maxEntries && this.totalBytes + bytes <= this.maxTotalBytes;
  }

  /**
   * 淘汰最旧的若干条
   *
   * 按落盘时间淘汰而不是按优先级：断网期间的日志优先级往往一样，
   * 时间顺序是唯一稳定且可预期的标准。
   */
  private async evictOldest(
    count: number,
    epoch: number,
    protectedSplitId?: string,
  ): Promise<number> {
    if (!this.isEpoch(epoch)) return 0;
    const candidates: OfflineRecordMeta[] = [];
    for (const meta of Array.from(this.index.values()).sort((a, b) => a.storedAt - b.storedAt)) {
      if (protectedSplitId !== undefined) {
        const record = await this.safeGet(meta.logId);
        if (record && getSplitId(record.log) === protectedSplitId) continue;
      }
      candidates.push(meta);
      if (candidates.length >= count) break;
    }
    let evicted = 0;
    for (const meta of candidates) {
      if (!this.isEpoch(epoch)) return evicted;
      if (!this.index.has(meta.logId)) continue;
      const removed = await this.deleteSplitGroup(meta.logId, 'storage-quota');
      this.stats.quotaDrops += Math.max(1, removed);
      evicted += Math.max(1, removed);
    }
    return evicted;
  }

  /** 任一分片无法落盘时清掉已落盘兄弟，并拒绝本轮后续分片。 */
  private async rejectPersistRecord(
    log: LogEntry,
    reason: 'storage-quota' | 'storage-rejected',
    epoch: number,
  ): Promise<void> {
    const splitId = getSplitId(log);
    if (splitId === undefined) {
      if (reason === 'storage-quota') this.stats.quotaDrops++;
      this.reportDrop(log, reason);
      return;
    }

    this.rememberRejectedPersistSplit(splitId, reason);
    // hydrate 后 meta.splitId 已是权威分组索引。终态清理不能先依赖正文读取：一次
    // 短暂 get 失败若阻断删除，当前拒绝事件就会被吞掉，残片也没有后续唤醒。
    const siblingIds = Array.from(this.index.values())
      .filter((meta) => meta.splitId === splitId)
      .map((meta) => meta.logId);
    const siblingRecords: OfflineRecord[] = [];
    for (const logId of siblingIds) {
      if (!this.isEpoch(epoch)) return;
      try {
        const record = await this.safeGet(logId);
        if (record) siblingRecords.push(record);
      } catch (error) {
        this.debug('split rejection could not read sibling body; deleting by indexed id:', error);
      }
      await this.safeDelete(logId);
    }
    for (const record of siblingRecords) this.reportDrop(record.log, reason);
    const removed = siblingIds.length;
    if (reason === 'storage-quota') this.stats.quotaDrops += removed + 1;
    if (this.isEpoch(epoch)) this.reportDrop(log, reason);
  }

  /** 配额淘汰和 TTL 过期按 splitId 整组删除，避免后端收到残片。 */
  private async deleteSplitGroup(
    logId: string,
    reason: UploadDropReason,
  ): Promise<number> {
    const indexedMeta = this.index.get(logId);
    const primary = await this.safeGet(logId);
    const splitId = indexedMeta
      ? (indexedMeta.splitId ?? undefined)
      : (primary ? getSplitId(primary.log) : undefined);
    // hydrate 后 meta.splitId 是分组的权威索引。正文可能被另一个 Tab 删除；
    // 它只影响 drop 事件能否携带原日志，绝不能改变本次需要清理的成员集合。
    const memberIds = splitId === undefined
      ? [logId]
      : Array.from(this.index.values())
          .filter((meta) => meta.splitId === splitId)
          .map((meta) => meta.logId);
    if (!memberIds.includes(logId)) memberIds.push(logId);

    // 先完成全部只读检查，再开始删除，避免中途读失败留下人为制造的半组。
    const records: OfflineRecord[] = [];
    for (const id of memberIds) {
      const record = id === logId ? primary : await this.safeGet(id);
      if (record) records.push(record);
    }
    for (const id of memberIds) await this.safeDelete(id);
    for (const record of records) this.reportDrop(record.log, reason);
    return memberIds.length;
  }

  // ==================== 补传 ====================

  private async drainPendingPersists(epoch: number): Promise<void> {
    const pending = this.pendingPersists.splice(0);
    for (const item of pending) {
      if (!this.isEpoch(epoch)) return;
      if (
        this.deliveredTombstones.has(item.log.logId)
        || this.preHydrationDeletes.has(item.log.logId)
        || hasPendingRecordDelete(this.claimedResources, item.log.logId)
      ) {
        continue;
      }
      await this.persist(item.log, item.priority, item.state);
    }
  }

  /** 短暂读写故障后的统一恢复入口：先重放写意图，再恢复补传扫描。 */
  private scheduleStorageRetry(): void {
    const epoch = this.epoch;
    this.enqueueOp(async () => {
      try {
        await this.flushPendingRecordDeletes();
        await this.drainPendingPersists(epoch);
        if (this.pendingPersists.length === 0) await this.replay();
        if (
          this.pendingPersists.length === 0
          && !hasPendingRecordDeletes(this.deletionResourceKeys())
        ) {
          this.clearStorageRetryTimer(true);
        }
      } catch (error) {
        this.armStorageRetryWake();
        throw error;
      }
    });
  }

  private scheduleReplay(): void {
    if (this.destroyed) return;
    if (this.index.size === 0) return;
    this.enqueueOp(async () => {
      try {
        await this.replay();
        if (
          this.pendingPersists.length === 0
          && !hasPendingRecordDeletes(this.deletionResourceKeys())
        ) {
          this.clearStorageRetryTimer(true);
        }
      } catch (error) {
        this.armStorageRetryWake();
        throw error;
      }
    });
  }

  private armStorageRetryWake(): void {
    if (this.destroyed || this.storageRetryTimer) return;
    this.storageRetryDelay = this.storageRetryDelay === 0
      ? 1000
      : Math.min(this.storageRetryDelay * 2, 60_000);
    const epoch = this.epoch;
    this.storageRetryTimer = setTimeout(() => {
      this.storageRetryTimer = null;
      if (this.isEpoch(epoch)) this.scheduleStorageRetry();
    }, this.storageRetryDelay);
  }

  private clearStorageRetryTimer(resetDelay = false): void {
    if (this.storageRetryTimer) {
      clearTimeout(this.storageRetryTimer);
      this.storageRetryTimer = null;
    }
    if (resetDelay) this.storageRetryDelay = 0;
  }

  /**
   * 队列溢出后的冷却唤醒
   *
   * 默认约 1s（不超过 replayTimeoutMs）：给 Upload 队列腾出空位的时间，
   * 又不会像默默等满 replayTimeoutMs 那样把同会话补传拖死。
   */
  private armOverflowReplayWake(): void {
    if (this.destroyed || this.overflowReplayTimer) return;
    const delay = Math.min(1000, this.options.replayTimeoutMs);
    const epoch = this.epoch;
    this.overflowReplayTimer = setTimeout(() => {
      this.overflowReplayTimer = null;
      if (this.destroyed || this.epoch !== epoch) return;
      this.scheduleReplay();
    }, delay);
  }

  private clearOverflowReplayTimer(): void {
    if (!this.overflowReplayTimer) return;
    clearTimeout(this.overflowReplayTimer);
    this.overflowReplayTimer = null;
  }

  private armDeferredReplayWake(deadline: number): void {
    this.clearDeferredReplayTimer();
    if (this.destroyed || !Number.isFinite(deadline)) return;
    const epoch = this.epoch;
    const delay = Math.max(0, deadline - Date.now());
    this.deferredReplayTimer = setTimeout(() => {
      this.deferredReplayTimer = null;
      if (!this.destroyed && this.epoch === epoch) this.scheduleReplay();
    }, Math.min(delay, 2_147_483_647));
  }

  private clearDeferredReplayTimer(): void {
    if (!this.deferredReplayTimer) return;
    clearTimeout(this.deferredReplayTimer);
    this.deferredReplayTimer = null;
  }

  private async replay(): Promise<void> {
    const epoch = this.epoch;
    if (!this.isEpoch(epoch)) return;
    if (!this.store || this.store.backend === 'noop') return;
    if (!this.storageOperational) return;
    if (this.index.size === 0) return;

    const upload = this.getUploadPlugin();
    if (!upload) return;

    const now = Date.now();
    // 未提交写意图是持久状态机的一部分：新分片还在退避时，磁盘上的兄弟只是
    // “暂时不完整”，不能被完整性校验当成损坏残组删除；deadline 更新待提交时，
    // 也不能按旧期限提前补传。
    const pendingPersistLogIds = new Set(
      this.pendingPersists.map((item) => item.log.logId),
    );
    const pendingPersistSplitIds = new Set(
      this.pendingPersists
        .map((item) => getSplitId(item.log))
        .filter((splitId): splitId is string => splitId !== undefined),
    );
    // 对账：超时放行；或 Upload 已不再持有（被卸掉 / 挤掉）→ 孤儿坑位清掉
    for (const [logId, startedAt] of this.inFlight) {
      if (
        now - startedAt >= this.options.replayTimeoutMs ||
        !upload.isPending(logId)
      ) {
        this.inFlight.delete(logId);
      }
    }

    const queueStatus = upload.getQueueStatus();
    if (queueStatus.maxSize - queueStatus.length - queueStatus.parked - queueStatus.admitting <= 0) {
      this.armOverflowReplayWake();
      return;
    }

    // 必须先用完整索引建组，再按组判断 inFlight / pending / Retry-After。
    // 先逐条筛选会让同组中“已到期”的分片先被单独 requeue，破坏全有或全无语义。
    const metaGroups = new Map<string, OfflineRecordMeta[]>();
    const ordered = Array.from(this.index.values())
      .sort((a, b) => b.priority - a.priority || a.storedAt - b.storedAt);
    for (const meta of ordered) {
      if (!this.isEpoch(epoch)) return;
      if (!this.index.has(meta.logId)) continue;
      if (now - meta.storedAt >= this.options.ttl) {
        await this.deleteSplitGroup(meta.logId, 'cache-expired');
        continue;
      }

      const groupKey = meta.splitId == null ? `log:${meta.logId}` : `split:${meta.splitId}`;
      const group = metaGroups.get(groupKey);
      if (group) group.push(meta);
      else metaGroups.set(groupKey, [meta]);
    }

    let earliestDeferred = Number.POSITIVE_INFINITY;
    const groups = new Map<string, Array<{ meta: OfflineRecordMeta; record: OfflineRecord }>>();
    for (const [groupKey, metas] of metaGroups) {
      let blocked = groupKey.startsWith('split:')
        ? pendingPersistSplitIds.has(groupKey.slice(6))
        : metas.some((meta) => pendingPersistLogIds.has(meta.logId));
      let groupDeadline = 0;
      for (const meta of metas) {
        if (
          this.inFlight.has(meta.logId) ||
          this.deliveredTombstones.has(meta.logId) ||
          hasPendingRecordDelete(this.claimedResources, meta.logId) ||
          upload.isPending(meta.logId)
        ) {
          blocked = true;
        }
        const notBefore = Math.max(meta.notBefore ?? 0, meta.serverNotBefore ?? 0);
        if (notBefore > now) {
          blocked = true;
          groupDeadline = Math.max(groupDeadline, notBefore);
        }
      }
      if (groupDeadline > 0) earliestDeferred = Math.min(earliestDeferred, groupDeadline);
      if (blocked) continue;

      const members: Array<{ meta: OfflineRecordMeta; record: OfflineRecord }> = [];
      let missing = false;
      for (const meta of metas) {
        const record = await this.safeGet(meta.logId);
        if (!this.isEpoch(epoch)) return;
        if (!record) {
          this.removeFromIndex(meta.logId);
          missing = true;
          continue;
        }
        members.push({ meta, record });
      }
      if (missing) {
        // 索引/正文已经不一致时不能把剩余分片作为“完整组”发送。
        if (groupKey.startsWith('split:') && members.length > 0) {
          await this.deleteSplitGroup(members[0]!.meta.logId, 'storage-rejected');
        }
        continue;
      }
      if (
        groupKey.startsWith('split:') &&
        members.length > 0 &&
        !isCompleteSplitGroup(members.map((member) => member.record), groupKey.slice(6))
      ) {
        // 旧版本、崩溃中断或 hydrate 淘汰都可能只留下部分分片。缺任何一片时
        // 后端都无法重组，继续上传只会制造不可恢复的孤儿数据。
        await this.deleteSplitGroup(members[0]!.meta.logId, 'storage-rejected');
        continue;
      }
      if (members.length > 0) groups.set(groupKey, members);
    }
    if (earliestDeferred !== Number.POSITIVE_INFINITY) {
      this.armDeferredReplayWake(earliestDeferred);
    }

    const latestStatus = upload.getQueueStatus();
    let room = Math.max(
      0,
      latestStatus.maxSize
        - latestStatus.length
        - latestStatus.parked
        - latestStatus.admitting,
    );
    if (room <= 0) {
      this.armOverflowReplayWake();
      return;
    }

    const candidates: Array<{ meta: OfflineRecordMeta; record: OfflineRecord }> = [];
    let deferredForCapacity = false;
    let hasFeasibleGroup = false;
    for (const group of groups.values()) {
      if (candidates.length >= this.options.replayBatchSize) break;
      if (group.length > latestStatus.maxSize) {
        this.debug(
          `replay deferred: split group of ${group.length} exceeds queue maxSize ${latestStatus.maxSize}`,
        );
        continue;
      }
      hasFeasibleGroup = true;
      if (group.length > room) {
        deferredForCapacity = true;
        continue;
      }
      candidates.push(...group);
      room -= group.length;
    }
    if (candidates.length === 0 && groups.size > 0) {
      this.debug('replay deferred: no complete split group fits the upload queue');
      if (hasFeasibleGroup) this.armOverflowReplayWake();
      return;
    }
    if (deferredForCapacity) this.armOverflowReplayWake();

    for (const { meta, record } of candidates) {
      if (!this.isEpoch(epoch)) return;
      this.inFlight.set(meta.logId, now);
      upload.requeue(this.markAsReplay(record.log), {
        source: OFFLINE_REPLAY_SOURCE,
        priority: meta.priority || undefined,
      });
    }
  }

  /**
   * 打上补传标记
   *
   * `timestamp`（捕获时刻）保持原样 —— 改掉它就再也分不清"当时发生"和
   * "网络恢复后补传"。发出时刻由 UploadPlugin 统一写入 `tags.uploadedAt`。
   */
  private markAsReplay(log: LogEntry): LogEntry {
    const tags: LogTags = { ...log.tags, offlineReplay: true };
    return { ...log, tags };
  }

  private async registerReplayFailure(log: LogEntry): Promise<void> {
    const epoch = this.epoch;
    if (!this.isEpoch(epoch)) return;
    const logId = log.logId;
    this.inFlight.delete(logId);
    const meta = this.index.get(logId);
    if (!meta) return;

    // 计数以内存索引为准。配额打满时写回落盘会失败，落盘里的 attempts 就一直
    // 停在旧值 —— 只认它的话，这条日志会被无限次翻出来重投。
    meta.replayAttempts++;
    const attempts = meta.replayAttempts;

    let record: OfflineRecord | null;
    try {
      record = await this.safeGet(logId);
    } catch (error) {
      this.deferPersistAfterStorageError(log, meta.priority, {
        replayAttempts: attempts,
      }, error);
      return;
    }
    if (!this.isEpoch(epoch)) return;
    if (!record) {
      this.removeFromIndex(logId);
      return;
    }

    if (attempts >= this.options.maxReplayAttempts) {
      await this.safeDelete(logId);
      if (!this.isEpoch(epoch)) return;
      this.stats.giveUps++;
      this.reportDrop(record.log, 'offline-give-up', OFFLINE_REPLAY_SOURCE);
      return;
    }

    record.replayAttempts = attempts;
    try {
      await this.store!.put(record);
    } catch (err) {
      // 补传预算与 Retry-After 同属持久状态。写回失败时先把更新意图放进统一
      // 退避链；在它提交前 replay 的可见性屏障会扣住本条，避免刷新后预算倒退。
      this.deferPersistAfterStorageError(record.log, record.priority, {
        replayAttempts: attempts,
      }, err);
      return;
    }

    if (!this.isEpoch(epoch)) return;
    // 继续推进剩余记录。这里不会热循环：每次失败都会消耗一次 replayAttempts，
    // 而网络真的断了的时候 UploadPlugin 会暂停，requeue 进去的条目根本不会失败。
    this.scheduleReplay();
  }

  // ==================== 工具 ====================

  private getUploadPlugin(): UploadPlugin | null {
    // 延迟解析：装载顺序不一定保证 UploadPlugin 先于本插件安装
    const plugin = this.logger?.getPluginInstance('upload') as UploadPlugin | undefined;
    return plugin && typeof plugin.requeue === 'function' ? plugin : null;
  }

  /** 丢弃汇报统一走 UploadPlugin 的出口，宿主只需要关心一个 onDrop */
  private reportDrop(
    log: LogEntry,
    reason: UploadDropReason,
    source: string = OFFLINE_STORE_SOURCE,
  ): void {
    const upload = this.getUploadPlugin();
    if (upload && typeof upload.reportExternalDrop === 'function') {
      // 已卸载的 UploadPlugin 会拒接，这时候要退回自己发事件
      if (upload.reportExternalDrop(log, { reason, source }) !== false) return;
    }
    try {
      this.logger?.emit('upload:drop', { log, reason, source });
    } catch (err) {
      this.debug('host drop event failed:', err);
    }
  }

  private removeFromIndex(logId: string): void {
    const meta = this.index.get(logId);
    if (!meta) return;
    this.index.delete(logId);
    this.totalBytes = Math.max(0, this.totalBytes - meta.bytes);
  }

  /**
   * 初始化/完整性降级期间权威后端尚未确定，终态必须保护 IDB 与 KV；完成
   * reconciliation 后 fallback 已为空，稳定态只标记实际后端，避免休眠后端的
   * 模块级墓碑集合随每次成功投递无界增长。
   */
  private deletionResourceKeys(): string[] {
    const backend = this.store?.backend;
    if (
      this.hydrated
      && this.storageOperational
      && backend !== undefined
      && backend !== 'noop'
    ) {
      return backendResourceKeys(this.options, backend);
    }
    return [...this.claimedResources];
  }

  private async safeGet(logId: string): Promise<OfflineRecord | null> {
    try {
      return (await this.store?.get(logId)) ?? null;
    } catch (err) {
      this.debug('get failed:', err);
      // 读取失败与“记录确实不存在”是两种完全不同的状态。让调用链本轮停止，
      // 绝不能据此移除索引或级联删除分片；后续唤醒/重载还可以再次读取。
      throw err;
    }
  }

  private async safeDelete(logId: string): Promise<boolean> {
    const store = this.store;
    const resources = this.deletionResourceKeys();
    // 先记终态删除意图，存储异常或生命周期切换后仍不得复活。
    notePendingRecordDelete(resources, logId);
    if (!store) {
      // 后端尚未确定，不能把“无句柄”误当成“两边都没有记录”。
      this.removeFromIndex(logId);
      return false;
    }
    if (store.backend === 'noop') {
      // noop 生命周期没有可寻址的持久副本。保留每个在线成功 logId 只会让
      // 模块级意图集合无界增长；真正打开后端的生命周期会按盘上 terminal
      // 标记和自身索引重新对账。
      clearPendingRecordDelete(resources, logId);
      this.removeFromIndex(logId);
      return false;
    }
    try {
      await store.delete(logId);
      // KV 后端可能吞掉 removeItem 失败仍 resolve：回读确认真的没了再清墓碑
      if (await store.get(logId)) throw new Error('offline delete did not stick');
      clearPendingRecordDelete(backendResourceKeys(this.options, store.backend), logId);
      this.removeFromIndex(logId);
      return true;
    } catch (err) {
      this.debug('delete failed:', err);
      try {
        const record = await store.get(logId);
        if (record) {
          await store.put({ ...record, terminal: true });
        }
      } catch (markErr) {
        this.debug('failed to persist terminal tombstone:', markErr);
      }
      // 删除、墓碑写回都属于持久状态变更；短暂故障应在本生命周期自动恢复，
      // 而不是只能寄希望于下一次重新安装插件。
      this.armStorageRetryWake();
    }
    this.removeFromIndex(logId);
    return false;
  }

  /** 清理本实际资源上遗留的终态记录。 */
  private async flushPendingRecordDeletes(): Promise<void> {
    if (this.claimedResources.length === 0 || !this.store || this.store.backend === 'noop') return;
    const pending = new Set<string>();
    for (const resource of backendResourceKeys(this.options, this.store.backend)) {
      for (const logId of PENDING_RECORD_DELETES.get(resource) ?? []) pending.add(logId);
    }
    for (const logId of pending) {
      if (this.destroyed) break;
      await this.safeDelete(logId);
    }
  }

  /**
   * 把一次持久化操作排进串行队列
   *
   * IndexedDB 是异步的，drop / success / replay 可能在同一 tick 里连着来；
   * 不串行化就会出现"删除跑在写入前面"这类竞态。
   */
  private enqueueOp<T>(op: () => Promise<T>, propagateError = false): Promise<T | undefined> {
    const epoch = this.epoch;
    const run = async (): Promise<T | undefined> => {
      // destroyed 或世代已变（同实例 remount）→ 上一轮工作作废
      if (this.destroyed || this.epoch !== epoch) return undefined;
      try {
        return await op();
      } catch (err) {
        // 单个操作失败绝不能打断整条链，否则后续的删除 / 补传全部停摆
        this.debug('offline op failed:', err);
        if (propagateError) throw err;
        return undefined;
      } finally {
        this.notifyDeliveryStatus();
      }
    };
    const next = this.chain.then(run, run);
    // 对外调用可以选择看见失败，但内部串行链永远恢复为 fulfilled，避免一次公开
    // clear 失败后把后续的成功/删除/补传全部短路。
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  private notifyDeliveryStatus(): void {
    const host = this.logger;
    if (!host) return;
    const notify = host.notifyDeliveryStatus;
    if (typeof notify !== 'function') return;
    try {
      notify.call(host);
    } catch (err) {
      this.debug('delivery status notification failed:', err);
    }
  }

  private warnStorageUnavailable(): void {
    if (this.storageWarned) return;
    this.storageWarned = true;
    if (typeof console === 'undefined' || !console.warn) return;
    console.warn(
      '[Aemeath] OfflinePersistencePlugin found no usable, fully reconciled storage backend '
        + '(storage is unavailable or failed its integrity scan). Offline logs will NOT be '
        + 'preserved across network outages. Uploading itself is unaffected.',
    );
  }

  private debug(...args: unknown[]): void {
    if (this.options.debug) {
      console.log('[Aemeath:offline]', ...args);
    }
  }
}
