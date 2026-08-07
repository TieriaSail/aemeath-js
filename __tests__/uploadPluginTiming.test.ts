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

  it('同一轮里 pause 和 resume 交替，probeDelay 不能被推到上限', async () => {
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

    // 反复触发 online：每次 resume 都会清掉退避，下一次暂停应从基础间隔重新开始
    for (let i = 0; i < 10; i++) {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(50);
    }

    const probeDelay = (plugin as unknown as { probeDelay: number }).probeDelay;
    // 基础间隔 5s，上限 60s。反复 resume 不该把它顶到上限
    expect(probeDelay).toBeLessThan(60000);
  });
});
