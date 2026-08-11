/**
 * 离线持久化存储层
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

export type OfflineBackend = 'indexeddb' | 'localstorage' | 'noop';

export interface OfflineRecordMeta {
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
  put(record: OfflineRecord): Promise<void>;
  get(logId: string): Promise<OfflineRecord | null>;
  delete(logId: string): Promise<void>;
  /** 仅在初始化时调用一次，用于重建内存索引 */
  loadMeta(): Promise<OfflineRecordMeta[]>;
  clear(): Promise<void>;
  close(): void;
}

/** IndexedDB open 超时：多 Tab `blocked` 或容器异常时不能无限等 */
const IDB_OPEN_TIMEOUT_MS = 3000;
const IDB_STORE_NAME = 'records';

function toMeta(record: OfflineRecord): OfflineRecordMeta {
  const rawSplitId = getSdkSplitId(record.log);
  return {
    logId: record.logId,
    storedAt: record.storedAt,
    capturedAt: record.capturedAt,
    priority: record.priority,
    bytes: record.bytes,
    replayAttempts: record.replayAttempts,
    splitId: rawSplitId === undefined ? null : String(rawSplitId),
    notBefore: record.notBefore,
    serverNotBefore: record.serverNotBefore,
    parkCount: record.parkCount,
    lastRetryReason: record.lastRetryReason,
    terminal: record.terminal,
  };
}

function isOfflineRecordMeta(value: unknown): value is OfflineRecordMeta {
  if (value == null || typeof value !== 'object') return false;
  const meta = value as Partial<OfflineRecordMeta>;
  return typeof meta.logId === 'string'
    && meta.logId.length > 0
    && Number.isFinite(meta.storedAt)
    && meta.storedAt! >= 0
    && Number.isFinite(meta.capturedAt)
    && meta.capturedAt! >= 0
    && Number.isFinite(meta.priority)
    && Number.isSafeInteger(meta.bytes)
    && meta.bytes! >= 0
    && Number.isSafeInteger(meta.replayAttempts)
    && meta.replayAttempts! >= 0
    && (meta.splitId === undefined || meta.splitId === null || typeof meta.splitId === 'string')
    && (meta.notBefore === undefined || Number.isFinite(meta.notBefore))
    && (meta.serverNotBefore === undefined || Number.isFinite(meta.serverNotBefore))
    && (meta.parkCount === undefined
      || (Number.isSafeInteger(meta.parkCount) && meta.parkCount >= 0))
    && (meta.lastRetryReason === undefined || typeof meta.lastRetryReason === 'string')
    && (meta.terminal === undefined || typeof meta.terminal === 'boolean');
}

