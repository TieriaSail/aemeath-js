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
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
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
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
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
        queue: { offlinePolicy: 'pause', deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
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
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
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

  it('Offline 在补传仅 requeue、尚未飞行时卸载，remount 不得误删未送达副本', async () => {
    const dbName = `t-requeue-tomb-${Math.random()}`;
    // Upload 用超长 dedup + 暂停：requeue 后进队列但不立刻 attemptUpload
    const upload = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => {
        throw new TypeError('Failed to fetch');
      },
      queue: {
        offlinePolicy: 'pause',
        deduplicationDelay: 60_000,
        suspectedOfflineThreshold: 1,
      },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({ dbName });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();

    setOnLine(false);
    logger.error('only-requeued');
    await settle(10);
    expect(offline.getStatus().pending).toBeGreaterThan(0);

    // 触发补传 requeue（Upload 仍因 dedup/队列未真正 inFlight）
    setOnLine(true);
    window.dispatchEvent(new Event('online'));
    await new Promise((r) => setTimeout(r, 30));

    offline.uninstall(logger as never);
    upload.uninstall(logger as never);
    logger.destroy();

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
    const offline2 = new OfflinePersistencePlugin({ dbName });
    logger2.use(upload2);
    logger2.use(offline2);
    await offline2.whenReady();
    await settle(40);

    expect(delivered).toContain('only-requeued');

    offline2.uninstall(logger2 as never);
    logger2.destroy();
  }, 20000);

  it('先卸 Offline、后到的 upload:success，remount 也不得再补传', async () => {
    const dbName = `t-late-success-${Math.random()}`;
    let resolveUpload!: (v: UploadResult) => void;

    const upload = new UploadPlugin({
      onUpload: () =>
        new Promise<UploadResult>((resolve) => {
          resolveUpload = resolve;
        }),
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({ dbName });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();

    setOnLine(false);
    logger.error('success-after-offline-gone');
    await settle(10);
    expect(offline.getStatus().pending).toBeGreaterThan(0);

    setOnLine(true);
    window.dispatchEvent(new Event('online'));
    await new Promise((r) => setTimeout(r, 20));

    // 关键：Offline 先拆掉，success 晚到
    offline.uninstall(logger as never);
    resolveUpload({ success: true });
    await new Promise((r) => setTimeout(r, 20));

    upload.uninstall(logger as never);
    logger.destroy();

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
    const offline2 = new OfflinePersistencePlugin({ dbName });
    logger2.use(upload2);
    logger2.use(offline2);
    await offline2.whenReady();
    await settle(30);

    expect(delivered).not.toContain('success-after-offline-gone');
    expect(offline2.getStatus().pending).toBe(0);

    offline2.uninstall(logger2 as never);
    logger2.destroy();
  }, 20000);

  it('uninstall 打断未完成删盘后，同 slot remount 不得把已送达日志再补传', async () => {
    const dbName = `t-orphan-del-${Math.random()}`;
    let resolveUpload!: (v: UploadResult) => void;
    let uploadStarted = false;

    const upload = new UploadPlugin({
      onUpload: () => {
        uploadStarted = true;
        return new Promise<UploadResult>((resolve) => {
          resolveUpload = resolve;
        });
      },
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({ dbName });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();

    setOnLine(false);
    logger.error('delivered-then-teardown');
    await settle(10);
    expect(offline.getStatus().pending).toBeGreaterThan(0);

    setOnLine(true);
    window.dispatchEvent(new Event('online'));
    // 等到补传/内存队列开始上传，再在删盘完成前拆掉 offline
    for (let i = 0; i < 50 && !uploadStarted; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(uploadStarted).toBe(true);

    resolveUpload({ success: true });
    // 给 handleSuccess 记墓碑的时间，但不给异步删盘跑完
    await new Promise((r) => setTimeout(r, 0));
    offline.uninstall(logger as never);
    upload.uninstall(logger as never);
    logger.destroy();

    // 同页 remount：同一 dbName/slot
    setOnLine(true);
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
    const offline2 = new OfflinePersistencePlugin({ dbName });
    logger2.use(upload2);
    logger2.use(offline2);
    await offline2.whenReady();
    await settle(30);

    expect(delivered).not.toContain('delivered-then-teardown');
    expect(offline2.getStatus().pending).toBe(0);

    offline2.uninstall(logger2 as never);
    logger2.destroy();
  }, 20000);

  it('store 打开完成前到达的 paused/enqueued 落盘请求不会被静默丢掉', async () => {
    const storeMod = await import('../src/plugins/offline/OfflineStore');
    const realCreate = storeMod.createOfflineStore;
    const spy = vi.spyOn(storeMod, 'createOfflineStore').mockImplementation(async (opts) => {
      await new Promise((r) => setTimeout(r, 120));
      return realCreate(opts);
    });

    try {
      const upload = new UploadPlugin({
        onUpload: (async (): Promise<UploadResult> => {
          throw new TypeError('Failed to fetch');
        }) as never,
        queue: { offlinePolicy: 'pause', deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
        cache: { enabled: false },
        saveOnUnload: false,
      });
      const offline = new OfflinePersistencePlugin({ dbName: `t-prestore-${Math.random()}` });
      logger.use(upload);
      logger.use(offline);

      // 不要 await whenReady：在 store===null 窗口内制造 paused 落盘
      setOnLine(false);
      logger.error('before-store-ready');
      await new Promise((r) => setTimeout(r, 30));

      await offline.whenReady();
      await settle(10);

      expect(offline.getStatus().pending).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  }, 20000);

  it('同实例 Offline remount：Upload 缓存先送达时不得再从盘补传一遍', async () => {
    const dbName = `t-same-inst-${Math.random()}`;
    const cacheKey = `__aemeath_cache_${Math.random()}__`;
    const delivered: string[] = [];

    const offline = new OfflinePersistencePlugin({ dbName });
    const upload1 = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => {
        throw new TypeError('Failed to fetch');
      },
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
      cache: { enabled: true, key: cacheKey },
      saveOnUnload: false,
    });
    logger.use(upload1);
    logger.use(offline);
    await offline.whenReady();

    setOnLine(false);
    logger.error('dup-candidate');
    await settle(20);
    expect(offline.getStatus().pending).toBeGreaterThan(0);

    // 强制把队列镜像进 cache（同 uninstall 存盘路径）
    upload1.uninstall(logger as never);
    offline.uninstall(logger as never);
    logger.destroy();

    setOnLine(true);
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
    // 复用同一个 Offline 实例（HMR / 手动持有引用 remount）
    logger2.use(offline);
    await settle(60);
    await offline.whenReady();
    await settle(40);

    expect(delivered.filter((m) => m === 'dup-candidate')).toHaveLength(1);

    offline.uninstall(logger2 as never);
    logger2.destroy();
  }, 20000);

  it('offline-replay 遇 queue-overflow 后，冷却结束仍能继续补传', async () => {
    const dbName = `t-overflow-wake-${Math.random()}`;
    let gate: Promise<void> = Promise.resolve();
    let releaseGate!: () => void;
    let hold = false;

    const upload = new UploadPlugin({
      onUpload: (async (log: { message: string }): Promise<UploadResult> => {
        if (hold) await gate;
        return { success: true };
      }) as never,
      queue: {
        offlinePolicy: 'pause',
        deduplicationDelay: 0,
        maxSize: 2,
        suspectedOfflineThreshold: 1,
      },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({
      dbName,
      replayBatchSize: 10,
      replayTimeoutMs: 5000,
    });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();

    setOnLine(false);
    for (let i = 0; i < 6; i++) logger.error(`ov-${i}`);
    await settle(30);
    expect(offline.getStatus().pending).toBeGreaterThan(2);

    hold = true;
    gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    setOnLine(true);
    window.dispatchEvent(new Event('online'));
    await settle(20);

    // 放行当前飞行，让溢出发生后的冷却有机会唤醒后续补传
    hold = false;
    releaseGate();
    await settle(150);

    // 静默超过冷却（armOverflowReplayWake ≈ 1s）后仍应消化完
    await new Promise((r) => setTimeout(r, 1500));
    await settle(40);

    expect(offline.getStatus().pending).toBe(0);
  }, 30000);

  it('split overflow 落盘后须冷却唤醒补传，不能因抑制 success 而饿死', async () => {
    const dbName = `t-overflow-wake-offline-${Math.random()}`;
    let release!: (r: UploadResult) => void;
    let hangOnce = true;
    const delivered: string[] = [];

    const upload = new UploadPlugin({
      onUpload: (log) => {
        // 只挂起第一次 p1，补传时必须放行，否则 maxSize=1 会堵死后续
        if (hangOnce && log.logId === 'p1') {
          hangOnce = false;
          return new Promise<UploadResult>((res) => {
            release = res;
          });
        }
        delivered.push(log.logId);
        return Promise.resolve({ success: true } as UploadResult);
      },
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, maxSize: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({ dbName, replayTimeoutMs: 2000 });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();

    const mk = (id: string, index: number) =>
      ({
        logId: id,
        level: 'error' as const,
        message: 'split-piece',
        timestamp: Date.now(),
        tags: { splitId: 'g1', splitIndex: index, splitTotal: 3 },
      });

    upload.requeue(mk('p1', 1) as never);
    await settle(15);
    upload.requeue(mk('p2', 2) as never);
    upload.requeue(mk('p3', 3) as never);
    await settle(20);
    expect(offline.getStatus().pending).toBeGreaterThan(0);

    release({ success: true });
    // resumed 会立刻 scheduleReplay；再留出串行补传（maxSize=1）时间
    await new Promise((r) => setTimeout(r, 2000));
    await settle(80);

    expect(offline.getStatus().pending).toBe(0);
    expect(delivered.length).toBeGreaterThan(0);
  }, 20000);

  it('补传已占 inFlight 后 Upload 被换掉，孤儿坑位不得挡住再次补传', async () => {
    const dbName = `t-orphan-inflight-${Math.random()}`;
    let hangRelease!: (r: UploadResult) => void;
    const delivered: string[] = [];

    const offline = new OfflinePersistencePlugin({ dbName, replayTimeoutMs: 60_000 });
    const hangUpload = new UploadPlugin({
      onUpload: () =>
        new Promise<UploadResult>((res) => {
          hangRelease = res;
        }),
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    // 先用会失败的 upload 落盘
    const seedUpload = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => {
        throw new TypeError('Failed to fetch');
      },
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(seedUpload);
    logger.use(offline);
    await offline.whenReady();

    setOnLine(false);
    logger.error('orphan-inflight');
    await settle(20);
    expect(offline.getStatus().pending).toBeGreaterThan(0);

    logger.uninstall('upload');
    setOnLine(true);
    logger.use(hangUpload);
    await settle(40);
    expect(offline.getStatus().replaying).toBeGreaterThan(0);

    // 挂起中再换 Upload：旧 inFlight 成孤儿
    logger.uninstall('upload');
    const okUpload = new UploadPlugin({
      onUpload: (async (log: { message: string }): Promise<UploadResult> => {
        delivered.push(log.message);
        return { success: true };
      }) as never,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(okUpload);
    await settle(60);

    expect(delivered).toContain('orphan-inflight');
    expect(offline.getStatus().pending).toBe(0);

    hangRelease?.({ success: true });
  }, 20000);

  it('只卸重装 Upload 后，Offline 盘上 pending 必须被唤醒补传', async () => {
    const dbName = `t-upload-remount-wake-${Math.random()}`;
    const delivered: string[] = [];

    const upload1 = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => {
        throw new TypeError('Failed to fetch');
      },
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({ dbName });
    logger.use(upload1);
    logger.use(offline);
    await offline.whenReady();

    setOnLine(false);
    logger.error('wake-after-upload-remount');
    await settle(20);
    expect(offline.getStatus().pending).toBeGreaterThan(0);

    // Offline 不动，只换 Upload（HMR / 热更新常见）
    logger.uninstall('upload');
    setOnLine(true);
    const upload2 = new UploadPlugin({
      onUpload: (async (log: { message: string }): Promise<UploadResult> => {
        delivered.push(log.message);
        return { success: true };
      }) as never,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(upload2);
    await settle(60);

    expect(delivered).toContain('wake-after-upload-remount');
    expect(offline.getStatus().pending).toBe(0);
  }, 20000);

  it('不可 JSON 序列化的载荷落盘失败时要报 storage-rejected', async () => {
    const drops: string[] = [];
    const upload = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => {
        throw new TypeError('Failed to fetch');
      },
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (_log, info) => {
        drops.push(info.reason);
      },
    });
    const offline = new OfflinePersistencePlugin({ dbName: `t-bigint-${Math.random()}` });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();

    setOnLine(false);
    logger.error('bigint-payload', { context: { id: 1n } });
    await settle(20);

    expect(drops).toContain('storage-rejected');
    expect(offline.getStatus().pending).toBe(0);
  }, 15000);
});
