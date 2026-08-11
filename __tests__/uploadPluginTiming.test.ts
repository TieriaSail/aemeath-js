/**
 * 并发交错与时序
 *
 * 暂停 / 半开 / 探测 / 强制冲刷 / 补传 这几套机制各自都对，合到一起时靠的是
 * 几个共享标志位（`paused`、`halfOpen`、`forceRunDepth`、`probeTimer`）。
 * 这类状态机出错不会抛异常，只会停在某个不该停的组合上——队列静悄悄不再上传，
 * 或者定时器泄漏成孤儿。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UploadPlugin, type UploadResult } from '../src/plugins/UploadPlugin';
import { AemeathLogger } from '../src/core/Logger';
import type { LogLevel } from '../src/types';

function setOnLine(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', {
    value,
    configurable: true,
    writable: true,
  });
}

describe('UploadPlugin 并发交错与时序', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    setOnLine(true);
    localStorage.clear();
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
    setOnLine(true);
    localStorage.clear();
    vi.useRealTimers();
  });

  it('队列已暂停时 flush() 必须能强推出去，而且不留下孤儿探测定时器', async () => {
    vi.useFakeTimers();
    let online = false;
    const uploaded: string[] = [];
    const plugin = new UploadPlugin({
      onUpload: (async (log: { message: string }): Promise<UploadResult> => {
        if (!online) throw new TypeError('Failed to fetch');
        uploaded.push(log.message);
        return { success: true };
      }) as never,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, suspectedOfflineThreshold: 1, uploadInterval: 100000 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);

    logger.error('held');
    await vi.advanceTimersByTimeAsync(300);
    expect(plugin.getQueueStatus().paused).toBe(true);

    // 网络其实已经好了，用户手动 flush（例如页面要跳走了）。
    // 假定时器下不能直接 await：processQueue 内部有串行间隔的 setTimeout，
    // 不推进时钟就永远等不到，await 会把自己锁死。
    online = true;
    const flushing = plugin.flush();
    await vi.advanceTimersByTimeAsync(2000);
    await flushing;

    expect(uploaded).toContain('held');
    // flush 成功之后状态必须完全归位，不能还挂着暂停或探测
    expect(plugin.getQueueStatus().paused).toBe(false);
    const internals = plugin as unknown as { probeTimer: unknown; halfOpen: boolean };
    expect(internals.probeTimer).toBeNull();
    expect(internals.halfOpen).toBe(false);
  });

  it('flush 只能覆盖本地调度，不能越过服务端 Retry-After', async () => {
    vi.useFakeTimers();
    const upload = vi.fn(async (): Promise<UploadResult> =>
      upload.mock.calls.length === 1
        ? {
            success: false,
            shouldRetry: true,
            retryReason: 'rate-limit',
            retryAfterMs: 5000,
          }
        : { success: true });
    const plugin = new UploadPlugin({
      onUpload: upload,
      queue: {
        offlinePolicy: 'pause',
        deduplicationDelay: 0,
        retryBackoff: { baseMs: 0, maxMs: 0 },
        uploadInterval: 100000,
      },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);

    logger.error('rate-limited');
    await vi.advanceTimersByTimeAsync(20);
    expect(upload).toHaveBeenCalledTimes(1);

    await plugin.flush();
    expect(upload).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4979);
    expect(upload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('探测正在飞的时候并发 flush()，不能把同一条日志发两遍', async () => {
    vi.useFakeTimers();
    let online = false;
    const uploaded: string[] = [];
    const plugin = new UploadPlugin({
      onUpload: (async (log: { message: string }): Promise<UploadResult> => {
        if (!online) throw new TypeError('Failed to fetch');
        await new Promise((r) => setTimeout(r, 50));
        uploaded.push(log.message);
        return { success: true };
      }) as never,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, suspectedOfflineThreshold: 1, uploadInterval: 100000 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);

    logger.error('only-once');
    await vi.advanceTimersByTimeAsync(300);
    expect(plugin.getQueueStatus().paused).toBe(true);

    online = true;
    // 探测定时器到点的同时手动 flush，制造两条路同时进 processQueue 的窗口
    const flushing = plugin.flush();
    await vi.advanceTimersByTimeAsync(10000);
    await flushing;
    await vi.advanceTimersByTimeAsync(1000);

    expect(uploaded.filter((m) => m === 'only-once')).toHaveLength(1);
  });

  it('网络反复抖动不会把状态卡死，也不会累积孤儿定时器', async () => {
    vi.useFakeTimers();
    let online = false;
    const uploaded: string[] = [];
    const plugin = new UploadPlugin({
      onUpload: (async (log: { message: string }): Promise<UploadResult> => {
        if (!online) throw new TypeError('Failed to fetch');
        uploaded.push(log.message);
        return { success: true };
      }) as never,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, suspectedOfflineThreshold: 1, uploadInterval: 100000 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);
    logger.error('survive the flapping');

    // 断-通-断-通…快速抖 20 个来回
    for (let i = 0; i < 20; i++) {
      setOnLine(false);
      window.dispatchEvent(new Event('offline'));
      await vi.advanceTimersByTimeAsync(30);
      setOnLine(true);
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(30);
    }

    // 抖动结束、网络真的好了
    online = true;
    setOnLine(true);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(120000);

    expect(uploaded).toContain('survive the flapping');
    expect(plugin.getQueueStatus().paused).toBe(false);
    expect(plugin.getQueueStatus().length).toBe(0);
  });

  it('processQueue 正在跑的时候 requeue 进来的日志不会被吞', async () => {
    const uploaded: string[] = [];
    let injected = false;
    const plugin = new UploadPlugin({
      onUpload: (async (log: { message: string }): Promise<UploadResult> => {
        uploaded.push(log.message);
        // 第一条上传途中塞一条新的进来，模拟离线插件的补传撞上正在进行的轮次
        if (!injected) {
          injected = true;
          plugin.requeue([
            {
              logId: 'injected-1',
              level: 'error' as LogLevel,
              message: 'injected mid-run',
              timestamp: Date.now(),
            },
          ]);
        }
        return { success: true };
      }) as never,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, uploadInterval: 50 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);

    logger.error('first');
    for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 10));

    expect(uploaded).toContain('first');
    expect(uploaded).toContain('injected mid-run');
    expect(plugin.getQueueStatus().length).toBe(0);
  });

  it('请求飞行期间 setOnUpload(null) 会在当前请求后停住，不能继续调用旧端点', async () => {
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const oldUpload = vi.fn(async (): Promise<UploadResult> => {
      if (oldUpload.mock.calls.length === 1) {
        markFirstStarted();
        await firstGate;
      }
      return { success: true };
    });
    const plugin = new UploadPlugin({
      onUpload: oldUpload,
      queue: { deduplicationDelay: 0, uploadInterval: 100000 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);

    logger.error('already flying');
    logger.error('must stay queued');
    await firstStarted;
    plugin.setOnUpload(null);
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 180));

    expect(oldUpload).toHaveBeenCalledTimes(1);
    expect(plugin.getQueueStatus()).toMatchObject({ paused: true, length: 1 });

    const replacement = vi.fn(async (): Promise<UploadResult> => ({ success: true }));
    plugin.setOnUpload(replacement);
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(replacement).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'must stay queued' }),
    );
  });

  it('重新绑定 callback 不能把仍然断网的队列谎报为 resumed', async () => {
    let online = false;
    const resumed = vi.fn();
    const plugin = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => {
        if (!online) throw new TypeError('Failed to fetch');
        return { success: true };
      },
      queue: { deduplicationDelay: 0, suspectedOfflineThreshold: 1, uploadInterval: 100000 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.on('upload:resumed', resumed);
    logger.use(plugin);

    logger.error('still offline after callback returns');
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(plugin.getQueueStatus().paused).toBe(true);

    plugin.setOnUpload(null);
    plugin.setOnUpload(async () => online ? { success: true } : {
      success: false,
      shouldRetry: true,
      retryReason: 'network',
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(resumed).not.toHaveBeenCalled();
    expect(plugin.getQueueStatus().paused).toBe(true);

    online = true;
    window.dispatchEvent(new Event('online'));
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(resumed).toHaveBeenCalledTimes(1);
    expect(plugin.getQueueStatus()).toMatchObject({ paused: false, length: 0 });
  });

  it('上传飞行途中卸载，这条日志要落进缓存而不是凭空消失', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const plugin = new UploadPlugin({
      onUpload: (async (): Promise<UploadResult> => {
        await gate;
        return { success: true };
      }) as never,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0 },
      cache: { enabled: true, key: 'inflight-teardown' },
      saveOnUnload: false,
    });
    logger.use(plugin);

    logger.error('in flight when torn down');
    await new Promise((r) => setTimeout(r, 50));

    // 请求还挂着的时候卸载
    plugin.uninstall(logger as never);
    release!();
    await new Promise((r) => setTimeout(r, 50));

    const cached = localStorage.getItem('inflight-teardown') ?? '';
    expect(cached).toContain('in flight when torn down');
  });

  it('重复 online 只触发半开探测，不能伪造恢复或突破退避上限', async () => {
    vi.useFakeTimers();
    const plugin = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => {
        throw new TypeError('Failed to fetch');
      },
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, suspectedOfflineThreshold: 1, uploadInterval: 100000 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);

    logger.error('flap');
    await vi.advanceTimersByTimeAsync(200);

    // online 只是链路可能恢复的提示；探测仍失败时不能清空退避。
    for (let i = 0; i < 10; i++) {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(50);
    }

    const probeDelay = (plugin as unknown as { probeDelay: number }).probeDelay;
    expect(plugin.getQueueStatus().paused).toBe(true);
    expect(probeDelay).toBeLessThanOrEqual(60000);
  });
});
