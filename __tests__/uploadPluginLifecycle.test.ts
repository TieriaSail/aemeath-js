/**
 * UploadPlugin —— 生命周期与并发
 *
 * 这一组针对的都是"不报错但功能已死"或"卸载后还在动"的问题：
 * 复装变哑巴、墓碑实例覆盖接任者的缓存、卸载后回调放冷枪、
 * 半开态永久卡死、卸载丢掉飞行中的日志。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UploadPlugin, type UploadResult } from '../src/plugins/UploadPlugin';
import { AemeathLogger } from '../src/core/Logger';
import type { LogEntry } from '../src/types';

const CACHE_KEY = '__logger_upload_queue__';

function setOnLine(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', {
    value,
    configurable: true,
    writable: true,
  });
}

function cachedIds(): string[] {
  const raw = localStorage.getItem(CACHE_KEY);
  if (!raw) return [];
  return (JSON.parse(raw) as Array<{ log: LogEntry }>).map((it) => it.log.logId);
}

describe('UploadPlugin — 生命周期', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    vi.useFakeTimers();
    setOnLine(true);
    localStorage.clear();
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
    setOnLine(true);
    vi.useRealTimers();
    localStorage.clear();
  });

  it('pause 模式下 remount 后必须能继续出队，不能永久卡在 paused', async () => {
    let calls = 0;
    const plugin = new UploadPlugin({
      onUpload: async () => {
        calls++;
        if (calls === 1) throw new TypeError('Failed to fetch');
        return { success: true } as UploadResult;
      },
      queue: {
        offlinePolicy: 'pause',
        deduplicationDelay: 10,
        suspectedOfflineThreshold: 1,
      },
      cache: { enabled: false },
      saveOnUnload: false,
    });

    logger.use(plugin);
    logger.error('pause-me');
    await vi.advanceTimersByTimeAsync(500);
    expect(plugin.getQueueStatus().paused).toBe(true);

    logger.uninstall('upload');
    logger.use(plugin);
    expect(plugin.getQueueStatus().paused).toBe(false);

    logger.error('after-remount');
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('同实例 remount：旧飞行 success 只扇出终态，不拆掉新生命周期的 inFlight', async () => {
    const releases: Array<(r: UploadResult) => void> = [];
    let logId = '';
    const uploadFn = vi.fn((log: LogEntry) => {
      logId = log.logId;
      return new Promise<UploadResult>((res) => {
        releases.push(res);
      });
    });
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 10 },
      cache: { enabled: true },
      saveOnUnload: false,
    });

    const successes: string[] = [];
    logger.on('upload:success', (p: { log?: { message?: string } }) => {
      if (p.log?.message) successes.push(p.log.message);
    });

    logger.use(plugin);
    logger.error('mid-flight');
    await vi.advanceTimersByTimeAsync(200);
    expect(uploadFn).toHaveBeenCalledTimes(1);

    logger.uninstall('upload');
    // 复装：cache 恢复后会再开一条飞行
    logger.use(plugin);
    await vi.advanceTimersByTimeAsync(200);
    expect(uploadFn).toHaveBeenCalledTimes(2);
    expect(releases).toHaveLength(2);

    // 旧 attempt 先成功：必须 emit，但不得把新飞行从 inFlight 拆掉
    releases[0]!({ success: true });
    await vi.advanceTimersByTimeAsync(50);
    expect(successes).toEqual(['mid-flight']);
    expect(plugin.isInFlight(logId)).toBe(true);

    // 新飞行仍能正常收尾（若旧路径误删 inFlight，这里会状态错乱）
    releases[1]!({ success: true });
    await vi.advanceTimersByTimeAsync(50);
    expect(successes.filter((m) => m === 'mid-flight')).toHaveLength(2);
    expect(plugin.getQueueStatus().length).toBe(0);
  });

  it('复装同一个插件实例后必须还能上传，而不是变成哑巴', async () => {
    // destroyed 这块墓碑标记一旦不清，插件看起来是装上的（hasPlugin 为真、
    // 定时器在转），但 processQueue / requeue 全在入口早退。HMR 会走到这里。
    const uploadFn = vi.fn(async () => ({ success: true }) as UploadResult);
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 10 },
      cache: { enabled: false },
      saveOnUnload: false,
    });

    logger.use(plugin);
    logger.error('before');
    await vi.advanceTimersByTimeAsync(500);
    expect(uploadFn).toHaveBeenCalledTimes(1);

    logger.uninstall('upload');
    logger.use(plugin);

    logger.error('after');
    await vi.advanceTimersByTimeAsync(500);
    expect(uploadFn).toHaveBeenCalledTimes(2);
  });

  it('已卸载的实例不能覆盖接任实例的缓存', async () => {
    // 缓存 key 是确定性的 → 跨实例共享。飞行中的请求在卸载后落地时回写，
    // 会把新实例刚存好的队列整个抹掉。
    let release!: (r: UploadResult) => void;
    const dead = new UploadPlugin({
      onUpload: () => new Promise<UploadResult>((res) => (release = res)),
      queue: { offlinePolicy: 'pause', deduplicationDelay: 10 },
      cache: { enabled: true },
      saveOnUnload: false,
    });

    logger.use(dead);
    logger.error('OLD');
    await vi.advanceTimersByTimeAsync(200);
    logger.uninstall('upload');

    const live = new UploadPlugin({
      onUpload: () => new Promise<UploadResult>(() => {}),
      queue: { offlinePolicy: 'pause', deduplicationDelay: 10, concurrency: 1 },
      cache: { enabled: true },
      saveOnUnload: false,
    });
    const logger2 = new AemeathLogger({ enableConsole: false });
    logger2.use(live);
    logger2.error('NEW-1');
    logger2.error('NEW-2');
    await vi.advanceTimersByTimeAsync(200);

    const before = cachedIds();

    // 死掉的插件此刻才收到响应
    release({ success: false, shouldRetry: true, retryReason: 'server' });
    await vi.advanceTimersByTimeAsync(200);

    expect(cachedIds()).toEqual(before);
    logger2.destroy();
  });

  it('卸载之后不再触发 onDrop', async () => {
    let release!: (r: UploadResult) => void;
    const drops: string[] = [];
    const plugin = new UploadPlugin({
      onUpload: () => new Promise<UploadResult>((res) => (release = res)),
      queue: { offlinePolicy: 'pause', deduplicationDelay: 10 },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (_l, info) => drops.push(info.reason),
    });

    logger.use(plugin);
    logger.error('x');
    await vi.advanceTimersByTimeAsync(200);
    logger.uninstall('upload');

    release({ success: false, shouldRetry: false });
    await vi.advanceTimersByTimeAsync(200);

    expect(drops).toEqual([]);
  });

  it('直接 plugin.uninstall() 也要摘掉 log 监听器', async () => {
    // 框架 teardown 钩子的典型写法，不会传 logger 参数
    const uploadFn = vi.fn(async () => ({ success: true }) as UploadResult);
    const drops: string[] = [];
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 10, maxSize: 2 },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (_l, info) => drops.push(info.reason),
    });

    logger.use(plugin);
    plugin.uninstall();

    for (let i = 0; i < 6; i++) logger.error(`after-teardown-${i}`);
    await vi.advanceTimersByTimeAsync(500);

    expect(plugin.getQueueStatus().length).toBe(0);
    expect(drops).toEqual([]);
  });

  it('探测收到"明确拒收"时应恢复队列，而不是永远停在 paused', async () => {
    // 服务端答 no-retry 说明链路是通的 —— 探测成功了，只是这条日志不受欢迎。
    // 卡住的话 upload:resumed 永不触发，离线补传也跟着永久停摆。
    let call = 0;
    const plugin = new UploadPlugin({
      onUpload: async () => {
        call++;
        // 前三次传输层失败 → 触发暂停；探测那次服务端明确拒收
        if (call <= 3) throw new TypeError('Failed to fetch');
        return { success: false, shouldRetry: false } as UploadResult;
      },
      queue: { offlinePolicy: 'pause', deduplicationDelay: 10, suspectedOfflineThreshold: 3 },
      cache: { enabled: false },
      saveOnUnload: false,
    });

    const resumed = vi.fn();
    logger.on('upload:resumed', resumed);
    logger.use(plugin);

    logger.error('a');
    // 走到暂停：三次传输层失败（之间有退避）
    let pausedSeen = false;
    for (let i = 0; i < 40 && !pausedSeen; i++) {
      await vi.advanceTimersByTimeAsync(250);
      if (plugin.getQueueStatus().paused) pausedSeen = true;
    }
    expect(pausedSeen).toBe(true);

    // 等探测定时器（PROBE_BASE_MS = 5s）触发
    await vi.advanceTimersByTimeAsync(10000);

    expect(plugin.getQueueStatus().paused).toBe(false);
    expect(resumed).toHaveBeenCalled();
  });

  it('卸载时飞行中的日志也要落盘，不能凭空消失', async () => {
    const plugin = new UploadPlugin({
      onUpload: () => new Promise<UploadResult>(() => {}),
      queue: { offlinePolicy: 'pause', deduplicationDelay: 10 },
      cache: { enabled: true },
      saveOnUnload: false,
    });

    logger.use(plugin);
    logger.error('IN-FLIGHT');
    await vi.advanceTimersByTimeAsync(200);

    logger.uninstall('upload');

    const messages = (
      JSON.parse(localStorage.getItem(CACHE_KEY) ?? '[]') as Array<{ log: LogEntry }>
    ).map((it) => it.log.message);
    expect(messages).toContain('IN-FLIGHT');
  });

  it('被明确拒收的日志不能留在缓存里等下次复活', async () => {
    const plugin = new UploadPlugin({
      onUpload: async () => ({ success: false, shouldRetry: false }) as UploadResult,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 10 },
      cache: { enabled: true },
      saveOnUnload: false,
    });

    logger.use(plugin);
    logger.error('rejected-by-server');
    await vi.advanceTimersByTimeAsync(500);

    expect(cachedIds()).toEqual([]);
  });
});
