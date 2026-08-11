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
import { LogLevel, type LogEntry } from '../src/types';

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
    const writesAfterFailedHydration = vi.fn();
    vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async (opts) => {
      const store = await real(opts);
      return {
        ...store,
        put: async (record) => {
          writesAfterFailedHydration(record);
          await store.put(record);
        },
        loadMeta: async () => {
          throw new Error('database is corrupted');
        },
      };
    });

    const upload = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => ({ success: true }),
      queue: { deduplicationDelay: 0 },
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
    expect(offline.getStatus().backend).toBe('noop');

    logger.emit('upload:paused', {
      reason: 'test',
      queued: 1,
      logs: [{
        log: {
          logId: 'must-not-write-after-failed-scan', level: 'error', message: 'held',
          timestamp: Date.now(),
        },
        priority: 100,
      }],
    });
    await settle(10);
    expect(writesAfterFailedHydration).not.toHaveBeenCalled();
  }, 20000);

  it('旧索引补读正文失败时必须整体 fail-closed，不能留下部分可信索引', async () => {
    const now = Date.now();
    const log = {
      logId: 'legacy-meta-body-failure',
      level: 'error' as const,
      message: 'legacy record',
      timestamp: now,
    };
    const meta = {
      logId: log.logId,
      storedAt: now,
      capturedAt: now,
      priority: 50,
      bytes: 100,
      replayAttempts: 0,
      // 旧 KV 索引没有 splitId，hydrate 必须补读正文后才能建立权威分组。
      splitId: undefined,
    };
    vi.spyOn(storeModule, 'createOfflineStore').mockResolvedValue({
      backend: 'localstorage',
      async put() {},
      async get() { throw new Error('legacy body cannot be read'); },
      async delete() {},
      async loadMeta() { return [meta]; },
      async clear() {},
      close() {},
    });
    const unavailable: unknown[] = [];
    logger.on('delivery:persistence-unavailable', (payload) => unavailable.push(payload));
    const uploadFn = vi.fn(async (): Promise<UploadResult> => ({ success: true }));
    const upload = new UploadPlugin({
      onUpload: uploadFn,
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({ storage: 'localstorage' });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();

    expect(offline.getStatus()).toMatchObject({ backend: 'noop', pending: 0, bytes: 0 });
    expect(unavailable).toHaveLength(1);
    expect(uploadFn).not.toHaveBeenCalled();
  });

  it('旧 KV 记录中的裸业务 splitId 必须在 hydrate 边界一次性规范化', async () => {
    const now = Date.now();
    const record: storeModule.OfflineRecord = {
      logId: 'legacy-business-split-id',
      storedAt: now,
      capturedAt: now,
      priority: 50,
      bytes: 128,
      replayAttempts: 0,
      splitId: 'business-correlation-only',
      log: {
        logId: 'legacy-business-split-id',
        level: LogLevel.ERROR,
        message: 'ordinary log with a business tag',
        timestamp: now,
        tags: { splitId: 'business-correlation-only' },
      },
    };
    let stored = record;
    const put = vi.fn(async (next: storeModule.OfflineRecord) => { stored = next; });
    vi.spyOn(storeModule, 'createOfflineStore').mockResolvedValue({
      backend: 'localstorage',
      put,
      async get(logId) { return logId === stored.logId ? stored : null; },
      async delete() {},
      async loadMeta() {
        const { log: _log, ...meta } = stored;
        return [meta];
      },
      async clear() {},
      close() {},
    });

    const offline = new OfflinePersistencePlugin({ storage: 'localstorage' });
    logger.use(offline);
    await offline.whenReady();

    expect(put).toHaveBeenCalledTimes(1);
    expect(stored.splitId).toBeNull();
    expect(offline.getStatus()).toMatchObject({ pending: 1, bytes: 128 });
  });

  it('store 已打开但 fallback 对账未完成时，新落盘请求只能缓冲，不能抢跑空索引', async () => {
    let releaseFallback!: () => void;
    let markFallbackStarted!: () => void;
    const fallbackStarted = new Promise<void>((resolve) => { markFallbackStarted = resolve; });
    const fallbackGate = new Promise<void>((resolve) => { releaseFallback = resolve; });
    const records = new Map<string, storeModule.OfflineRecord>();
    const put = vi.fn(async (record: storeModule.OfflineRecord) => {
      records.set(record.logId, record);
    });
    let calls = 0;
    vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        return {
          backend: 'indexeddb', put,
          async get(id) { return records.get(id) ?? null; },
          async delete(id) { records.delete(id); },
          async loadMeta() { return []; },
          async clear() { records.clear(); }, close() {},
        };
      }
      markFallbackStarted();
      await fallbackGate;
      return {
        backend: 'localstorage', async put() {}, async get() { return null; },
        async delete() {}, async loadMeta() { return []; }, async clear() {}, close() {},
      };
    });

    const upload = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => ({ success: true }),
      queue: { deduplicationDelay: 0 },
      cache: { enabled: false }, saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin();
    logger.use(upload);
    logger.use(offline);
    await fallbackStarted;

    logger.emit('upload:paused', {
      reason: 'test', queued: 1,
      logs: [{ log: {
        logId: 'during-reconcile', level: LogLevel.ERROR,
        message: 'buffer me', timestamp: Date.now(),
      }, priority: 100 }],
    });
    await settle(5);
    expect(put).not.toHaveBeenCalled();

    releaseFallback();
    await offline.whenReady();
    await settle(5);
    expect(put).toHaveBeenCalledTimes(1);
  }, 20000);

  it('正文读取异常不能被当作缺失，存储退避会自动唤醒并完整补传', async () => {
    const now = Date.now();
    const records = new Map(['a', 'b'].map((suffix, offset) => {
      const log: LogEntry = {
        logId: `read-failure-${suffix}`,
        level: LogLevel.ERROR,
        message: `split-${suffix}`,
        timestamp: now,
        tags: { splitId: 'read-failure-group', splitIndex: offset + 1, splitTotal: 2 },
      };
      return [log.logId, {
        logId: log.logId,
        storedAt: now,
        capturedAt: now,
        priority: 100,
        bytes: 100,
        replayAttempts: 0,
        splitId: 'read-failure-group',
        log,
      }] as const;
    }));
    let failNextRead = true;
    const deleted: string[] = [];
    vi.spyOn(storeModule, 'createOfflineStore').mockResolvedValue({
      backend: 'indexeddb',
      async put(record) { records.set(record.logId, record as never); },
      async get(logId) {
        if (failNextRead) {
          failNextRead = false;
          throw new Error('transient body read failure');
        }
        return records.get(logId) as never ?? null;
      },
      async delete(logId) { deleted.push(logId); records.delete(logId); },
      async loadMeta() {
        return Array.from(records.values(), ({ log: _log, ...meta }) => meta);
      },
      async clear() { records.clear(); },
      close() {},
    });

    const delivered: string[] = [];
    const upload = new UploadPlugin({
      onUpload: async (log): Promise<UploadResult> => {
        delivered.push(log.logId);
        return { success: true };
      },
      queue: { deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({ dbName: `body-read-${Math.random()}` });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();

    expect(offline.getStatus().pending).toBe(2);
    expect(deleted).toEqual([]);
    expect(delivered).toEqual([]);

    await settle(130);

    expect(delivered.sort()).toEqual(['read-failure-a', 'read-failure-b']);
    expect(offline.getStatus().pending).toBe(0);
  }, 20000);

  it('noop 后端处理成功事件后不得泄漏全局删除墓碑到下一实例', async () => {
    const key = `noop-tomb-${Math.random()}`;
    const dbName = `noop-tomb-${Math.random()}`;
    const realCreate = storeModule.createOfflineStore;
    const deleted: string[] = [];
    let firstOpen = true;
    vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async (options) => {
      if (firstOpen) {
        firstOpen = false;
        return storeModule.createNoopStore();
      }
      const store = await realCreate({
        ...options,
        preference: 'localstorage',
        dbName,
        keyPrefix: key,
      });
      const realDelete = store.delete.bind(store);
      return {
        ...store,
        async delete(logId: string) {
          deleted.push(logId);
          await realDelete(logId);
        },
      };
    });
    const ghost: LogEntry = {
      logId: 'never-persisted-in-noop',
      level: LogLevel.ERROR,
      message: 'already delivered',
      timestamp: Date.now(),
    };
    const offline1 = new OfflinePersistencePlugin({ storage: 'localstorage', key, dbName });
    logger.use(offline1);
    await offline1.whenReady();
    logger.emit('upload:success', { log: ghost });
    await settle(5);
    offline1.uninstall(logger);
    logger.destroy();

    logger = new AemeathLogger({ enableConsole: false });
    const offline2 = new OfflinePersistencePlugin({ storage: 'localstorage', key, dbName });
    logger.use(offline2);
    await offline2.whenReady();

    expect(deleted).not.toContain(ghost.logId);
    offline2.uninstall(logger);
  });

  it('创建存储时直接抛异常，不能变成未处理 rejection，也不能卡在未落定态', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
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
      queue: { deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({ dbName: `hydboom-${Math.random()}` });
    logger.use(upload);
    logger.use(offline);

    await expect(offline.whenReady()).resolves.toBeUndefined();

    expect(offline.getStatus().backend).toBe('noop');
    expect(logger.getDeliveryStatus().persistence.backend).toBe('noop');

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
      queue: { deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
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
      queue: { deduplicationDelay: 0 },
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

    off2.uninstall(logger2 as never);
    logger2.destroy();
  }, 20000);

  it('hydrate 前收到永久拒收时也要留下删盘意图，不能在下次启动复活', async () => {
    const dbName = `hyd-terminal-${Math.random()}`;
    const seedId = 'seed-permanently-rejected';
    const real = storeModule.createOfflineStore;
    let releaseStore!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseStore = resolve;
    });

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
          level: LogLevel.ERROR,
          message: 'seed',
          timestamp: Date.now(),
        },
      });
      await gate;
      return store;
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

    logger.emit('upload:drop', {
      log: {
        logId: seedId,
        level: LogLevel.ERROR,
        message: 'seed',
        timestamp: Date.now(),
      },
      reason: 'no-retry',
    });
    releaseStore();
    await offline.whenReady();

    vi.restoreAllMocks();
    const verify = await real({
      preference: 'indexeddb',
      platform: logger.platform,
      dbName,
      keyPrefix: '__aemeath_offline__',
    });
    expect(await verify.get(seedId)).toBeNull();
    verify.close();
  }, 20000);
});
