/**
 * UploadPlugin —— 没有 DOM 的宿主（小程序 / SSR / Worker）
 *
 * 断网暂停这套机制是在浏览器里设计的：它靠 `navigator.onLine` 判断离线，
 * 靠 `window` 的 `online` 事件恢复。小程序两样都没有，SSR 和 Worker 也没有。
 * 这里要钉死的是：**队列在这种宿主里必须仍然能自己醒过来**，
 * 不能因为等不到永远不会来的 `online` 事件而永久停摆
 * （那会连带让 OfflinePersistencePlugin 的补传一起永久停摆）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UploadPlugin, type UploadResult } from '../src/plugins/UploadPlugin';
import { AemeathLogger } from '../src/core/Logger';

describe('UploadPlugin — 无 window / 无 navigator 的宿主', () => {
  let logger: AemeathLogger;
  let savedWindow: unknown;
  let savedNavigator: unknown;

  beforeEach(() => {
    vi.useFakeTimers();
    savedWindow = (globalThis as Record<string, unknown>)['window'];
    savedNavigator = (globalThis as Record<string, unknown>)['navigator'];
    // 抹掉浏览器全局，模拟小程序 / SSR 宿主
    delete (globalThis as Record<string, unknown>)['window'];
    delete (globalThis as Record<string, unknown>)['navigator'];
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
    (globalThis as Record<string, unknown>)['window'] = savedWindow;
    (globalThis as Record<string, unknown>)['navigator'] = savedNavigator;
    vi.useRealTimers();
  });

  it('装载和上传都不能因为缺少 window / navigator 而抛异常', async () => {
    const uploadFn = vi.fn(async () => ({ success: true }) as UploadResult);
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { deduplicationDelay: 10 },
      cache: { enabled: false },
      saveOnUnload: false,
    });

    expect(() => logger.use(plugin)).not.toThrow();
    logger.error('no dom here');
    await vi.advanceTimersByTimeAsync(500);
    expect(uploadFn).toHaveBeenCalledTimes(1);
  });

  it('缺少 navigator 时不能被误判为离线', async () => {
    // `navigator` 不存在 ≠ 离线。判成离线的话，小程序一启动队列就是暂停的。
    const uploadFn = vi.fn(async () => ({ success: true }) as UploadResult);
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { deduplicationDelay: 10 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);

    logger.error('first');
    await vi.advanceTimersByTimeAsync(500);

    expect(plugin.getQueueStatus().paused).toBe(false);
    expect(uploadFn).toHaveBeenCalled();
  });

  it('暂停后必须靠探测定时器自己恢复，而不是干等永远不会来的 online 事件', async () => {
    // 这是本文件的核心断言。浏览器里恢复有两条路（online 事件 + 探测定时器），
    // 小程序里只剩后者。若探测这条路不通，队列就是永久死锁，
    // 而且 upload:resumed 永不触发 → 离线补传也跟着永久停摆。
    let failing = true;
    const uploadFn = vi.fn(async (): Promise<UploadResult> => {
      if (failing) throw new TypeError('Failed to fetch');
      return { success: true };
    });
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { deduplicationDelay: 10, suspectedOfflineThreshold: 2 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const resumed = vi.fn();
    logger.on('upload:resumed', resumed);
    logger.use(plugin);

    logger.error('written while the network is down');

    // 走到暂停
    let paused = false;
    for (let i = 0; i < 60 && !paused; i++) {
      await vi.advanceTimersByTimeAsync(250);
      paused = plugin.getQueueStatus().paused;
    }
    expect(paused).toBe(true);

    // 网络恢复，但宿主发不出 online 事件
    failing = false;
    const before = uploadFn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120000);

    expect(uploadFn.mock.calls.length).toBeGreaterThan(before);
    expect(plugin.getQueueStatus().paused).toBe(false);
    expect(plugin.getQueueStatus().length).toBe(0);
    expect(resumed).toHaveBeenCalled();
  });

  it('反复暂停不会把探测间隔推到上限，导致恢复越来越慢', async () => {
    // 探测退避应该由"探测失败"驱动，不是由"又暂停了一次"驱动
    const uploadFn = vi.fn(async (): Promise<UploadResult> => {
      throw new TypeError('Failed to fetch');
    });
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { deduplicationDelay: 10, suspectedOfflineThreshold: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);

    for (let i = 0; i < 5; i++) {
      logger.error(`burst-${i}`);
      await plugin.flush();
    }
    await vi.advanceTimersByTimeAsync(200);

    const before = uploadFn.mock.calls.length;
    // 首个探测间隔是 5s，若被反复暂停推高就等不到这次探测
    await vi.advanceTimersByTimeAsync(8000);
    expect(uploadFn.mock.calls.length).toBeGreaterThan(before);
  });
});