function isOfflineRecord(value: unknown, expectedLogId?: string): value is OfflineRecord {
  if (value == null || typeof value !== 'object') return false;
  const record = value as Partial<OfflineRecord>;
  if (!isOfflineRecordMeta(record)) return false;
  const recordWithLog = value as Partial<OfflineRecord>;
  if (
    (expectedLogId !== undefined && record.logId !== expectedLogId) ||
    recordWithLog.log == null ||
    typeof recordWithLog.log !== 'object'
  ) {
    return false;
  }
  const log = recordWithLog.log as Partial<LogEntry>;
  const logSplitId = getSdkSplitId(log as LogEntry);
  const rawBusinessSplitId = log.tags && typeof log.tags === 'object'
    ? (log.tags as Record<string, unknown>)['splitId']
    : undefined;
  // 兼容旧版本把裸业务 splitId 冗余进 record.splitId 的副本；hydrate 会把它
  // 规范化为 null。新写入只有真正带坐标的 SDK 分片才允许非空 splitId。
  const legacyBareSplit = logSplitId === undefined
    && rawBusinessSplitId !== undefined
    && record.splitId === String(rawBusinessSplitId);
  const splitIdentityMatches = logSplitId === undefined
    ? record.splitId === undefined || record.splitId === null || legacyBareSplit
    : record.splitId === undefined || record.splitId === logSplitId;
  return log.logId === record.logId
    && typeof log.message === 'string'
    && (log.level === 'debug'
      || log.level === 'info'
      || log.level === 'track'
      || log.level === 'warn'
      || log.level === 'error')
    && Number.isFinite(log.timestamp)
    && log.timestamp! >= 0
    && record.capturedAt === log.timestamp
    && splitIdentityMatches
    && (log.requestId === undefined || typeof log.requestId === 'string')
    && (log.tags === undefined || (log.tags !== null && typeof log.tags === 'object'));
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
): OfflineStore {
  const indexKey = `${keyPrefix}:index`;
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
      throw new Error('offline key-value index is corrupted: expected an array');
    }
    const metas: OfflineRecordMeta[] = [];
    for (const value of parsed) {
      if (isOfflineRecordMeta(value)) {
        metas.push(value);
        continue;
      }
      const logId = value && typeof value === 'object'
        ? (value as { logId?: unknown }).logId
        : undefined;
      if (typeof logId === 'string' && logId.length > 0) {
        throw new Error('offline key-value index is corrupted: invalid metadata entry');
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

  return {
    backend: 'localstorage',

    async put(record) {
      if (!isOfflineRecord(record)) {
        const invalidId = (record as unknown as { logId?: unknown })?.logId;
        throw new Error(`offline key-value record is invalid: ${String(invalidId ?? '')}`);
      }
      const key = recordKey(record.logId);
      // put 同时承担新建与 retry deadline/attempts 更新。更新失败时必须恢复旧正文，
      // 不能把此前已经可靠落盘的副本当作“本次新写入”直接删掉。
      const previous = readValue(key);
      const previousMetas = readIndex();
      const nextMetas = previousMetas.filter((m) => m.logId !== record.logId);
      nextMetas.push(toMeta(record));
      const serialized = JSON.stringify(record);
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

    async get(logId) {
      const raw = readValue(recordKey(logId));
      if (raw === null) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!isOfflineRecord(parsed, logId)) {
        throw new Error(`offline record is corrupted: ${logId}`);
      }
      return parsed;
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
      request = indexedDB.open(dbName, 1);
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

    const timer = setTimeout(() => abandon(new Error('IndexedDB open timed out')), IDB_OPEN_TIMEOUT_MS);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
        db.createObjectStore(IDB_STORE_NAME, { keyPath: 'logId' });
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
      finish(() => reject(request.error ?? new Error('IndexedDB open failed')));
    };
    request.onblocked = () => {
      clearTimeout(timer);
      abandon(new Error('IndexedDB open blocked by another tab'));
    };
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export async function createIndexedDbStore(dbName: string): Promise<OfflineStore> {
  const db = await openDatabase(dbName);

  // 同名库已经存在、但里面没有我们的 object store（多半是 dbName 撞上了宿主自己的库）。
  // 这时每一次读写都会抛 NotFoundError，不如当场认输，让工厂降级到 KV 存储。
  if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    throw new Error(`IndexedDB "${dbName}" has no "${IDB_STORE_NAME}" object store`);
  }

  // 别的 Tab 要升级或删除这个库时，必须让出连接，否则对方会一直卡在 blocked
  db.onversionchange = () => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  };

  const withStore = <T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => Promise<T> | T,
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
        if (promiseSettled || !operationSettled || !transactionCompleted) return;
        promiseSettled = true;
        resolve(operationResult);
      };
      try {
        tx = db.transaction(IDB_STORE_NAME, mode);
      } catch (err) {
        rejectOnce(err);
        return;
      }
      tx.oncomplete = () => {
        transactionCompleted = true;
        resolveWhenCommitted();
      };
      tx.onabort = () => rejectOnce(tx.error ?? new Error('IndexedDB transaction aborted'));
      tx.onerror = () => rejectOnce(tx.error ?? new Error('IndexedDB transaction failed'));
      // 同步发起请求：事务只在当前任务内有效，推迟到后续微任务再碰 store
      // 就可能撞上 TransactionInactiveError
      try {
        Promise.resolve(run(tx.objectStore(IDB_STORE_NAME))).then(
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

  return {
    backend: 'indexeddb',

    put(record) {
      if (!isOfflineRecord(record)) {
        const invalidId = (record as unknown as { logId?: unknown })?.logId;
        return Promise.reject(
          new Error(`offline IndexedDB record is invalid: ${String(invalidId ?? '')}`),
        );
      }
      return withStore('readwrite', (store) => requestToPromise(store.put(record)).then(() => undefined));
    },

    get(logId) {
      return withStore('readonly', (store) =>
        requestToPromise<unknown>(store.get(logId)).then((record) => {
          if (record === undefined) return null;
          if (!isOfflineRecord(record, logId)) {
            throw new Error(`offline IndexedDB record is corrupted: ${logId}`);
          }
          return record;
        }),
      );
    },

    delete(logId) {
      return withStore('readwrite', (store) =>
        requestToPromise(store.delete(logId)).then(() => undefined),
      );
    },

    /**
     * 用游标逐条读取并只保留元数据
     *
     * 不用 `getAll()`：那会把全部日志正文一次性拉进内存，配额较大时是明显的内存尖峰。
     */
    loadMeta() {
      return withStore(
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
              metas.push(toMeta(value));
              cursor.continue();
            };
            request.onerror = () =>
              reject(request.error ?? new Error('IndexedDB cursor failed'));
          }),
      );
    },

    clear() {
      return withStore('readwrite', (store) =>
        requestToPromise(store.clear()).then(() => undefined),
      );
    },

    close() {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    },
  };
}

