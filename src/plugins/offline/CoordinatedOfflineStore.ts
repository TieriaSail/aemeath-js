/**
 * CrossTabDeliveryPlugin 专用的 v2 离线持久化存储层
 *
 * 三级降级：IndexedDB → 平台 KV 存储（浏览器 localStorage / 小程序 storage）→ noop。
 *
 * 这是**尽力而为**的存储，不是数据库级 WAL：
 * - 宿主不支持 IndexedDB（隐私模式、老 WebView、小程序）时自动退到 KV 存储，
 *   容量小得多，因此条数与总字节上限也会自动收紧；
 * - 两者都不可用时退到 noop —— 插件仍然安装，但只记录告警，绝不拖垮主上传通道；
 * - 配额打满时先淘汰最旧的记录，仍失败就丢弃当前这条并对外通知。
 */

import type { LogEntry } from '../../types';
import type { PlatformAdapter } from '../../platform/types';
import { getSdkSplitId } from '../../utils/splitIdentity';
import {
  IDB_COORDINATION_STORE_NAME,
  IDB_NAMESPACE_STORE_NAME,
  IDB_RECORDS_STORE_NAME,
  IDB_SPLIT_PROGRESS_STORE_NAME,
  deleteIndexedDbStoreContext,
  isOfflineRecord,
  isOfflineRecordMeta,
  normalizeOfflineRecord,
  requestToPromise,
  setIndexedDbStoreContext,
} from './OfflineStoreInternals';
import { coordinatedDatabaseName } from './OfflineProtocol';
import { createOfflineStore as createLegacyOfflineStore } from './OfflineStore';

export type OfflineBackend = 'indexeddb' | 'localstorage' | 'noop';

export type OfflineRecordState = 'pending' | 'leased' | 'parked';

export interface CoordinatorRecord {
  namespace: string;
  protocolVersion: 2;
  ownerId: string;
  epoch: number;
  leaseUntil: number;
  heartbeatAt: number;
}

export interface LeadershipRequest {
  namespace: string;
  ownerId: string;
  now: number;
  leaseMs: number;
}

export interface LeadershipFence {
  namespace: string;
  ownerId: string;
  epoch: number;
}

export interface ClaimBatchRequest extends LeadershipFence {
  now: number;
  leaseMs: number;
  /**
   * 候选必须按逻辑日志分组。普通日志是一项一组，SDK 分片是完整 split group。
   * 存储层以整组为单位 compare-and-lease，绝不返回半组。
   */
  candidateGroups: readonly (readonly string[])[];
  limit: number;
}

export interface LeasedOfflineRecord extends OfflineRecord {
  schemaVersion: 2;
  deliveryAttempt: number;
  state: 'leased';
  nextEligibleAt: number;
  leaseOwner: string;
  leaseToken: string;
  leaseUntil: number;
  leaderEpoch: number;
}

export interface ClaimBatchResult {
  status: 'claimed' | 'not-leader';
  records: LeasedOfflineRecord[];
  expiredLeaseRecoveries: number;
}

export interface SplitDeliveryProgress {
  id: string;
  namespace: string;
  splitId: string;
  splitTotal: number;
  complete: true;
  deliveredIndices: number[];
  updatedAt: number;
}

interface StorageNamespaceBinding {
  resource: 'offline-v2';
  protocolVersion: 2;
  namespace: string;
}

export interface LeasedRecordFence extends LeadershipFence {
  logId: string;
  leaseToken: string;
}

export interface ReleaseLeasedRecordRequest extends LeasedRecordFence {
  state: 'pending' | 'parked';
  nextEligibleAt: number;
  serverNotBefore?: number;
  replayAttempts?: number;
  parkCount?: number;
  lastRetryReason?: string;
}

export interface UpdateLeasedRecordRequest extends LeasedRecordFence {
  nextEligibleAt: number;
  serverNotBefore?: number;
  replayAttempts?: number;
  lastRetryReason?: string;
}

/**
 * 跨标签正确性的持久化事实源。
 *
 * BroadcastChannel、Web Locks 和页面内存都只能优化唤醒或争用；任何会改变
 * leader/record 所有权的操作最终都必须经过这里的事务和 fencing 校验。
 */
