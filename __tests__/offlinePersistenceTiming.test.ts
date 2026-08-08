/**
 * 离线持久化的并发交错
 *
 * 补传是异步的、串行化在一条操作链上，而卸载、清空、上传成功这些动作是同步发生的。
 * 交错点集中在"操作链上的某一步跑到一半，外面把 store 撤了 / 把索引清了"。
 * 这类问题不会抛到用户面前（链上有兜底），但可能留下残留记录、
 * 或者让后续所有持久化静默停摆。
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin, type UploadResult } from '../src/plugins/UploadPlugin';
import { OfflinePersistencePlugin } from '../src/plugins/OfflinePersistencePlugin';

function setOnLine(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', {
    value,
    configurable: true,
    writable: true,
  });
}

const settle = async (n = 30): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10));
};

describe('离线持久化的并发交错', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    setOnLine(true);
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
    setOnLine(true);
  });

  it('补传正在飞的时候卸载插件，不能抛异常也不能产生未处理 rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent): void => {
      unhandled.push(e.reason);
      e.preventDefault();
    };
    window.addEventListener('unhandledrejection', onUnhandled);

    let online = false;
    const upload = new UploadPlugin({
      onUpload: (async (): Promise<UploadResult> => {
        if (!online) throw new TypeError('Failed to fetch');
        await new Promise((r) => setTimeout(r, 30));
        return { success: true };
      }) as never,
      queue: { deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({ dbName: `t-teardown-${Math.random()}` });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();

    setOnLine(false);
    for (let i = 0; i < 5; i++) logger.error(`pending-${i}`);
    await settle();
    expect(offline.getStatus().pending).toBeGreaterThan(0);

    // 补传刚开始就把插件撤掉
    online = true;
    setOnLine(true);
    window.dispatchEvent(new Event('online'));
    await new Promise((r) => setTimeout(r, 5));
    expect(() => offline.uninstall(logger as never)).not.toThrow();

    await settle();
    expect(unhandled).toEqual([]);
    window.removeEventListener('unhandledrejection', onUnhandled);
  }, 20000);

  it('clear() 撞上正在进行的补传，索引不能被残留记录污染', async () => {
    let online = false;
    const upload = new UploadPlugin({
      onUpload: (async (): Promise<UploadResult> => {
        if (!online) throw new TypeError('Failed to fetch');
        await new Promise((r) => setTimeout(r, 20));
        return { success: true };
      }) as never,
      queue: { deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({ dbName: `t-clear-${Math.random()}` });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();

    setOnLine(false);
    for (let i = 0; i < 6; i++) logger.error(`will-clear-${i}`);
    await settle();
    expect(offline.getStatus().pending).toBeGreaterThan(0);

    online = true;
    setOnLine(true);
    window.dispatchEvent(new Event('online'));
    await new Promise((r) => setTimeout(r, 5));
    await offline.clear();
    await settle();

    // clear 之后不能再冒出记录来
    expect(offline.getStatus().pending).toBe(0);
    expect(offline.getStatus().bytes).toBe(0);
  }, 20000);

  it('反复装卸（HMR）之后，存储位要能被重新认领，落盘照常工作', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dbName = `t-hmr-${Math.random()}`;

    for (let cycle = 0; cycle < 3; cycle++) {
      const host = new AemeathLogger({ enableConsole: false });
      const upload = new UploadPlugin({
        onUpload: async (): Promise<UploadResult> => {
          throw new TypeError('Failed to fetch');
        },
        queue: { deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
        cache: { enabled: false },
        saveOnUnload: false,
      });
      const offline = new OfflinePersistencePlugin({ dbName });
      host.use(upload);
      host.use(offline);
      await offline.whenReady();

      // 每一轮都必须真的拿到后端，而不是因为上一轮没归还而被让位成 noop
      expect(offline.getStatus().backend, `cycle ${cycle} was denied a backend`).not.toBe('noop');

      setOnLine(false);
      host.error(`cycle-${cycle}`);
      await settle();
      expect(offline.getStatus().pending, `cycle ${cycle} persisted nothing`).toBeGreaterThan(0);

      offline.uninstall(host as never);
      upload.uninstall(host as never);
      host.destroy();
      setOnLine(true);
    }

    vi.mocked(console.warn).mockRestore();
  }, 30000);

  it('上传成功与补传失败对同一条日志同时到达时，账不能记乱', async () => {
    let online = false;
    const delivered: string[] = [];
    const upload = new UploadPlugin({
      onUpload: (async (log: { message: string }): Promise<UploadResult> => {
        if (!online) throw new TypeError('Failed to fetch');
        delivered.push(log.message);
        return { success: true };
      }) as never,
      queue: { deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({
      dbName: `t-race-${Math.random()}`,
      maxReplayAttempts: 2,
    });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();

    setOnLine(false);
    logger.error('contested');
    await settle();
    expect(offline.getStatus().pending).toBeGreaterThan(0);

    online = true;
    setOnLine(true);
    window.dispatchEvent(new Event('online'));
    await settle(60);

    // 内存队列和持久副本是同一条日志的两个引用。恢复联网时两边都可能发它，
    // 真正要守住的是"恰好一次"：多发是重复上报，少发是丢日志。
    // 走哪条路（内存队列直发 / 持久层补传）是实现细节，不该断言。
    expect(delivered.filter((m) => m === 'contested')).toHaveLength(1);

    const after = offline.getStatus();
    expect(after.pending).toBe(0);
    expect(after.giveUps).toBe(0);
  }, 20000);

  it('store 打开前缓冲的日志在 ready 后必须落盘', async () => {
    const storeMod = await import('../src/plugins/offline/OfflineStore');
    const realCreate = storeMod.createOfflineStore;
    const spy = vi.spyOn(storeMod, 'createOfflineStore').mockImplementation(async (opts) => {
      await new Promise((r) => setTimeout(r, 120));
      return realCreate(opts);
    });

    try {
      const upload = new UploadPlugin({
        onUpload: async (): Promise<UploadResult> => {
          throw new TypeError('Failed to fetch');
        },
        queue: { offlinePolicy: 'pause', deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
        cache: { enabled: false },
        saveOnUnload: false,
      });
      const offline = new OfflinePersistencePlugin({ dbName: `t-buf-${Math.random()}` });
      logger.use(upload);
      logger.use(offline);

      setOnLine(false);
      logger.error('buffered-while-opening');
      await new Promise((r) => setTimeout(r, 20));
      expect(offline.getStatus().backend).toBe('initializing');
      expect(offline.getStatus().pending).toBe(0);

      await offline.whenReady();
      await settle(20);

      expect(offline.getStatus().pending).toBe(1);
    } finally {
      spy.mockRestore();
    }
  }, 20000);

  it('store 打开前缓冲的日志若已上传成功，ready 后不得再落盘补传', async () => {
    const storeMod = await import('../src/plugins/offline/OfflineStore');
    const realCreate = storeMod.createOfflineStore;
    const spy = vi.spyOn(storeMod, 'createOfflineStore').mockImplementation(async (opts) => {
      await new Promise((r) => setTimeout(r, 120));
      return realCreate(opts);
    });

    try {
      let online = false;
      const delivered: string[] = [];
      const upload = new UploadPlugin({
        onUpload: (async (log: { message: string }): Promise<UploadResult> => {
          if (!online) throw new TypeError('Failed to fetch');
          delivered.push(log.message);
          return { success: true };
        }) as never,
        queue: { offlinePolicy: 'pause', deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
        cache: { enabled: false },
        saveOnUnload: false,
      });
      const offline = new OfflinePersistencePlugin({ dbName: `t-presuccess-${Math.random()}` });
      logger.use(upload);
      logger.use(offline);

      // store 未就绪：先断网入队（进 pendingPersists），再在同窗口内恢复并上传成功
      setOnLine(false);
      logger.error('buffered-then-sent');
      await new Promise((r) => setTimeout(r, 20));
      online = true;
      setOnLine(true);
      window.dispatchEvent(new Event('online'));
      await new Promise((r) => setTimeout(r, 40));

      await offline.whenReady();
      await settle(20);

      expect(delivered.filter((m) => m === 'buffered-then-sent')).toHaveLength(1);
      expect(offline.getStatus().pending).toBe(0);
    } finally {
      spy.mockRestore();
    }
  }, 20000);
});

