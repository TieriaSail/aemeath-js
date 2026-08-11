/**
 * KV 后端删除失败时必须保留已送达墓碑，不能假装删干净。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin, type UploadResult } from '../src/plugins/UploadPlugin';
import { OfflinePersistencePlugin } from '../src/plugins/OfflinePersistencePlugin';
import * as storeModule from '../src/plugins/offline/OfflineStore';
import { LogLevel } from '../src/types';

const settle = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10));
};

describe('localStorage 删除失败保留墓碑', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    logger = new AemeathLogger({ enableConsole: false });
    Object.defineProperty(window.navigator, 'onLine', {
      value: true,
      configurable: true,
    });
  });

  afterEach(() => {
    logger.destroy();
    vi.restoreAllMocks();
  });

  it('开库挂起时同实例 remount，陈旧 init 不得清掉新生命周期的 preHydration 墓碑', async () => {
    const dbName = `stale-init-${Math.random()}`;
    const keyPrefix = `__aemeath_offline_${Math.random().toString(36).slice(2)}__`;
    const realCreate = storeModule.createOfflineStore;
    let releaseOpen!: () => void;
    const openBlocked = new Promise<void>((r) => {
      releaseOpen = r;
    });

    vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async (opts) => {
      await openBlocked;
      return realCreate({
        ...opts,
        preference: 'localstorage',
        dbName,
        keyPrefix,
      });
    });

    const offline = new OfflinePersistencePlugin({
      dbName,
      key: keyPrefix,
      storage: 'localstorage',
    });

    // 预写一条到 KV，模拟盘上残留
    const seed = await realCreate({
      preference: 'localstorage',
      dbName,
      keyPrefix,
    });
    const seedLog = {
      logId: 'seed-delivered',
      level: 'error' as const,
      message: 'stale-init-dup',
      timestamp: Date.now(),
    };
    await seed.put({
      logId: seedLog.logId,
      storedAt: Date.now(),
      capturedAt: seedLog.timestamp,
      priority: 0,
      bytes: 64,
      replayAttempts: 0,
      log: seedLog as never,
    });
    seed.close();

    const logger1 = new AemeathLogger({ enableConsole: false });
    logger1.use(offline);
    await settle(5);

    offline.uninstall(logger1 as never);
    logger1.destroy();

    const delivered: string[] = [];
    const logger2 = new AemeathLogger({ enableConsole: false });
    const upload2 = new UploadPlugin({
      onUpload: (async (log: { message: string }): Promise<UploadResult> => {
        delivered.push(log.message);
        return { success: true };
      }) as never,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger2.use(upload2);
    logger2.use(offline);

    // 两个 init 都仍卡在开库：先记上已送达墓碑
    logger2.emit('upload:success', {
      log: seedLog,
      source: 'test',
    });
    await settle(5);

    // 放行开库：陈旧 init 的 finally 若误清墓碑，hydrate 会把 seed 再补传
    releaseOpen();
    await offline.whenReady();
    await settle(40);

    expect(delivered.filter((m) => m === 'stale-init-dup')).toHaveLength(0);

    offline.uninstall(logger2 as never);
    logger2.destroy();
  });

  it('store 尚未挂上时 safeDelete 不得清掉 PENDING（避免已送达被再补传）', async () => {
    const dbName = `null-store-tomb-${Math.random()}`;
    const keyPrefix = `__aemeath_offline_${Math.random().toString(36).slice(2)}__`;
    const cacheKey = `__logger_upload_${Math.random().toString(36).slice(2)}__`;
    const realCreate = storeModule.createOfflineStore;
    let gate!: () => void;
    const blocked = new Promise<void>((r) => {
      gate = r;
    });
    let createCount = 0;

    vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async (opts) => {
      createCount++;
      const store = await realCreate({
        ...opts,
        preference: 'localstorage',
        dbName,
        keyPrefix,
      });
      // 第二次打开（remount）卡住，制造 store===null 窗口里的 success→safeDelete
      if (createCount >= 2) {
        await blocked;
      }
      return store;
    });

    const delivered: string[] = [];
    const upload1 = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => {
        throw new TypeError('Failed to fetch');
      },
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
      cache: { enabled: true, key: cacheKey },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({
      dbName,
      key: keyPrefix,
      storage: 'localstorage',
    });
    logger.use(upload1);
    logger.use(offline);
    await offline.whenReady();

    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
    logger.error('kept-on-disk');
    await settle(30);
    expect(offline.getStatus().pending).toBeGreaterThan(0);

    upload1.uninstall(logger as never);
    offline.uninstall(logger as never);
    logger.destroy();

    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
    const logger2 = new AemeathLogger({ enableConsole: false });
    const upload2 = new UploadPlugin({
      onUpload: (async (log: { message: string }): Promise<UploadResult> => {
        delivered.push(log.message);
        return { success: true };
      }) as never,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0 },
      cache: { enabled: true, key: cacheKey },
      saveOnUnload: false,
    });
    logger2.use(upload2);
    logger2.use(offline);
    // cache 恢复上传成功时 store 仍未赋值
    await settle(40);
    expect(delivered).toContain('kept-on-disk');

    gate();
    await offline.whenReady();
    await settle(40);

    // PENDING 若被假删，hydrate 会再补传一次
    expect(delivered.filter((m) => m === 'kept-on-disk')).toHaveLength(1);

    offline.uninstall(logger2 as never);
    logger2.destroy();
  });

  it('noop 后端处理成功事件后不得泄漏全局删除墓碑到下一实例', async () => {
    const keyPrefix = `noop-tomb-${Math.random()}`;
    const dbName = `noop-tomb-${Math.random()}`;
    const realCreate = storeModule.createOfflineStore;
    const deleted: string[] = [];
    let firstOpen = true;
    vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async (opts) => {
      if (firstOpen) {
        firstOpen = false;
        return storeModule.createNoopStore();
      }
      const store = await realCreate({
        ...opts,
        preference: 'localstorage',
        dbName,
        keyPrefix,
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

    const ghost = {
      logId: 'never-persisted-in-noop',
      level: 'error' as const,
      message: 'already delivered',
      timestamp: Date.now(),
    };
    const offline1 = new OfflinePersistencePlugin({ storage: 'localstorage', key: keyPrefix, dbName });
    logger.use(offline1);
    await offline1.whenReady();
    logger.emit('upload:success', { log: ghost });
    await settle(5);
    offline1.uninstall(logger as never);
    logger.destroy();

    logger = new AemeathLogger({ enableConsole: false });
    const offline2 = new OfflinePersistencePlugin({ storage: 'localstorage', key: keyPrefix, dbName });
    logger.use(offline2);
    await offline2.whenReady();

    expect(deleted).not.toContain(ghost.logId);
    offline2.uninstall(logger as never);
  });

  it('delete 后记录仍可读时不清 PENDING，remount 会再删且不补传', async () => {
    const dbName = `kv-tomb-${Math.random()}`;
    const keyPrefix = `__aemeath_offline_${Math.random().toString(36).slice(2)}__`;
    const realCreate = storeModule.createOfflineStore;

    let failDelete = false;
    vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async (opts) => {
      const store = await realCreate({
        ...opts,
        preference: 'localstorage',
        dbName,
        keyPrefix,
      });
      const realDelete = store.delete.bind(store);
      return {
        ...store,
        backend: 'localstorage' as const,
        async delete(logId: string) {
          if (failDelete) {
            // 假装 delete 成功（旧 KV 实现会吞错 resolve），盘上其实还在
            return;
          }
          return realDelete(logId);
        },
      };
    });

    let online = false;
    Object.defineProperty(window.navigator, 'onLine', {
      get: () => online,
      configurable: true,
    });

    const upload = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => {
        if (!online) throw new TypeError('Failed to fetch');
        return { success: true };
      },
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({
      dbName,
      key: keyPrefix,
      storage: 'localstorage',
    });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();

    logger.error('sticky-record');
    await settle(15);
    expect(offline.getStatus().pending).toBeGreaterThan(0);

    failDelete = true;
    online = true;
    window.dispatchEvent(new Event('online'));
    await settle(25);

    offline.uninstall(logger as never);
    upload.uninstall(logger as never);
    logger.destroy();

    // remount：delete 恢复正常，flushPending 应清掉盘上残留，且不得再补传
    failDelete = false;
    const logger2 = new AemeathLogger({ enableConsole: false });
    const delivered: string[] = [];
    const upload2 = new UploadPlugin({
      onUpload: (async (log: { message: string }): Promise<UploadResult> => {
        delivered.push(log.message);
        return { success: true };
      }) as never,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline2 = new OfflinePersistencePlugin({
      dbName,
      key: keyPrefix,
      storage: 'localstorage',
    });
    logger2.use(upload2);
    logger2.use(offline2);
    await offline2.whenReady();
    await settle(20);

    expect(delivered).not.toContain('sticky-record');
    expect(offline2.getStatus().pending).toBe(0);

    offline2.uninstall(logger2 as never);
    logger2.destroy();
  }, 20000);

  it('flush 删盘仍失败时 hydrate 不得把墓碑 id 放进补传队列', async () => {
    const dbName = `kv-hyd-${Math.random()}`;
    const keyPrefix = `__aemeath_offline_${Math.random().toString(36).slice(2)}__`;
    const realCreate = storeModule.createOfflineStore;
    const seedId = 'delivered-sticky';

    // 第一轮：写入一条，记 PENDING，delete 永远失败
    vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async (opts) => {
      const store = await realCreate({
        ...opts,
        preference: 'localstorage',
        dbName,
        keyPrefix,
      });
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
          message: 'sticky-delivered',
          timestamp: Date.now(),
        },
      });
      return {
        ...store,
        backend: 'localstorage' as const,
        async delete() {
          /* 始终失败：不删盘、不抛给上层之前先靠回读发现 */
        },
      };
    });

    const offline1 = new OfflinePersistencePlugin({
      dbName,
      key: keyPrefix,
      storage: 'localstorage',
    });
    const upload1 = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => ({ success: true }),
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(upload1);
    logger.use(offline1);
    await offline1.whenReady();

    // 模拟已送达：记 PENDING（与 handleSuccess / uninstall inFlight 同源）
    logger.emit('upload:success', {
      log: {
        logId: seedId,
        level: 'error',
        message: 'sticky-delivered',
        timestamp: Date.now(),
      },
    });
    await settle(10);
    offline1.uninstall(logger as never);
    upload1.uninstall(logger as never);
    logger.destroy();

    // 第二轮：delete 仍然失败 —— hydrate 绝不能把它当成待补传
    logger = new AemeathLogger({ enableConsole: false });
    const delivered: string[] = [];
    const upload2 = new UploadPlugin({
      onUpload: (async (log: { message: string }): Promise<UploadResult> => {
        delivered.push(log.message);
        return { success: true };
      }) as never,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline2 = new OfflinePersistencePlugin({
      dbName,
      key: keyPrefix,
      storage: 'localstorage',
    });
    logger.use(upload2);
    logger.use(offline2);
    await offline2.whenReady();
    await settle(20);

    expect(delivered).not.toContain('sticky-delivered');
    expect(offline2.getStatus().pending).toBe(0);

    offline2.uninstall(logger as never);
  }, 20000);
});