export interface OfflineCoordinationStore {
  readonly mode: 'strong';
  getLeadership(namespace: string): Promise<CoordinatorRecord | null>;
  tryAcquireLeadership(
    request: LeadershipRequest,
  ): Promise<CoordinatorRecord | null>;
  renewLeadership(
    request: LeadershipRequest & { epoch: number },
  ): Promise<boolean>;
  releaseLeadership(
    request: LeadershipFence & { now: number },
  ): Promise<boolean>;
  claimBatch(request: ClaimBatchRequest): Promise<ClaimBatchResult>;
  renewRecordLease(
    request: LeasedRecordFence & { now: number; leaseMs: number },
  ): Promise<boolean>;
  incrementDeliveryAttempt(
    request: LeasedRecordFence & { now: number },
  ): Promise<number | null>;
  updateLeasedRecord(request: UpdateLeasedRecordRequest): Promise<boolean>;
  releaseLeasedRecord(request: ReleaseLeasedRecordRequest): Promise<boolean>;
  deleteLeasedRecord(request: LeasedRecordFence): Promise<boolean>;
  /**
   * v2 records 的唯一非租约写入口。读取当前值与单调合并在同一事务完成，
   * 因而 migration、实时状态镜像和新记录写入都不能覆盖并发 lease/fence。
   */
  mergePendingRecords(
    records: readonly OfflineRecord[],
  ): Promise<OfflineRecord[]>;
  /**
   * 配额、损坏和终态清理只能删除事务时仍未被领取的完整逻辑组。
   * 任一成员拥有活跃或不可验证的 lease 时整组不动。
   */
  deleteUnleasedGroup(
    namespace: string,
    logIds: readonly string[],
    now: number,
  ): Promise<OfflineRecord[]>;
  /**
   * TTL cleanup is a storage transaction, not a scan-time best guess.  The
   * whole logical group is deleted only when every member is still expired and
   * none owns a live lease at transaction time.
   */
  deleteExpiredGroup(
    namespace: string,
    logIds: readonly string[],
    now: number,
    ttl: number,
  ): Promise<OfflineRecord[]>;
  /** 真实成功是送达证明；不要求旧 lease token 仍然有效。 */
  deleteDelivered(namespace: string, logId: string): Promise<boolean>;
  getSplitProgress(
    namespace: string,
    splitId: string,
  ): Promise<SplitDeliveryProgress | null>;
  markSplitComplete(
    namespace: string,
    splitId: string,
    splitTotal: number,
  ): Promise<void>;
  clearSplitProgress(namespace: string, splitId: string): Promise<void>;
}

export interface OfflineRecordMeta {
  /** 省略仅用于读取 2.5 遗留记录；新写入统一规范化为 v2。 */
  schemaVersion?: 2;
  logId: string;
  /** 写入持久层的时刻（TTL 基准） */
  storedAt: number;
  /** 日志被捕获的时刻（= LogEntry.timestamp） */
  capturedAt: number;
  priority: number;
  /** 序列化后的字节数（用于总量控制） */
  bytes: number;
  /** 已经补传失败的次数 */
  replayAttempts: number;
  /** 每次真实网络调用前递增，跨页面恢复后延续。 */
  deliveryAttempt?: number;
  /** 2.6 持久恢复状态。 */
  state?: OfflineRecordState;
  /** 本地调度与服务端期限合并后的最早可领取时间。 */
  nextEligibleAt?: number;
  leaseOwner?: string;
  leaseToken?: string;
  leaseUntil?: number;
  leaderEpoch?: number;
  /** `null` 表示已确认不是分片；`undefined` 仅用于兼容旧 KV 索引。 */
  splitId?: string | null;
  /** 服务端/冷却策略要求的最早再次尝试时间 */
  notBefore?: number;
  /** 服务端 Retry-After 的不可绕过期限（与 SDK 本地调度期限分离）。 */
  serverNotBefore?: number;
  /** parked 的跨生命周期退避次数 */
  parkCount?: number;
  /** 最近一次可重试失败的分类 */
  lastRetryReason?: string;
  /** 已进入终态但物理删除失败；hydrate 时只能继续删除，绝不能重放 */
  terminal?: true;
}

export interface OfflineRecord extends OfflineRecordMeta {
  log: LogEntry;
}

