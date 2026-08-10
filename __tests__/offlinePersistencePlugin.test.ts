/**
 * OfflinePersistencePlugin —— 断网落盘、联网补传、配额与降级
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin, type UploadResult } from '../src/plugins/UploadPlugin';
import {
  OfflinePersistencePlugin,
  purgeOfflinePersistenceStorage,
} from '../src/plugins/OfflinePersistencePlugin';
import type { LogEntry } from '../src/types';

function setOnLine(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', {
    value,
    configurable: true,
    writable: true,
  });
}

/**
 * 用真实计时器推进异步链
 *
 * 这里不能用 fake timers：IndexedDB 的事务回调走的是宿主自己的调度，
 * 而 UploadPlugin 串行模式下每条之间还有 100ms 真实间隔。
 */
async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('OfflinePersistencePlugin', () => {
  let logger: AemeathLogger;
  let upload: UploadPlugin;
  let offline: OfflinePersistencePlugin;
  let uploadFn: ReturnType<typeof vi.fn>;
  let online: boolean;

  const installWithDb = async (
    dbName: string,
    options: ConstructorParameters<typeof OfflinePersistencePlugin>[0] = {},
  ): Promise<void> => {
    upload = new UploadPlugin({
      onUpload: uploadFn as never,
      queue: { deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    offline = new OfflinePersistencePlugin({ dbName, ...options });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();
  };

  const install = (
    options: ConstructorParameters<typeof OfflinePersistencePlugin>[0] = {},
  ): Promise<void> => installWithDb(`test-${Math.random()}`, options);

  /** 模拟页面关闭后重开：内存队列全部丢失，只剩持久层里的副本 */
  const restart = async (
    dbName: string,
    options: ConstructorParameters<typeof OfflinePersistencePlugin>[0] = {},
  ): Promise<void> => {
    logger.destroy();
    uploadFn.mockClear();
    logger = new AemeathLogger({ enableConsole: false });
    await installWithDb(dbName, options);
  };

  beforeEach(() => {
    // 每个用例一个干净的 IndexedDB
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    online = true;
    setOnLine(true);
    uploadFn = vi.fn(async (): Promise<UploadResult> => {
      if (!online) throw new Error('network unreachable');
      return { success: true };
    });
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
    setOnLine(true);
  });

  it('优先使用 IndexedDB', async () => {
    await install();
    expect(offline.getStatus().backend).toBe('indexeddb');
  });

  it('宿主没有 IndexedDB 时降级到 KV 存储', async () => {
    const saved = globalThis.indexedDB;
    // @ts-expect-error 故意制造不支持的宿主
    delete globalThis.indexedDB;
    try {
      await install();
      expect(offline.getStatus().backend).toBe('localstorage');
    } finally {
      globalThis.indexedDB = saved;
    }
  });

  it('KV 索引中的坏项不会遮蔽后面的健康记录', async () => {
    const key = `corrupt-index-${Math.random()}`;
    const now = Date.now();
    const log: LogEntry = {
      logId: 'healthy-after-null',
      level: 'error' as LogEntry['level'],
      message: 'must still replay',
      timestamp: now,
    };
    const meta = {
      logId: log.logId,
      storedAt: now,
      capturedAt: now,
      priority: 100,
      bytes: JSON.stringify(log).length,
      replayAttempts: 0,
    };
    localStorage.setItem(`${key}:index`, JSON.stringify([null, meta]));
    localStorage.setItem(`${key}:r:${log.logId}`, JSON.stringify({ ...meta, log }));

    upload = new UploadPlugin({
      onUpload: uploadFn as never,
      queue: { deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    offline = new OfflinePersistencePlugin({ storage: 'localstorage', key });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();
    await settle(20);

    expect(uploadFn).toHaveBeenCalledTimes(1);
    expect((uploadFn.mock.calls[0]![0] as LogEntry).logId).toBe(log.logId);
    expect(offline.getStatus().pending).toBe(0);
  });

  it('多实例分别按 IndexedDB dbName 与 KV key 阻止潜在串台', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const secondLogger = new AemeathLogger({ enableConsole: false });
    const thirdLogger = new AemeathLogger({ enableConsole: false });
    try {
      const sharedDb = `shared-db-${Math.random()}`;
      const sharedKey = `shared-key-${Math.random()}`;
      await installWithDb(sharedDb, { key: sharedKey });

      const secondUpload = new UploadPlugin({
        onUpload: async () => ({ success: true }),
        cache: { enabled: false },
        saveOnUnload: false,
      });
      const sameDb = new OfflinePersistencePlugin({
        dbName: sharedDb,
        key: `${sharedKey}-different`,
      });
      secondLogger.use(secondUpload);
      secondLogger.use(sameDb);
      await sameDb.whenReady();
      expect(sameDb.getStatus().backend).toBe('noop');

      const thirdUpload = new UploadPlugin({
        onUpload: async () => ({ success: true }),
        cache: { enabled: false },
        saveOnUnload: false,
      });
      const sameFallbackKey = new OfflinePersistencePlugin({
        dbName: `${sharedDb}-different`,
        key: sharedKey,
      });
      thirdLogger.use(thirdUpload);
      thirdLogger.use(sameFallbackKey);
      await sameFallbackKey.whenReady();
      expect(sameFallbackKey.getStatus().backend).toBe('noop');
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      secondLogger.destroy();
      thirdLogger.destroy();
    }
  });

  it('让位实例的显式清理不能删除另一活跃实例持有的存储', async () => {
    const key = `claimed-purge-${Math.random()}`;
    online = false;
    setOnLine(false);
    await install({ storage: 'localstorage', key });
    logger.error('owned by the active logger');
    await settle();
    expect(offline.getStatus().pending).toBe(1);
    expect(localStorage.getItem(`${key}:index`)).not.toBeNull();

    // 模拟另一个因相同 key 撞车而让位的入口随后执行 offlinePersistence:false。
    await purgeOfflinePersistenceStorage(logger.platform, { storage: 'localstorage', key });

    expect(localStorage.getItem(`${key}:index`)).not.toBeNull();
    expect(offline.getStatus().pending).toBe(1);
    await offline.clear();
  });

  it('断网期间的日志会落盘，联网后自动补传', async () => {
    await install();

    online = false;
    setOnLine(false);
    logger.error('lost in the tunnel');
    await settle();

    expect(uploadFn).not.toHaveBeenCalled();
    expect(offline.getStatus().pending).toBe(1);

    online = true;
    setOnLine(true);
    window.dispatchEvent(new Event('online'));
    await settle(30);

    const messages = uploadFn.mock.calls.map((c) => (c[0] as LogEntry).message);
    expect(messages).toContain('lost in the tunnel');
    expect(offline.getStatus().pending).toBe(0);
  });

  it('持久化快照参与统一状态去重，并发送 delivery:persisted', async () => {
    await install();
    const persisted = vi.fn();
    logger.on('delivery:persisted', persisted);

    online = false;
    setOnLine(false);
    logger.error('durable status');
    await settle();

    const offlineStatus = offline.getStatus();
    const deliveryStatus = logger.getDeliveryStatus();
    expect(offlineStatus.items).toHaveLength(1);
    expect(offlineStatus.items[0]).toMatchObject({ state: 'persisted' });
    expect(persisted).toHaveBeenCalledTimes(1);
    expect(deliveryStatus).toMatchObject({
      state: 'paused',
      totalPending: 1,
      persisted: 1,
      persistedOnly: 0,
      persistence: { enabled: true, backend: 'indexeddb' },
    });
  });

  it('网络恢复后由内存队列直接发出，不产生重复上报', async () => {
    await install();

    online = false;
    setOnLine(false);
    logger.error('cleanup me');
    await settle();
    expect(offline.getStatus().pending).toBe(1);

    online = true;
    setOnLine(true);
    window.dispatchEvent(new Event('online'));
    await settle(30);

    // 内存队列里的原件先发成功，持久副本随即被清理 —— 全程只上报一次
    const sent = uploadFn.mock.calls.filter((c) => (c[0] as LogEntry).message === 'cleanup me');
    expect(sent).toHaveLength(1);
    expect(offline.getStatus().pending).toBe(0);
  });

  it('正常在线时不落盘，避免白白消耗配额', async () => {
    await install();

    logger.error('normal log');
    await settle();

    expect(uploadFn).toHaveBeenCalledTimes(1);
    expect(offline.getStatus().pending).toBe(0);
  });

  it('可恢复失败进入 parked 时保留磁盘副本，恢复后只上传一次', async () => {
    const dropped: string[] = [];
    uploadFn.mockResolvedValue({
      success: false,
      shouldRetry: true,
      retryReason: 'server',
    });
    upload = new UploadPlugin({
      onUpload: uploadFn as never,
      queue: { deduplicationDelay: 0, maxRetries: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (_log, info) => dropped.push(info.reason),
    });
    offline = new OfflinePersistencePlugin({ dbName: `parked-${Math.random()}` });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();

    logger.error('park and recover');
    await settle();
    expect(upload.getQueueStatus()).toMatchObject({ length: 0, parked: 1 });
    expect(offline.getStatus().pending).toBe(1);
    expect(dropped).toEqual([]);

    uploadFn.mockResolvedValue({ success: true });
    await upload.flush();
    await settle();

    const sent = uploadFn.mock.calls.filter(
      (call) => (call[0] as LogEntry).message === 'park and recover',
    );
    expect(sent).toHaveLength(2); // 首次失败 + 恢复成功，各一次
    expect(upload.getQueueStatus()).toMatchObject({ length: 0, parked: 0 });
    expect(offline.getStatus().pending).toBe(0);
    expect(dropped).toEqual([]);
  });

  it('超过 maxEntries 时淘汰最旧的记录并通知丢弃', async () => {
    const dropped: string[] = [];
    logger.on('upload:drop', ((p: { reason: string }) => dropped.push(p.reason)) as never);
    await install({ maxEntries: 2 });

    online = false;
    setOnLine(false);
    logger.error('old-1');
    await settle();
    logger.error('old-2');
    await settle();
    logger.error('new-3');
    await settle();

    expect(offline.getStatus().pending).toBeLessThanOrEqual(2);
    expect(dropped).toContain('storage-quota');
  });

  it('单条记录超过 maxTotalBytes 时拒绝落盘，不能突破硬上限', async () => {
    const dropped: string[] = [];
    logger.on('upload:drop', ((p: { reason: string }) => dropped.push(p.reason)) as never);
    await install({ storage: 'localstorage', key: `tiny-${Math.random()}`, maxTotalBytes: 10 });

    online = false;
    setOnLine(false);
    logger.error('larger than ten bytes');
    await settle();

    expect(offline.getStatus()).toMatchObject({ pending: 0, bytes: 0 });
    expect(dropped).toContain('storage-quota');
  });

  it('服务端持续拒收时持久层最终会被清空，不留僵尸记录', async () => {
    await install({ maxReplayAttempts: 2 });

    online = false;
    setOnLine(false);
    logger.error('doomed');
    await settle();
    expect(offline.getStatus().pending).toBe(1);

    // 网络"恢复"了，但服务端每次都明确拒收
    online = true;
    setOnLine(true);
    uploadFn.mockImplementation(async () => ({ success: false, shouldRetry: false }));

    for (let i = 0; i < 4; i++) {
      window.dispatchEvent(new Event('online'));
      await settle(20);
    }

    expect(offline.getStatus().pending).toBe(0);
    expect(offline.getStatus().bytes).toBe(0);
  });

  it('UploadPlugin 缓存也开着时，跨重启的日志不能被上报两遍', async () => {
    // UploadPlugin.install() 是同步从缓存恢复并立刻开传的，而本插件要 await
    // createOfflineStore()。于是"上传成功"早于"索引建好"，清理动作查空索引直接返回，
    // 落盘副本没人删；索引建好后又把它读回来补传一次 —— 每条跨刷新的日志都发两遍。
    const dbName = `dup-${Math.random()}`;
    const cacheKey = `dup-cache-${Math.random()}`;

    const installBoth = async (): Promise<void> => {
      upload = new UploadPlugin({
        onUpload: uploadFn as never,
        queue: { deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
        cache: { enabled: true, key: cacheKey },
        saveOnUnload: false,
      });
      offline = new OfflinePersistencePlugin({ dbName });
      logger.use(upload);
      logger.use(offline);
      await offline.whenReady();
    };

    await installBoth();
    online = false;
    setOnLine(false);
    logger.error('pending across reload');
    await settle(10);
    expect(offline.getStatus().pending).toBe(1);

    // 关页：内存队列丢失，localStorage 缓存和 IndexedDB 副本都还在
    logger.destroy();
    online = true;
    setOnLine(true);
    uploadFn.mockClear();
    logger = new AemeathLogger({ enableConsole: false });
    await installBoth();
    await settle(30);

    const sent = uploadFn.mock.calls
      .map((c) => c[0] as LogEntry)
      .filter((log) => log.message === 'pending across reload');
    expect(sent).toHaveLength(1);
    expect(offline.getStatus().pending).toBe(0);
  });

  it('Upload cache 过期不能删除仍在 Offline TTL 内的可靠副本', async () => {
    const key = `dual-ttl-${Math.random()}`;
    const cacheKey = `dual-cache-${Math.random()}`;
    const now = Date.now();
    const log: LogEntry = {
      logId: 'dual-ttl-log',
      level: 'error' as LogEntry['level'],
      message: 'keep the longer-lived copy',
      timestamp: now - 2 * 60 * 60 * 1000,
    };
    const record = {
      logId: log.logId,
      storedAt: now - 2 * 60 * 60 * 1000,
      capturedAt: log.timestamp,
      priority: 100,
      bytes: JSON.stringify(log).length,
      replayAttempts: 0,
      log,
    };
    localStorage.setItem(`${key}:r:${log.logId}`, JSON.stringify(record));
    localStorage.setItem(`${key}:index`, JSON.stringify([{ ...record, log: undefined }]));
    localStorage.setItem(cacheKey, JSON.stringify([{
      log,
      priority: 100,
      retryCount: 0,
      timestamp: now - 2 * 60 * 60 * 1000,
      cachedAt: now - 2 * 60 * 60 * 1000,
    }]));

    offline = new OfflinePersistencePlugin({
      storage: 'localstorage',
      key,
      ttl: 7 * 24 * 60 * 60 * 1000,
    });
    logger.use(offline);
    await offline.whenReady();
    expect(offline.getStatus().pending).toBe(1);

    uploadFn.mockResolvedValue({ success: true });
    upload = new UploadPlugin({
      onUpload: uploadFn as never,
      queue: { deduplicationDelay: 0 },
      cache: { enabled: true, key: cacheKey, ttl: 60 * 60 * 1000 },
      saveOnUnload: false,
    });
    logger.use(upload);
    await settle(25);

    expect(uploadFn).toHaveBeenCalledTimes(1);
    expect((uploadFn.mock.calls[0]![0] as LogEntry).logId).toBe(log.logId);
    expect(offline.getStatus().pending).toBe(0);
  });

  it('重启后能从持久层恢复未上报的日志，并带上补传元数据', async () => {
    const dbName = `restart-${Math.random()}`;

    await installWithDb(dbName);
    online = false;
    setOnLine(false);
    logger.error('survives restart');
    await settle();
    const capturedAt = Date.now();
    expect(offline.getStatus().pending).toBe(1);

    // 模拟页面关闭后重开：内存队列彻底丢失，只剩持久副本
    online = true;
    setOnLine(true);
    await restart(dbName);
    await settle(30);

    const replayed = uploadFn.mock.calls
      .map((c) => c[0] as LogEntry)
      .find((log) => log.message === 'survives restart');

    expect(replayed).toBeDefined();
    expect(replayed!.tags?.offlineReplay).toBe(true);
    // 捕获时间保持原样，上传时间由 UploadPlugin 在发出瞬间写入
    expect(replayed!.timestamp).toBeLessThanOrEqual(capturedAt);
    expect(replayed!.tags!.uploadedAt as number).toBeGreaterThanOrEqual(replayed!.timestamp);
    expect(offline.getStatus().pending).toBe(0);
    expect(offline.getStatus().replayed).toBeGreaterThanOrEqual(1);
  });

  it('关闭 Upload cache 时 Offline 副本仍跨重启遵守 Retry-After', async () => {
    const key = `offline-retry-after-${Math.random()}`;
    uploadFn.mockResolvedValue({
      success: false,
      shouldRetry: true,
      retryReason: 'rate-limit',
      retryAfterMs: 1000,
    });
    upload = new UploadPlugin({
      onUpload: uploadFn as never,
      queue: { deduplicationDelay: 0, retryBackoff: false },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    offline = new OfflinePersistencePlugin({ storage: 'localstorage', key });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();
    logger.error('durable Retry-After');
    await settle(12);
    expect(uploadFn).toHaveBeenCalledTimes(1);
    expect(offline.getStatus().pending).toBe(1);

    logger.destroy();
    uploadFn.mockReset();
    uploadFn.mockResolvedValue({ success: true });
    logger = new AemeathLogger({ enableConsole: false });
    upload = new UploadPlugin({
      onUpload: uploadFn as never,
      queue: { deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    offline = new OfflinePersistencePlugin({ storage: 'localstorage', key });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();
    await settle(20);
    expect(uploadFn).not.toHaveBeenCalled();
    await settle(90);
    expect(uploadFn).toHaveBeenCalledTimes(1);
  });

  it('超过 TTL 的持久副本在补传前被清理', async () => {
    const dbName = `ttl-${Math.random()}`;

    await installWithDb(dbName, { ttl: 60 });
    online = false;
    setOnLine(false);
    logger.error('stale');
    await settle();
    expect(offline.getStatus().pending).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 100));
    online = true;
    setOnLine(true);
    await restart(dbName, { ttl: 60 });
    await settle(20);

    expect(offline.getStatus().pending).toBe(0);
    const messages = uploadFn.mock.calls.map((c) => (c[0] as LogEntry).message);
    expect(messages).not.toContain('stale');
  });

  it('补传被服务端永久拒收时立即清理，不伪装成重试耗尽', async () => {
    const dbName = `giveup-${Math.random()}`;
    const dropped: string[] = [];

    await installWithDb(dbName);
    online = false;
    setOnLine(false);
    logger.error('doomed');
    await settle();
    expect(offline.getStatus().pending).toBe(1);

    // 重启后网络"恢复"，但服务端每次都明确拒收
    online = true;
    setOnLine(true);
    uploadFn.mockImplementation(async () => ({ success: false, shouldRetry: false }));
    await restart(dbName, { maxReplayAttempts: 2 });
    logger.on('upload:drop', ((p: { reason: string }) => dropped.push(p.reason)) as never);
    await settle(40);

    expect(offline.getStatus().pending).toBe(0);
    expect(offline.getStatus().giveUps).toBe(0);
    expect(dropped).toContain('no-retry');
    expect(dropped).not.toContain('offline-give-up');
  });

  it('两种存储都不可用时安装成功但只告警，不影响上传', async () => {
    const saved = globalThis.indexedDB;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    // @ts-expect-error 故意制造不支持的宿主
    delete globalThis.indexedDB;

    try {
      await install();
      expect(offline.getStatus().backend).toBe('noop');
      expect(warn).toHaveBeenCalled();

      setItem.mockRestore();
      logger.error('still uploads');
      await settle();
      expect(uploadFn).toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
      globalThis.indexedDB = saved;
    }
  });
});
