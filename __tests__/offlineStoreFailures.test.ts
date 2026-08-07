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
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
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
