/**
 * UploadPlugin —— 终止性保证
 *
 * 这一组测试守的是同一条底线：**任何失败模式都必须在有限次尝试内收敛**，
 * 要么成功、要么暂停、要么明确丢弃。永远不允许出现「无限重试 = 请求风暴」。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UploadPlugin, type UploadResult } from '../src/plugins/UploadPlugin';
import { AemeathLogger } from '../src/core/Logger';
import { LogLevel, type LogEntry } from '../src/types';

const CACHE_KEY = '__resilience_cache__';

function setOnLine(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', {
    value,
    configurable: true,
    writable: true,
  });
}

describe('UploadPlugin — 终止性保证', () => {
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

  it('legacy 策略下 onUpload 抛异常必须耗尽预算后丢弃，不能无限重试', async () => {
    const uploadFn = vi.fn(async (_log: LogEntry): Promise<UploadResult> => {
      throw new Error('network down');
    });
    const dropped: string[] = [];
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { deduplicationDelay: 10, maxRetries: 3, offlinePolicy: 'legacy' },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (_log, info) => dropped.push(info.reason),
    });
    logger.use(plugin);

    logger.error('doomed');
    await vi.advanceTimersByTimeAsync(30_000);

    // 首次 + 3 次重试 = 4 次，然后必须丢弃
    expect(uploadFn.mock.calls.length).toBeLessThanOrEqual(4);
    expect(dropped).toEqual(['max-retries']);
    expect(plugin.getQueueStatus().length).toBe(0);
  });

  it('legacy 策略下 retryReason=network 同样耗预算，不能无限重试', async () => {
    const uploadFn = vi.fn(
      async (_log: LogEntry): Promise<UploadResult> => ({
        success: false,
        shouldRetry: true,
        retryReason: 'network',
      }),
    );
    const dropped: string[] = [];
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { deduplicationDelay: 10, maxRetries: 2, offlinePolicy: 'legacy' },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (_log, info) => dropped.push(info.reason),
    });
    logger.use(plugin);

    logger.error('doomed');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(uploadFn.mock.calls.length).toBeLessThanOrEqual(3);
    expect(dropped).toEqual(['max-retries']);
  });

  it('单条日志连续传输失败到阈值即暂停，即使其它日志把全局计数清零', async () => {
    // poison 每次都抛（传输层失败，不消耗预算）；noise 立即被判为 no-retry 丢弃，
    // 而 no-retry 会把 consecutiveFailures 清零 —— 只靠全局计数就永远到不了阈值
    const uploadFn = vi.fn(async (log: LogEntry): Promise<UploadResult> => {
      // fetch 网络失败抛的就是 TypeError，这才是"确实没连上"的正面证据
      if (log.message === 'poison') throw new TypeError('Failed to fetch');
      return { success: false, shouldRetry: false };
    });
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { deduplicationDelay: 10, suspectedOfflineThreshold: 3 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);

    logger.error('poison');
    for (let i = 0; i < 12; i++) {
      logger.error(`noise ${i}`);
      await vi.advanceTimersByTimeAsync(1200);
    }

    const poisonAttempts = uploadFn.mock.calls.filter(
      (c) => (c[0] as LogEntry).message === 'poison',
    ).length;
    // 阈值是 3，允许半开探测多打一两次，但绝不能是十几次
    expect(poisonAttempts).toBeLessThanOrEqual(5);
    expect(plugin.getQueueStatus().paused).toBe(true);
  });

  it('抛出的 HTTP 错误（axios 风格）不算离线：耗预算丢弃，队列不暂停', async () => {
    // axios / ky / got 默认对 4xx-5xx **抛异常**，异常上挂着 response。
    // 把"回调抛了"一律当成离线，等于让后端故障把整条上报链路静默挂起 ——
    // 这和"服务端 5xx 不算离线证据"是同一条原则，只是走的另一条分支。
    const uploadFn = vi.fn(async (_log: LogEntry): Promise<UploadResult> => {
      const err = new Error('Request failed with status code 500') as Error & {
        response?: unknown;
      };
      err.response = { status: 500, data: { message: 'boom' } };
      throw err;
    });
    const dropped: string[] = [];
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { deduplicationDelay: 10, maxRetries: 2, suspectedOfflineThreshold: 2 },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (_log, info) => dropped.push(info.reason),
    });
    logger.use(plugin);

    logger.error('backend 500 via throw');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(plugin.getQueueStatus().paused).toBe(false);
    expect(dropped).toEqual(['max-retries']);
  });

  it('fetch 的网络异常（TypeError）仍然算离线：暂停而不是丢弃', async () => {
    // fetch 规范：只有网络层失败才 reject，且一定是 TypeError。
    // 这是"确实没连上"的正面证据，必须继续走暂停而不是烧预算。
    const uploadFn = vi.fn(async (_log: LogEntry): Promise<UploadResult> => {
      throw new TypeError('Failed to fetch');
    });
    const dropped: string[] = [];
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { deduplicationDelay: 10, maxRetries: 2, suspectedOfflineThreshold: 2 },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (_log, info) => dropped.push(info.reason),
    });
    logger.use(plugin);

    logger.error('really offline');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(plugin.getQueueStatus().paused).toBe(true);
    expect(dropped).toEqual([]);
  });

  it('回调自身的 bug（普通 Error）按服务端失败处理，不把链路挂起', async () => {
    // 用户回调里写错了变量名之类。这不是离线的证据，当成离线会让整条链路
    // 因为一个代码 bug 永久停摆 —— 耗预算丢弃至少是有界且可观测的
    const uploadFn = vi.fn(async (_log: LogEntry): Promise<UploadResult> => {
      throw new ReferenceError('token is not defined');
    });
    const dropped: string[] = [];
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { deduplicationDelay: 10, maxRetries: 1, suspectedOfflineThreshold: 2 },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (_log, info) => dropped.push(info.reason),
    });
    logger.use(plugin);

    logger.error('callback bug');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(plugin.getQueueStatus().paused).toBe(false);
    expect(dropped).toEqual(['max-retries']);
  });

  it('上传超时按传输层失败处理：暂停等网络，不消耗重试预算', async () => {
    // 超时的分类靠的是插件给异常打的标，不是匹配错误文案。
    // 这条测试盯住的正是那个契约：改了文案而忘了改判定，这里必须红。
    const uploadFn = vi.fn(() => new Promise<UploadResult>(() => {}));
    const dropped: string[] = [];
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { deduplicationDelay: 10, maxRetries: 2, suspectedOfflineThreshold: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (_log, info) => dropped.push(info.reason),
    });
    logger.use(plugin);

    logger.error('hangs forever');
    await vi.advanceTimersByTimeAsync(35_000);

    expect(plugin.getQueueStatus().paused).toBe(true);
    expect(dropped).toEqual([]);
  });

  it('恶劣的队列配置不会破坏终止性', async () => {
    // 配置常常来自远端下发的 JSON，字符串 / NaN / 负数都可能进来。
    // 关键不变量：无论配置多离谱，失败的日志要么被丢弃，要么被暂停接住，
    // 绝不能变成"既不消耗预算、也永不暂停"的无限重试。
    const hostile = [
      { suspectedOfflineThreshold: NaN, maxRetries: NaN },
      { suspectedOfflineThreshold: -1, maxRetries: -5 },
      { suspectedOfflineThreshold: 0, maxRetries: 0 },
      { suspectedOfflineThreshold: '3' as unknown as number },
    ];

    for (const queue of hostile) {
      const uploadFn = vi.fn(async (): Promise<UploadResult> => {
        throw new ReferenceError('server-side style failure');
      });
      const plugin = new UploadPlugin({
        onUpload: uploadFn,
        queue: { deduplicationDelay: 10, ...queue },
        cache: { enabled: false },
        saveOnUnload: false,
      });
      logger.use(plugin);
      logger.error('hostile config');
      await vi.advanceTimersByTimeAsync(120_000);

      const status = plugin.getQueueStatus();
      // 收敛的两种合法形态：队列清空（已丢弃），或明确处于暂停态
      expect(status.length === 0 || status.paused).toBe(true);
      logger.uninstall('upload');
    }
  });

  it('缓存里缺少 retryCount 的历史数据不会变成无限重试', async () => {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify([
        {
          // 故意不写 retryCount，模拟被外部改坏 / 更早版本写入的缓存
          log: {
            logId: 'legacy-cache',
            level: LogLevel.ERROR,
            message: 'from old cache',
            timestamp: Date.now(),
          },
          priority: 50,
          timestamp: Date.now(),
          cachedAt: Date.now(),
        },
      ]),
    );

    const uploadFn = vi.fn(
      async (_log: LogEntry): Promise<UploadResult> => ({
        success: false,
        shouldRetry: true,
        retryReason: 'server',
      }),
    );
    const dropped: string[] = [];
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { deduplicationDelay: 10, maxRetries: 2 },
      cache: { enabled: true, key: CACHE_KEY },
      saveOnUnload: false,
      onDrop: (_log, info) => dropped.push(info.reason),
    });
    logger.use(plugin);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(uploadFn.mock.calls.length).toBeLessThanOrEqual(3);
    expect(dropped).toEqual(['max-retries']);
    expect(plugin.getQueueStatus().length).toBe(0);
  });
});

describe('processQueue 崩溃不能变成自噬热循环', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    vi.useFakeTimers();
    setOnLine(true);
    localStorage.clear();
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
    vi.useRealTimers();
    localStorage.clear();
  });

  it('缓存里 stack 类型损坏时不抛、不空转、不永久卡死', async () => {
    // 三个弱点原本会合流成灾难：
    //   1. stack.split 对非字符串抛异常
    //   2. processQueue 只有 try/finally，且六处以浮动 Promise 调用 → unhandledrejection
    //   3. finally 以 0 延迟立刻重排 → 热循环
    // 再加上 ErrorCapturePlugin 会把这个 unhandledrejection 当宿主错误上报，
    // 上报又走同一条崩溃路径，就是自噬。
    const rejections: unknown[] = [];
    const onRejection = (e: PromiseRejectionEvent) => {
      rejections.push(e.reason);
      e.preventDefault();
    };
    globalThis.addEventListener?.('unhandledrejection', onRejection as never);

    localStorage.setItem(
      '__logger_upload_queue__',
      JSON.stringify([
        {
          log: { logId: 'bad', level: 'error', message: 'm', error: { stack: { not: 'a string' } } },
          priority: 50,
          timestamp: Date.now(),
          retryCount: 0,
        },
      ]),
    );

    const uploadFn = vi.fn(async () => ({ success: true }) as UploadResult);
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { deduplicationDelay: 10 },
      cache: { enabled: true },
      saveOnUnload: false,
    });

    const scoped = new AemeathLogger({ enableConsole: false });
    scoped.use(plugin);
    await vi.advanceTimersByTimeAsync(5000);

    globalThis.removeEventListener?.('unhandledrejection', onRejection as never);

    expect(rejections).toHaveLength(0);
    // 崩溃后必须退避，而不是贴着 CPU 反复重入
    expect(uploadFn.mock.calls.length).toBeLessThan(5);
    scoped.destroy();
  });

  it('一次 flush() 不会把所有日志的重试预算一次烧光', async () => {
    // forceRun 让 takeNextDueItem 无视 nextAttemptAt，而失败条目是在同一个
    // 循环内部重新入队的 —— 没有"一轮一次"的闸，flush() 就等于即刻处决
    const uploadFn = vi.fn(async () => ({
      success: false,
      shouldRetry: true,
      retryReason: 'server',
    }) as UploadResult);
    const dropped: string[] = [];
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { deduplicationDelay: 10, maxRetries: 3 },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (_l, info) => dropped.push(info.reason),
    });
    logger.use(plugin);

    logger.error('a');
    logger.error('b');
    logger.error('c');
    await vi.advanceTimersByTimeAsync(200);

    // flush 内部会 await 串行间隔（100ms）与可能的飞行等待；假时钟下必须推进
    const flushP = plugin.flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await flushP;

    expect(dropped).toHaveLength(0);
    expect(plugin.getQueueStatus().length).toBe(3);
  });
});
