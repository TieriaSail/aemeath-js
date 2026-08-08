/**
 * OfflinePersistence 插件 — 断网期间落盘，联网后自动补传
 *
 * `UploadPlugin` 自带的 localStorage 缓存只解决"页面重载"（刷新、关闭后重开），
 * 它是队列镜像，日志一旦被丢弃就不在缓存里。真正的断网续传由本插件提供，
 * 而且刻意做成**独立可选插件**：持久化涉及存储引擎、配额、唤醒、复投、去重，
 * 把这些塞进主上传通道只会让核心链路更容易出 bug。
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
 *
 * 详细文档参见 docs/{zh,en}/11-offline-persistence.md
 */

import type { AemeathPlugin, AemeathInterface, LogEntry, LogTags } from '../types';
import { PluginPriority } from '../types';
import type { UploadPlugin, UploadDropReason } from './UploadPlugin';
import { jsonBytes } from '../utils/payloadSanitize';
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

/** IndexedDB 后端的默认容量 */
const IDB_DEFAULT_MAX_ENTRIES = 500;
const IDB_DEFAULT_MAX_BYTES = 2_000_000;

/** KV 后端容量小得多（localStorage 通常整源只有 ~5MB），默认收紧 */
/** 当前页面上已被占用的离线存储位，用于发现两个实例共用一个库 */
const CLAIMED_OFFLINE_SLOTS = new Set<string>();

/**
 * 跨 uninstall→install 的「已送达、删盘未完成」墓碑
 *
 * uninstall 会打断 enqueueOp 链并关掉 store，未完成的 delete 会丢掉。
 * 这些 id 挂在模块级，同 slot 的下一次 install/hydrate 会先清掉，避免
 * remount / 下次打开把已送达日志再补传一遍。
 */
const PENDING_DELIVERED_DELETES = new Map<string, Set<string>>();

function notePendingDeliveredDelete(slot: string, logId: string): void {
  let set = PENDING_DELIVERED_DELETES.get(slot);
  if (!set) {
    set = new Set();
    PENDING_DELIVERED_DELETES.set(slot, set);
  }
  set.add(logId);
}

function clearPendingDeliveredDelete(slot: string | null, logId: string): void {
  if (!slot) return;
  const set = PENDING_DELIVERED_DELETES.get(slot);
  if (!set) return;
  set.delete(logId);
  if (set.size === 0) PENDING_DELIVERED_DELETES.delete(slot);
}

function hasPendingDeliveredDelete(slot: string | null, logId: string): boolean {
  if (!slot) return false;
  return PENDING_DELIVERED_DELETES.get(slot)?.has(logId) === true;
}

const KV_DEFAULT_MAX_ENTRIES = 100;
const KV_DEFAULT_MAX_BYTES = 512_000;

