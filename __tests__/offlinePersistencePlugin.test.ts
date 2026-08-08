/**
 * OfflinePersistencePlugin —— 断网落盘、联网补传、配额与降级
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin, type UploadResult } from '../src/plugins/UploadPlugin';
import { OfflinePersistencePlugin } from '../src/plugins/OfflinePersistencePlugin';
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

  it('补传反复失败到上限后放弃，不会无限占位', async () => {
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
    expect(offline.getStatus().giveUps).toBeGreaterThanOrEqual(1);
    expect(dropped).toContain('offline-give-up');
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