export interface OfflineStore {
  readonly backend: OfflineBackend;
  /** 本次数据库升级迁移的 2.5 记录数。 */
  readonly legacyMigrationCount?: number;
  /** A legacy database was observed, so mixed 2.5/2.6 tabs still need logId dedupe. */
  readonly mixedVersionRisk?: boolean;
  put(record: OfflineRecord): Promise<void>;
  /** IDB implements this as one transaction; split groups must never become partially visible. */
  putMany?(records: readonly OfflineRecord[]): Promise<void>;
  /**
   * 在一个事务内导入 2.5 快照。已存在的 v2 状态只能单调合并，绝不能覆盖租约。
   */
  importLegacy?(records: readonly OfflineRecord[]): Promise<void>;
  get(logId: string): Promise<OfflineRecord | null>;
  delete(logId: string): Promise<void>;
  /** 仅在初始化时调用一次，用于重建内存索引 */
  loadMeta(): Promise<OfflineRecordMeta[]>;
  clear(): Promise<void>;
  close(): void;
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (ancestors.has(value)) throw new Error('cyclic value in offline record');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`;
    }
    const object = value as Record<string, unknown>;
    const members = Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(object[key], ancestors)}`,
      );
    return `{${members.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function sameLogIdentity(left: OfflineRecord, right: OfflineRecord): boolean {
  return (
    left.logId === right.logId &&
    left.capturedAt === right.capturedAt &&
    left.log.timestamp === right.log.timestamp &&
    left.log.level === right.log.level &&
    left.log.message === right.log.message &&
    canonicalJson(left.log) === canonicalJson(right.log)
  );
}

/**
 * v1 是迁移输入，v2 是并发状态机的事实来源。合并只允许推进期限/计数；领取状态、
 * fence、网络尝试世代和正文全部保留 v2 值。
 */
export function mergePendingRecord(
  currentValue: OfflineRecord,
  pendingValue: OfflineRecord,
): OfflineRecord {
  const current = normalizeOfflineRecord(currentValue);
  const pending = normalizeOfflineRecord(pendingValue);
  if (!sameLogIdentity(current, pending)) {
    throw new Error(
      `pending logId conflicts with coordinated record: ${pending.logId}`,
    );
  }
  return normalizeOfflineRecord({
    ...pending,
    ...current,
    storedAt: Math.min(current.storedAt, pending.storedAt),
    priority: Math.max(current.priority, pending.priority),
    bytes: Math.max(current.bytes, pending.bytes),
    replayAttempts: Math.max(current.replayAttempts, pending.replayAttempts),
    deliveryAttempt: current.deliveryAttempt,
    state: current.state,
    nextEligibleAt: Math.max(
      current.nextEligibleAt ?? 0,
      pending.nextEligibleAt ?? 0,
    ),
    notBefore:
      Math.max(current.notBefore ?? 0, pending.notBefore ?? 0) || undefined,
    serverNotBefore:
      Math.max(current.serverNotBefore ?? 0, pending.serverNotBefore ?? 0) ||
      undefined,
    parkCount:
      Math.max(current.parkCount ?? 0, pending.parkCount ?? 0) || undefined,
    lastRetryReason: current.lastRetryReason ?? pending.lastRetryReason,
    terminal: current.terminal || pending.terminal ? true : undefined,
    leaseOwner: current.leaseOwner,
    leaseToken: current.leaseToken,
    leaseUntil: current.leaseUntil,
    leaderEpoch: current.leaderEpoch,
    log: current.log,
  });
}

function sameLegacySnapshotRecord(
  current: unknown,
  snapshot: OfflineRecord,
): boolean {
  if (!isOfflineRecord(current, snapshot.logId)) return false;
  return (
    canonicalJson(normalizeOfflineRecord(current)) ===
    canonicalJson(normalizeOfflineRecord(snapshot))
  );
}

/** IndexedDB open 超时：多 Tab `blocked` 或容器异常时不能无限等 */
const IDB_OPEN_TIMEOUT_MS = 3000;
const IDB_DATABASE_VERSION = 2;

function toMeta(record: OfflineRecord): OfflineRecordMeta {
  const rawSplitId = getSdkSplitId(record.log);
  return {
    schemaVersion: record.schemaVersion,
    logId: record.logId,
    storedAt: record.storedAt,
    capturedAt: record.capturedAt,
    priority: record.priority,
    bytes: record.bytes,
    replayAttempts: record.replayAttempts,
    deliveryAttempt: record.deliveryAttempt,
    state: record.state,
    nextEligibleAt: record.nextEligibleAt,
    leaseOwner: record.leaseOwner,
    leaseToken: record.leaseToken,
    leaseUntil: record.leaseUntil,
    leaderEpoch: record.leaderEpoch,
    splitId: rawSplitId === undefined ? null : String(rawSplitId),
    notBefore: record.notBefore,
    serverNotBefore: record.serverNotBefore,
    parkCount: record.parkCount,
    lastRetryReason: record.lastRetryReason,
    terminal: record.terminal,
  };
}

function isStorageNamespaceBinding(
  value: unknown,
  namespace?: string,
): value is StorageNamespaceBinding {
  if (value == null || typeof value !== 'object') return false;
  const binding = value as Partial<StorageNamespaceBinding>;
  return (
    binding.resource === 'offline-v2' &&
    binding.protocolVersion === 2 &&
    typeof binding.namespace === 'string' &&
    binding.namespace.length > 0 &&
    (namespace === undefined || binding.namespace === namespace)
  );
}

// ==================== noop ====================

export function createNoopStore(): OfflineStore {
  return {
    backend: 'noop',
    async put() {
      throw new Error('offline storage unavailable');
    },
    async get() {
      return null;
    },
    async delete() {
      /* nothing to delete */
    },
    async loadMeta() {
      return [];
    },
    async clear() {
      /* nothing to clear */
    },
    close() {
      /* nothing to close */
    },
  };
}

// ==================== KV（localStorage / 小程序 storage）====================

/**
 * 基于平台同步 KV 存储的实现
 *
 * 每条记录单独一个 key，另有一个索引 key 保存全部元数据 —— 这样写入一条日志
 * 不需要把整个队列读出来再写回去（那在几百条时会明显卡主线程）。
 */
export function createKeyValueStore(
  platform: PlatformAdapter,
  keyPrefix: string,
  namespace = keyPrefix,
): OfflineStore {
  if (typeof namespace !== 'string' || namespace.length === 0) {
    throw new Error('offline storage namespace is required');
  }
  const indexKey = `${keyPrefix}:index`;
  const namespaceKey = `${keyPrefix}:namespace-v2`;
  const recordKey = (logId: string) => `${keyPrefix}:r:${logId}`;
  const throwLastStorageError = (): void => {
    const error = platform.storage.consumeLastError?.();
    if (error !== undefined) throw error;
  };

  /** 首读为空时复读一次，区分一次性适配器故障与真实缺失。 */
  const readValue = (key: string): string | null => {
    let firstError: unknown;
    try {
      const value = platform.storage.getItem(key);
      throwLastStorageError();
      if (value !== null) return value;
    } catch (error) {
      firstError = error;
    }
    try {
      const value = platform.storage.getItem(key);
      throwLastStorageError();
      if (value !== null) return value;
      if (firstError !== undefined) throw firstError;
      return null;
    } catch (error) {
      throw firstError ?? error;
    }
  };

  const readIndex = (): OfflineRecordMeta[] => {
    const raw = readValue(indexKey);
    if (raw === null) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('offline key-value index is corrupted');
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        'offline key-value index is corrupted: expected an array',
      );
    }
    const metas: OfflineRecordMeta[] = [];
    for (const value of parsed) {
      if (isOfflineRecordMeta(value)) {
        metas.push(value);
        continue;
      }
      const logId =
        value && typeof value === 'object'
          ? (value as { logId?: unknown }).logId
          : undefined;
      if (typeof logId === 'string' && logId.length > 0) {
        throw new Error(
          'offline key-value index is corrupted: invalid metadata entry',
        );
      }
    }
    return metas;
  };

  const writeValue = (key: string, value: string): void => {
    platform.storage.setItem(key, value);
    throwLastStorageError();
    if (readValue(key) !== value) {
      throw new Error(`key-value storage write did not stick: ${key}`);
    }
  };

  const removeValue = (key: string): void => {
    platform.storage.removeItem(key);
    throwLastStorageError();
    if (readValue(key) !== null) {
      throw new Error(`key-value storage remove did not stick: ${key}`);
    }
  };

  const writeIndex = (metas: OfflineRecordMeta[]): void => {
    writeValue(indexKey, JSON.stringify(metas));
  };

  // KV 没有事务；持久绑定至少阻止后续生命周期把共享 keyPrefix 当成自己的
  // 队列。极窄的首次并发竞态仍属于 best-effort 后端的显式降级边界。
  const existingBinding = readValue(namespaceKey);
  if (existingBinding === null) {
    writeValue(
      namespaceKey,
      JSON.stringify({
        resource: 'offline-v2',
        protocolVersion: 2,
        namespace,
      } satisfies StorageNamespaceBinding),
    );
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existingBinding);
    } catch {
      throw new Error('offline key-value namespace binding is corrupted');
    }
    if (!isStorageNamespaceBinding(parsed)) {
      throw new Error('offline key-value namespace binding is corrupted');
    }
    if (parsed.namespace !== namespace) {
      throw new Error(
        `offline key-value resource is already bound to namespace "${parsed.namespace}"`,
      );
    }
  }

  return {
    backend: 'localstorage',

    async put(record) {
      if (!isOfflineRecord(record)) {
        const invalidId = (record as unknown as { logId?: unknown })?.logId;
        throw new Error(
          `offline key-value record is invalid: ${String(invalidId ?? '')}`,
        );
      }
      const normalized = normalizeOfflineRecord(record);
      const key = recordKey(normalized.logId);
      // put 同时承担新建与 retry deadline/attempts 更新。更新失败时必须恢复旧正文，
      // 不能把此前已经可靠落盘的副本当作“本次新写入”直接删掉。
      const previous = readValue(key);
      const previousMetas = readIndex();
      const nextMetas = previousMetas.filter(
        (m) => m.logId !== normalized.logId,
      );
      nextMetas.push(toMeta(normalized));
      const serialized = JSON.stringify(normalized);
      try {
        writeValue(key, serialized);
        writeIndex(nextMetas);
      } catch (err) {
        try {
          if (previous === null) removeValue(key);
          else writeValue(key, previous);
        } catch {
          /* ignore */
        }
        try {
          if (previousMetas.length === 0) removeValue(indexKey);
          else writeIndex(previousMetas);
        } catch {
          /* ignore */
        }
        throw err;
      }
    },

    async putMany(records) {
      if (records.length === 0) return;
      const normalized = records.map((record) => {
        if (!isOfflineRecord(record)) {
          const invalidId = (record as unknown as { logId?: unknown })?.logId;
          throw new Error(
            `offline key-value record is invalid: ${String(invalidId ?? '')}`,
          );
        }
        return normalizeOfflineRecord(record);
      });
      const ids = new Set(normalized.map((record) => record.logId));
      if (ids.size !== normalized.length) {
        throw new Error('offline key-value group contains duplicate logIds');
      }
      const previousMetas = readIndex();
      const previousBodies = new Map<string, string | null>();
      for (const record of normalized) {
        previousBodies.set(record.logId, readValue(recordKey(record.logId)));
      }
      const nextMetas = previousMetas.filter((meta) => !ids.has(meta.logId));
      nextMetas.push(...normalized.map(toMeta));
      try {
        for (const record of normalized) {
          writeValue(recordKey(record.logId), JSON.stringify(record));
        }
        writeIndex(nextMetas);
      } catch (error) {
        for (const [logId, previous] of previousBodies) {
          try {
            if (previous === null) removeValue(recordKey(logId));
            else writeValue(recordKey(logId), previous);
          } catch {
            /* best-effort backend rollback */
          }
        }
        try {
          if (previousMetas.length === 0) removeValue(indexKey);
          else writeIndex(previousMetas);
        } catch {
          /* preserve the original failure */
        }
        throw error;
      }
    },

    async get(logId) {
      const raw = readValue(recordKey(logId));
      if (raw === null) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!isOfflineRecord(parsed, logId)) {
        throw new Error(`offline record is corrupted: ${logId}`);
      }
      return normalizeOfflineRecord(parsed);
    },

    async delete(logId) {
      const key = recordKey(logId);
      const previous = readValue(key);
      const previousMetas = readIndex();
      const nextMetas = previousMetas.filter((m) => m.logId !== logId);
      try {
        removeValue(key);
        if (nextMetas.length === 0) removeValue(indexKey);
        else writeIndex(nextMetas);
      } catch (error) {
        try {
          if (previous !== null) writeValue(key, previous);
        } catch {
          /* ignore */
        }
        try {
          if (previousMetas.length === 0) removeValue(indexKey);
          else writeIndex(previousMetas);
        } catch {
          /* ignore */
        }
        throw error;
      }
    },

    async loadMeta() {
      return readIndex();
    },

    async clear() {
      const metas = readIndex();
      const remaining: OfflineRecordMeta[] = [];
      let firstError: unknown;
      for (const meta of metas) {
        try {
          removeValue(recordKey(meta.logId));
        } catch (error) {
          remaining.push(meta);
          firstError ??= error;
        }
      }
      try {
        if (remaining.length > 0) writeIndex(remaining);
        else removeValue(indexKey);
      } catch (error) {
        firstError ??= error;
      }
      if (firstError !== undefined) throw firstError;
    },

    close() {
      /* nothing to close */
    },
  };
}

// ==================== IndexedDB ====================

function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    // 部分环境访问 indexedDB 本身就会抛（如禁用 cookie 的 Safari 隐私模式）
    return false;
  }
}

function openDatabase(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(dbName, IDB_DATABASE_VERSION);
    } catch (err) {
      reject(err);
      return;
    }

    // 放弃等待之后连接可能仍会打开。不主动关掉的话，这个没人持有的连接会一直
    // 挂着，把别的 Tab 的版本升级 / 删库永久卡住。
    let abandoned = false;
    const abandon = (err: Error) =>
      finish(() => {
        abandoned = true;
        reject(err);
      });

    const timer = setTimeout(
      () => abandon(new Error('IndexedDB open timed out')),
      IDB_OPEN_TIMEOUT_MS,
    );

    let upgradeError: unknown;
    request.onupgradeneeded = () => {
      const db = request.result;
      const tx = request.transaction;
      if (!tx) {
        upgradeError = new Error(
          'IndexedDB upgrade transaction is unavailable',
        );
        return;
      }
      try {
        if (!db.objectStoreNames.contains(IDB_RECORDS_STORE_NAME)) {
          db.createObjectStore(IDB_RECORDS_STORE_NAME, { keyPath: 'logId' });
        }
        if (!db.objectStoreNames.contains(IDB_COORDINATION_STORE_NAME)) {
          db.createObjectStore(IDB_COORDINATION_STORE_NAME, {
            keyPath: 'namespace',
          });
        }
        if (!db.objectStoreNames.contains(IDB_SPLIT_PROGRESS_STORE_NAME)) {
          db.createObjectStore(IDB_SPLIT_PROGRESS_STORE_NAME, {
            keyPath: 'id',
          });
        }
        if (!db.objectStoreNames.contains(IDB_NAMESPACE_STORE_NAME)) {
          db.createObjectStore(IDB_NAMESPACE_STORE_NAME, {
            keyPath: 'resource',
          });
        }
      } catch (error) {
        upgradeError = error;
        try {
          tx.abort();
        } catch {
          /* ignore */
        }
        return;
      }
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      const db = request.result;
      if (abandoned) {
        try {
          db.close();
        } catch {
          /* ignore */
        }
        return;
      }
      finish(() => resolve(db));
    };
    request.onerror = () => {
      clearTimeout(timer);
      finish(() =>
        reject(
          upgradeError ?? request.error ?? new Error('IndexedDB open failed'),
        ),
      );
    };
    request.onblocked = () => {
      clearTimeout(timer);
      abandon(new Error('IndexedDB open blocked by another tab'));
    };
  });
}

export async function createIndexedDbStore(
  dbName: string,
  namespace = dbName,
): Promise<OfflineStore> {
  if (typeof namespace !== 'string' || namespace.length === 0) {
    throw new Error('offline storage namespace is required');
  }
  const db = await openDatabase(dbName);

  // 同名库已经存在、但里面没有我们的 object store（多半是 dbName 撞上了宿主自己的库）。
  // 这时每一次读写都会抛 NotFoundError，不如当场认输，让工厂降级到 KV 存储。
  if (
    !db.objectStoreNames.contains(IDB_RECORDS_STORE_NAME) ||
    !db.objectStoreNames.contains(IDB_COORDINATION_STORE_NAME) ||
    !db.objectStoreNames.contains(IDB_SPLIT_PROGRESS_STORE_NAME) ||
    !db.objectStoreNames.contains(IDB_NAMESPACE_STORE_NAME)
  ) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    throw new Error(
      `IndexedDB "${dbName}" does not implement the v2 offline protocol`,
    );
  }

  // 别的 Tab 要升级或删除这个库时，必须让出连接，否则对方会一直卡在 blocked
  db.onversionchange = () => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  };

  const withStores = <T>(
    storeNames: readonly string[],
    mode: IDBTransactionMode,
    run: (tx: IDBTransaction) => Promise<T> | T,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      let operationSettled = false;
      let transactionCompleted = false;
      let operationResult: T;
      let promiseSettled = false;
      const rejectOnce = (error: unknown): void => {
        if (promiseSettled) return;
        promiseSettled = true;
        reject(error);
      };
      const resolveWhenCommitted = (): void => {
        if (promiseSettled || !operationSettled || !transactionCompleted)
          return;
        promiseSettled = true;
        resolve(operationResult);
      };
      try {
        tx = db.transaction([...storeNames], mode);
      } catch (err) {
        rejectOnce(err);
        return;
      }
      tx.oncomplete = () => {
        transactionCompleted = true;
        resolveWhenCommitted();
      };
      tx.onabort = () =>
        rejectOnce(tx.error ?? new Error('IndexedDB transaction aborted'));
      tx.onerror = () =>
        rejectOnce(tx.error ?? new Error('IndexedDB transaction failed'));
      // 同步发起请求：事务只在当前任务内有效，推迟到后续微任务再碰 store
      // 就可能撞上 TransactionInactiveError
      try {
        Promise.resolve(run(tx)).then(
          (value) => {
            operationResult = value;
            operationSettled = true;
            resolveWhenCommitted();
          },
          (error) => {
            try {
              tx.abort();
            } catch {
              /* transaction may already be inactive */
            }
            rejectOnce(error);
          },
        );
      } catch (err) {
        try {
          tx.abort();
        } catch {
          /* transaction may already be inactive */
        }
        rejectOnce(err);
      }
    });

  const withRecordStore = <T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => Promise<T> | T,
  ): Promise<T> =>
    withStores([IDB_RECORDS_STORE_NAME], mode, (tx) =>
      run(tx.objectStore(IDB_RECORDS_STORE_NAME)),
    );

  // leader/lease 的 namespace 隔离并不能隔离共用 dbName 的日志正文。任何正文
  // 读写前先原子绑定物理数据库，冲突项目只能安全降级，不能读取对方记录。
  try {
    await withStores([IDB_NAMESPACE_STORE_NAME], 'readwrite', async (tx) => {
      const store = tx.objectStore(IDB_NAMESPACE_STORE_NAME);
      const current = await requestToPromise<unknown>(store.get('offline-v2'));
      if (current === undefined) {
        await requestToPromise(
          store.put({
            resource: 'offline-v2',
            protocolVersion: 2,
            namespace,
          } satisfies StorageNamespaceBinding),
        );
        return;
      }
      if (!isStorageNamespaceBinding(current)) {
        throw new Error('offline IndexedDB namespace binding is corrupted');
      }
      if (current.namespace !== namespace) {
        throw new Error(
          `offline IndexedDB resource is already bound to namespace "${current.namespace}"`,
        );
      }
    });
  } catch (error) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    throw error;
  }
  const offlineStore: OfflineStore = {
    backend: 'indexeddb',
    legacyMigrationCount: 0,

    put(record) {
      if (!isOfflineRecord(record)) {
        const invalidId = (record as unknown as { logId?: unknown })?.logId;
        return Promise.reject(
          new Error(
            `offline IndexedDB record is invalid: ${String(invalidId ?? '')}`,
          ),
        );
      }
      const normalized = normalizeOfflineRecord(record);
      return withRecordStore('readwrite', (store) =>
        requestToPromise(store.put(normalized)).then(() => undefined),
      );
    },

    async putMany(records) {
      if (records.length === 0) return;
      const normalized = records.map((record) => {
        if (!isOfflineRecord(record)) {
          const invalidId = (record as unknown as { logId?: unknown })?.logId;
          throw new Error(
            `offline IndexedDB record is invalid: ${String(invalidId ?? '')}`,
          );
        }
        return normalizeOfflineRecord(record);
      });
      await withRecordStore('readwrite', async (store) => {
        await Promise.all(
          normalized.map((record) => requestToPromise(store.put(record))),
        );
      });
    },

    async importLegacy(records) {
      if (records.length === 0) return;
      const normalized = records.map((record) => {
        if (!isOfflineRecord(record)) {
          const invalidId = (record as unknown as { logId?: unknown })?.logId;
          throw new Error(
            `legacy IndexedDB record is invalid: ${String(invalidId ?? '')}`,
          );
        }
        return normalizeOfflineRecord(record);
      });
      const ids = new Set(normalized.map((record) => record.logId));
      if (ids.size !== normalized.length) {
        throw new Error('legacy IndexedDB snapshot contains duplicate logIds');
      }
      await withRecordStore('readwrite', async (store) => {
        const currentValues = await Promise.all(
          normalized.map((record) =>
            requestToPromise<unknown>(store.get(record.logId)),
          ),
        );
        const merged = normalized.map((record, index) => {
          const current = currentValues[index];
          if (current === undefined) return record;
          if (!isOfflineRecord(current, record.logId)) {
            throw new Error(
              `offline IndexedDB record is corrupted: ${record.logId}`,
            );
          }
          return mergePendingRecord(current, record);
        });
        await Promise.all(
          merged.map((record) => requestToPromise(store.put(record))),
        );
      });
    },

    get(logId) {
      return withRecordStore('readonly', (store) =>
        requestToPromise<unknown>(store.get(logId)).then((record) => {
          if (record === undefined) return null;
          if (!isOfflineRecord(record, logId)) {
            throw new Error(`offline IndexedDB record is corrupted: ${logId}`);
          }
          return normalizeOfflineRecord(record);
        }),
      );
    },

    delete(logId) {
      return withRecordStore('readwrite', (store) =>
        requestToPromise(store.delete(logId)).then(() => undefined),
      );
    },

    /**
     * 用游标逐条读取并只保留元数据
     *
     * 不用 `getAll()`：那会把全部日志正文一次性拉进内存，配额较大时是明显的内存尖峰。
     */
    loadMeta() {
      return withRecordStore(
        'readonly',
        (store) =>
          new Promise<OfflineRecordMeta[]>((resolve, reject) => {
            const metas: OfflineRecordMeta[] = [];
            const request = store.openCursor();
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor) {
                resolve(metas);
                return;
              }
              const value: unknown = cursor.value;
              if (!isOfflineRecord(value)) {
                reject(new Error('offline IndexedDB record is corrupted'));
                return;
              }
              metas.push(toMeta(normalizeOfflineRecord(value)));
              cursor.continue();
            };
            request.onerror = () =>
              reject(request.error ?? new Error('IndexedDB cursor failed'));
          }),
      );
    },

    clear() {
      return withStores(
        [
          IDB_RECORDS_STORE_NAME,
          IDB_COORDINATION_STORE_NAME,
          IDB_SPLIT_PROGRESS_STORE_NAME,
        ],
        'readwrite',
        async (tx) => {
          await Promise.all([
            requestToPromise(tx.objectStore(IDB_RECORDS_STORE_NAME).clear()),
            requestToPromise(
              tx.objectStore(IDB_COORDINATION_STORE_NAME).clear(),
            ),
            requestToPromise(
              tx.objectStore(IDB_SPLIT_PROGRESS_STORE_NAME).clear(),
            ),
          ]);
        },
      );
    },

    close() {
      deleteIndexedDbStoreContext(offlineStore);
      try {
        db.close();
      } catch {
        /* ignore */
      }
    },
  };
  setIndexedDbStoreContext(offlineStore, { withStores, withRecordStore });
  return offlineStore;
}

interface LegacySnapshot {
  records: OfflineRecord[];
  close(): void;
  deleteMigrated(records: readonly OfflineRecord[]): Promise<void>;
}

/**
 * Read the v1 database without ever upgrading it.  Aborting an oldVersion=0
 * open avoids creating an empty legacy database for first-time 2.6 users.
 */
function openLegacySnapshot(dbName: string): Promise<LegacySnapshot | null> {
  return new Promise((resolve, reject) => {
    let missing = false;
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(dbName, 1);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = (event) => {
      if (event.oldVersion === 0) {
        missing = true;
        request.transaction?.abort();
      }
    };
    request.onerror = () => {
      if (missing) {
        resolve(null);
        return;
      }
      reject(request.error ?? new Error('legacy IndexedDB open failed'));
    };
    request.onblocked = () =>
      reject(new Error('legacy IndexedDB open blocked'));
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('records')) {
        db.close();
        resolve(null);
        return;
      }
      db.onversionchange = () => db.close();
      let tx: IDBTransaction;
      try {
        tx = db.transaction('records', 'readonly');
      } catch (error) {
        db.close();
        reject(error);
        return;
      }
      const records: OfflineRecord[] = [];
      const cursorRequest = tx.objectStore('records').openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        if (!isOfflineRecord(cursor.value)) {
          try {
            tx.abort();
          } catch {
            /* transaction may already be inactive */
          }
          reject(new Error('legacy offline record is corrupted'));
          return;
        }
        records.push(cursor.value);
        cursor.continue();
      };
      cursorRequest.onerror = () =>
        reject(
          cursorRequest.error ?? new Error('legacy IndexedDB cursor failed'),
        );
      tx.onabort = () => {
        db.close();
        reject(tx.error ?? new Error('legacy IndexedDB read aborted'));
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error ?? new Error('legacy IndexedDB read failed'));
      };
      tx.oncomplete = () =>
        resolve({
          records,
          close: () => db.close(),
          deleteMigrated: (migratedRecords) =>
            new Promise<void>((resolveDelete, rejectDelete) => {
              if (migratedRecords.length === 0) {
                resolveDelete();
                return;
              }
              let deleteTx: IDBTransaction;
              try {
                deleteTx = db.transaction('records', 'readwrite');
              } catch (error) {
                rejectDelete(error);
                return;
              }
              const store = deleteTx.objectStore('records');
              const reads = migratedRecords.map((record) =>
                requestToPromise<unknown>(store.get(record.logId)),
              );
              void Promise.all(reads)
                .then(async (currentValues) => {
                  const deletions = migratedRecords.flatMap((record, index) =>
                    sameLegacySnapshotRecord(currentValues[index], record)
                      ? [requestToPromise(store.delete(record.logId))]
                      : [],
                  );
                  await Promise.all(deletions);
                })
                .catch((error) => {
                  try {
                    deleteTx.abort();
                  } catch {
                    /* transaction may already be inactive */
                  }
                  rejectDelete(error);
                });
              deleteTx.oncomplete = () => resolveDelete();
              deleteTx.onerror = () =>
                rejectDelete(
                  deleteTx.error ?? new Error('legacy IndexedDB delete failed'),
                );
              deleteTx.onabort = () =>
                rejectDelete(
                  deleteTx.error ??
                    new Error('legacy IndexedDB delete aborted'),
                );
            }),
        });
    };
  });
}

async function migrateLegacyRecords(
  legacyDbName: string,
  namespace: string,
  canonicalNamespace: string,
  target: OfflineStore,
): Promise<{ count: number; mixedVersionRisk: boolean }> {
  // A custom namespace is an explicit isolation boundary.  An unbound v1
  // database cannot prove that it belongs to that namespace, so do not even
  // read its bodies.  Users can opt into migration by retaining the canonical
  // dbName:key identity for one upgrade.
  if (namespace !== canonicalNamespace)
    return { count: 0, mixedVersionRisk: false };
  const snapshot = await openLegacySnapshot(legacyDbName);
  if (!snapshot) return { count: 0, mixedVersionRisk: false };
  try {
    if (snapshot.records.length === 0)
      return { count: 0, mixedVersionRisk: true };
    if (!target.importLegacy) {
      throw new Error(
        'coordinated IndexedDB store lacks transactional legacy import',
      );
    }
    const normalized = snapshot.records.map(normalizeOfflineRecord);
    await target.importLegacy(normalized);
    // 只有 v1 当前值仍与快照完全一致时才删除。活跃 2.5 tab 在复制期间对同一
    // logId 的任何更新都会保留，并由下一轮迁移单调并入 v2。
    await snapshot.deleteMigrated(normalized);
    return { count: normalized.length, mixedVersionRisk: true };
  } finally {
    snapshot.close();
  }
}

// ==================== 工厂 ====================

export interface CreateStoreOptions {
  preference: 'auto' | 'indexeddb' | 'localstorage';
  platform: PlatformAdapter;
  dbName: string;
  keyPrefix: string;
  namespace?: string;
  /** 清盘等场景要求命中指定后端，禁止把失败自动降级成另一个后端。 */
  allowFallback?: boolean;
  onFallback?: (from: string, reason: unknown) => void;
}

/**
 * 按偏好创建存储，失败时逐级降级
 *
 * 注意：`preference: 'indexeddb'` 表达的是"优先用"，不是"保证用" —— 宿主不支持
 * 时仍会降级，否则等于让用户在"不可用"和"崩溃"之间二选一。
 */
export async function createOfflineStore(
  options: CreateStoreOptions,
): Promise<OfflineStore> {
  const {
    preference,
    platform,
    dbName,
    keyPrefix,
    namespace = `${dbName}:${keyPrefix}`,
    allowFallback = true,
    onFallback,
  } = options;

  if (preference !== 'localstorage') {
    if (hasIndexedDb()) {
      try {
        const store = await createIndexedDbStore(
          coordinatedDatabaseName(dbName),
          namespace,
        );
        try {
          const migration = await migrateLegacyRecords(
            dbName,
            namespace,
            `${dbName}:${keyPrefix}`,
            store,
          );
          Object.defineProperties(store, {
            legacyMigrationCount: { value: migration.count, enumerable: true },
            mixedVersionRisk: {
              value: migration.mixedVersionRisk,
              enumerable: true,
            },
          });
          return store;
        } catch (error) {
          store.close();
          throw error;
        }
      } catch (err) {
        onFallback?.('indexeddb', err);
        if (!allowFallback) throw err;
      }
    } else if (!allowFallback) {
      const error = new Error('IndexedDB is unavailable');
      onFallback?.('indexeddb', error);
      throw error;
    }
  }

  // No strong IndexedDB means no v2 protocol at all.  Returning the original
  // 2.5 KV/noop store keeps the unsupported-plugin path byte-for-byte
  // compatible instead of writing namespace-v2 metadata into the default key.
  return createLegacyOfflineStore({
    preference: 'localstorage',
    platform,
    dbName,
    keyPrefix,
    allowFallback,
    onFallback,
  }) as unknown as OfflineStore;
}
