/**
 * OfflineStore —— IndexedDB 故障路径
 *
 * 覆盖率显示 OfflineStore 的 `request.onerror` / `tx.onabort` / `tx.onerror` /
 * 游标失败这几条分支从未被执行过。它们恰恰是生产环境真正会走的路：配额耗尽、
 * 库损坏、用户中途清了存储、隐私模式。而本 SDK 有过"未处理的 rejection 引发
 * 自噬热循环"的前科，所以这些 reject 有没有人接住，必须钉死。
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { OfflinePersistencePlugin } from '../src/plugins/OfflinePersistencePlugin';
import { UploadPlugin, type UploadResult } from '../src/plugins/UploadPlugin';
import { AemeathLogger } from '../src/core/Logger';
import { createNoopAdapter } from '../src/platform/noop';
import {
  createIndexedDbStore,
  createKeyValueStore,
  createOfflineStore,
  type OfflineRecord,
} from '../src/plugins/offline/OfflineStore';
import { LogLevel } from '../src/types';

function setOnLine(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', {
    value,
    configurable: true,
    writable: true,
  });
}

/** 让出真实事件循环，等异步存储操作跑完 */
const settle = async (times = 20): Promise<void> => {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('OfflineStore —— IndexedDB 故障不能逃逸成未处理 rejection', () => {
  let logger: AemeathLogger;
  let rejections: unknown[];
  let onRejection: (e: PromiseRejectionEvent) => void;

  beforeEach(() => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    setOnLine(true);
    logger = new AemeathLogger({ enableConsole: false });
    rejections = [];
    onRejection = (e: PromiseRejectionEvent) => {
      rejections.push(e.reason);
      e.preventDefault();
    };
    globalThis.addEventListener?.('unhandledrejection', onRejection as never);
  });

  afterEach(() => {
    globalThis.removeEventListener?.('unhandledrejection', onRejection as never);
    logger.destroy();
    setOnLine(true);
  });

  it('每个事务都 abort 时，插件降级但不抛，也不产生未处理 rejection', async () => {
    const real = globalThis.indexedDB;
    // 让所有事务在建立后立刻 abort，模拟配额耗尽 / 库损坏
    const brokenOpen = (name: string, version?: number): IDBOpenDBRequest => {
      const request = real.open(name, version);
      const origSuccess = Object.getOwnPropertyDescriptor(request, 'onsuccess');
      void origSuccess;
      request.addEventListener('success', () => {
        const db = request.result;
        const origTransaction = db.transaction.bind(db);
        db.transaction = ((...args: Parameters<IDBDatabase['transaction']>) => {
          const tx = origTransaction(...args);
          setTimeout(() => {
            try {
              tx.abort();
            } catch {
              /* 已结束 */
            }
          }, 0);
          return tx;
        }) as IDBDatabase['transaction'];
      });
      return request;
    };
    (globalThis as { indexedDB: IDBFactory }).indexedDB = {
      ...real,
      open: brokenOpen,
      deleteDatabase: real.deleteDatabase.bind(real),
      cmp: real.cmp.bind(real),
    } as IDBFactory;

    const uploadFn = vi.fn(async (): Promise<UploadResult> => {
      throw new TypeError('Failed to fetch');
    });
    const upload = new UploadPlugin({
      onUpload: uploadFn as never,
      queue: { deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({ dbName: `abort-${Math.random()}` });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();

    setOnLine(false);
    logger.error('written while the store is broken');
    await settle();

    // 关键断言：坏掉的存储不能把异常泄漏成未处理 rejection
    expect(rejections).toEqual([]);
    // 状态查询仍然可用，不抛
    expect(() => offline.getStatus()).not.toThrow();

    (globalThis as { indexedDB: IDBFactory }).indexedDB = real;
  });

  it('request 成功后事务再 abort 时 put 必须 reject，绝不能报告假持久化', async () => {
    const realFactory = globalThis.indexedDB;
    const wrappedOpen = (name: string, version?: number): IDBOpenDBRequest => {
      const openRequest = realFactory.open(name, version);
      openRequest.addEventListener('success', () => {
        const db = openRequest.result;
        const realTransaction = db.transaction.bind(db);
        let injectAbort = true;
        db.transaction = ((...args: Parameters<IDBDatabase['transaction']>) => {
          if (!injectAbort) return realTransaction(...args);
          injectAbort = false;
          const request = { result: undefined, error: null, onsuccess: null, onerror: null };
          const tx = {
            error: new DOMException('forced abort', 'AbortError'),
            oncomplete: null,
            onabort: null as null | (() => void),
            onerror: null,
            abort: vi.fn(),
            objectStore: () => ({
              put: () => {
                queueMicrotask(() => {
                  (request.onsuccess as null | (() => void))?.();
                  tx.onabort?.();
                });
                return request;
              },
            }),
          };
          return tx as unknown as IDBTransaction;
        }) as IDBDatabase['transaction'];
      });
      return openRequest;
    };
    (globalThis as { indexedDB: IDBFactory }).indexedDB = {
      ...realFactory,
      open: wrappedOpen,
      deleteDatabase: realFactory.deleteDatabase.bind(realFactory),
      cmp: realFactory.cmp.bind(realFactory),
    } as IDBFactory;
    const store = await createIndexedDbStore(`commit-boundary-${Math.random()}`);
    (globalThis as { indexedDB: IDBFactory }).indexedDB = realFactory;
    const now = Date.now();
    const record: OfflineRecord = {
      logId: 'must-commit', storedAt: now, capturedAt: now, priority: 1, bytes: 32,
      replayAttempts: 0,
      log: {
        logId: 'must-commit', level: LogLevel.ERROR,
        message: 'transaction commit is the durability boundary', timestamp: now,
      },
    };
    await expect(store.put(record)).rejects.toThrow();
    expect(await store.get(record.logId)).toBeNull();
    store.close();
  });

  it('损坏的 IndexedDB 正文必须快速 reject，游标不能因回调抛错永久挂起', async () => {
    const dbName = `corrupt-body-${Math.random()}`;
    const store = await createIndexedDbStore(dbName);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite');
      tx.objectStore('records').put({ logId: 'corrupt', storedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();

    await expect(store.get('corrupt')).rejects.toThrow('record is corrupted');
    await expect(store.loadMeta()).rejects.toThrow('record is corrupted');
    store.close();
  });

  it('打开数据库直接失败时退回可用后端，不抛也不卡住', async () => {
    const real = globalThis.indexedDB;
    (globalThis as { indexedDB: IDBFactory }).indexedDB = {
      ...real,
      open: () => {
        const req = {
          onsuccess: null as unknown,
          onerror: null as unknown,
          onupgradeneeded: null as unknown,
          onblocked: null as unknown,
          error: new DOMException('quota', 'QuotaExceededError'),
          result: undefined,
        };
        setTimeout(() => {
          (req.onerror as ((e: unknown) => void) | null)?.({ target: req });
        }, 0);
        return req as unknown as IDBOpenDBRequest;
      },
      deleteDatabase: real.deleteDatabase.bind(real),
      cmp: real.cmp.bind(real),
    } as IDBFactory;

    const offline = new OfflinePersistencePlugin({ dbName: `openfail-${Math.random()}` });
    logger.use(offline);
    await offline.whenReady();
    await settle(5);

    // 降级到 localStorage（或 noop），但绝不能停在 initializing 或抛出
    expect(['localstorage', 'noop']).toContain(offline.getStatus().backend);
    expect(rejections).toEqual([]);

    (globalThis as { indexedDB: IDBFactory }).indexedDB = real;
  });

  it('打开数据库永久挂起时会超时降级，不会把插件卡在初始化态', async () => {
    const real = globalThis.indexedDB;
    (globalThis as { indexedDB: IDBFactory }).indexedDB = {
      ...real,
      // 永远不回调：模拟被其它 Tab 的升级请求无限期阻塞
      open: () =>
        ({
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
          onblocked: null,
        }) as unknown as IDBOpenDBRequest,
      deleteDatabase: real.deleteDatabase.bind(real),
      cmp: real.cmp.bind(real),
    } as IDBFactory;

    const offline = new OfflinePersistencePlugin({ dbName: `hang-${Math.random()}` });
    logger.use(offline);
    await offline.whenReady();

    expect(offline.getStatus().backend).not.toBe('initializing');
    expect(rejections).toEqual([]);

    (globalThis as { indexedDB: IDBFactory }).indexedDB = real;
  }, 20000);
});

describe('OfflineStore —— KV 更新回滚', () => {
  it('持久记录的计数与日志外壳必须整体合法，不能只检查 logId', async () => {
    const values = new Map<string, string>();
    const platform = createNoopAdapter();
    platform.storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    };
    const store = createKeyValueStore(platform, '__invalid_envelope__');
    const now = Date.now();

    values.set('__invalid_envelope__:index', JSON.stringify([{
      logId: 'invalid-meta', storedAt: now, capturedAt: now, priority: 1, bytes: -1,
      replayAttempts: -1,
    }]));
    await expect(store.loadMeta()).rejects.toThrow('invalid metadata entry');
    expect(values.has('__invalid_envelope__:index')).toBe(true);
    values.clear();

    await expect(store.put({
      logId: 'invalid', storedAt: now, capturedAt: now, priority: 1, bytes: 16,
      replayAttempts: -1,
      log: { logId: 'invalid', level: LogLevel.ERROR, message: 'invalid', timestamp: now },
    })).rejects.toThrow('record is invalid');
    expect(values.size).toBe(0);
  });

  it('探测时删除能力失败必须降级为 noop，不能把只能写不能删的后端宣称可用', async () => {
    const values = new Map<string, string>();
    let lastError: unknown;
    const platform = createNoopAdapter();
    platform.storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        lastError = undefined;
        values.set(key, value);
      },
      removeItem: () => {
        lastError = new Error('native storage remove failed');
      },
      consumeLastError: () => {
        const error = lastError;
        lastError = undefined;
        return error;
      },
    };

    const store = await createOfflineStore({
      preference: 'localstorage',
      platform,
      dbName: 'unused',
      keyPrefix: '__partial_storage__',
    });

    expect(store.backend).toBe('noop');
    await expect(store.put({} as OfflineRecord)).rejects.toThrow('storage unavailable');
  });

  it('适配器静默忽略删除时也必须降级为 noop', async () => {
    const values = new Map<string, string>();
    const platform = createNoopAdapter();
    platform.storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: () => {
        /* hostile host silently ignores deletion */
      },
    };

    const store = await createOfflineStore({
      preference: 'localstorage',
      platform,
      dbName: 'unused',
      keyPrefix: '__silent_remove__',
    });

    expect(store.backend).toBe('noop');
    await expect(createOfflineStore({
      preference: 'localstorage',
      platform,
      dbName: 'unused',
      keyPrefix: '__silent_remove_exact__',
      allowFallback: false,
    })).rejects.toThrow('not writable');
  });

  it('适配器报告持续读取异常时必须拒绝写入，不能把异常伪装成空索引', async () => {
    const values = new Map<string, string>([['__reported_error__:index', '[]']]);
    let lastError: unknown;
    const platform = createNoopAdapter();
    platform.storage = {
      getItem: (key) => {
        if (key.endsWith(':index')) {
          lastError = new Error('native storage read failed');
          return null;
        }
        return values.get(key) ?? null;
      },
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
      consumeLastError: () => {
        const error = lastError;
        lastError = undefined;
        return error;
      },
    };
    const store = createKeyValueStore(platform, '__reported_error__');
    const now = Date.now();
    await expect(store.put({
      logId: 'new', storedAt: now, capturedAt: now, priority: 1, bytes: 16,
      replayAttempts: 0,
      log: { logId: 'new', level: LogLevel.ERROR, message: 'new', timestamp: now },
    })).rejects.toThrow('native storage read failed');
    expect(values.get('__reported_error__:index')).toBe('[]');
    expect(values.has('__reported_error__:r:new')).toBe(false);
  });

  it('适配器一次性返回空索引时必须复读恢复，不能覆盖已有索引', async () => {
    const values = new Map<string, string>();
    let failNextIndexRead = false;
    const platform = createNoopAdapter();
    platform.storage = {
      getItem: (key) => {
        if (failNextIndexRead && key.endsWith(':index')) {
          failNextIndexRead = false;
          return null;
        }
        return values.get(key) ?? null;
      },
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    };
    const store = createKeyValueStore(platform, '__stable_index__');
    const make = (logId: string): OfflineRecord => {
      const now = Date.now();
      return {
        logId, storedAt: now, capturedAt: now, priority: 1, bytes: 16, replayAttempts: 0,
        log: { logId, level: LogLevel.ERROR, message: logId, timestamp: now },
      };
    };
    await store.put(make('a'));
    await store.put(make('b'));
    failNextIndexRead = true;
    await store.put(make('c'));
    expect((await store.loadMeta()).map((meta) => meta.logId).sort()).toEqual(['a', 'b', 'c']);
    expect(await store.get('a')).not.toBeNull();
    expect(await store.get('b')).not.toBeNull();
  });

  it('整个索引损坏时变更必须拒绝，不能覆盖旧值', async () => {
    const values = new Map<string, string>([['__corrupt__:index', '{broken']]);
    const platform = createNoopAdapter();
    platform.storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    };
    const store = createKeyValueStore(platform, '__corrupt__');
    const now = Date.now();
    const record: OfflineRecord = {
      logId: 'new', storedAt: now, capturedAt: now, priority: 1, bytes: 16, replayAttempts: 0,
      log: { logId: 'new', level: LogLevel.ERROR, message: 'new', timestamp: now },
    };
    await expect(store.put(record)).rejects.toThrow('index is corrupted');
    expect(values.get('__corrupt__:index')).toBe('{broken');
    expect(values.has('__corrupt__:r:new')).toBe(false);
  });

  it('更新已有记录时索引写失败必须恢复旧正文', async () => {
    const values = new Map<string, string>();
    let failIndexWrite = false;
    const platform = createNoopAdapter();
    platform.storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        if (failIndexWrite && key.endsWith(':index')) throw new Error('index quota');
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    };
    const store = createKeyValueStore(platform, '__rollback__');
    const original: OfflineRecord = {
      logId: 'durable',
      storedAt: Date.now(),
      capturedAt: Date.now(),
      priority: 1,
      bytes: 32,
      replayAttempts: 0,
      log: {
        logId: 'durable',
        level: LogLevel.ERROR,
        message: 'keep the old copy',
        timestamp: Date.now(),
      },
    };
    await store.put(original);

    failIndexWrite = true;
    await expect(store.put({ ...original, replayAttempts: 1 })).rejects.toThrow('index quota');

    expect(await store.get('durable')).toMatchObject({ replayAttempts: 0 });
    expect(await store.loadMeta()).toMatchObject([{ logId: 'durable', replayAttempts: 0 }]);
  });

  it('平台静默吞掉正文写入时必须 reject，且不得写入幽灵索引', async () => {
    const values = new Map<string, string>();
    const platform = createNoopAdapter();
    platform.storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        if (!key.includes(':r:')) values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    };
    const store = createKeyValueStore(platform, '__silent_write__');
    const record: OfflineRecord = {
      logId: 'missing-body',
      storedAt: Date.now(),
      capturedAt: Date.now(),
      priority: 1,
      bytes: 32,
      replayAttempts: 0,
      log: {
        logId: 'missing-body',
        level: LogLevel.ERROR,
        message: 'must not become an indexed ghost',
        timestamp: Date.now(),
      },
    };

    await expect(store.put(record)).rejects.toThrow('write did not stick');
    expect(await store.get(record.logId)).toBeNull();
    expect(await store.loadMeta()).toEqual([]);
  });

  it('clear 部分删除失败时必须 reject，并保留未删记录的索引供下次重试', async () => {
    const values = new Map<string, string>();
    let blockRecordRemoval = false;
    const platform = createNoopAdapter();
    platform.storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        if (blockRecordRemoval && key.includes(':r:')) return;
        values.delete(key);
      },
    };
    const store = createKeyValueStore(platform, '__clear_retry__');
    const record: OfflineRecord = {
      logId: 'still-durable',
      storedAt: Date.now(),
      capturedAt: Date.now(),
      priority: 1,
      bytes: 32,
      replayAttempts: 0,
      log: {
        logId: 'still-durable',
        level: LogLevel.ERROR,
        message: 'keep indexed until deletion succeeds',
        timestamp: Date.now(),
      },
    };
    await store.put(record);

    blockRecordRemoval = true;
    await expect(store.clear()).rejects.toThrow('remove did not stick');
    expect(await store.get(record.logId)).not.toBeNull();
    expect(await store.loadMeta()).toMatchObject([{ logId: record.logId }]);

    blockRecordRemoval = false;
    await expect(store.clear()).resolves.toBeUndefined();
    expect(await store.get(record.logId)).toBeNull();
    expect(await store.loadMeta()).toEqual([]);
  });
});