// ==================== 工厂 ====================

export interface CreateStoreOptions {
  preference: 'auto' | 'indexeddb' | 'localstorage';
  platform: PlatformAdapter;
  dbName: string;
  keyPrefix: string;
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
export async function createOfflineStore(options: CreateStoreOptions): Promise<OfflineStore> {
  const { preference, platform, dbName, keyPrefix, allowFallback = true, onFallback } = options;

  if (preference !== 'localstorage') {
    if (hasIndexedDb()) {
      try {
        return await createIndexedDbStore(dbName);
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

  if (probeKeyValueStorage(platform, keyPrefix)) {
    return createKeyValueStore(platform, keyPrefix);
  }
  const error = new Error('key-value storage is not writable');
  onFallback?.('localstorage', error);
  if (!allowFallback) throw error;
  return createNoopStore();
}

/**
 * 写入后**回读校验**，而不是只看 setItem 有没有抛异常
 *
 * `PlatformAdapter.storage` 的公开方法为兼容旧调用仍不向外抛底层异常；这里通过
 * 错误通道和回读同时验证写、读、删三个能力，避免把部分可用的存储误判为可靠后端。
 */
function probeKeyValueStorage(platform: PlatformAdapter, keyPrefix: string): boolean {
  const probeKey = `${keyPrefix}:probe`;
  const token = `${Date.now()}`;
  const throwLastStorageError = (): void => {
    const error = platform.storage.consumeLastError?.();
    if (error !== undefined) throw error;
  };
  try {
    platform.storage.setItem(probeKey, token);
    throwLastStorageError();
    const readBack = platform.storage.getItem(probeKey);
    throwLastStorageError();
    platform.storage.removeItem(probeKey);
    throwLastStorageError();
    const removed = platform.storage.getItem(probeKey);
    throwLastStorageError();
    return readBack === token && removed === null;
  } catch {
    // 清掉适配器可能尚未被消费的最后一次错误，避免污染后续探测。
    platform.storage.consumeLastError?.();
    return false;
  }
}
