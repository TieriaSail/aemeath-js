/**
 * OfflinePersistence 插件 — 断网期间落盘，联网后自动补传
 *
 * `UploadPlugin` 自带的 localStorage 缓存只解决"页面重载"（刷新、关闭后重开），
 * 它是队列镜像，日志一旦被丢弃就不在缓存里。真正的断网续传由本插件提供，
 * 并且刻意做成**独立插件**：持久化涉及存储引擎、配额、唤醒、复投、去重，
 * 把这些塞进主上传通道只会让核心链路更容易出 bug。
 * 标准入口配置 upload 时会默认安装本插件，也可用 `offlinePersistence: false` 关闭。
 *
 * 工作方式（全部基于事件，不侵入 UploadPlugin 内部）：
 *
 * ```
 * upload:paused  → 之后 upload:enqueued 的日志镜像落盘
 * upload:parked  → 热重试预算耗尽，保留持久副本
 * upload:drop    → 兜底落盘（队列溢出 / legacy 重试耗尽）
 * online / upload:resumed → 分批 upload.requeue(..., source: 'offline-replay')
 * upload:success → 按 logId 删除持久副本
 * ```
 *
 * 关键约束：
 * - **成功才删**。入队即删会在上传失败时丢掉唯一的持久副本。
 * - 补传走 `UploadPlugin.requeue()` 而不是 `logger.log()`，因此其它插件、
 *   `beforeSend` 和业务侧的 `logger.on('log')` 都不会被重放打扰。
 * - 默认策略的可恢复失败进入 parked，不消耗持久副本生命周期；
 *   `maxReplayAttempts` 只保留为 legacy 补传链路的终止保护。
 *
 * 详细文档参见 docs/{zh,en}/11-offline-persistence.md
 */

import type {
  AemeathPlugin,
  AemeathInterface,
  LogEntry,
  LogTags,
} from '../types';
import { PluginPriority } from '../types';
import type {
  DurableDeliveryReceipt,
  RecoveryCacheItem,
  UploadPlugin,
  UploadDropReason,
} from './UploadPlugin';
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
import type {
  LeasedOfflineRecord,
  OfflineCoordinationStore,
  OfflineRecordMeta as CoordinatedOfflineRecordMeta,
} from './offline/CoordinatedOfflineStore';
import {
  getCrossTabDeliveryCapability,
  type CrossTabDeliveryCapability,
} from './offline/CrossTabCapability';

type RuntimeOfflineRecordMeta = OfflineRecordMeta &
  Partial<CoordinatedOfflineRecordMeta>;

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
  return /quota|storage[ _]?full|NS_ERROR_DOM_QUOTA/i.test(
    `${name} ${message}`,
  );
}

/** 只有确定由记录内容造成、重试也不会改变的错误才可判为永久不可存储。 */
function isPermanentRecordError(err: unknown): boolean {
  if (err == null) return false;
  const name = String((err as { name?: unknown }).name ?? '');
  const message = String((err as { message?: unknown }).message ?? '');
  return (
    name === 'DataCloneError' ||
    /could not be cloned|record is invalid|cyclic object|circular structure/i.test(
      message,
    )
  );
}

/** IndexedDB 后端的默认容量 */
const IDB_DEFAULT_MAX_ENTRIES = 500;
const IDB_DEFAULT_MAX_BYTES = 2_000_000;

/** KV 后端容量小得多（localStorage 通常整源只有 ~5MB），默认收紧 */
/** 当前页面上已被占用的实际存储资源，用于发现两个实例共用一个库 */
const CLAIMED_OFFLINE_RESOURCES = new Set<string>();
const PENDING_RESOURCE_PURGES = new Map<string, Promise<void>>();