/** 只有这些原因的丢弃值得留到下次再传；其余要么不可送达，要么是我们自己发出的 */
const PERSISTABLE_DROP_REASONS: ReadonlySet<UploadDropReason> = new Set<UploadDropReason>([
  'max-retries',
  'queue-overflow',
]);

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
   * 只约束**磁盘**容量。同页断网恢复仍走 UploadPlugin 内存队列，
   * 被磁盘淘汰的条目仍可能从内存发出。想限同页积压请调 `queue.maxSize`。
   */
  maxEntries?: number;

  /**
   * 最多占用多少字节（IndexedDB 默认 2MB，KV 后端默认 512KB）
   *
   * 语义同 `maxEntries`：只管落盘，不管内存队列。
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
}

export class OfflinePersistencePlugin implements AemeathPlugin {
  readonly name = 'offline-persistence';
  readonly version = '2.5.0';
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

  /** 本实例认领到的存储位（dbName + key），卸载时归还 */
  private claimedSlot: string | null = null;

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
   * 已上传成功、磁盘删除尚未跑完（或尚未 hydrate）的 logId
   *
   * 必须同步写入：否则已排队的 pending flush / replay 仍会把已送达日志再写盘、再补传。
   */
  private readonly deliveredTombstones = new Set<string>();
  /**
   * store 尚未打开时收到的落盘请求
   *
   * `createOfflineStore` 是异步的；`upload:paused` / pause 期 `enqueued` 可能
   * 抢在 store 赋值之前到达。若直接丢弃，断网窗口里最早一批日志会永远落不了盘。
   */
  private pendingPersists: Array<{ log: LogEntry; priority?: number }> = [];
  /** 索引是否已建好（含"没有可用后端"这种提前定论的情况） */
  private hydrated = false;
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
   * 生命周期世代：同实例 remount 时递增，作废上一轮还挂在 chain / init 上的工作。
   */
  private epoch = 0;

  constructor(options: OfflinePersistencePluginOptions = {}) {
    this.options = {
      storage: options.storage ?? 'auto',
      ttl: options.ttl ?? 7 * 24 * 60 * 60 * 1000,
      replayBatchSize: Math.max(1, options.replayBatchSize ?? 10),
      maxReplayAttempts: Math.max(1, options.maxReplayAttempts ?? 3),
      replayTimeoutMs: Math.max(1000, options.replayTimeoutMs ?? 60000),
      dbName: options.dbName ?? 'aemeath-offline',
      key: options.key ?? '__aemeath_offline__',
      debug: options.debug ?? false,
      maxEntries: options.maxEntries,
      maxTotalBytes: options.maxTotalBytes,
    };
  }

  install(logger: AemeathInterface): void {
    // 同 UploadPlugin：不清墓碑标记的话，复装后 init() 会把刚打开的 store
    // 立刻关掉，backend 永远停在 'initializing'
    this.epoch++;
    this.destroyed = false;
    this.logger = logger;

    // 同实例 remount 必须丢掉上一轮内存态：hydrated 若仍为 true，
    // handleSuccess 进不了 preHydrationDeletes，store 未挂上时 safeDelete 空操作，
    // 随后 hydrate 又把盘上副本读回补传 → 与 Upload 内存队列叠成重复上报。
    this.hydrated = false;
    this.index.clear();
    this.totalBytes = 0;
    this.inFlight.clear();
    this.pendingPersists = [];
    this.deliveredTombstones.clear();
    this.preHydrationDeletes.clear();
    this.store = null;
    this.chain = Promise.resolve();
    this.ready = null;

    // 库名同样有确定性默认值。两个实例共用一个库时，A 攒下的离线日志会被
    // B 补传到 B 的上报地址上 —— 和缓存 key 撞车是同一类串台，只是更隐蔽，
    // 因为补传是自动发生的。
    const slot = `${this.options.dbName}::${this.options.key}`;
    if (CLAIMED_OFFLINE_SLOTS.has(slot)) {
      this.destroyed = true;
      // 让位也要报得清楚：backend 停在 'initializing' 的话，用户看 getStatus()
      // 只会以为还没初始化完，而不是"这个实例被让位了"
      this.store = createNoopStore();
      this.hydrated = true;
      this.ready = Promise.resolve();
      console.warn(
        `[Aemeath] Two OfflinePersistencePlugin instances on this page share the store "${slot}". ` +
          "One project's offline logs could be replayed to the other's endpoint, so this instance " +
          'is inactive. Give each instance its own `dbName` (and `key`) to run both.'
      );
      return;
    }
    CLAIMED_OFFLINE_SLOTS.add(slot);
    this.claimedSlot = slot;

    this.on('upload:drop', (payload) => this.handleDrop(payload));
    this.on('upload:paused', (payload) => this.handlePaused(payload));
    this.on('upload:enqueued', (payload) => this.handleEnqueued(payload));
    this.on('upload:success', (payload) => this.handleSuccess(payload));
    this.on('upload:resumed', () => this.scheduleReplay());

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
    const slot = this.claimedSlot;
    const host = logger ?? this.logger;
    const upload = this.getUploadPlugin();

    // 卸载时可能已有日志在 Upload 真正飞行中。
    // **不要**乐观记 PENDING：结果未知时 remount 的 flushPending 会把唯一副本删掉。
    // 只在晚到的 success 上 note；drop/失败则什么也不做，盘上副本留给下次补传。
    const watchIds = new Set<string>();
    if (slot && upload) {
      for (const logId of this.index.keys()) {
        if (upload.isInFlight(logId)) watchIds.add(logId);
      }
    }

    this.epoch++;
    this.destroyed = true;
    // 注意：不要清 PENDING_DELIVERED_DELETES —— 未完成的删盘要留给同 slot 的下一次实例
    if (this.claimedSlot !== null) {
      CLAIMED_OFFLINE_SLOTS.delete(this.claimedSlot);
      this.claimedSlot = null;
    }
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
    if (host && slot && watchIds.size > 0) {
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
        notePendingDeliveredDelete(slot, logId);
        if (watchIds.size === 0) {
          detachLate(onLateSuccess, 'upload:success');
          detachLate(onLateDrop, 'upload:drop');
        }
      };
      const onLateDrop = (...args: unknown[]): void => {
        const payload = args[0] as { log?: { logId?: string }; reason?: string } | undefined;
        const logId = payload?.log?.logId;
        if (!logId || !watchIds.has(logId)) return;
        watchIds.delete(logId);
        // 终态拒收：盘上副本再补传也只会再被拒，记 PENDING 留给 remount 清掉
        if (payload?.reason === 'no-retry' || payload?.reason === 'max-retries') {
          notePendingDeliveredDelete(slot, logId);
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

    try {
      this.store?.close();
    } catch (err) {
      this.debug('failed to close store:', err);
    }
    this.store = null;
    this.pendingPersists = [];
    this.deliveredTombstones.clear();
    this.logger = null;
  }

  // ==================== 对外查询 ====================

  /** 当前后端、待补传条数、占用字节与各类计数 */
  getStatus(): OfflinePersistenceStatus {
    return {
      backend: this.store?.backend ?? 'initializing',
      pending: this.index.size,
      bytes: this.totalBytes,
      replaying: this.inFlight.size,
      quotaDrops: this.stats.quotaDrops,
      giveUps: this.stats.giveUps,
      replayed: this.stats.replayed,
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
      await this.store?.clear();
      this.index.clear();
      this.inFlight.clear();
      this.totalBytes = 0;
    });
  }

  // ==================== 初始化 ====================

  private async init(): Promise<void> {
    // 任何逃逸都必须让 hydrated 落定，否则墓碑集合会无限增长、已上传的日志
    // 也永远不会从盘上删掉（详见 hydration 里的注释）。init() 本身也不能把
    // 异常抛出去：this.ready 常常没人 await，抛出去就是未处理 rejection。
    try {
      await this.initInternal();
    } catch (err) {
      this.debug('init failed:', err);
    } finally {
      this.hydrated = true;
      this.preHydrationDeletes.clear();
    }
  }

  private async initInternal(): Promise<void> {
    const logger = this.logger;
    if (!logger) return;
    const epoch = this.epoch;

    const store = await createOfflineStore({
      preference: this.options.storage,
      platform: logger.platform,
      dbName: this.options.dbName,
      keyPrefix: this.options.key,
      onFallback: (from, reason) =>
        this.debug(`storage backend "${from}" unavailable, falling back:`, reason),
    });

    // 打开数据库期间插件可能已经被卸载 / remount。直接挂上去等于复活一个没人会关闭的连接
    if (this.destroyed || this.epoch !== epoch) {
      store.close();
      if (this.epoch === epoch) {
        this.hydrated = true;
        this.pendingPersists = [];
      }
      return;
    }
    this.store = store;

    if (this.store.backend === 'noop') {
      // 也算"定论"：不置位的话墓碑集合会随每次上传成功无限增长
      this.hydrated = true;
      this.preHydrationDeletes.clear();
      this.pendingPersists = [];
      this.warnStorageUnavailable();
      logger.emit('upload:offline-unavailable', { reason: 'no-storage-backend' });
      return;
    }

    const isKv = this.store.backend === 'localstorage';
    this.maxEntries =
      this.options.maxEntries ?? (isKv ? KV_DEFAULT_MAX_ENTRIES : IDB_DEFAULT_MAX_ENTRIES);
    this.maxTotalBytes =
      this.options.maxTotalBytes ?? (isKv ? KV_DEFAULT_MAX_BYTES : IDB_DEFAULT_MAX_BYTES);

    // 上一次实例 uninstall 时未完成的删盘：先清掉，再 hydrate
    await this.enqueueOp(async () => {
      if (this.epoch !== epoch) return;
      await this.flushPendingDeliveredDeletes();
    });

    await this.enqueueOp(async () => {
      if (this.epoch !== epoch) return;
      // hydrated 必须在**所有**出口置位，包括读盘失败这条。
      try {
        let metas: OfflineRecordMeta[] = [];
        try {
          metas = await this.store!.loadMeta();
        } catch (err) {
          this.debug('loadMeta failed:', err);
          for (const logId of this.preHydrationDeletes) {
            if (this.epoch !== epoch) return;
            await this.safeDelete(logId);
          }
          return;
        }
        const now = Date.now();
        for (const meta of metas) {
          if (this.epoch !== epoch) return;
          if (now - meta.storedAt >= this.options.ttl) {
            // hydrate 时 index 尚未建完，不能走 deleteSplitGroup（找不到兄弟）。
            // 同组其它片会在本循环里各自过期删掉。
            await this.safeDelete(meta.logId);
            continue;
          }
          // 这条在索引建好之前就已经传成功了，读回来只会导致重复上报
          if (
            this.preHydrationDeletes.has(meta.logId) ||
            hasPendingDeliveredDelete(this.claimedSlot, meta.logId)
          ) {
            this.index.set(meta.logId, meta);
            this.totalBytes += meta.bytes;
            await this.safeDelete(meta.logId);
            continue;
          }
          this.index.set(meta.logId, meta);
          this.totalBytes += meta.bytes;
        }
        this.debug(
          `hydrated ${this.index.size} pending logs from ${this.store!.backend} (${this.totalBytes} bytes)`,
        );
      } finally {
        if (this.epoch === epoch) {
          // hydrated 先落定；墓碑留给下面的 pendingPersists flush 过滤已送达项
          this.hydrated = true;
        }
      }
    });

    if (this.epoch !== epoch) return;

    // store 打开前缓冲的落盘请求：排在 hydrate 之后写盘，避免与索引重建交错。
    await this.enqueueOp(async () => {
      this.preHydrationDeletes.clear();
      if (this.destroyed || this.epoch !== epoch) {
        this.pendingPersists = [];
        return;
      }
      const pending = this.pendingPersists.splice(0);
      for (const item of pending) {
        if (this.destroyed || this.epoch !== epoch) break;
        if (
          this.deliveredTombstones.has(item.log.logId) ||
          this.preHydrationDeletes.has(item.log.logId) ||
          hasPendingDeliveredDelete(this.claimedSlot, item.log.logId)
        ) {
          continue;
        }
        await this.persist(item.log, item.priority);
      }
    });

    if (this.epoch !== epoch) return;

    // Upload 可能在 Offline 挂上监听器之前就已 paused：补齐那次快照里的队列
    this.catchUpPausedQueue();

    this.scheduleReplay();
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

    // 补传出来的条目又被丢弃 → 计入失败次数，不再当作新日志重新落盘
    if (payload['source'] === OFFLINE_REPLAY_SOURCE) {
      // 但队列溢出不算"补传失败"：那是本地内存队列被别的日志挤爆了，
      // 这条根本没上过网。照算的话，补传预算会被本地拥挤白白耗光，
      // 日志明明还在盘上却被判了死刑（实测被挤掉四次后直接放弃）。
      if (reason === 'queue-overflow') {
        this.scheduleReplay();
        return;
      }
      this.enqueueOp(() => this.registerReplayFailure(log.logId));
      return;
    }

    if (!PERSISTABLE_DROP_REASONS.has(reason)) {
      // 服务端明确拒收（no-retry / payload）：补传只会被再拒一次。
      // 之前落过盘的话必须就地清掉，否则这份副本没人再管，会一直占着配额，
      // 还会在下次上线 / 下次打开页面时被翻出来重投。
      this.enqueueOp(async () => {
        if (!this.index.has(log.logId)) return;
        await this.safeDelete(log.logId);
      });
      return;
    }
    this.enqueueOp(() => this.persist(log, payload['priority'] as number | undefined));
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
    // 必须在 enqueueOp 之外完成，否则已排队的 replay / 稍后的 pending flush
    // 仍会把已送达日志再写盘、再补传。
    this.deliveredTombstones.add(logId);
    this.inFlight.delete(logId);
    this.pendingPersists = this.pendingPersists.filter((p) => p.log.logId !== logId);
    if (this.claimedSlot) {
      notePendingDeliveredDelete(this.claimedSlot, logId);
    }
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

  private async persist(log: LogEntry, priority?: number): Promise<void> {
    if (this.destroyed) return;
    // 已送达的绝不能再进缓冲 / 再写盘
    if (
      this.deliveredTombstones.has(log.logId) ||
      this.preHydrationDeletes.has(log.logId) ||
      hasPendingDeliveredDelete(this.claimedSlot, log.logId)
    ) {
      return;
    }
    if (!this.store) {
      // store 还在打开：先攒着，init 完成后统一 flush
      this.pendingPersists.push({ log, priority });
      return;
    }
    if (this.store.backend === 'noop') return;
    if (this.index.has(log.logId)) return;

    const bytes = jsonBytes(log);
    if (!Number.isFinite(bytes)) return;

    const record: OfflineRecord = {
      logId: log.logId,
      storedAt: Date.now(),
      capturedAt: log.timestamp,
      priority: priority ?? 0,
      bytes,
      replayAttempts: 0,
      log,
    };

    await this.makeRoomFor(bytes);

    try {
      await this.store.put(record);
    } catch (err) {
      if (!isQuotaError(err)) {
        // 这条本身就存不下（结构化克隆失败等），腾出多少空间都没用。
        // 当成配额问题去淘汰，只会白白搭进去一批本来好好的日志。
        this.stats.quotaDrops++;
        this.debug('record is not storable, dropping:', err);
        this.reportDrop(log, 'storage-quota');
        return;
      }
      // 确实是配额：再淘汰一批后重试一次，仍失败就明确丢弃
      this.debug('quota hit, evicting and retrying:', err);
      await this.evictOldest(Math.max(1, Math.ceil(this.index.size * 0.2)));
      try {
        await this.store.put(record);
      } catch (retryErr) {
        this.stats.quotaDrops++;
        this.debug('put failed after eviction, dropping:', retryErr);
        this.reportDrop(log, 'storage-quota');
        return;
      }
    }

    this.index.set(record.logId, {
      logId: record.logId,
      storedAt: record.storedAt,
      capturedAt: record.capturedAt,
      priority: record.priority,
      bytes: record.bytes,
      replayAttempts: 0,
    });
    this.totalBytes += bytes;
  }

  /** 为新记录腾出条数与字节配额 */
  private async makeRoomFor(bytes: number): Promise<void> {
    while (
      this.index.size > 0 &&
      (this.index.size >= this.maxEntries || this.totalBytes + bytes > this.maxTotalBytes)
    ) {
      const evicted = await this.evictOldest(1);
      if (evicted === 0) break;
    }
  }

  /**
   * 淘汰最旧的若干条
   *
   * 按落盘时间淘汰而不是按优先级：断网期间的日志优先级往往一样，
   * 时间顺序是唯一稳定且可预期的标准。
   */
  private async evictOldest(count: number): Promise<number> {
    const candidates = Array.from(this.index.values())
      .sort((a, b) => a.storedAt - b.storedAt)
      .slice(0, count);
    let evicted = 0;
    for (const meta of candidates) {
      if (!this.index.has(meta.logId)) continue;
      const n = await this.deleteSplitGroup(meta.logId, 'storage-quota');
      this.stats.quotaDrops += Math.max(1, n);
      evicted += Math.max(1, n);
    }
    return evicted;
  }

  /**
   * 按 splitId 整组删除：配额淘汰 / TTL 过期不能只撕一片，否则后端收残组。
   * @returns 实际删除条数
   */
  private async deleteSplitGroup(
    logId: string,
    reason: UploadDropReason,
  ): Promise<number> {
    const primary = await this.safeGet(logId);
    const splitId = primary?.log.tags?.splitId;
    if (splitId === undefined) {
      await this.safeDelete(logId);
      if (primary) this.reportDrop(primary.log, reason);
      return primary ? 1 : 0;
    }

    const sid = String(splitId);
    const siblingIds: string[] = [];
    for (const id of this.index.keys()) {
      const rec = id === logId ? primary : await this.safeGet(id);
      if (rec && String(rec.log.tags?.splitId ?? '') === sid) {
        siblingIds.push(id);
      }
    }
    if (!siblingIds.includes(logId)) siblingIds.push(logId);

    let n = 0;
    for (const id of siblingIds) {
      const rec = id === logId ? primary : await this.safeGet(id);
      await this.safeDelete(id);
      if (rec) {
        this.reportDrop(rec.log, reason);
        n++;
      }
    }
    return n;
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

  private scheduleReplay(): void {
    if (this.destroyed) return;
    if (this.index.size === 0) return;
    this.enqueueOp(() => this.replay());
  }

  private async replay(): Promise<void> {
    if (!this.store || this.store.backend === 'noop') return;
    if (this.index.size === 0) return;

    const upload = this.getUploadPlugin();
    if (!upload) return;

    const now = Date.now();
    // 对账：既没等到 success 也没等到 drop 的记录，超时后允许再次补传
    for (const [logId, startedAt] of this.inFlight) {
      if (now - startedAt >= this.options.replayTimeoutMs) {
        this.inFlight.delete(logId);
      }
    }

    let candidates = Array.from(this.index.values())
      .filter((meta) => !this.inFlight.has(meta.logId))
      .filter((meta) => !this.deliveredTombstones.has(meta.logId))
      .filter((meta) => !hasPendingDeliveredDelete(this.claimedSlot, meta.logId))
      // 还被上传队列持有的不投：网络恢复瞬间队列自己就会把它发出去，
      // 这里再投一遍就是实打实的重复上报
      .filter((meta) => !upload.isPending(meta.logId))
      .sort((a, b) => b.priority - a.priority || a.storedAt - b.storedAt)
      .slice(0, this.options.replayBatchSize);

    // 选中任一片 → 把同 splitId 的其余片也带上，避免残组补传
    const selectedSplitIds = new Set<string>();
    for (const meta of candidates) {
      const rec = await this.safeGet(meta.logId);
      const sid = rec?.log.tags?.splitId;
      if (sid !== undefined) selectedSplitIds.add(String(sid));
    }
    if (selectedSplitIds.size > 0) {
      const byId = new Map(candidates.map((m) => [m.logId, m]));
      for (const meta of this.index.values()) {
        if (byId.has(meta.logId)) continue;
        if (this.inFlight.has(meta.logId) || this.deliveredTombstones.has(meta.logId)) continue;
        if (upload.isPending(meta.logId)) continue;
        const rec = await this.safeGet(meta.logId);
        if (rec && selectedSplitIds.has(String(rec.log.tags?.splitId ?? ''))) {
          byId.set(meta.logId, meta);
        }
      }
      candidates = Array.from(byId.values());
    }

    for (const meta of candidates) {
      if (now - meta.storedAt >= this.options.ttl) {
        await this.deleteSplitGroup(meta.logId, 'cache-expired');
        continue;
      }

      const record = await this.safeGet(meta.logId);
      if (!record) {
        // 索引里有、存储里没有 → 清掉幽灵项
        this.removeFromIndex(meta.logId);
        continue;
      }

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

  private async registerReplayFailure(logId: string): Promise<void> {
    this.inFlight.delete(logId);
    const meta = this.index.get(logId);
    if (!meta) return;

    // 计数以内存索引为准。配额打满时写回落盘会失败，落盘里的 attempts 就一直
    // 停在旧值 —— 只认它的话，这条日志会被无限次翻出来重投。
    meta.replayAttempts++;
    const attempts = meta.replayAttempts;

    const record = await this.safeGet(logId);
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
      await this.store!.put(record);
    } catch (err) {
      this.debug('failed to persist replay attempt count:', err);
    }

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
    this.logger?.emit('upload:drop', { log, reason, source });
  }

  private removeFromIndex(logId: string): void {
    const meta = this.index.get(logId);
    if (!meta) return;
    this.index.delete(logId);
    this.totalBytes = Math.max(0, this.totalBytes - meta.bytes);
  }

  private async safeGet(logId: string): Promise<OfflineRecord | null> {
    try {
      return (await this.store?.get(logId)) ?? null;
    } catch (err) {
      this.debug('get failed:', err);
      return null;
    }
  }

  private async safeDelete(logId: string): Promise<void> {
    try {
      await this.store?.delete(logId);
      clearPendingDeliveredDelete(this.claimedSlot, logId);
    } catch (err) {
      this.debug('delete failed:', err);
      // 磁盘没删掉就保留模块级墓碑，留给下次实例再清
    }
    this.removeFromIndex(logId);
  }

  /** 清理本 slot 上遗留的「已送达未删盘」记录 */
  private async flushPendingDeliveredDeletes(): Promise<void> {
    const slot = this.claimedSlot;
    if (!slot || !this.store || this.store.backend === 'noop') return;
    const pending = PENDING_DELIVERED_DELETES.get(slot);
    if (!pending || pending.size === 0) return;
    for (const logId of [...pending]) {
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
  private enqueueOp<T>(op: () => Promise<T>): Promise<T | undefined> {
    const epoch = this.epoch;
    const run = async (): Promise<T | undefined> => {
      // destroyed 或世代已变（同实例 remount）→ 上一轮工作作废
      if (this.destroyed || this.epoch !== epoch) return undefined;
      try {
        return await op();
      } catch (err) {
        // 单个操作失败绝不能打断整条链，否则后续的删除 / 补传全部停摆
        this.debug('offline op failed:', err);
        return undefined;
      }
    };
    const next = this.chain.then(run, run);
    this.chain = next;
    return next;
  }

  private warnStorageUnavailable(): void {
    if (this.storageWarned) return;
    this.storageWarned = true;
    if (typeof console === 'undefined' || !console.warn) return;
    console.warn(
      '[Aemeath] OfflinePersistencePlugin found no usable storage backend '
        + '(IndexedDB and key-value storage both unavailable). Offline logs will NOT be '
        + 'preserved across network outages. Uploading itself is unaffected.',
    );
  }

  private debug(...args: unknown[]): void {
    if (this.options.debug) {
      console.log('[Aemeath:offline]', ...args);
    }
  }
}
