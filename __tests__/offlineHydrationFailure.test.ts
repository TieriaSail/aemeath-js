/**
 * hydration 失败后的收敛性
 *
 * `hydrated` 是个只该置位一次、但必须**保证**被置位的开关。停在 false 上不会
 * 报任何错，却有两个后果：
 *
 * 1. 每次上传成功都往 `preHydrationDeletes` 里塞一个 logId，永不清理 ——
 *    长驻页面上就是一条稳定增长的内存泄漏。
 * 2. handleSuccess 只记墓碑、不删盘，已经传成功的日志一直躺在库里等着被补传 ——
 *    这正是第七轮修掉的跨重启重复上报，从"读盘失败"这扇门又走回来。
 *
 * 读盘失败一点都不异常：库损坏、配额打满、localStorage 后端解析失败都会走到。
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin, type UploadResult } from '../src/plugins/UploadPlugin';
import { OfflinePersistencePlugin } from '../src/plugins/OfflinePersistencePlugin';
import * as storeModule from '../src/plugins/offline/OfflineStore';

const settle = async (n = 25): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10));
};

describe('hydration 失败后插件必须落定', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
    vi.restoreAllMocks();
  });

  it('loadMeta 读盘失败时，墓碑集合不能无限增长', async () => {
    const real = storeModule.createOfflineStore;
    vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async (opts) => {
      const store = await real(opts);
      return {
        ...store,
        loadMeta: async () => {
          throw new Error('database is corrupted');
        },
      };
    });

    const upload = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => ({ success: true }),
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({ dbName: `hydfail-${Math.random()}` });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();

    for (let i = 0; i < 40; i++) logger.error(`ok-${i}`);
    await settle(40);

    const tombstones = (offline as unknown as { preHydrationDeletes: Set<string> })
      .preHydrationDeletes;
    expect(tombstones.size).toBe(0);
    expect((offline as unknown as { hydrated: boolean }).hydrated).toBe(true);
  }, 20000);

  it('创建存储时直接抛异常，不能变成未处理 rejection，也不能卡在未落定态', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent): void => {
      unhandled.push(e.reason);
      e.preventDefault();
    };
    window.addEventListener('unhandledrejection', onUnhandled);

    vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async () => {
      throw new Error('boom during open');
    });

    const upload = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => ({ success: true }),
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({ dbName: `hydboom-${Math.random()}` });
    logger.use(upload);
    logger.use(offline);

    await expect(offline.whenReady()).resolves.toBeUndefined();

    for (let i = 0; i < 20; i++) logger.error(`still-fine-${i}`);
    await settle(30);

    expect((offline as unknown as { hydrated: boolean }).hydrated).toBe(true);
    expect(
      (offline as unknown as { preHydrationDeletes: Set<string> }).preHydrationDeletes.size
    ).toBe(0);
    expect(unhandled).toEqual([]);

    window.removeEventListener('unhandledrejection', onUnhandled);
  }, 20000);

  it('读盘失败后，上传成功的日志仍要从盘上删掉，不能留着被重复补传', async () => {
    // 先正常存一批离线日志
    const dbName = `hydreplay-${Math.random()}`;
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });

    const failing = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => {
        throw new TypeError('Failed to fetch');
      },
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const off1 = new OfflinePersistencePlugin({ dbName });
    logger.use(failing);
    logger.use(off1);
    await off1.whenReady();
    logger.error('persist me');
    await settle(30);
    expect(off1.getStatus().pending).toBeGreaterThan(0);
    off1.uninstall(logger as never);
    failing.uninstall(logger as never);

    // 重启：这次读盘失败
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
    const real = storeModule.createOfflineStore;
    vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async (opts) => {
      const store = await real(opts);
      return {
        ...store,
        loadMeta: async () => {
          throw new Error('corrupted on restart');
        },
      };
    });

    const logger2 = new AemeathLogger({ enableConsole: false });
    const uploaded: string[] = [];
    const ok = new UploadPlugin({
      onUpload: (async (log: { message: string }): Promise<UploadResult> => {
        uploaded.push(log.message);
        return { success: true };
      }) as never,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const off2 = new OfflinePersistencePlugin({ dbName });
    logger2.use(ok);
    logger2.use(off2);
    await off2.whenReady();

    logger2.error('fresh log');
    await settle(40);

    // 墓碑没有堆积，说明 handleSuccess 走的是真删除而不是记账
    expect(
      (off2 as unknown as { preHydrationDeletes: Set<string> }).preHydrationDeletes.size
    ).toBe(0);
    expect(uploaded).toContain('fresh log');
    // 读盘失败时无法枚举索引，旧的未送达记录不会在本会话被补传
    expect(uploaded).not.toContain('persist me');

    off2.uninstall(logger2 as never);
    logger2.destroy();
  }, 20000);

  it('loadMeta 失败后，upload:success 仍会尝试删盘（对不了账就直接删）', async () => {
    const dbName = `hyd-delete-${Math.random()}`;
    const seedId = 'seed-already-delivered';
    const real = storeModule.createOfflineStore;

    vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async (opts) => {
      const store = await real({ ...opts, dbName });
      await store.put({
        logId: seedId,
        storedAt: Date.now(),
        capturedAt: Date.now(),
        priority: 100,
        bytes: 32,
        replayAttempts: 0,
        log: {
          logId: seedId,
          level: 'error',
          message: 'seed',
          timestamp: Date.now(),
        },
      });
      return {
        ...store,
        loadMeta: async () => {
          throw new Error('corrupted meta');
        },
      };
    });

    const upload = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => ({ success: true }),
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({ dbName });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();
    expect(offline.getStatus().pending).toBe(0);

    // 模拟这条盘上记录其实已经上报成功
    logger.emit('upload:success', {
      log: {
        logId: seedId,
        level: 'error',
        message: 'seed',
        timestamp: Date.now(),
      },
    });
    await settle(20);

    vi.restoreAllMocks();
    const verify = await real({
      preference: 'indexeddb',
      dbName,
      keyPrefix: '__aemeath_offline__',
    });
    expect(await verify.get(seedId)).toBeNull();
    verify.close();
  }, 20000);
});
