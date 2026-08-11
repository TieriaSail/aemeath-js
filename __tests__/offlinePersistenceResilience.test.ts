/**
 * OfflinePersistencePlugin —— 存储异常下的终止性保证
 *
 * 持久层写不进去，是配额打满时的**常态**而不是意外。这一组测试守的是：
 * 存储坏掉时补传必须照样收敛，不能变成「投递 → 失败 → 重新投递」的死循环。
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin, type UploadResult } from '../src/plugins/UploadPlugin';
import { OfflinePersistencePlugin } from '../src/plugins/OfflinePersistencePlugin';
import * as storeModule from '../src/plugins/offline/OfflineStore';
import { LogLevel, type LogEntry } from '../src/types';

function setOnLine(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', {
    value,
    configurable: true,
    writable: true,
  });
}

async function settle(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('OfflinePersistencePlugin — 存储异常下的终止性', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    setOnLine(true);
    localStorage.clear();
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
    setOnLine(true);
    localStorage.clear();
  });

  it('持久层删除失败时，永久拒收仍然收敛且不形成补传热循环', async () => {
    let online = true;
    const uploadFn = vi.fn(async (_log: LogEntry): Promise<UploadResult> => {
      if (!online) throw new Error('network unreachable');
      // 网络恢复后服务端明确永久拒收，不能再进入可恢复补传循环。
      return { success: false, shouldRetry: false };
    });

    const upload = new UploadPlugin({
      onUpload: uploadFn as never,
      queue: { deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({
      storage: 'localstorage',
      maxReplayAttempts: 3,
    });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();
    expect(offline.getStatus().backend).toBe('localstorage');

    // 1. 断网期间产生日志 → 落盘
    online = false;
    setOnLine(false);
    logger.error('stranded');
    await settle(10);
    expect(offline.getStatus().pending).toBe(1);

    // 2. 落盘之后冻结存储：写入一律失败（配额打满的典型形态），读取仍然正常
    const realSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function frozen(): void {
      throw new Error('QuotaExceededError');
    };

    try {
      // 3. 网络恢复，但服务端拒收；删盘写不进去也不能立刻反复补投。
      online = true;
      setOnLine(true);
      window.dispatchEvent(new Event('online'));
      await settle(60);
    } finally {
      Storage.prototype.setItem = realSetItem;
    }

    // 关键断言：投递次数必须有上限。修复前这里是持续增长的请求风暴。
    expect(uploadFn.mock.calls.length).toBeLessThanOrEqual(5);
    expect(offline.getStatus().pending).toBe(0);

    // 删盘失败的终态记录必须留下跨生命周期墓碑。存储恢复后重启，
    // 它应在 hydrate 之前被清理，而不是又被翻出来上报。
    logger.destroy();
    uploadFn.mockClear();
    logger = new AemeathLogger({ enableConsole: false });
    const uploadAfterRestart = new UploadPlugin({
      onUpload: uploadFn as never,
      queue: { deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offlineAfterRestart = new OfflinePersistencePlugin({
      storage: 'localstorage',
      maxReplayAttempts: 3,
    });
    logger.use(uploadAfterRestart);
    logger.use(offlineAfterRestart);
    await offlineAfterRestart.whenReady();
    await settle(20);

    expect(uploadFn).not.toHaveBeenCalled();
    expect(offlineAfterRestart.getStatus().pending).toBe(0);
  });

  it('一次性非配额写故障应保留写意图并自动退避重试', async () => {
    const realCreateStore = storeModule.createOfflineStore;
    let failRecordWrite = true;
    const createSpy = vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(
      async (options) => {
        const store = await realCreateStore(options);
        return {
          ...store,
          put: async (record) => {
            if (failRecordWrite) {
              failRecordWrite = false;
              throw new DOMException('temporary transaction failure', 'UnknownError');
            }
            await store.put(record);
          },
        };
      },
    );
    const upload = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => ({ success: true }),
      queue: { deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({ storage: 'localstorage' });
    const drops: string[] = [];
    logger.on('upload:drop', ((payload: { reason?: string }) => {
      if (payload.reason) drops.push(payload.reason);
    }) as never);
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();
    createSpy.mockRestore();

    const log: LogEntry = {
      logId: 'transient-put',
      level: LogLevel.ERROR,
      message: 'must survive a one-shot storage fault',
      timestamp: Date.now(),
    };
    setOnLine(false);
    logger.emit('upload:drop', { log, reason: 'max-retries', retryCount: 1 });

    await settle(20);
    expect(failRecordWrite).toBe(false);
    expect(offline.getStatus()).toMatchObject({ pending: 0, buffered: 1 });
    expect(logger.getDeliveryStatus()).toMatchObject({
      state: 'degraded',
      totalPending: 1,
      buffered: 1,
      persistence: { buffered: 1 },
    });
    expect(drops).not.toContain('storage-rejected');

    await settle(110);
    expect(offline.getStatus()).toMatchObject({ pending: 1, buffered: 0 });
    expect(drops).not.toContain('storage-rejected');
  });

  it('持续瞬时写故障也不能让待写意图绕过配置容量无限增长', async () => {
    const realCreateStore = storeModule.createOfflineStore;
    const createSpy = vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(
      async (options) => {
        const store = await realCreateStore(options);
        return {
          ...store,
          put: async () => {
            throw new DOMException('storage temporarily unavailable', 'UnknownError');
          },
        };
      },
    );
    const upload = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => ({ success: true }),
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({
      storage: 'localstorage',
      maxEntries: 1,
      maxTotalBytes: 64_000,
    });
    const drops: string[] = [];
    logger.on('upload:drop', ((payload: { reason?: string }) => {
      if (payload.reason) drops.push(payload.reason);
    }) as never);
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();
    createSpy.mockRestore();

    setOnLine(false);
    for (const logId of ['bounded-buffer-1', 'bounded-buffer-2']) {
      const log: LogEntry = {
        logId,
        level: LogLevel.ERROR,
        message: 'bounded transient write intent',
        timestamp: Date.now(),
      };
      logger.emit('upload:drop', { log, reason: 'max-retries', retryCount: 1 });
    }
    await settle(20);

    expect(offline.getStatus()).toMatchObject({ pending: 0, buffered: 1, quotaDrops: 1 });
    expect(drops).toContain('storage-quota');
    expect(drops).not.toContain('storage-rejected');

    await offline.clear();
    expect(offline.getStatus()).toMatchObject({ pending: 0, buffered: 0 });
    await settle(110);
    expect(offline.getStatus()).toMatchObject({ pending: 0, buffered: 0 });
  });

  it('补传次数写回短暂失败时必须先提交状态，再允许下一次补传', async () => {
    const realCreateStore = storeModule.createOfflineStore;
    let failAttemptUpdate = true;
    const createSpy = vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(
      async (options) => {
        const store = await realCreateStore(options);
        return {
          ...store,
          put: async (record) => {
            if (failAttemptUpdate && record.replayAttempts === 1) {
              failAttemptUpdate = false;
              throw new DOMException('attempt update temporarily failed', 'UnknownError');
            }
            await store.put(record);
          },
        };
      },
    );
    const uploadFn = vi.fn(async (): Promise<UploadResult> => ({ success: true }));
    const upload = new UploadPlugin({
      onUpload: uploadFn,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({ storage: 'localstorage' });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();
    createSpy.mockRestore();

    const log: LogEntry = {
      logId: 'durable-attempt-update',
      level: LogLevel.ERROR,
      message: 'retry budget must not regress',
      timestamp: Date.now(),
    };
    logger.emit('upload:drop', { log, reason: 'max-retries', retryCount: 1 });
    await settle(20);
    expect(offline.getStatus().pending).toBe(1);

    logger.emit('upload:drop', {
      log,
      reason: 'max-retries',
      retryCount: 1,
      source: 'offline-replay',
    });
    await settle(20);
    expect(failAttemptUpdate).toBe(false);
    expect(offline.getStatus()).toMatchObject({ pending: 1, buffered: 1 });
    expect(uploadFn).not.toHaveBeenCalled();

    await settle(110);
    expect(uploadFn).toHaveBeenCalledOnce();
    expect(offline.getStatus()).toMatchObject({ pending: 0, buffered: 0 });
  });

  it('终态删除短暂失败时应在当前生命周期自动重试物理清理', async () => {
    const realCreateStore = storeModule.createOfflineStore;
    let failDelete = true;
    let backingStore: Awaited<ReturnType<typeof realCreateStore>> | undefined;
    const createSpy = vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(
      async (options) => {
        const store = await realCreateStore(options);
        backingStore = store;
        return {
          ...store,
          delete: async (logId) => {
            if (failDelete) {
              failDelete = false;
              throw new DOMException('delete temporarily failed', 'UnknownError');
            }
            await store.delete(logId);
          },
        };
      },
    );
    const upload = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => ({ success: true }),
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({ storage: 'localstorage' });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();
    createSpy.mockRestore();

    const log: LogEntry = {
      logId: 'transient-delete',
      level: LogLevel.ERROR,
      message: 'terminal records must be physically cleaned',
      timestamp: Date.now(),
    };
    logger.emit('upload:drop', { log, reason: 'max-retries', retryCount: 1 });
    await settle(20);
    expect(await backingStore!.get(log.logId)).not.toBeNull();

    logger.emit('upload:drop', { log, reason: 'no-retry', retryCount: 1 });
    await settle(20);
    expect(failDelete).toBe(false);
    expect((await backingStore!.get(log.logId))?.terminal).toBe(true);

    await settle(110);
    expect(await backingStore!.get(log.logId)).toBeNull();
  });

  it('分片写意图未提交时补传扫描不得把暂时残组当成损坏数据', async () => {
    const realCreateStore = storeModule.createOfflineStore;
    let failFirstChunk = true;
    const createSpy = vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(
      async (options) => {
        const store = await realCreateStore(options);
        return {
          ...store,
          put: async (record) => {
            if (failFirstChunk && record.logId === 'transient-split-1') {
              failFirstChunk = false;
              throw new DOMException('temporary split write failure', 'UnknownError');
            }
            await store.put(record);
          },
        };
      },
    );
    const uploaded: string[] = [];
    const rejected: string[] = [];
    const upload = new UploadPlugin({
      onUpload: async (log): Promise<UploadResult> => {
        uploaded.push(log.logId);
        return { success: true };
      },
      queue: { deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({ storage: 'localstorage' });
    logger.on('upload:drop', ((payload: { reason?: string }) => {
      if (payload.reason === 'storage-rejected') rejected.push(payload.reason);
    }) as never);
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();
    createSpy.mockRestore();

    const chunks = [1, 2].map((index): LogEntry => ({
      logId: `transient-split-${index}`,
      level: LogLevel.ERROR,
      message: 'temporary split',
      timestamp: Date.now(),
      tags: { splitId: 'transient-split', splitIndex: index, splitTotal: 2 },
    }));
    for (const log of chunks) {
      logger.emit('upload:drop', { log, reason: 'max-retries', retryCount: 1 });
    }
    await settle(20);
    expect(offline.getStatus()).toMatchObject({ pending: 1, buffered: 1 });

    window.dispatchEvent(new Event('online'));
    await settle(20);
    expect(uploaded).toEqual([]);
    expect(rejected).toEqual([]);

    await settle(110);
    expect(uploaded.sort()).toEqual(['transient-split-1', 'transient-split-2']);
    expect(rejected).toEqual([]);
    expect(offline.getStatus().pending).toBe(0);
  });

  it('裸 splitId 业务标签不得把独立离线日志绑定成不可准入的大组', async () => {
    const uploaded: string[] = [];
    const upload = new UploadPlugin({
      onUpload: async (log): Promise<UploadResult> => {
        uploaded.push(log.logId);
        return { success: true };
      },
      queue: { maxSize: 1, offlinePolicy: 'pause', deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({ storage: 'localstorage' });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();

    for (const suffix of ['a', 'b']) {
      const log: LogEntry = {
        logId: `business-split-${suffix}`,
        level: LogLevel.ERROR,
        message: `independent offline ${suffix}`,
        timestamp: Date.now(),
        tags: { splitId: 'business-correlation-only' },
      };
      logger.emit('upload:drop', { log, reason: 'max-retries', retryCount: 1 });
    }
    await settle(20);
    expect(offline.getStatus().pending).toBe(2);

    window.dispatchEvent(new Event('online'));
    await settle(50);

    expect(uploaded.sort()).toEqual(['business-split-a', 'business-split-b']);
    expect(offline.getStatus().pending).toBe(0);
  });

  it('日志无法被存储引擎克隆时只丢它自己，不牵连已落盘的其它日志', async () => {
    // JSON 能序列化、structuredClone 不能：函数是最常见的一种。
    // 若把 DataCloneError 当成配额不足处理，就会白白淘汰掉 20% 的存量日志。
    const uploadFn = vi.fn(async (_log: LogEntry): Promise<UploadResult> => {
      throw new Error('offline');
    });
    const dropped: string[] = [];

    const upload = new UploadPlugin({
      onUpload: uploadFn as never,
      queue: { deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (_log, info) => dropped.push(info.reason),
    });
    const offline = new OfflinePersistencePlugin({ dbName: `clone-${Math.random()}` });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();
    expect(offline.getStatus().backend).toBe('indexeddb');

    setOnLine(false);
    for (let i = 0; i < 5; i++) {
      logger.error(`healthy ${i}`);
    }
    await settle(15);
    const before = offline.getStatus().pending;
    expect(before).toBe(5);

    // 绕开 PayloadSanitizePlugin（这里没装），直接投一条含函数的日志
    logger.error('has function', { context: { cb: () => undefined } });
    await settle(15);

    // 这一条存不下是应该的，明确记一次丢弃；但已经落盘的 5 条一条都不能少
    expect(offline.getStatus().quotaDrops).toBe(0);
    expect(dropped).toContain('storage-rejected');
    expect(offline.getStatus().pending).toBe(before);
  });

  it('物理删除失败会写入持久终态墓碑，真正的新模块生命周期也不会复活', async () => {
    const values = new Map<string, string>();
    let failRemove = false;
    const platform = {
      type: 'unknown' as const,
      storage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { if (!failRemove) values.delete(key); },
      },
      onBeforeExit: () => () => {},
      requestIdle: (callback: () => void) => callback(),
      getCurrentPath: () => '',
      errorCapture: { onGlobalError: () => () => {}, onUnhandledRejection: () => () => {} },
      earlyCapture: { isInstalled: () => false, hasEarlyErrors: () => false, flush: () => {} },
    };
    const key = 'durable-tombstone';
    let online = false;
    const uploadFn = vi.fn(async (): Promise<UploadResult> => online
      ? { success: false, shouldRetry: false }
      : { success: false, shouldRetry: true, retryReason: 'network' });
    logger.destroy();
    logger = new AemeathLogger({ enableConsole: false, platform });
    const upload = new UploadPlugin({
      onUpload: uploadFn,
      queue: { deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({ storage: 'localstorage', key });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();
    setOnLine(false);
    logger.error('terminal across real restart');
    await settle(12);
    const logId = offline.getStatus().items[0]!.logId;

    failRemove = true;
    online = true;
    setOnLine(true);
    window.dispatchEvent(new Event('online'));
    await settle(25);
    const retained = JSON.parse(values.get(`${key}:r:${logId}`)!);
    expect(retained.terminal).toBe(true);

    logger.destroy();
    vi.resetModules();
    failRemove = false;
    const [{ AemeathLogger: FreshLogger }, { UploadPlugin: FreshUpload }, { OfflinePersistencePlugin: FreshOffline }] = await Promise.all([
      import('../src/core/Logger'),
      import('../src/plugins/UploadPlugin'),
      import('../src/plugins/OfflinePersistencePlugin'),
    ]);
    const replay = vi.fn(async () => ({ success: true }));
    logger = new FreshLogger({ enableConsole: false, platform });
    const freshOffline = new FreshOffline({ storage: 'localstorage', key });
    logger.use(new FreshUpload({ onUpload: replay, cache: { enabled: false }, saveOnUnload: false }));
    logger.use(freshOffline);
    await freshOffline.whenReady();
    await settle(10);

    expect(replay).not.toHaveBeenCalled();
    expect(freshOffline.getStatus().pending).toBe(0);
    expect(values.has(`${key}:r:${logId}`)).toBe(false);
  });
});
