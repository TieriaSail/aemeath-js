/**
 * UploadPlugin 并发与崩溃恢复
 *
 * 补第六轮几处修复的行为验证：`forceRunDepth` 引用计数、崩溃退避之后能真的
 * 醒过来、缓存写入的合并。这些都是"错了也不报错"的性质，只能靠行为钉。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UploadPlugin, type UploadResult } from '../src/plugins/UploadPlugin';
import { AemeathLogger } from '../src/core/Logger';

describe('UploadPlugin 并发与崩溃恢复', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    localStorage.clear();
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
    localStorage.clear();
    vi.useRealTimers();
  });

  it('并发 flush()：后一个不能把前一个截断，两个都要等到队列真的空', async () => {
    // forceRun 从前是个布尔量：第二个 flush() 结束时把它清掉，第一个 flush()
    // 还没发完就以为自己发完了，resolve 时队列里其实还压着日志。
    let resolveGate: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      resolveGate = r;
    });
    let first = true;
    const uploaded: string[] = [];

    const plugin = new UploadPlugin({
      onUpload: (async (log: { message: string }): Promise<UploadResult> => {
        if (first) {
          first = false;
          await gate; // 卡住第一条，制造两个 flush 重叠的窗口
        }
        uploaded.push(log.message);
        return { success: true };
      }) as never,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, uploadInterval: 100000 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);

    for (let i = 0; i < 6; i++) logger.error(`concurrent-${i}`);

    const a = plugin.flush();
    const b = plugin.flush();
    resolveGate!();
    await Promise.all([a, b]);

    expect(uploaded).toHaveLength(6);
    expect(plugin.getQueueStatus().length).toBe(0);
  });

  it('processQueue 崩溃后要退避，但退避结束必须自己醒过来', async () => {
    vi.useFakeTimers();
    const uploaded: string[] = [];
    let poisoned = true;

    const plugin = new UploadPlugin({
      onUpload: (async (log: { message: string }): Promise<UploadResult> => {
        uploaded.push(log.message);
        return { success: true };
      }) as never,
      // 周期定时器拉得很长，把恢复这件事完全交给崩溃退避那条路，
      // 否则测的是定时器而不是退避
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, uploadInterval: 100000 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);

    // 让 processQueue 内部炸一次：污染取队首这一步
    const self = plugin as unknown as { takeNextDueItem: (...a: unknown[]) => unknown };
    const original = self.takeNextDueItem.bind(plugin);
    self.takeNextDueItem = (...args: unknown[]) => {
      // 只在队列真的有东西时炸，否则空队列的例行轮询会先把毒药消耗掉
      if (poisoned && plugin.getQueueStatus().length > 0) {
        poisoned = false;
        throw new Error('boom inside processQueue');
      }
      return original(...args);
    };

    logger.error('after the crash');

    // 崩溃后的短期内必须安静：不能贴着 CPU 重排
    await vi.advanceTimersByTimeAsync(5000);
    expect(uploaded).toHaveLength(0);

    // 退避（30s）过后必须自己恢复，否则就是崩一次брick一辈子
    await vi.advanceTimersByTimeAsync(40000);
    expect(uploaded).toContain('after the crash');
  });

  it('持续崩溃不能变成自噬：SDK 不能把自己的崩溃造成新日志', async () => {
    vi.useFakeTimers();
    const produced: string[] = [];
    let poisoned = true;

    const plugin = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => ({ success: true }),
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, uploadInterval: 500 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);
    logger.on('log', (entry) => {
      produced.push(entry.message);
    });

    const self = plugin as unknown as { takeNextDueItem: (...a: unknown[]) => unknown };
    const original = self.takeNextDueItem.bind(plugin);
    self.takeNextDueItem = (...args: unknown[]) => {
      if (poisoned && plugin.getQueueStatus().length > 0) throw new Error('persistent boom');
      return original(...args);
    };

    logger.error('seed');
    await vi.advanceTimersByTimeAsync(120000);
    poisoned = false;

    // 持续崩溃两分钟，日志总数必须仍然只有那一条 seed。
    // 崩溃被自己的 ErrorCapturePlugin 抓走再上报，就是自噬循环的起点。
    expect(produced).toEqual(['seed']);
    expect(plugin.getQueueStatus().length).toBeLessThanOrEqual(1);
  });

  it('突发丢弃时缓存写入要合并，不能每丢一条就整队列写一次盘', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    const plugin = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => ({ success: false, error: 'nope' }),
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, maxSize: 5, uploadInterval: 100000 },
      cache: { enabled: true, key: 'coalesce-test' },
      saveOnUnload: false,
    });
    logger.use(plugin);

    setItem.mockClear();
    for (let i = 0; i < 60; i++) logger.error(`burst-${i}`);
    await new Promise((r) => setTimeout(r, 50));

    // 60 次溢出丢弃若每次都整队列落盘，就是 O(N^2) 的写放大
    const writes = setItem.mock.calls.filter((c) => c[0] === 'coalesce-test').length;
    expect(writes).toBeLessThan(20);

    setItem.mockRestore();
  });
});
