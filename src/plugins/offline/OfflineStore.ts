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
  return {
    logId: record.logId,
    storedAt: record.storedAt,
    capturedAt: record.capturedAt,
    priority: record.priority,
    bytes: record.bytes,
    replayAttempts: record.replayAttempts,
  };
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

  const readIndex = (): OfflineRecordMeta[] => {
    try {
      const raw = platform.storage.getItem(indexKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as OfflineRecordMeta[]) : [];
    } catch {
      return [];
    }
  };

  const writeIndex = (metas: OfflineRecordMeta[]): void => {
    platform.storage.setItem(indexKey, JSON.stringify(metas));
  };

  return {
    backend: 'localstorage',

    async put(record) {
      // 先写记录本体再更新索引：反过来的话中途失败会留下"索引里有、实际没有"的幽灵项
      platform.storage.setItem(recordKey(record.logId), JSON.stringify(record));
      const metas = readIndex().filter((m) => m.logId !== record.logId);
      metas.push(toMeta(record));
      try {
        writeIndex(metas);
      } catch (err) {
        // 索引写失败就把刚写的记录回滚掉，避免不可回收的孤儿
        try {
          platform.storage.removeItem(recordKey(record.logId));
        } catch {
          /* ignore */
        }
        throw err;
      }
    },

    async get(logId) {
      try {
        const raw = platform.storage.getItem(recordKey(logId));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as OfflineRecord;
        return parsed && parsed.log ? parsed : null;
      } catch {
        return null;
      }
    },

    async delete(logId) {
      try {
        platform.storage.removeItem(recordKey(logId));
      } catch {
        /* ignore */
      }
      try {
        writeIndex(readIndex().filter((m) => m.logId !== logId));
      } catch {
        /* ignore */
      }
    },

    async loadMeta() {
      return readIndex();
    },

    async clear() {
      for (const meta of readIndex()) {
        try {
          platform.storage.removeItem(recordKey(meta.logId));
        } catch {
          /* ignore */
        }
      }
      try {
        platform.storage.removeItem(indexKey);
      } catch {
        /* ignore */
      }
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
      try {
        tx = db.transaction(IDB_STORE_NAME, mode);
      } catch (err) {
        reject(err);
        return;
      }
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      // 同步发起请求：事务只在当前任务内有效，推迟到后续微任务再碰 store
      // 就可能撞上 TransactionInactiveError
      try {
        Promise.resolve(run(tx.objectStore(IDB_STORE_NAME))).then(resolve, reject);
      } catch (err) {
        reject(err);
      }
    });

  return {
    backend: 'indexeddb',

    put(record) {
      return withStore('readwrite', (store) => requestToPromise(store.put(record)).then(() => undefined));
    },

    get(logId) {
      return withStore('readonly', (store) =>
        requestToPromise<OfflineRecord | undefined>(store.get(logId)).then((r) => r ?? null),
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
              const value = cursor.value as OfflineRecord | undefined;
              if (value && typeof value.logId === 'string') {
                metas.push(toMeta(value));
              }
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
  onFallback?: (from: string, reason: unknown) => void;
}

/**
 * 按偏好创建存储，失败时逐级降级
 *
 * 注意：`preference: 'indexeddb'` 表达的是"优先用"，不是"保证用" —— 宿主不支持
 * 时仍会降级，否则等于让用户在"不可用"和"崩溃"之间二选一。
 */
export async function createOfflineStore(options: CreateStoreOptions): Promise<OfflineStore> {
  const { preference, platform, dbName, keyPrefix, onFallback } = options;

  if (preference !== 'localstorage' && hasIndexedDb()) {
    try {
      return await createIndexedDbStore(dbName);
    } catch (err) {
      onFallback?.('indexeddb', err);
    }
  }

  if (probeKeyValueStorage(platform, keyPrefix)) {
    return createKeyValueStore(platform, keyPrefix);
  }
  onFallback?.('localstorage', new Error('key-value storage is not writable'));
  return createNoopStore();
}

/**
 * 写入后**回读校验**，而不是只看 setItem 有没有抛异常
 *
 * `PlatformAdapter.storage` 会吞掉底层异常（隐私模式、配额已满、容器禁用存储都
 * 只是静默失败），所以"没抛错"完全不能说明写进去了。不回读的话，插件会一路
 * 报告 `backend: 'localstorage'`，实际上一条都没落盘。
 */
function probeKeyValueStorage(platform: PlatformAdapter, keyPrefix: string): boolean {
  const probeKey = `${keyPrefix}:probe`;
  const token = `${Date.now()}`;
  try {
    platform.storage.setItem(probeKey, token);
    const readBack = platform.storage.getItem(probeKey);
    platform.storage.removeItem(probeKey);
    return readBack === token;
  } catch {
    return false;
  }
}