function offlineResourceKeys(options: {
  storage: 'auto' | 'indexeddb' | 'localstorage';
  dbName: string;
  key: string;
}): string[] {
  const resources = [`kv:${options.key}`];
  // auto 与显式 indexeddb 都可能降级到 KV，所以要同时认领两条后端资源。
  if (options.storage !== 'localstorage')
    resources.push(`idb:${options.dbName}`);
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

function trackResourcePurge(
  resources: readonly string[],
  run: () => Promise<void>,
): Promise<void> {
  const previous = pendingResourcePurges(resources);
  const tracked = Promise.all(
    previous.map((task) => task.catch(() => undefined)),
  ).then(run);
  for (const resource of resources)
    PENDING_RESOURCE_PURGES.set(resource, tracked);
  const cleanup = (): void => {
    for (const resource of resources) {
      if (PENDING_RESOURCE_PURGES.get(resource) === tracked)
        PENDING_RESOURCE_PURGES.delete(resource);
    }
  };
  // 不用 finally：finally 返回的新 rejected Promise 若无人接，会制造 unhandled rejection。
  void tracked.then(cleanup, cleanup);
  return tracked;
}

function pendingResourcePurges(resources: readonly string[]): Promise<void>[] {
  const tasks = new Set<Promise<void>>();
  for (const resource of resources) {
    const task = PENDING_RESOURCE_PURGES.get(resource);
    if (task) tasks.add(task);
  }
  return Array.from(tasks);
}

/**
 * 跨 uninstall→install 的「已决定删除、但删盘未完成」墓碑
 *
 * 不仅是上传成功：服务端终态拒收、TTL/配额淘汰也不能在删除失败后
 * 于下次打开“复活”。这些 id 挂在模块级，同 slot 的下次 hydrate 先清掉。
 */
const PENDING_RECORD_DELETES = new Map<string, Set<string>>();

function notePendingRecordDelete(
  resources: readonly string[],
  logId: string,
): void {
  for (const resource of resources) {
    let set = PENDING_RECORD_DELETES.get(resource);
    if (!set) {
      set = new Set();
      PENDING_RECORD_DELETES.set(resource, set);
    }
    set.add(logId);
  }
}

function clearPendingRecordDelete(
  resources: readonly string[],
  logId: string,
): void {
  for (const resource of resources) {
    const set = PENDING_RECORD_DELETES.get(resource);
    if (!set) continue;
    set.delete(logId);
    if (set.size === 0) PENDING_RECORD_DELETES.delete(resource);
  }
}

function hasPendingRecordDelete(
  resources: readonly string[],
  logId: string,
): boolean {
  return resources.some(
    (resource) => PENDING_RECORD_DELETES.get(resource)?.has(logId) === true,
  );
}

function hasPendingRecordDeletes(resources: readonly string[]): boolean {
  return resources.some(
    (resource) => (PENDING_RECORD_DELETES.get(resource)?.size ?? 0) > 0,
  );
}

function clearPendingDeletesForResources(resources: readonly string[]): void {
  for (const resource of resources) PENDING_RECORD_DELETES.delete(resource);
}

const KV_DEFAULT_MAX_ENTRIES = 100;
const KV_DEFAULT_MAX_BYTES = 512_000;
const REJECTED_SPLIT_TTL_MS = 60_000;
const MAX_REJECTED_SPLIT_IDS = 1024;
const SPLIT_ASSEMBLY_GRACE_MS = 100;
/**
 * 协调模式下内存缓冲的新分片等齐的宽限期。同一扇出的分片经序列化链快速到达；
 * 超过宽限仍不完整说明兄弟片已在上游被丢（不可能再来），残片必须清理，
 * 否则它会永久占用内存并阻塞同 splitId 盘上残组的领取。
 */
const SPLIT_BUFFER_GRACE_MS = 10_000;

/** 只有这些原因的丢弃值得留到下次再传；其余要么不可送达，要么是我们自己发出的 */
const PERSISTABLE_DROP_REASONS: ReadonlySet<UploadDropReason> =
  new Set<UploadDropReason>(['max-retries', 'queue-overflow']);

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

/** store 尚未就绪或短暂故障时暂存的写意图 */
interface BufferedPersist {
  log: LogEntry;
  priority?: number;
  state?: PersistStateUpdate;
  /** 首次进入缓冲的时刻；不完整 split 组按它判定残片超时 */
  bufferedAt?: number;
}

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
  const later = (
    a: number | undefined,
    b: number | undefined,
  ): number | undefined => {
    const values = [a, b].filter((value): value is number =>
      Number.isFinite(value),
    );
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
function isCompleteSplitGroup(
  records: readonly OfflineRecord[],
  splitId: string,
): boolean {
  if (records.length === 0) return false;
  const hasCoordinates = records.some(
    (record) =>
      record.log.tags?.splitIndex !== undefined ||
      record.log.tags?.splitTotal !== undefined,
  );
  // 兼容旧业务把 splitId 当普通标签使用的记录；SDK 生成的分片一定带坐标。
  if (!hasCoordinates) return true;

  let expectedTotal: number | undefined;
  const indices = new Set<number>();
  for (const record of records) {
    if (getSplitId(record.log) !== splitId) return false;
    const index = Number(record.log.tags?.splitIndex);
    const total = Number(record.log.tags?.splitTotal);
    if (
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(total) ||
      total <= 0
    )
      return false;
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

  /** legacy 补传链路失败多少次后放弃（默认 3；parked 不计入） */
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
  /** legacy 补传链路因反复失败而放弃的条数 */
  giveUps: number;
  /** 成功补传的条数 */
  replayed: number;
  /** 供统一 Delivery 状态中心按 logId 去重的持久化快照 */
  items: Array<{
    logId: string;
    capturedAt: number;
    state: 'persisted' | 'replaying' | 'buffering';
  }>;
}

/** @internal 浏览器入口可在同一个资源栅栏内追加 v2 清理。 */
export interface OfflinePersistencePurgeContext {
  dbName: string;
  namespace: string;
  storage: OfflinePersistencePluginOptions['storage'];
  canPurgeCrossTabStorage: boolean;
}

type OfflinePersistencePurgeHook = (
  context: OfflinePersistencePurgeContext,
) => Promise<void>;

export type OfflinePersistencePurgeOptions = OfflinePersistencePluginOptions & {
  namespace?: string;
};

/** 显式退出持久化时清除旧版本/上次会话留下的默认存储。内部入口使用。 */
export function purgeOfflinePersistenceStorage(
  platform: AemeathInterface['platform'],
  options: OfflinePersistencePurgeOptions = {},
): Promise<void> {
  return runOfflinePersistencePurge(platform, options);
}

/** @internal 在 legacy 与浏览器 v2 清理之间保持同一资源栅栏。 */
export function purgeOfflinePersistenceStorageWithHook(
  platform: AemeathInterface['platform'],
  options: OfflinePersistencePurgeOptions,
  hook: OfflinePersistencePurgeHook,
): Promise<void> {
  return runOfflinePersistencePurge(platform, options, hook);
}

async function runOfflinePersistencePurge(
  platform: AemeathInterface['platform'],
  options: OfflinePersistencePurgeOptions,
  hook?: OfflinePersistencePurgeHook,
): Promise<void> {
  // 只保护清理发起前已经存在的外部占用者。发起后才安装的新实例会通过
  // PENDING_RESOURCE_PURGES 等待本任务，不能反过来令本任务跳过清盘。
  const claimedBeforePurge = new Set(CLAIMED_OFFLINE_RESOURCES);
  const resources = offlineResourceKeys({
    storage: options.storage ?? 'auto',
    dbName: options.dbName ?? 'aemeath-offline',
    key: options.key ?? '__aemeath_offline__',
  });
  const runPurge = async (): Promise<void> => {
    const failures: unknown[] = [];
    const dbName = options.dbName ?? 'aemeath-offline';
    const key = options.key ?? '__aemeath_offline__';
    const namespace = options.namespace?.trim() || `${dbName}:${key}`;
    // auto/indexeddb 都可能在过去某次会话降级到 KV。显式关闭必须分别清理
    // 两种实际资源，否则 IDB 恢复后只清 IDB，旧 KV 副本会在未来再次降级时复活。
    const preferences: Array<'indexeddb' | 'localstorage'> =
      options.storage === 'localstorage'
        ? ['localstorage']
        : ['indexeddb', 'localstorage'];
    for (const preference of preferences) {
      // 不支持某种存储与“该存储存在但清理失败”不同：前者没有可清资源，后者
      // 必须让调用方看见。小程序/SSR 没有 IDB 是正常能力差异。
      if (preference === 'indexeddb') {
        try {
          if (typeof indexedDB === 'undefined' || indexedDB === null) continue;
        } catch {
          continue;
        }
      } else if (platform.type === 'unknown') {
        continue;
      }
      const targetResource =
        preference === 'indexeddb' ? `idb:${dbName}` : `kv:${key}`;
      if (claimedBeforePurge.has(targetResource)) continue;
      let store: OfflineStore | null = null;
      try {
        store = await createOfflineStore({
          preference,
          platform,
          dbName,
          keyPrefix: key,
          allowFallback: false,
        });
        const actualResources = backendResourceKeys(
          { dbName, key },
          store.backend,
        );
        // 另一个活跃实例可能正持有这条资源（典型：当前实例因撞 key 已让位，
        // 随后又显式关闭）。绝不能把“关闭自己”变成“清空别人的可靠队列”。
        if (
          actualResources.some((resource) => claimedBeforePurge.has(resource))
        ) {
          continue;
        }
        await store.clear();
        clearPendingDeletesForResources(actualResources);
      } catch (error) {
        failures.push(error);
      } finally {
        store?.close();
      }
    }
    if (hook) {
      try {
        await hook({
          dbName,
          namespace,
          storage: options.storage,
          canPurgeCrossTabStorage: !claimedBeforePurge.has(`idb:${dbName}`),
        });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw failures[0];
    }
  };
  await trackResourcePurge(resources, runPurge);
}

/** CrossTabDeliveryPlugin 与离线持久化插件之间的窄接口。 */
export interface OfflineCrossTabRecoveryController {
  wake(reason?: string): void;
  notifyStoreCleared(): void;
  stop(): Promise<void>;
}

export interface OfflineCrossTabStoreFactoryOptions {
  preference: 'auto' | 'indexeddb' | 'localstorage';
  platform: AemeathInterface['platform'];
  dbName: string;
  keyPrefix: string;
  namespace: string;
  allowFallback?: boolean;
  onFallback?: (from: string, reason: unknown) => void;
}

export type OfflineCrossTabStoreFactory = (
  options: OfflineCrossTabStoreFactoryOptions,
) => Promise<OfflineStore>;

export type OfflineCrossTabCoordinationFactory = (
  store: OfflineStore,
) => OfflineCoordinationStore;

export interface OfflineCrossTabClaim {
  record: LeasedOfflineRecord;
  receipt: DurableDeliveryReceipt;
}

export interface OfflineCrossTabRecoveryPort {
  readonly store: OfflineStore;
  /** v2 的唯一写入/所有权事务门面。 */
  readonly coordination: OfflineCoordinationStore;
  readonly namespace: string;
  readonly replayBatchSize: number;
  getCandidateGroups(): Promise<readonly (readonly string[])[]>;
  acceptClaims(deliveries: readonly OfflineCrossTabClaim[]): Promise<void>;
  acknowledgeRemoteDelivery(logId: string): Promise<void>;
  connect(controller: OfflineCrossTabRecoveryController): void;
  /** 只释放控制器，不把 v2 数据交回 legacy replay。 */
  disconnect(controller: OfflineCrossTabRecoveryController): void;
}

export class OfflinePersistencePlugin implements AemeathPlugin {
  readonly name = 'offline-persistence';
  readonly version = '2.6.0';
  /** 不参与日志管道，优先级仅用于安装顺序的可预期性 */
  readonly priority: number = PluginPriority.LATE + 1;
  readonly description = '断网期间日志落盘，联网后自动补传';

  private readonly options: Required<
    Omit<OfflinePersistencePluginOptions, 'maxEntries' | 'maxTotalBytes'>
  > & { maxEntries?: number; maxTotalBytes?: number; namespace: string };
  /** 只有显式跨标签能力可以覆盖；每次 remount 都恢复到这个兼容默认值。 */
  private readonly defaultNamespace: string;

  private logger: AemeathInterface | null = null;
  private store: OfflineStore | null = null;
  /** 由可选 CrossTabDeliveryPlugin 同步预留；默认补传路径完全不使用协调器。 */
  private crossTabReservation: symbol | null = null;
  private crossTabStoreFactory: OfflineCrossTabStoreFactory | null = null;
  private crossTabCoordinationFactory: OfflineCrossTabCoordinationFactory | null =
    null;
  private crossTabReservationTask: Promise<OfflineCrossTabRecoveryPort | null> | null =
    null;
  private crossTabStoreActive = false;
  private crossTabCoordination: OfflineCoordinationStore | null = null;
  private crossTabWake: ((reason?: string) => void) | null = null;
  private crossTabStoreCleared: (() => void) | null = null;
  private crossTabStop: (() => Promise<void>) | null = null;
  private ready: Promise<void> | null = null;
  private destroyed = false;

  /** 实际认领的 IDB/KV 资源；两种后端的命名空间并不相同 */
  private claimedResources: string[] = [];
  /** 显式关闭请求按生命周期世代绑定，避免 remount 继承旧清盘意图。 */
  private readonly purgeEpochs = new Set<number>();

  /** 内存索引：避免每次写入都去扫存储 */
  private index = new Map<string, RuntimeOfflineRecordMeta>();
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
   * 已上传成功、磁盘删除尚未跑完（或尚未 hydrate）的 logId
   *
   * 必须同步写入：否则已排队的 pending flush / replay 仍会把已送达日志再写盘、再补传。
   */
  private readonly deliveredTombstones = new Set<string>();
  /** 非 claim 的内存副本成功后，等待 split-progress 原子删除提交的 logId。 */
  private readonly pendingCoordinatedSuccesses = new Set<string>();
  /**
   * store 尚未打开时收到的落盘请求
   *
   * `createOfflineStore` 是异步的；`upload:paused` / pause 期 `enqueued` 可能
   * 抢在 store 赋值之前到达。若直接丢弃，断网窗口里最早一批日志会永远落不了盘。
   */
  private pendingPersists: BufferedPersist[] = [];
  /** Upload cache 在首次网络调用前交出的恢复所有权；提交完成前原 cache 仍保留。 */
  private recoveryCacheTransfer: RecoveryCacheItem[] = [];
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

  private handlers: Array<{ event: string; fn: (...args: unknown[]) => void }> =
    [];
  private boundOnline: (() => void) | null = null;
  /** 队列溢出后的冷却补传，避免立即 requeue 形成热循环 */
  private overflowReplayTimer: ReturnType<typeof setTimeout> | null = null;
  /** 持久化 Retry-After / parked 到期后的精确唤醒 */
  private deferredReplayTimer: ReturnType<typeof setTimeout> | null = null;
  /** 持久层瞬时读取失败后的有界重试 */
  private storageRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private storageRetryDelay = 0;
  /** 以 Upload 发出的状态事件为准；事件到达后不得被一次瞬时 onLine=true 绕过。 */
  private uploadPaused = false;
  /**
   * 生命周期世代：同实例 remount 时递增，作废上一轮还挂在 chain / init 上的工作。
   */
  private epoch = 0;
  /** 已确认无法整组落盘的 splitId；本生命周期内后续分片也必须拒绝。 */
  private readonly rejectedPersistSplitIds = new Map<
    string,
    { reason: 'storage-quota' | 'storage-rejected'; expiresAt: number }
  >();

  constructor(options: OfflinePersistencePluginOptions = {}) {
    const positive = (
      value: number | undefined,
      fallback: number,
      min = 1,
    ): number =>
      typeof value === 'number' && Number.isFinite(value) && value >= min
        ? value
        : fallback;
    const positiveInteger = (
      value: number | undefined,
      fallback: number,
      min = 1,
    ): number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= min
        ? value
        : fallback;
    const dbName = options.dbName ?? 'aemeath-offline';
    const key = options.key ?? '__aemeath_offline__';
    this.defaultNamespace = `${dbName}:${key}`;
    this.options = {
      storage: options.storage ?? 'auto',
      ttl: positive(options.ttl, 7 * 24 * 60 * 60 * 1000, 0),
      replayBatchSize: positiveInteger(options.replayBatchSize, 10),
      maxReplayAttempts: positiveInteger(options.maxReplayAttempts, 3),
      replayTimeoutMs: positive(options.replayTimeoutMs, 60000, 1000),
      dbName,
      key,
      namespace: this.defaultNamespace,
      debug: options.debug ?? false,
      maxEntries:
        options.maxEntries == null
          ? undefined
          : positiveInteger(options.maxEntries, 1),
      maxTotalBytes:
        options.maxTotalBytes == null
          ? undefined
          : positive(options.maxTotalBytes, 1),
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
    // 随后 hydrate 又把盘上副本读回补传 → 与 Upload 内存队列叠成重复上报。
    this.hydrated = false;
    this.storageOperational = false;
    this.index.clear();
    this.totalBytes = 0;
    this.inFlight.clear();
    this.pendingPersists = [];
    this.recoveryCacheTransfer = [];
    this.deliveredTombstones.clear();
    this.pendingCoordinatedSuccesses.clear();
    this.preHydrationDeletes.clear();
    this.rejectedPersistSplitIds.clear();
    this.uploadPaused = false;
    this.store = null;
    this.crossTabReservation = null;
    this.crossTabStoreFactory = null;
    this.crossTabCoordinationFactory = null;
    this.crossTabReservationTask = null;
    this.crossTabStoreActive = false;
    this.crossTabCoordination = null;
    this.crossTabWake = null;
    this.crossTabStoreCleared = null;
    this.crossTabStop = null;
    this.chain = Promise.resolve();
    this.ready = null;

    const crossTabCapability = getCrossTabDeliveryCapability(logger);
    this.options.namespace =
      crossTabCapability?.namespace || this.defaultNamespace;

    // 库名同样有确定性默认值。两个实例共用一个库时，A 攒下的离线日志会被
    // B 补传到 B 的上报地址上 —— 和缓存 key 撞车是同一类串台，只是更隐蔽，
    // 因为补传是自动发生的。
    const resources = offlineResourceKeys(this.options);
    const conflictingResource = resources.find((key) =>
      CLAIMED_OFFLINE_RESOURCES.has(key),
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
          'is inactive. Give each instance its own `dbName` and `key` to run both safely, including fallback.',
      );
      return;
    }
    for (const resource of resources) CLAIMED_OFFLINE_RESOURCES.add(resource);
    this.claimedResources = resources;

    // 能力插件必须先安装。资源认领成功后再同步预留恢复权，既不需要给默认路径
    // 额外插入 microtask，也不会在资源冲突的失活实例上接管 Upload cache。
    if (crossTabCapability && logger.platform.type === 'browser') {
      this.beginCrossTabReservation(crossTabCapability);
    }

    this.on('upload:drop', (payload) => this.handleDrop(payload));
    this.on('upload:parked', (payload) => this.handleParked(payload));
    this.on('upload:retry-scheduled', (payload) =>
      this.handleRetryScheduled(payload),
    );
    this.on('upload:paused', (payload) => this.handlePaused(payload));
    this.on('upload:enqueued', (payload) => this.handleEnqueued(payload));
    this.on('upload:success', (payload) => this.handleSuccess(payload));
    this.on('upload:resumed', () => {
      this.uploadPaused = false;
      this.scheduleReplay();
    });

    // Upload 被单独 uninstall→use 时不会走 online / upload:resumed，
    // 盘上 pending 会永久饿死。plugin:install 的载荷是字符串，不能走 this.on。
    const onPluginInstall = (...args: unknown[]): void => {
      if (this.destroyed) return;
      if (args[0] !== 'upload') return;
      this.inFlight.clear();
      this.scheduleReplay();
    };
    this.handlers.push({ event: 'plugin:install', fn: onPluginInstall });
    logger.on('plugin:install', onPluginInstall);

    if (
      typeof window !== 'undefined' &&
      typeof window.addEventListener === 'function'
    ) {
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
    const wasCrossTabReserved = this.crossTabReservation !== null;
    const hadCrossTabController = this.crossTabStop !== null;
    const coordinatorStopped = this.crossTabStop?.() ?? Promise.resolve();
    this.crossTabReservation = null;
    this.crossTabStoreFactory = null;
    this.crossTabCoordinationFactory = null;
    this.crossTabReservationTask = null;
    this.crossTabStoreActive = false;
    this.crossTabCoordination = null;
    this.crossTabWake = null;
    this.crossTabStoreCleared = null;
    this.crossTabStop = null;
    if (this.recoveryCacheTransfer.length > 0) {
      upload?.rollbackRecoveryCacheTransfer();
      this.recoveryCacheTransfer = [];
    }

    // 卸载时可能已有日志在 Upload 真正飞行中。
    // **不要**乐观记 PENDING：结果未知时 remount 的 flushPending 会把唯一副本删掉。
    // 只在晚到的 success 上 note；drop/失败则什么也不做，盘上副本留给下次补传。
    const watchIds = new Set<string>();
    // 显式关闭会无条件清盘，晚到结果已经不再决定磁盘生命周期；此时继续挂监听
    // 反而可能在 purge 完成后写入一个没有对应记录的永久模块级墓碑。
    if (!purgeRequested && resources.length > 0 && upload) {
      for (const logId of this.index.keys()) {
        if (upload.isInFlight(logId)) watchIds.add(logId);
      }
    }

    this.epoch++;
    this.destroyed = true;
    this.clearOverflowReplayTimer();
    this.clearDeferredReplayTimer();
    this.clearStorageRetryTimer(true);
    // 注意：不要清 PENDING_RECORD_DELETES —— 未完成的删盘要留给同 slot 的下一次实例
    for (const resource of this.claimedResources)
      CLAIMED_OFFLINE_RESOURCES.delete(resource);
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

    // Offline 单独卸载而 Upload/logger 还在时：补听晚到的 success/drop
    if (!purgeRequested && host && resources.length > 0 && watchIds.size > 0) {
      const detachLate = (
        fn: (...args: unknown[]) => void,
        event: string,
      ): void => {
        try {
          host.off(event, fn);
        } catch {
          /* ignore */
        }
      };
      const onLateSuccess = (...args: unknown[]): void => {
        const payload = args[0] as
          | {
              log?: { logId?: string };
              source?: string;
            }
          | undefined;
        const logId = payload?.log?.logId;
        if (!logId || !watchIds.has(logId)) return;
        watchIds.delete(logId);
        // 协调成功只能由 records + split-progress 原子事务删除。若 clean stop 已释放
        // receipt，保留记录让下一任按 logId 幂等重投，不能退回普通删除丢失分片证明。
        if (!(
          wasCrossTabReserved && payload?.source === OFFLINE_REPLAY_SOURCE
        )) {
          notePendingRecordDelete(terminalResources, logId);
        }
        if (watchIds.size === 0) {
          detachLate(onLateSuccess, 'upload:success');
          detachLate(onLateDrop, 'upload:drop');
        }
      };
      const onLateDrop = (...args: unknown[]): void => {
        const payload = args[0] as
          { log?: { logId?: string }; reason?: string } | undefined;
        const logId = payload?.log?.logId;
        if (!logId || !watchIds.has(logId)) return;
        watchIds.delete(logId);
        // 终态拒收：盘上副本再补传也只会再被拒，记 PENDING 留给 remount 清掉
        if (
          TERMINAL_UPLOAD_DROP_REASONS.has(payload?.reason as UploadDropReason)
        ) {
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
          // 协调器停不干净不能挡住用户显式请求的清盘；receipt/lease 有硬截止时间。
          await coordinatorStopped.catch((err) =>
            this.debug('cross-tab coordinator stop failed before purge:', err),
          );
          await chain.catch(() => undefined);
          await store.clear();
          clearPendingDeletesForResources(
            backendResourceKeys(this.options, store.backend),
          );
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
      // store 仍在打开时由 initInternal 的失效分支执行 clear；新实例必须等它完成。
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
      const closeStore = (): void => {
        try {
          store?.close();
        } catch (err) {
          this.debug('failed to close store:', err);
        }
      };
      // stop() 被 reject 时也必须关库，否则这条 IDB 连接会把其它标签的
      // 升级/删库永久卡在 blocked。
      if (hadCrossTabController) {
        void coordinatorStopped
          .catch((err) =>
            this.debug('cross-tab coordinator stop failed on uninstall:', err),
          )
          .then(closeStore);
      } else closeStore();
    }
    this.store = null;
    this.pendingPersists = [];
    this.deliveredTombstones.clear();
    this.pendingCoordinatedSuccesses.clear();
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
        state: this.inFlight.has(meta.logId)
          ? ('replaying' as const)
          : ('persisted' as const),
      }),
    );
    const bufferedItems: OfflinePersistenceStatus['items'] =
      this.pendingPersists.map((item) => ({
        logId: item.log.logId,
        capturedAt: item.log.timestamp,
        state: 'buffering' as const,
      }));
    return {
      backend: !this.hydrated
        ? 'initializing'
        : this.storageOperational
          ? (this.store?.backend ?? 'noop')
          : 'noop',
      pending: this.index.size,
      buffered: this.pendingPersists.length,
      bytes: this.totalBytes,
      replaying: this.inFlight.size,
      quotaDrops: this.stats.quotaDrops,
      giveUps: this.stats.giveUps,
      replayed: this.stats.replayed,
      items: [...persistedItems, ...bufferedItems],
    };
  }

  /** 等待初始化与首轮 hydrate 完成（主要供测试使用） */
  async whenReady(): Promise<void> {
    await this.ready;
    await this.chain.catch(() => undefined);
  }

  /**
   * 为显式安装的 CrossTabDeliveryPlugin 预留恢复调度权。
   *
   * 预留动作在第一次 await 前同步完成，因此紧跟 OfflinePersistencePlugin 安装
   * 即可阻止 legacy replay 抢跑。只有 IndexedDB 强事务后端会返回端口；KV/小程序
   * 会立即归还调度权并继续原来的单实例补传。
   */
  reserveCrossTabRecovery(
    capability: CrossTabDeliveryCapability,
  ): Promise<OfflineCrossTabRecoveryPort | null> {
    if (this.destroyed || !this.logger || !this.ready) {
      return Promise.reject(
        new Error('OfflinePersistencePlugin is not installed'),
      );
    }
    if (this.crossTabReservation) {
      if (
        this.crossTabStoreFactory !== capability.createStore ||
        this.crossTabCoordinationFactory !== capability.createCoordination
      ) {
        return Promise.reject(
          new Error('cross-tab recovery is already reserved'),
        );
      }
      if (!this.crossTabReservationTask) {
        this.crossTabReservationTask = this.finishCrossTabReservation(
          this.crossTabReservation,
        );
      }
      return this.crossTabReservationTask;
    }
    this.beginCrossTabReservation(capability);
    const reservation = this.crossTabReservation!;
    this.crossTabReservationTask = this.finishCrossTabReservation(reservation);
    return this.crossTabReservationTask;
  }

  private beginCrossTabReservation(
    capability: CrossTabDeliveryCapability,
  ): void {
    this.crossTabReservation = Symbol('cross-tab-recovery');
    // namespace 必须与预留同点落定：能力插件晚于 Offline 安装时不会再走
    // install 的赋值，丢掉自定义 namespace 会让不同安装顺序的标签页
    // 绑定到不同隔离域上。
    this.options.namespace =
      capability.namespace || this.defaultNamespace;
    this.crossTabStoreFactory = capability.createStore;
    this.crossTabCoordinationFactory = capability.createCoordination;
    const upload = this.getUploadPlugin();
    this.recoveryCacheTransfer = upload
      ? [...upload.beginRecoveryCacheTransfer()]
      : [];
    this.clearOverflowReplayTimer();
    this.clearDeferredReplayTimer();
  }

  private async finishCrossTabReservation(
    reservation: symbol,
  ): Promise<OfflineCrossTabRecoveryPort | null> {
    await this.ready;
    await this.chain.catch(() => undefined);
    if (
      this.destroyed ||
      this.crossTabReservation !== reservation ||
      !this.crossTabStoreActive ||
      !this.store ||
      this.store.backend !== 'indexeddb' ||
      !this.crossTabCoordination
    ) {
      if (this.crossTabReservation === reservation) {
        this.crossTabReservation = null;
        this.crossTabStoreFactory = null;
        this.crossTabCoordinationFactory = null;
        this.crossTabReservationTask = null;
        this.crossTabCoordination = null;
        if (this.recoveryCacheTransfer.length > 0) {
          this.getUploadPlugin()?.rollbackRecoveryCacheTransfer();
          this.recoveryCacheTransfer = [];
        }
        this.scheduleReplay();
      }
      return null;
    }

    const store = this.store;
    const coordination = this.crossTabCoordination;
    let controller: OfflineCrossTabRecoveryController | null = null;
    const assertActive = (): void => {
      if (
        this.destroyed ||
        this.crossTabReservation !== reservation
      ) {
        throw new Error('cross-tab recovery reservation is no longer active');
      }
    };
    return {
      store,
      coordination,
      namespace: this.options.namespace,
      replayBatchSize: this.options.replayBatchSize,
      getCandidateGroups: async () => {
        assertActive();
        return this.getCoordinatedCandidateGroups();
      },
      acceptClaims: async (deliveries) => {
        assertActive();
        await this.handleCoordinatedClaims(deliveries);
      },
      acknowledgeRemoteDelivery: async (logId) => {
        assertActive();
        await this.handleRemoteDelivered(logId);
      },
      connect: (nextController) => {
        assertActive();
        controller = nextController;
        this.crossTabWake = (reason) => nextController.wake(reason);
        this.crossTabStoreCleared = () => nextController.notifyStoreCleared();
        this.crossTabStop = () => nextController.stop();
        nextController.wake('offline-ready');
      },
      disconnect: (currentController) => {
        if (controller !== currentController) return;
        controller = null;
        this.crossTabWake = null;
        this.crossTabStoreCleared = null;
        this.crossTabStop = null;
        this.inFlight.clear();
      },
    };
  }

  /** 清空所有持久副本 */
  async clear(): Promise<void> {
    await this.ready;
    await this.enqueueOp(async () => {
      try {
        await this.clearConfiguredBackends();
      } catch (error) {
        this.storageOperational = false;
        throw error;
      }
      clearPendingDeletesForResources(this.claimedResources);
      this.storageOperational =
        this.store?.backend !== undefined && this.store.backend !== 'noop';
      this.index.clear();
      this.inFlight.clear();
      this.pendingPersists = [];
      this.deliveredTombstones.clear();
      this.preHydrationDeletes.clear();
      this.rejectedPersistSplitIds.clear();
      this.totalBytes = 0;
      this.clearStorageRetryTimer(true);
      this.crossTabStoreCleared?.();
    }, true);
  }

  /** `clear()` 同时覆盖当前后端与可能休眠的 fallback。 */
  private async clearConfiguredBackends(): Promise<void> {
    const active = this.store;
    if (active && active.backend !== 'noop') await active.clear();
    if (this.options.storage === 'localstorage') return;
    const platform = this.logger?.platform;
    if (!platform)
      throw new Error(
        'platform unavailable while clearing offline persistence',
      );

    const targets: Array<'indexeddb' | 'localstorage'> = [
      'indexeddb',
      'localstorage',
    ];
    for (const preference of targets) {
      if (active?.backend === preference) continue;
      if (preference === 'indexeddb') {
        try {
          if (typeof indexedDB === 'undefined' || indexedDB === null) continue;
        } catch {
          continue;
        }
      }
      const dormant =
        this.crossTabStoreActive && this.crossTabStoreFactory
          ? await this.crossTabStoreFactory({
              preference,
              platform,
              dbName: this.options.dbName,
              keyPrefix: this.options.key,
              namespace: this.options.namespace,
              allowFallback: false,
            })
          : await createOfflineStore({
              preference,
              platform,
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

  /** 下一次 uninstall 是用户显式关闭持久化：立即停止接收，并异步清除全部旧副本。 */
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
    const epoch = this.epoch;
    try {
      await this.initInternal(epoch);
    } catch (err) {
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
        this.finalizeRecoveryCacheTransfer(true);
        this.warnStorageUnavailable();
        try {
          this.logger?.emit('upload:offline-unavailable', {
            reason: 'initialization-failed',
          });
        } catch (emitErr) {
          this.debug(
            'failed to report offline initialization failure:',
            emitErr,
          );
        }
      }
    } finally {
      if (this.isEpoch(epoch)) {
        this.hydrated = true;
        this.preHydrationDeletes.clear();
        if (!this.storageOperational) this.finalizeRecoveryCacheTransfer(true);
        this.notifyDeliveryStatus();
      }
    }
  }

  private async initInternal(epoch: number): Promise<void> {
    const logger = this.logger;
    if (!logger || !this.isEpoch(epoch)) return;

    const purges = pendingResourcePurges(this.claimedResources);
    if (purges.length > 0) {
      await Promise.all(purges);
      if (!this.isEpoch(epoch)) return;
    }

    const crossTabFactory = this.crossTabReservation
      ? this.crossTabStoreFactory
      : null;
    const coordinationFactory = this.crossTabReservation
      ? this.crossTabCoordinationFactory
      : null;
    const onFallback = (from: string, reason: unknown): void =>
      this.debug(
        `storage backend "${from}" unavailable, falling back:`,
        reason,
      );
    const store = crossTabFactory
      ? await crossTabFactory({
          preference: this.options.storage,
          platform: logger.platform,
          dbName: this.options.dbName,
          keyPrefix: this.options.key,
          namespace: this.options.namespace,
          onFallback,
        })
      : await createOfflineStore({
          preference: this.options.storage,
          platform: logger.platform,
          dbName: this.options.dbName,
          keyPrefix: this.options.key,
          onFallback,
        });

    // 打开数据库期间插件可能已经被卸载 / remount。直接挂上去等于复活一个没人会关闭的连接
    if (!this.isEpoch(epoch)) {
      if (this.purgeEpochs.has(epoch)) {
        try {
          await store.clear();
          clearPendingDeletesForResources(
            backendResourceKeys(this.options, store.backend),
          );
        } catch (error) {
          store.close();
          throw error;
        }
      }
      store.close();
      return;
    }
    this.store = store;
    // v2 协议依赖 IDB 的事务隔离。工厂降级到 2.5 KV/noop 时必须彻底回到
    // legacy 路径，不能只因“尝试过协调工厂”就要求 putMany 或跳过 TTL。
    this.crossTabStoreActive =
      crossTabFactory !== null && store.backend === 'indexeddb';
    if (this.crossTabStoreActive) {
      if (!coordinationFactory) {
        throw new Error('cross-tab coordination factory is unavailable');
      }
      // 从这一刻起，records 的任何并发相关写入都只能经过该事务门面。
      // 控制器可以卸载/重装，但数据协议在本次 Offline 生命周期内不会降回
      // legacy replay，避免两个所有者同时消费同一 v2 数据库。
      this.crossTabCoordination = coordinationFactory(store);
    }

    if (this.store.backend === 'noop') {
      // 也算"定论"：不置位的话墓碑集合会随每次上传成功无限增长
      this.hydrated = true;
      this.storageOperational = false;
      this.preHydrationDeletes.clear();
      this.pendingPersists = [];
      this.warnStorageUnavailable();
      try {
        logger.emit('upload:offline-unavailable', {
          reason: 'no-storage-backend',
        });
      } catch (err) {
        this.debug('failed to report unavailable storage:', err);
      }
      return;
    }

    try {
      await this.reconcileFallbackStore(this.store, logger.platform, epoch);
    } catch (err) {
      this.debug('fallback reconciliation failed:', err);
      this.storageOperational = false;
      this.pendingPersists = [];
      for (const logId of this.preHydrationDeletes) {
        if (!this.isEpoch(epoch)) return;
        await this.safeDelete(logId);
      }
      this.warnStorageUnavailable();
      try {
        logger.emit('upload:offline-unavailable', {
          reason: 'reconciliation-failed',
        });
      } catch (emitErr) {
        this.debug('failed to report reconciliation failure:', emitErr);
      }
      return;
    }
    if (!this.isEpoch(epoch)) return;

    const isKv = this.store.backend === 'localstorage';
    this.maxEntries =
      this.options.maxEntries ??
      (isKv ? KV_DEFAULT_MAX_ENTRIES : IDB_DEFAULT_MAX_ENTRIES);
    this.maxTotalBytes =
      this.options.maxTotalBytes ??
      (isKv ? KV_DEFAULT_MAX_BYTES : IDB_DEFAULT_MAX_BYTES);

    if (!this.isEpoch(epoch)) {
      store.close();
      if (this.store === store) this.store = null;
      return;
    }

    // 上一次实例 uninstall 时未完成的删盘：先清掉，再 hydrate
    await this.enqueueOp(async () => {
      if (!this.isEpoch(epoch)) return;
      await this.flushPendingRecordDeletes();
    });

    await this.enqueueOp(async () => {
      if (!this.isEpoch(epoch)) return;
      // hydrated 必须在**所有**出口置位，包括读盘失败这条。
      try {
        let metas: OfflineRecordMeta[] = [];
        try {
          metas = await this.store!.loadMeta();
        } catch (err) {
          this.debug('loadMeta failed:', err);
          for (const logId of this.preHydrationDeletes) {
            if (!this.isEpoch(epoch)) return;
            await this.safeDelete(logId);
          }
          this.storageOperational = false;
          this.pendingPersists = [];
          this.warnStorageUnavailable();
          try {
            logger.emit('upload:offline-unavailable', {
              reason: 'hydration-failed',
            });
          } catch (emitErr) {
            this.debug('failed to report hydration failure:', emitErr);
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
            if (meta && typeof meta.logId === 'string')
              await this.safeDelete(meta.logId);
            continue;
          }
          // 删除失败后写回到记录里的持久墓碑。它能跨真正的页面/进程重启，
          // 与下面模块级快速墓碑共同保证终态记录永不重新补传。
          if (meta.terminal === true) {
            await this.safeDelete(meta.logId);
            continue;
          }
          if (
            !this.crossTabStoreActive &&
            (meta.storedAt > now + 5 * 60 * 1000 ||
              now - meta.storedAt >= this.options.ttl)
          ) {
            // hydrate 时 index 尚未建完，不能走 deleteSplitGroup（找不到兄弟）。
            // 同组其它片会在本循环里各自过期删掉。
            await this.safeDelete(meta.logId);
            continue;
          }
          // 这条在索引建好之前就已经传成功了，读回来只会导致重复上报
          if (
            this.preHydrationDeletes.has(meta.logId) ||
            hasPendingRecordDelete(this.claimedResources, meta.logId)
          ) {
            this.index.set(meta.logId, meta);
            this.totalBytes += meta.bytes;
            await this.safeDelete(meta.logId);
            continue;
          }
          meta.priority = Number.isFinite(meta.priority) ? meta.priority : 0;
          meta.replayAttempts = Number.isFinite(meta.replayAttempts)
            ? Math.max(0, Math.floor(meta.replayAttempts))
            : 0;
          // 新记录把 splitId 冗余进 meta，避免每轮 replay 为分组读取全部正文。
          // 旧 KV 索引没有这个字段，只在 hydrate 时补读一次。
          if (
            meta.splitId !== null &&
            (typeof meta.splitId !== 'string' ||
              this.store!.backend === 'localstorage')
          ) {
            const legacyRecord = await this.safeGet(meta.logId);
            const canonicalSplitId = legacyRecord
              ? (getSplitId(legacyRecord.log) ?? null)
              : null;
            if (legacyRecord && legacyRecord.splitId !== canonicalSplitId) {
              // 旧 KV 索引曾把裸业务 splitId 写进分组字段；在 hydrate 边界一次性
              // 规范化正文和索引，后续生命周期就不会再把普通日志误绑成原子组。
              await this.writePendingRecords([{
                ...legacyRecord,
                splitId: canonicalSplitId,
              }]);
            }
            meta.splitId = canonicalSplitId;
          }
          meta.notBefore = Number.isFinite(meta.notBefore)
            ? meta.notBefore
            : undefined;
          meta.serverNotBefore = Number.isFinite(meta.serverNotBefore)
            ? meta.serverNotBefore
            : undefined;
          meta.parkCount = Number.isFinite(meta.parkCount)
            ? meta.parkCount
            : undefined;
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
          logger.emit('upload:offline-unavailable', {
            reason: 'hydration-failed',
          });
        } catch (emitErr) {
          this.debug('failed to report hydration failure:', emitErr);
        }
      } finally {
        if (this.isEpoch(epoch)) {
          // hydrated 先落定；墓碑留给下面的 pendingPersists flush 过滤已送达项
          this.hydrated = true;
        }
      }
    });

    if (!this.isEpoch(epoch)) return;

    // store 打开前缓冲的落盘请求：排在 hydrate 之后写盘，避免与索引重建交错。
    await this.enqueueOp(async () => {
      if (!this.isEpoch(epoch)) {
        this.pendingPersists = [];
        return;
      }
      this.stageRecoveryCacheTransfer();
      await this.drainPendingPersists(epoch);
      this.finalizeRecoveryCacheTransfer(false);
    });

    if (!this.isEpoch(epoch)) return;

    // Upload 可能在 Offline 挂上监听器之前就已 paused：补齐那次快照里的队列
    this.catchUpPausedQueue();

    this.scheduleReplay();
  }

  /** 把历史 KV fallback 与恢复后的 IndexedDB 收敛成一个权威后端。 */
  private async reconcileFallbackStore(
    primary: OfflineStore,
    platform: AemeathInterface['platform'],
    epoch: number,
  ): Promise<void> {
    if (
      primary.backend !== 'indexeddb' ||
      this.options.storage === 'localstorage'
    )
      return;

    let fallback: OfflineStore;
    try {
      fallback =
        this.crossTabStoreActive && this.crossTabStoreFactory
          ? await this.crossTabStoreFactory({
              preference: 'localstorage',
              platform,
              dbName: this.options.dbName,
              keyPrefix: this.options.key,
              namespace: this.options.namespace,
              allowFallback: false,
            })
          : await createOfflineStore({
              preference: 'localstorage',
              platform,
              dbName: this.options.dbName,
              keyPrefix: this.options.key,
              allowFallback: false,
            });
    } catch {
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
    const maxOptional = (
      a: number | undefined,
      b: number | undefined,
    ): number | undefined => {
      const values = [a, b].filter((value): value is number =>
        Number.isFinite(value),
      );
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
        const terminal =
          secondary.terminal === true ||
          current?.terminal === true ||
          hasPendingRecordDelete(resources, meta.logId);
        if (terminal) {
          if (this.crossTabCoordination) {
            const removed =
              await this.crossTabCoordination.deleteUnleasedGroup(
                this.options.namespace,
                [meta.logId],
                Date.now(),
              );
            if (removed.length > 0) {
              await fallback.delete(meta.logId);
              clearPendingRecordDelete(resources, meta.logId);
            }
          } else {
            await primary.delete(meta.logId);
            await fallback.delete(meta.logId);
            clearPendingRecordDelete(resources, meta.logId);
          }
          continue;
        }

        let migrated = secondary;
        if (current) {
          if (
            current.capturedAt !== secondary.capturedAt ||
            (current.splitId ?? null) !== (secondary.splitId ?? null) ||
            JSON.stringify(current.log) !== JSON.stringify(secondary.log)
          ) {
            throw new Error(`offline backend identity conflict: ${meta.logId}`);
          }
          migrated = {
            ...current,
            storedAt: Math.min(current.storedAt, secondary.storedAt),
            priority: Math.max(current.priority, secondary.priority),
            replayAttempts: Math.max(
              current.replayAttempts,
              secondary.replayAttempts,
            ),
            notBefore: maxOptional(current.notBefore, secondary.notBefore),
            serverNotBefore: maxOptional(
              current.serverNotBefore,
              secondary.serverNotBefore,
            ),
            parkCount: maxOptional(current.parkCount, secondary.parkCount),
            lastRetryReason:
              secondary.lastRetryReason ?? current.lastRetryReason,
          };
        }
        if (this.crossTabCoordination) {
          // KV 没有跨标签事务。v2 启用后只把它当作可重复读取的迁移源：
          // 在 v2 事务中合并，但不做“先读后删”的破坏性搬运。旧版本标签仍可能
          // 正在更新该 key，保留源副本比制造静默丢失更安全。
          await this.crossTabCoordination.mergePendingRecords([migrated]);
        } else {
          await primary.put(migrated);
          await fallback.delete(meta.logId);
        }
      }
    } finally {
      fallback.close();
    }
  }

  // ==================== 事件处理 ====================

  private on(
    event: string,
    handler: (payload: Record<string, unknown>) => void,
  ): void {
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

    // Upload 队列镜像过期只说明那份 1h cache 不再有效，不能删除 OfflinePlugin
    // 自己仍在 7d TTL 内的可靠副本。Offline 自己的 TTL 清理由 replay/hydrate 完成。
    if (reason === 'cache-expired' && payload['source'] === 'upload-cache')
      return;

    // 补传出来的条目又被丢弃 → 计入失败次数，不再当作新日志重新落盘
    if (payload['source'] === OFFLINE_REPLAY_SOURCE) {
      // 但队列溢出不算"补传失败"：那是本地内存队列被别的日志挤爆了，
      // 这条根本没上过网。照算的话，补传预算会被本地拥挤白白耗光，
      // 日志明明还在盘上却被判了死刑（实测被挤掉四次后直接放弃）。
      if (reason === 'queue-overflow') {
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
      this.pendingPersists = this.pendingPersists.filter(
        (item) => item.log.logId !== logId,
      );
      notePendingRecordDelete(this.deletionResourceKeys(), logId);
      if (!this.hydrated) this.preHydrationDeletes.add(logId);
      this.enqueueOp(async () => {
        try {
          // hydrate 尚未完成或 loadMeta 失败时，磁盘可能有记录而内存索引为空。
          // safeDelete 会保留跨 remount 的删除意图，不能以 index.has 为前置条件。
          await this.safeDelete(logId);
        } finally {
          this.deliveredTombstones.delete(logId);
        }
      });
      return;
    }
    this.enqueueOp(() =>
      this.persist(log, payload['priority'] as number | undefined),
    );
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
    // 补传项仍由 UploadPlugin 的 parked 区持有，磁盘副本保持不动；只清掉本插件
    // 的 replay inFlight 账，不能把一次热预算耗尽算成生命周期失败；但新的
    // parkedUntil 必须覆盖旧期限，否则下一次页面重开会提前补传。
    if (payload['source'] === OFFLINE_REPLAY_SOURCE) {
      this.inFlight.delete(log.logId);
      if (this.crossTabReservation) {
        const meta = this.index.get(log.logId);
        if (meta) {
          meta.state = 'parked';
          meta.nextEligibleAt = state.notBefore;
          meta.notBefore = state.notBefore;
          meta.serverNotBefore = state.serverNotBefore;
          meta.parkCount = state.parkCount;
          meta.lastRetryReason = state.lastRetryReason;
        }
        this.scheduleReplay();
        return;
      }
      this.enqueueOp(() =>
        this.persist(log, payload['priority'] as number | undefined, state),
      );
      return;
    }
    this.enqueueOp(() =>
      this.persist(log, payload['priority'] as number | undefined, state),
    );
  }

  /** 热重试也要落下服务端 Retry-After；cache 被关闭/不可用时仍能跨页面守约。 */
  private handleRetryScheduled(payload: Record<string, unknown>): void {
    const log = payload['log'] as LogEntry | undefined;
    if (!log) return;
    if (
      payload['source'] === OFFLINE_REPLAY_SOURCE &&
      !this.index.has(log.logId)
    )
      return;
    if (
      payload['source'] === OFFLINE_REPLAY_SOURCE &&
      this.crossTabReservation
    ) {
      const meta = this.index.get(log.logId);
      if (meta) {
        meta.nextEligibleAt = payload['nextAttemptAt'] as number | undefined;
        meta.notBefore = payload['nextAttemptAt'] as number | undefined;
        meta.serverNotBefore = payload['serverNotBefore'] as number | undefined;
        meta.lastRetryReason = payload['reason'] as string | undefined;
      }
      return;
    }
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
    this.uploadPaused = true;
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
    this.enqueueOp(() =>
      this.persist(log, payload['priority'] as number | undefined),
    );
  }

  private handleSuccess(payload: Record<string, unknown>): void {
    const log = payload['log'] as LogEntry | undefined;
    if (!log) return;
    const logId = log.logId;
    if (payload['source'] === OFFLINE_REPLAY_SOURCE) {
      this.stats.replayed++;
    }
    if (
      payload['source'] === OFFLINE_REPLAY_SOURCE &&
      this.crossTabReservation
    ) {
      // 成功证明由 DeliveryReceipt 在 records + split-progress 的同一事务中提交。
      // 即使该事务短暂失败也只能重试证明提交，绝不能退回普通 delete 丢掉分片证据。
      this.inFlight.delete(logId);
      this.scheduleReplay();
      return;
    }
    if (this.hydrated && this.storageOperational && this.crossTabCoordination) {
      this.deliveredTombstones.add(logId);
      this.inFlight.delete(logId);
      this.pendingPersists = this.pendingPersists.filter(
        (p) => p.log.logId !== logId,
      );
      this.pendingCoordinatedSuccesses.add(logId);
      this.enqueueOp(() => this.commitCoordinatedSuccess(logId));
      return;
    }
    // 必须在 enqueueOp 之外完成，否则已排队的 replay / 稍后的 pending flush
    // 仍会把已送达日志再写盘、再补传。
    this.deliveredTombstones.add(logId);
    this.inFlight.delete(logId);
    this.pendingPersists = this.pendingPersists.filter(
      (p) => p.log.logId !== logId,
    );
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
        // hydrated 但对不了账（如 loadMeta 失败）：直接尝试删盘
        await this.safeDelete(logId);
      } finally {
        this.deliveredTombstones.delete(logId);
      }
    });
    // 上一批消化完了就继续下一批
    this.scheduleReplay();
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
      const oldest = this.rejectedPersistSplitIds.keys().next().value as
        string | undefined;
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
    const rejectedReason =
      splitId === undefined
        ? undefined
        : this.getRejectedPersistReason(splitId);
    if (rejectedReason) {
      if (rejectedReason === 'storage-quota') this.stats.quotaDrops++;
      this.reportDrop(log, rejectedReason);
      return;
    }
    const index = this.pendingPersists.findIndex(
      (item) => item.log.logId === log.logId,
    );
    // 退避缓冲不能成为绕过持久层配额的第二个无界队列。允许至多一份当前
    // 持久索引量 + 一份新写预算；超过时拒绝新原子单元，保留更早的写意图。
    const bytes = jsonBytes(log);
    const entryLimit = Math.max(1, this.index.size + this.maxEntries);
    const byteLimit = Math.max(1, this.totalBytes + this.maxTotalBytes);
    const pendingBytes = this.pendingPersists.reduce((total, item) => {
      const size = jsonBytes(item.log);
      return Number.isFinite(size) ? total + size : Number.POSITIVE_INFINITY;
    }, 0);
    const previousBytes =
      index === -1 ? 0 : jsonBytes(this.pendingPersists[index]!.log);
    const projectedBytes =
      pendingBytes -
      (Number.isFinite(previousBytes) ? previousBytes : 0) +
      bytes;
    const reason: 'storage-quota' | 'storage-rejected' | undefined =
      !Number.isFinite(bytes)
        ? 'storage-rejected'
        : this.pendingPersists.length + (index === -1 ? 1 : 0) > entryLimit ||
            projectedBytes > byteLimit
          ? 'storage-quota'
          : undefined;
    if (reason) {
      const rejected =
        splitId === undefined
          ? []
          : this.pendingPersists.filter(
              (item) => getSplitId(item.log) === splitId,
            );
      if (splitId !== undefined) {
        this.pendingPersists = this.pendingPersists.filter(
          (item) => getSplitId(item.log) !== splitId,
        );
        this.rememberRejectedPersistSplit(splitId, reason);
      }
      const victims = [...rejected, { log, priority, state }].filter(
        (item, offset, all) =>
          all.findIndex(
            (candidate) => candidate.log.logId === item.log.logId,
          ) === offset,
      );
      for (const victim of victims) {
        if (reason === 'storage-quota') this.stats.quotaDrops++;
        this.reportDrop(victim.log, reason);
      }
      return;
    }
    if (index === -1) {
      this.pendingPersists.push({ log, priority, state, bufferedAt: Date.now() });
    } else {
      const previous = this.pendingPersists[index]!;
      this.pendingPersists[index] = {
        log,
        priority: priority ?? previous.priority,
        state: mergePersistStateUpdate(previous.state, state),
        bufferedAt: previous.bufferedAt,
      };
    }
  }

  /**
   * 清理超过宽限期仍不完整的缓冲 split 组（仅协调模式的新分片缓冲路径）。
   * 完整组不受影响：它们要么已被 flush，要么正在等存储退避重试。
   */
  private purgeStaleSplitBuffers(now = Date.now()): void {
    if (!this.hydrated || !this.crossTabStoreActive) return;
    const groups = new Map<
      string,
      { members: BufferedPersist[]; oldest: number }
    >();
    for (const item of this.pendingPersists) {
      const splitId = getSplitId(item.log);
      if (splitId === undefined) continue;
      const bufferedAt = item.bufferedAt ?? now;
      const group = groups.get(splitId);
      if (group) {
        group.members.push(item);
        group.oldest = Math.min(group.oldest, bufferedAt);
      } else {
        groups.set(splitId, { members: [item], oldest: bufferedAt });
      }
    }
    for (const [splitId, group] of groups) {
      if (now - group.oldest < SPLIT_BUFFER_GRACE_MS) continue;
      const totals = new Set(
        group.members.map((item) => Number(item.log.tags?.splitTotal)),
      );
      const expectedTotal = totals.size === 1 ? [...totals][0]! : Number.NaN;
      // 完整（或即将由 flush 判定 malformed）的组交给既有路径处理
      if (
        Number.isSafeInteger(expectedTotal) &&
        group.members.length >= expectedTotal
      ) {
        continue;
      }
      this.pendingPersists = this.pendingPersists.filter(
        (item) => getSplitId(item.log) !== splitId,
      );
      this.rememberRejectedPersistSplit(splitId, 'storage-rejected');
      for (const member of group.members) {
        this.reportDrop(member.log, 'storage-rejected');
      }
    }
  }

  private deferPersistAfterStorageError(
    log: LogEntry,
    priority: number | undefined,
    state: PersistStateUpdate | undefined,
    error: unknown,
  ): void {
    if (this.destroyed) return;
    this.debug(
      'transient offline persistence failure; retrying with backoff:',
      error,
    );
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
    if (!this.hydrated) {
      this.bufferPersist(log, priority, state);
      return;
    }
    if (!this.storageOperational) return;
    const splitId = getSplitId(log);
    const rejectedReason =
      splitId === undefined
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
    if (
      this.crossTabStoreActive &&
      splitId !== undefined &&
      !this.index.has(log.logId)
    ) {
      // Coordinated recovery may observe this database from another tab at any
      // transaction boundary.  Buffer a fresh split until every coordinate is
      // present, then expose the whole logical log in one store transaction.
      this.bufferPersist(log, priority, state);
      await this.flushCompleteSplitPersist(splitId, epoch);
      return;
    }
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
      const merged = mergePersistStateUpdate(
        {
          notBefore: existing.notBefore,
          serverNotBefore: existing.serverNotBefore,
          parkCount: existing.parkCount,
          replayAttempts: existing.replayAttempts,
          lastRetryReason: existing.lastRetryReason,
        },
        state,
      )!;
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
        const [committed] = await this.writePendingRecords([existing]);
        if (!committed) return;
        const meta = this.index.get(log.logId);
        if (meta) {
          meta.notBefore = committed.notBefore;
          meta.serverNotBefore = committed.serverNotBefore;
          meta.parkCount = committed.parkCount;
          meta.replayAttempts = committed.replayAttempts;
          meta.lastRetryReason = committed.lastRetryReason;
        }
      } catch (err) {
        this.deferPersistAfterStorageError(log, priority, state, err);
      }
      return;
    }

    const bytes = jsonBytes(log);
    if (!Number.isFinite(bytes)) {
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
      notBefore: Number.isFinite(state?.notBefore)
        ? state?.notBefore
        : undefined,
      serverNotBefore: Number.isFinite(state?.serverNotBefore)
        ? state?.serverNotBefore
        : undefined,
      parkCount: Number.isFinite(state?.parkCount)
        ? Math.max(0, Math.floor(state!.parkCount!))
        : undefined,
      lastRetryReason: state?.lastRetryReason,
      log,
    };

    // 单条自身已经超过上限时，淘汰完其它健康日志也不可能让它合规。
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
      const [committed] = await this.writePendingRecords([record]);
      if (committed) Object.assign(record, committed);
    } catch (err) {
      if (!this.isEpoch(epoch)) return;
      if (!isQuotaError(err)) {
        if (isPermanentRecordError(err)) {
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
        const [committed] = await this.writePendingRecords([record]);
        if (committed) Object.assign(record, committed);
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
    this.setIndexedRecord(record);
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
    this.crossTabWake?.('persisted');
  }

  private async flushCompleteSplitPersist(
    splitId: string,
    epoch: number,
  ): Promise<void> {
    if (!this.isEpoch(epoch) || !this.store) return;
    this.purgeStaleSplitBuffers();
    const members = this.pendingPersists.filter(
      (item) => getSplitId(item.log) === splitId,
    );
    if (members.length === 0) return;
    const totals = new Set(
      members.map((item) => Number(item.log.tags?.splitTotal)),
    );
    const indices = members.map((item) => Number(item.log.tags?.splitIndex));
    const expectedTotal = totals.size === 1 ? [...totals][0]! : Number.NaN;
    const malformed =
      !Number.isSafeInteger(expectedTotal) ||
      expectedTotal <= 0 ||
      indices.some(
        (index) =>
          !Number.isSafeInteger(index) || index < 1 || index > expectedTotal,
      ) ||
      new Set(indices).size !== indices.length ||
      new Set(members.map((item) => item.log.logId)).size !== members.length;
    if (malformed) {
      this.pendingPersists = this.pendingPersists.filter(
        (item) => getSplitId(item.log) !== splitId,
      );
      this.rememberRejectedPersistSplit(splitId, 'storage-rejected');
      for (const member of members)
        this.reportDrop(member.log, 'storage-rejected');
      return;
    }
    if (members.length < expectedTotal) return;
    if (members.length !== expectedTotal) {
      this.pendingPersists = this.pendingPersists.filter(
        (item) => getSplitId(item.log) !== splitId,
      );
      this.rememberRejectedPersistSplit(splitId, 'storage-rejected');
      for (const member of members)
        this.reportDrop(member.log, 'storage-rejected');
      return;
    }

    const ordered = [...members].sort(
      (a, b) => Number(a.log.tags?.splitIndex) - Number(b.log.tags?.splitIndex),
    );
    this.pendingPersists = this.pendingPersists.filter(
      (item) => getSplitId(item.log) !== splitId,
    );
    await this.persistAtomicSplitGroup(ordered, splitId, epoch);
  }

  private async persistAtomicSplitGroup(
    members: readonly {
      log: LogEntry;
      priority?: number;
      state?: PersistStateUpdate;
    }[],
    splitId: string,
    epoch: number,
  ): Promise<void> {
    if (!this.isEpoch(epoch) || !this.store || this.store.backend === 'noop')
      return;
    const storedAt = Date.now();
    const records: OfflineRecord[] = [];
    let totalBytes = 0;
    for (const member of members) {
      const bytes = jsonBytes(member.log);
      if (!Number.isFinite(bytes)) {
        this.rememberRejectedPersistSplit(splitId, 'storage-rejected');
        for (const item of members)
          this.reportDrop(item.log, 'storage-rejected');
        return;
      }
      totalBytes += bytes;
      records.push({
        logId: member.log.logId,
        storedAt,
        capturedAt: member.log.timestamp,
        priority: member.priority ?? 0,
        bytes,
        replayAttempts: Number.isFinite(member.state?.replayAttempts)
          ? Math.max(0, Math.floor(member.state!.replayAttempts!))
          : 0,
        splitId,
        notBefore: Number.isFinite(member.state?.notBefore)
          ? member.state?.notBefore
          : undefined,
        serverNotBefore: Number.isFinite(member.state?.serverNotBefore)
          ? member.state?.serverNotBefore
          : undefined,
        parkCount: Number.isFinite(member.state?.parkCount)
          ? Math.max(0, Math.floor(member.state!.parkCount!))
          : undefined,
        lastRetryReason: member.state?.lastRetryReason,
        log: member.log,
      });
    }
    const rejectGroup = (
      reason: 'storage-quota' | 'storage-rejected',
    ): void => {
      this.rememberRejectedPersistSplit(splitId, reason);
      for (const member of members) {
        if (reason === 'storage-quota') this.stats.quotaDrops++;
        this.reportDrop(member.log, reason);
      }
    };
    if (records.length > this.maxEntries || totalBytes > this.maxTotalBytes) {
      rejectGroup('storage-quota');
      return;
    }
    let hasRoom: boolean;
    try {
      hasRoom = await this.makeRoomFor(
        totalBytes,
        epoch,
        splitId,
        records.length,
      );
    } catch (error) {
      for (const member of members) {
        this.bufferPersist(member.log, member.priority, member.state);
      }
      this.armStorageRetryWake();
      this.debug(
        'transient split persistence failure; retrying with backoff:',
        error,
      );
      return;
    }
    if (!hasRoom || !this.isEpoch(epoch) || !this.store) {
      if (this.isEpoch(epoch)) rejectGroup('storage-quota');
      return;
    }
    const commit = () => this.writePendingRecords(records);
    let committedRecords = records;
    try {
      committedRecords = await commit();
    } catch (error) {
      if (!this.isEpoch(epoch)) return;
      if (isQuotaError(error)) {
        const evicted = await this.evictOldest(
          Math.max(records.length, Math.ceil(this.index.size * 0.2)),
          epoch,
          splitId,
        );
        if (evicted > 0 && this.isEpoch(epoch)) {
          try {
            committedRecords = await commit();
          } catch (retryError) {
            if (isQuotaError(retryError)) rejectGroup('storage-quota');
            else if (isPermanentRecordError(retryError))
              rejectGroup('storage-rejected');
            else {
              for (const member of members) {
                this.bufferPersist(member.log, member.priority, member.state);
              }
              this.armStorageRetryWake();
            }
          }
        } else {
          rejectGroup('storage-quota');
        }
        return;
      }
      if (isPermanentRecordError(error)) {
        rejectGroup('storage-rejected');
        return;
      }
      for (const member of members) {
        this.bufferPersist(member.log, member.priority, member.state);
      }
      this.armStorageRetryWake();
      return;
    }
    if (!this.isEpoch(epoch)) return;
    const backend = this.store.backend;
    for (const record of committedRecords) this.setIndexedRecord(record);
    // Publish observability only after the entire in-memory index mirrors the
    // already-committed transaction. A synchronous listener must never observe
    // half of a split group.
    for (const record of records) {
      try {
        this.logger?.emit('delivery:persisted', {
          logId: record.logId,
          capturedAt: record.capturedAt,
          bytes: record.bytes,
          backend,
        });
      } catch (error) {
        this.debug('delivery:persisted listener failed:', error);
      }
    }
    this.crossTabWake?.('persisted-split');
  }

  /** 为新记录腾出条数与字节配额 */
  private async makeRoomFor(
    bytes: number,
    epoch: number,
    protectedSplitId?: string,
    entries = 1,
  ): Promise<boolean> {
    while (
      this.isEpoch(epoch) &&
      this.index.size > 0 &&
      (this.index.size + entries > this.maxEntries ||
        this.totalBytes + bytes > this.maxTotalBytes)
    ) {
      const evicted = await this.evictOldest(1, epoch, protectedSplitId);
      if (evicted === 0) break;
    }
    return (
      this.index.size + entries <= this.maxEntries &&
      this.totalBytes + bytes <= this.maxTotalBytes
    );
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
    const candidates = Array.from(this.index.values()).sort(
      (a, b) => a.storedAt - b.storedAt,
    );
    let evicted = 0;
    const visitedGroups = new Set<string>();
    for (const meta of candidates) {
      if (evicted >= count) break;
      if (!this.isEpoch(epoch)) return evicted;
      if (!this.index.has(meta.logId)) continue;
      const groupKey =
        meta.splitId == null ? `log:${meta.logId}` : `split:${meta.splitId}`;
      if (visitedGroups.has(groupKey)) continue;
      visitedGroups.add(groupKey);
      if (
        protectedSplitId !== undefined &&
        meta.splitId === protectedSplitId
      ) {
        continue;
      }
      const n = await this.deleteSplitGroup(meta.logId, 'storage-quota');
      // 候选扫描与删除事务之间可能被另一标签领取。此时 n=0，继续找下一组，
      // 既不删除活跃请求的唯一副本，也不虚报 quota drop。
      this.stats.quotaDrops += n;
      evicted += n;
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
        this.debug(
          'split rejection could not read sibling body; deleting by indexed id:',
          error,
        );
      }
    }
    let removed = 0;
    if (this.crossTabCoordination && siblingIds.length > 0) {
      const deleted = await this.crossTabCoordination.deleteUnleasedGroup(
        this.options.namespace,
        siblingIds,
        Date.now(),
      );
      for (const record of deleted) {
        this.removeFromIndex(record.logId);
        this.reportDrop(record.log, reason);
      }
      removed = deleted.length;
    } else {
      for (const logId of siblingIds) {
        if (!this.isEpoch(epoch)) return;
        await this.safeDelete(logId);
      }
      for (const record of siblingRecords) this.reportDrop(record.log, reason);
      removed = siblingIds.length;
    }
    if (reason === 'storage-quota') this.stats.quotaDrops += removed + 1;
    if (this.isEpoch(epoch)) this.reportDrop(log, reason);
  }

  /**
   * 按 splitId 整组删除：配额淘汰 / TTL 过期不能只撕一片，否则后端收残组。
   * @returns 实际删除条数
   */
  private async deleteSplitGroup(
    logId: string,
    reason: UploadDropReason,
  ): Promise<number> {
    const indexedMeta = this.index.get(logId);
    const primary = await this.safeGet(logId);
    const splitId = indexedMeta
      ? (indexedMeta.splitId ?? undefined)
      : primary
        ? getSplitId(primary.log)
        : undefined;
    // hydrate 后 meta.splitId 是分组的权威索引。正文可能被另一个 Tab 删除；
    // 它只影响 drop 事件能否携带原日志，绝不能改变本次需要清理的成员集合。
    const memberIds =
      splitId === undefined
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
    if (this.crossTabCoordination) {
      const removed = await this.crossTabCoordination.deleteUnleasedGroup(
        this.options.namespace,
        memberIds,
        Date.now(),
      );
      if (removed.length === 0) return 0;
      for (const record of removed) {
        clearPendingRecordDelete(this.deletionResourceKeys(), record.logId);
        this.removeFromIndex(record.logId);
        this.reportDrop(record.log, reason);
      }
      return removed.length;
    }
    for (const id of memberIds) await this.safeDelete(id);
    for (const record of records) this.reportDrop(record.log, reason);
    return memberIds.length;
  }

  /**
   * Offline 监听器挂上之前 Upload 可能已发过 `upload:paused`。
   * store ready 后若队列仍处于暂停，把当前队列镜像落盘补齐。
   */
  private catchUpPausedQueue(): void {
    if (this.destroyed) return;
    const upload = this.getUploadPlugin();
    if (!upload?.getQueueStatus().paused) return;
    for (const item of upload.peekQueuedForPersist()) {
      this.enqueueOp(() => this.persist(item.log, item.priority));
    }
  }

  // ==================== 补传 ====================

  /** 每次协调唤醒都重新读取事实源；Broadcast 只负责提示，绝不携带所有权状态。 */
  private async getCoordinatedCandidateGroups(): Promise<
    readonly (readonly string[])[]
  > {
    const store = this.store;
    const coordination = this.crossTabCoordination;
    const upload = this.getUploadPlugin();
    const epoch = this.epoch;
    if (
      !store ||
      !coordination ||
      !upload ||
      this.uploadPaused ||
      !this.isEpoch(epoch) ||
      !this.storageOperational
    ) {
      return [];
    }

    // 让本标签已经排队的 put/delete 先落定，再用跨标签共享存储重建候选快照。
    await this.chain.catch(() => undefined);
    if (!this.isEpoch(epoch)) return [];
    const metas = await store.loadMeta();
    if (!this.isEpoch(epoch)) return [];
    const refreshed = new Map<string, RuntimeOfflineRecordMeta>();
    let refreshedBytes = 0;
    for (const meta of metas) {
      if (
        !meta ||
        typeof meta.logId !== 'string' ||
        !Number.isFinite(meta.bytes)
      )
        continue;
      refreshed.set(meta.logId, meta);
      refreshedBytes += Math.max(0, meta.bytes);
    }
    this.index = refreshed;
    this.totalBytes = refreshedBytes;

    const now = Date.now();
    // 残片若不清理会通过 pendingSplitIds 永久阻塞同 splitId 盘上残组的领取
    this.purgeStaleSplitBuffers(now);
    const pendingLogIds = new Set(
      this.pendingPersists.map((entry) => entry.log.logId),
    );
    const pendingSplitIds = new Set(
      this.pendingPersists
        .map((entry) => getSplitId(entry.log))
        .filter((splitId): splitId is string => splitId !== undefined),
    );
    const grouped = new Map<string, RuntimeOfflineRecordMeta[]>();
    for (const meta of Array.from(refreshed.values()).sort(
      (a, b) => b.priority - a.priority || a.storedAt - b.storedAt,
    )) {
      const key =
        meta.splitId == null ? `log:${meta.logId}` : `split:${meta.splitId}`;
      const group = grouped.get(key);
      if (group) group.push(meta);
      else grouped.set(key, [meta]);
    }

    const status = upload.getQueueStatus();
    let room = Math.max(
      0,
      status.maxSize - status.length - status.parked - status.admitting,
    );
    let batchRoom = this.options.replayBatchSize;
    let earliestWake = Number.POSITIVE_INFINITY;
    const candidates: string[][] = [];
    for (const [key, group] of grouped) {
      const expired = group.every(
        (meta) =>
          meta.storedAt > now + 5 * 60 * 1000 ||
          now - meta.storedAt >= this.options.ttl,
      );
      if (expired) {
        const removed = await coordination.deleteExpiredGroup(
          this.options.namespace,
          group.map((meta) => meta.logId),
          now,
          this.options.ttl,
        );
        if (removed.length > 0) {
          for (const record of removed) {
            this.removeFromIndex(record.logId);
            this.reportDrop(record.log, 'cache-expired');
          }
        } else {
          for (const meta of group) {
            if (meta.state === 'leased' && (meta.leaseUntil ?? 0) > now) {
              earliestWake = Math.min(earliestWake, meta.leaseUntil!);
            }
          }
        }
        continue;
      }
      if (group.some((meta) => meta.terminal === true)) {
        for (const meta of group)
          this.enqueueOp(() => this.safeDelete(meta.logId));
        continue;
      }
      const pending = key.startsWith('split:')
        ? pendingSplitIds.has(key.slice(6))
        : group.some((meta) => pendingLogIds.has(meta.logId));
      if (pending) continue;
      if (key.startsWith('split:')) {
        const splitId = key.slice(6);
        const records: OfflineRecord[] = [];
        let missing = false;
        for (const meta of group) {
          const record = await store.get(meta.logId);
          if (!record) {
            missing = true;
            break;
          }
          records.push(record);
        }
        if (missing) continue;

        const complete = isCompleteSplitGroup(records, splitId);
        if (complete) {
          const splitTotal = Number(records[0]?.log.tags?.splitTotal);
          await coordination.markSplitComplete(
            this.options.namespace,
            splitId,
            splitTotal,
          );
        } else {
          const progress = await coordination.getSplitProgress(
            this.options.namespace,
            splitId,
          );
          const totals = new Set(
            records.map((record) => Number(record.log.tags?.splitTotal)),
          );
          const currentIndices = records.map((record) =>
            Number(record.log.tags?.splitIndex),
          );
          const union = new Set([
            ...(progress?.deliveredIndices ?? []),
            ...currentIndices,
          ]);
          const provenResidual =
            progress !== null &&
            totals.size === 1 &&
            totals.has(progress.splitTotal) &&
            new Set(currentIndices).size === currentIndices.length &&
            currentIndices.length + progress.deliveredIndices.length ===
              progress.splitTotal &&
            currentIndices.every(
              (index) =>
                Number.isSafeInteger(index) &&
                index > 0 &&
                index <= progress.splitTotal,
            ) &&
            union.size === progress.splitTotal &&
            currentIndices.every(
              (index) => !progress.deliveredIndices.includes(index),
            );
          if (!provenResidual) {
            const newestStoredAt = Math.max(
              ...group.map((meta) => meta.storedAt),
            );
            const cleanupAt = newestStoredAt + SPLIT_ASSEMBLY_GRACE_MS;
            if (cleanupAt > now) {
              earliestWake = Math.min(earliestWake, cleanupAt);
            } else {
              const first = group[0];
              if (first) {
                this.enqueueOp(async () => {
                  await this.deleteSplitGroup(first.logId, 'storage-rejected');
                  await coordination.clearSplitProgress(
                    this.options.namespace,
                    splitId,
                  );
                });
              }
            }
            continue;
          }
        }
      }
      let blocked = false;
      for (const meta of group) {
        if (
          this.deliveredTombstones.has(meta.logId) ||
          hasPendingRecordDelete(this.claimedResources, meta.logId) ||
          upload.isPending(meta.logId)
        ) {
          blocked = true;
          break;
        }
        const eligibleAt = Math.max(
          meta.nextEligibleAt ?? 0,
          meta.notBefore ?? 0,
          meta.serverNotBefore ?? 0,
          meta.state === 'leased' ? (meta.leaseUntil ?? 0) : 0,
        );
        if (eligibleAt > now) {
          earliestWake = Math.min(earliestWake, eligibleAt);
          blocked = true;
        }
      }
      if (blocked) continue;
      if (
        group.length > room ||
        group.length > status.maxSize ||
        (group.length > batchRoom && candidates.length > 0)
      ) {
        if (group.length <= status.maxSize) this.armOverflowReplayWake();
        continue;
      }
      candidates.push(group.map((meta) => meta.logId));
      room -= group.length;
      batchRoom = Math.max(0, batchRoom - group.length);
    }
    if (earliestWake !== Number.POSITIVE_INFINITY)
      this.armDeferredReplayWake(earliestWake);
    return candidates;
  }

  private async handleCoordinatedClaims(
    deliveries: readonly OfflineCrossTabClaim[],
  ): Promise<void> {
    const upload = this.getUploadPlugin();
    if (!upload) {
      await Promise.all(
        deliveries.map(({ receipt }) =>
          receipt.retry({
            nextEligibleAt: Date.now() + 1000,
            lastRetryReason: 'upload-unavailable',
          }),
        ),
      );
      return;
    }
    for (const { record } of deliveries) {
      // 索引只存 meta：把含正文的完整记录塞进去会让内存占用随领取批次膨胀。
      const { log: _log, ...meta } = record;
      this.index.set(record.logId, meta);
      this.inFlight.set(record.logId, Date.now());
    }
    try {
      await upload.requeueCoordinated(
        deliveries.map(({ record, receipt }) => ({
          log: this.markAsReplay(record.log),
          priority: record.priority || undefined,
          receipt,
        })),
      );
    } finally {
      // 派发抛出时协调器会释放 receipts（settled）；不清 inFlight 的话这些
      // 脏条目会一直挂到 remount。
      for (const { record, receipt } of deliveries) {
        if (receipt.isSettled()) this.inFlight.delete(record.logId);
      }
    }
  }

  private async handleRemoteDelivered(logId: string): Promise<void> {
    if (this.destroyed) return;
    this.inFlight.delete(logId);
    this.pendingPersists = this.pendingPersists.filter(
      (entry) => entry.log.logId !== logId,
    );
    this.removeFromIndex(logId);
    this.getUploadPlugin()?.acknowledgeDelivered(logId);
    this.notifyDeliveryStatus();
  }

  private async drainPendingPersists(epoch: number): Promise<void> {
    const pending = this.pendingPersists.splice(0);
    for (const item of pending) {
      if (!this.isEpoch(epoch)) return;
      if (
        this.deliveredTombstones.has(item.log.logId) ||
        this.preHydrationDeletes.has(item.log.logId) ||
        hasPendingRecordDelete(this.claimedResources, item.log.logId)
      ) {
        continue;
      }
      await this.persist(item.log, item.priority, item.state);
    }
  }

  private async commitCoordinatedSuccess(logId: string): Promise<void> {
    const coordination = this.crossTabCoordination;
    if (!coordination || !this.pendingCoordinatedSuccesses.has(logId)) return;
    try {
      await coordination.deleteDelivered(this.options.namespace, logId);
      this.removeFromIndex(logId);
      this.pendingCoordinatedSuccesses.delete(logId);
      this.deliveredTombstones.delete(logId);
      this.scheduleReplay();
    } catch (error) {
      this.debug('coordinated success proof commit failed:', error);
      this.armStorageRetryWake();
    }
  }

  private finalizeRecoveryCacheTransfer(forceRollback: boolean): void {
    if (this.recoveryCacheTransfer.length === 0) return;
    const upload = this.getUploadPlugin();
    if (!upload) return;
    // 所有权事务只允许 v2 强事务后端提交。工厂回落到 KV/noop 时，缺失索引并不
    // 是“已终态处理”，而是这些 cache 项从未进入该后端；必须原样归还 Upload。
    if (!this.crossTabStoreActive) {
      upload.rollbackRecoveryCacheTransfer();
      this.recoveryCacheTransfer = [];
      return;
    }
    const allCommitted = this.recoveryCacheTransfer.every((item) =>
      this.index.has(item.log.logId),
    );
    if (allCommitted) {
      upload.confirmRecoveryCacheTransfer();
      this.recoveryCacheTransfer = [];
      return;
    }
    const stillBuffered = this.recoveryCacheTransfer.some((item) =>
      this.pendingPersists.some(
        (pending) => pending.log.logId === item.log.logId,
      ),
    );
    if (
      !forceRollback &&
      !stillBuffered &&
      this.hydrated &&
      this.storageOperational
    ) {
      // 缺失项已经通过配额/格式终态出口明确处理；不能先对外报告 drop 又退回 Upload 发送。
      upload.confirmRecoveryCacheTransfer();
      this.recoveryCacheTransfer = [];
      return;
    }
    if (forceRollback) {
      upload.rollbackRecoveryCacheTransfer();
      this.recoveryCacheTransfer = [];
    }
  }

  /**
   * 只在显式协调存储已成功打开后才导入 Upload cache。
   * 默认 2.5 路径不调用 beginRecoveryCacheTransfer，也不改写其恢复顺序。
   */
  private stageRecoveryCacheTransfer(): void {
    if (!this.crossTabStoreActive || this.recoveryCacheTransfer.length === 0)
      return;
    for (const item of this.recoveryCacheTransfer) {
      this.bufferPersist(item.log, item.priority, {
        notBefore:
          Math.max(item.nextAttemptAt ?? 0, item.parkedUntil ?? 0) || undefined,
        serverNotBefore: item.serverNotBefore,
        parkCount: item.parkCount,
        lastRetryReason: item.lastRetryReason,
      });
    }
  }

  /** 短暂读写故障后的统一恢复入口：先重放写意图，再恢复补传扫描。 */
  private scheduleStorageRetry(): void {
    const epoch = this.epoch;
    this.enqueueOp(async () => {
      try {
        for (const logId of [...this.pendingCoordinatedSuccesses]) {
          await this.commitCoordinatedSuccess(logId);
        }
        await this.flushPendingRecordDeletes();
        await this.drainPendingPersists(epoch);
        this.finalizeRecoveryCacheTransfer(false);
        if (this.pendingPersists.length === 0) {
          if (this.crossTabReservation)
            this.crossTabWake?.('storage-recovered');
          else await this.replay();
        }
        if (
          this.pendingPersists.length === 0 &&
          this.pendingCoordinatedSuccesses.size === 0 &&
          !hasPendingRecordDeletes(this.deletionResourceKeys())
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
    if (this.crossTabReservation) {
      this.crossTabWake?.('replay');
      return;
    }
    if (this.index.size === 0) return;
    this.enqueueOp(async () => {
      try {
        await this.replay();
        if (
          this.pendingPersists.length === 0 &&
          this.pendingCoordinatedSuccesses.size === 0 &&
          !hasPendingRecordDeletes(this.deletionResourceKeys())
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
    this.storageRetryDelay =
      this.storageRetryDelay === 0
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

  private armOverflowReplayWake(): void {
    if (this.destroyed || this.overflowReplayTimer) return;
    const epoch = this.epoch;
    const delay = Math.min(1000, this.options.replayTimeoutMs);
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
    this.deferredReplayTimer = setTimeout(
      () => {
        this.deferredReplayTimer = null;
        if (this.isEpoch(epoch)) this.scheduleReplay();
      },
      Math.min(delay, 2_147_483_647),
    );
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
    // 对账：既没等到 success 也没等到 drop 的记录，超时后允许再次补传
    for (const [logId, startedAt] of this.inFlight) {
      if (now - startedAt >= this.options.replayTimeoutMs) {
        this.inFlight.delete(logId);
      }
    }

    const queueStatus = upload.getQueueStatus();
    if (
      queueStatus.maxSize -
        queueStatus.length -
        queueStatus.parked -
        queueStatus.admitting <=
      0
    ) {
      this.armOverflowReplayWake();
      return;
    }

    // 必须先用完整索引建组，再按组判断 inFlight / pending / Retry-After。
    // 先逐条筛选会让同组中“已到期”的分片先被单独 requeue，破坏全有或全无语义。
    const metaGroups = new Map<string, RuntimeOfflineRecordMeta[]>();
    const ordered = Array.from(this.index.values()).sort(
      (a, b) => b.priority - a.priority || a.storedAt - b.storedAt,
    );
    for (const meta of ordered) {
      if (!this.isEpoch(epoch)) return;
      if (!this.index.has(meta.logId)) continue;
      if (
        !this.crossTabStoreActive &&
        now - meta.storedAt >= this.options.ttl
      ) {
        await this.deleteSplitGroup(meta.logId, 'cache-expired');
        continue;
      }

      const groupKey =
        meta.splitId == null ? `log:${meta.logId}` : `split:${meta.splitId}`;
      const group = metaGroups.get(groupKey);
      if (group) group.push(meta);
      else metaGroups.set(groupKey, [meta]);
    }

    let earliestDeferred = Number.POSITIVE_INFINITY;
    const groups = new Map<
      string,
      Array<{
        meta: RuntimeOfflineRecordMeta;
        record: OfflineRecord;
      }>
    >();
    for (const [groupKey, metas] of metaGroups) {
      if (
        this.crossTabStoreActive &&
        metas.every(
          (meta) =>
            meta.storedAt > now + 5 * 60 * 1000 ||
            now - meta.storedAt >= this.options.ttl,
        )
      ) {
        const removed = this.crossTabCoordination
          ? await this.crossTabCoordination.deleteExpiredGroup(
              this.options.namespace,
              metas.map((meta) => meta.logId),
              now,
              this.options.ttl,
            )
          : [];
        for (const record of removed) {
          this.removeFromIndex(record.logId);
          this.reportDrop(record.log, 'cache-expired');
        }
        continue;
      }
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
        const notBefore = Math.max(
          meta.notBefore ?? 0,
          meta.serverNotBefore ?? 0,
          this.crossTabStoreActive && meta.state === 'leased'
            ? (meta.leaseUntil ?? 0)
            : 0,
        );
        if (notBefore > now) {
          blocked = true;
          groupDeadline = Math.max(groupDeadline, notBefore);
        }
      }
      if (groupDeadline > 0)
        earliestDeferred = Math.min(earliestDeferred, groupDeadline);
      if (blocked) continue;

      const members: Array<{
        meta: RuntimeOfflineRecordMeta;
        record: OfflineRecord;
      }> = [];
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
        // 索引/正文不一致时不能把剩余分片作为“完整组”发送。
        if (groupKey.startsWith('split:') && members.length > 0) {
          await this.deleteSplitGroup(
            members[0]!.meta.logId,
            'storage-rejected',
          );
        }
        continue;
      }
      if (
        groupKey.startsWith('split:') &&
        members.length > 0 &&
        !isCompleteSplitGroup(
          members.map((member) => member.record),
          groupKey.slice(6),
        )
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

    // safeGet 是异步的，期间宿主可能继续入队；真正 requeue 前重新计算容量。
    const latestStatus = upload.getQueueStatus();
    let room = Math.max(
      0,
      latestStatus.maxSize -
        latestStatus.length -
        latestStatus.parked -
        latestStatus.admitting,
    );
    if (room <= 0) {
      this.armOverflowReplayWake();
      return;
    }

    const candidates: Array<{
      meta: RuntimeOfflineRecordMeta;
      record: OfflineRecord;
    }> = [];
    let deferredForCapacity = false;
    let hasFeasibleGroup = false;
    for (const group of groups.values()) {
      if (candidates.length >= this.options.replayBatchSize) break;
      // 这个配置下整组永远不可能进入队列。保留磁盘副本，等待下次以更大
      // maxSize 启动；不要每秒唤醒一次制造永不收敛的后台热循环。
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
      this.debug(
        'replay deferred: no complete split group fits the upload queue',
      );
      if (hasFeasibleGroup) this.armOverflowReplayWake();
      return;
    }
    if (deferredForCapacity) this.armOverflowReplayWake();

    for (const { meta, record } of candidates) {
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
      this.deferPersistAfterStorageError(
        log,
        meta.priority,
        {
          replayAttempts: attempts,
        },
        error,
      );
      return;
    }
    if (!record) {
      this.removeFromIndex(logId);
      return;
    }

    if (attempts >= this.options.maxReplayAttempts) {
      await this.safeDelete(logId);
      this.stats.giveUps++;
      this.reportDrop(record.log, 'offline-give-up', OFFLINE_REPLAY_SOURCE);
      return;
    }

    record.replayAttempts = attempts;
    try {
      await this.writePendingRecords([record]);
    } catch (err) {
      // 补传预算与 Retry-After 同属持久状态。写回失败时先把更新意图放进统一
      // 退避链；在它提交前 replay 的可见性屏障会扣住本条，避免刷新后预算倒退。
      this.deferPersistAfterStorageError(
        record.log,
        record.priority,
        {
          replayAttempts: attempts,
        },
        err,
      );
      return;
    }

    // 继续推进剩余记录。这里不会热循环：每次失败都会消耗一次 replayAttempts，
    // 而网络真的断了的时候 UploadPlugin 会暂停，requeue 进去的条目根本不会失败。
    this.scheduleReplay();
  }

  // ==================== 工具 ====================

  private getUploadPlugin(): UploadPlugin | null {
    // 延迟解析：装载顺序不一定保证 UploadPlugin 先于本插件安装
    const plugin = this.logger?.getPluginInstance('upload') as
      UploadPlugin | undefined;
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

  private setIndexedRecord(record: OfflineRecord): void {
    this.removeFromIndex(record.logId);
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
      ...(('schemaVersion' in record || 'state' in record)
        ? (record as RuntimeOfflineRecordMeta)
        : {}),
    });
    this.totalBytes += Math.max(0, record.bytes);
  }

  /** 初始化/降级期保护全部候选资源；完成 reconciliation 后只标记实际后端。 */
  private deletionResourceKeys(): string[] {
    const backend = this.store?.backend;
    if (
      this.hydrated &&
      this.storageOperational &&
      backend !== undefined &&
      backend !== 'noop'
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
      throw err;
    }
  }

  /**
   * OfflinePersistence 的唯一记录写入口。
   *
   * v2 在一个读写事务内重新读取并单调合并，任何页面内的旧快照都不能覆盖
   * 已提交的 lease/fence/deliveryAttempt；未启用 CrossTab 时仍调用原 2.5 store，
   * 保持原有行为与包体边界。
   */
  private async writePendingRecords(
    records: readonly OfflineRecord[],
  ): Promise<OfflineRecord[]> {
    if (records.length === 0) return [];
    const store = this.store;
    if (!store) throw new Error('offline store is unavailable');
    if (this.crossTabCoordination) {
      return (await this.crossTabCoordination.mergePendingRecords(
        records,
      )) as OfflineRecord[];
    }
    if (records.length === 1) {
      await store.put(records[0]!);
      return [records[0]!];
    }
    const putMany = (
      store as OfflineStore & {
        putMany?: (items: readonly OfflineRecord[]) => Promise<void>;
      }
    ).putMany;
    if (!putMany) {
      throw new Error('offline store does not support atomic group writes');
    }
    await putMany.call(store, records);
    return [...records];
  }

  private async safeDelete(logId: string): Promise<boolean> {
    const store = this.store;
    const resources = this.deletionResourceKeys();
    // 删盘意图先记墓碑：即使下一行就遇到 uninstall/存储异常，下一个实例
    // 也会在 hydrate 前继续删，而不是把已终止的记录重放。
    notePendingRecordDelete(resources, logId);
    if (!store) {
      // 后端尚未确定，不能把“没有句柄”误当成“没有记录”。
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
    if (this.crossTabCoordination) {
      try {
        const removed = await this.crossTabCoordination.deleteUnleasedGroup(
          this.options.namespace,
          [logId],
          Date.now(),
        );
        if (removed.length === 0 && (await store.get(logId)) !== null) {
          // 事务时仍有活跃/不可验证 lease。保留索引与删除意图；当前所有者先完成
          // 网络结果，或由 lease 到期后下一轮存储重试继续清理。
          this.armStorageRetryWake();
          return false;
        }
        clearPendingRecordDelete(
          backendResourceKeys(this.options, store.backend),
          logId,
        );
        this.removeFromIndex(logId);
        return removed.length > 0;
      } catch (err) {
        this.debug('coordinated delete failed:', err);
        this.armStorageRetryWake();
        return false;
      }
    }
    try {
      await store.delete(logId);
      // KV 后端可能吞掉 removeItem 失败仍 resolve；回读确认删除真的生效。
      if (await store.get(logId)) {
        throw new Error('offline delete did not stick');
      }
      clearPendingRecordDelete(
        backendResourceKeys(this.options, store.backend),
        logId,
      );
      this.removeFromIndex(logId);
      return true;
    } catch (err) {
      this.debug('delete failed:', err);
      // 模块级墓碑只覆盖同一 JS realm。把终态标记写回记录，真正关闭页面后
      // 下一实例也只会继续删除，绝不会把已终止日志重新补传。
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

  /** 清理本实际资源上遗留的「已终止但未删盘」记录 */
  private async flushPendingRecordDeletes(): Promise<void> {
    if (
      this.claimedResources.length === 0 ||
      !this.store ||
      this.store.backend === 'noop'
    )
      return;
    const pending = new Set<string>();
    for (const resource of backendResourceKeys(
      this.options,
      this.store.backend,
    )) {
      for (const logId of PENDING_RECORD_DELETES.get(resource) ?? [])
        pending.add(logId);
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
  private enqueueOp<T>(
    op: () => Promise<T>,
    propagateError = false,
  ): Promise<T | undefined> {
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
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private warnStorageUnavailable(): void {
    if (this.storageWarned) return;
    this.storageWarned = true;
    if (typeof console === 'undefined' || !console.warn) return;
    console.warn(
      '[Aemeath] OfflinePersistencePlugin found no usable, fully reconciled storage backend ' +
        '(storage is unavailable or failed its integrity scan). Offline logs will NOT be ' +
        'preserved across network outages. Uploading itself is unaffected.',
    );
  }

  private notifyDeliveryStatus(): void {
    const host = this.logger;
    if (!host) return;
    // JS 宿主或手写测试宿主可能仍实现 2.5.1 之前的 AemeathInterface。
    // 统一状态通知是增强能力，不应让持久化主链路因缺方法而抛错。
    const notify = (
      host as AemeathInterface & { notifyDeliveryStatus?: () => void }
    ).notifyDeliveryStatus;
    if (typeof notify !== 'function') return;
    try {
      notify.call(host);
    } catch (err) {
      // 自定义宿主的观测钩子即使实现有误，也不能让持久化串行链变成 rejected，
      // 否则浮动的 enqueueOp 会产生 unhandled rejection。
      this.debug('delivery status notification failed:', err);
    }
  }

  private debug(...args: unknown[]): void {
    if (this.options.debug) {
      console.log('[Aemeath:offline]', ...args);
    }
  }
}
