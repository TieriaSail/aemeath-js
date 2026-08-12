/**
 * UploadPlugin —— 离线暂停 / 恢复 / requeue / 缓存 TTL / 上报期元数据
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  UploadPlugin,
  type DurableDeliveryReceipt,
  type UploadResult,
} from '../src/plugins/UploadPlugin';
import { AemeathLogger } from '../src/core/Logger';
import { LogLevel, type LogEntry } from '../src/types';

function setOnLine(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', {
    value,
    configurable: true,
    writable: true,
  });
}

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    logId: 'restored-1',
    level: LogLevel.ERROR,
    message: 'restored',
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeReceipt(logId: string): DurableDeliveryReceipt {
  let settled = false;
  return {
    logId,
    isSettled: () => settled,
    beginAttempt: vi.fn(async () => (settled ? null : 1)),
    renew: vi.fn(async () => !settled),
    succeed: vi.fn(async () => {
      if (settled) return false;
      settled = true;
      return true;
    }),
    retry: vi.fn(async () => {
      if (settled) return false;
      settled = true;
      return true;
    }),
    retryScheduled: vi.fn(async () => !settled),
    park: vi.fn(async () => {
      if (settled) return false;
      settled = true;
      return true;
    }),
    terminal: vi.fn(async () => {
      if (settled) return false;
      settled = true;
      return true;
    }),
  };
}

describe('UploadPlugin — 离线与恢复', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    vi.useFakeTimers();
    setOnLine(true);
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
    setOnLine(true);
    vi.useRealTimers();
  });

  it('navigator.onLine 为 false 时完全不调用 onUpload', async () => {
    const uploadFn = vi.fn().mockResolvedValue({ success: true } as UploadResult);
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { deduplicationDelay: 10 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);

    setOnLine(false);
    logger.error('offline log');
    await vi.advanceTimersByTimeAsync(1000);

    expect(uploadFn).not.toHaveBeenCalled();
    const status = plugin.getQueueStatus();
    expect(status.paused).toBe(true);
    expect(status.length).toBe(1);
    // 关键：一次重试预算都没消耗
    expect(status.items[0]!.retryCount).toBe(0);
  });

  it('暂停时会带出当前扣在队列里的日志快照', async () => {
    const plugin = new UploadPlugin({
      onUpload: vi.fn().mockResolvedValue({ success: true } as UploadResult),
      queue: { deduplicationDelay: 10 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);

    const paused: Array<Record<string, unknown>> = [];
    logger.on('upload:paused', ((p: Record<string, unknown>) => paused.push(p)) as never);

    setOnLine(false);
    logger.error('first offline log');
    await vi.advanceTimersByTimeAsync(1000);

    expect(paused).toHaveLength(1);
    const logs = paused[0]!['logs'] as Array<{ log: LogEntry }>;
    expect(logs).toHaveLength(1);
    expect(logs[0]!.log.message).toBe('first offline log');
  });

  it('online 事件应恢复队列并把积压日志发出去', async () => {
    const uploadFn = vi.fn().mockResolvedValue({ success: true } as UploadResult);
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { deduplicationDelay: 10 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);

    setOnLine(false);
    logger.error('held while offline');
    await vi.advanceTimersByTimeAsync(1000);
    expect(uploadFn).not.toHaveBeenCalled();

    setOnLine(true);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(1000);

    expect(uploadFn).toHaveBeenCalledTimes(1);
    expect(plugin.getQueueStatus().length).toBe(0);
    expect(plugin.getQueueStatus().paused).toBe(false);
  });

  it('半开探测收到可恢复服务端失败并立即 parked 时也应退出半开', async () => {
    let reachable = false;
    const resumed = vi.fn();
    const plugin = new UploadPlugin({
      onUpload: async () => {
        if (!reachable) throw new TypeError('Failed to fetch');
        return { success: false, shouldRetry: true, retryReason: 'server' as const };
      },
      queue: { deduplicationDelay: 10, maxRetries: 0, suspectedOfflineThreshold: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);
    logger.on('upload:resumed', resumed);

    logger.error('probe parks immediately');
    await vi.advanceTimersByTimeAsync(1000);
    expect(plugin.getQueueStatus().paused).toBe(true);

    reachable = true;
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(1000);

    expect(plugin.getQueueStatus()).toMatchObject({ paused: false, length: 0, parked: 1 });
    expect(resumed).toHaveBeenCalledOnce();
  });

  it('online 事件不能提前唤醒仍受 Retry-After 约束的 parked 日志', async () => {
    const uploadFn = vi.fn(async () => ({
      success: false,
      shouldRetry: true,
      retryReason: 'rate-limit' as const,
      retryAfter: '120',
    }));
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { deduplicationDelay: 10, maxRetries: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);
    logger.error('respect server delay');
    await vi.advanceTimersByTimeAsync(1000);

    expect(uploadFn).toHaveBeenCalledTimes(1);
    expect(plugin.getQueueStatus()).toMatchObject({ length: 0, parked: 1 });

    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(uploadFn).toHaveBeenCalledTimes(1);
    expect(plugin.getQueueStatus()).toMatchObject({ length: 0, parked: 1 });
  });

  it('多条 parked 同时到期时一次 processQueue 只放行一个恢复探针', async () => {
    const failing = vi.fn(async () => ({
      success: false,
      shouldRetry: true,
      retryReason: 'server' as const,
    }));
    const plugin = new UploadPlugin({
      onUpload: failing,
      queue: { deduplicationDelay: 0, maxRetries: 0, concurrency: 2 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);
    logger.error('park-1');
    logger.error('park-2');
    logger.error('park-3');
    await vi.advanceTimersByTimeAsync(1000);
    expect(plugin.getQueueStatus().parked).toBe(3);

    const recovered = vi.fn(async () => ({ success: true } as UploadResult));
    plugin.setOnUpload(recovered);
    vi.setSystemTime(Date.now() + 61_000);
    await (plugin as unknown as { processQueue(): Promise<void> }).processQueue();

    expect(recovered).toHaveBeenCalledTimes(1);
    expect(plugin.getQueueStatus()).toMatchObject({ parked: 2, length: 0 });
  });

  it('暂停后的定时探测成功即自动恢复，无需 online 事件', async () => {
    let online = false;
    const uploadFn = vi.fn(async () => {
      if (!online) throw new TypeError('Failed to fetch');
      return { success: true } as UploadResult;
    });
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { deduplicationDelay: 10, suspectedOfflineThreshold: 2 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);

    logger.error('will recover');
    await vi.advanceTimersByTimeAsync(5000);
    expect(plugin.getQueueStatus().paused).toBe(true);

    online = true;
    await vi.advanceTimersByTimeAsync(20000);

    expect(plugin.getQueueStatus().length).toBe(0);
    expect(plugin.getQueueStatus().paused).toBe(false);
  });

  it('retryReason: network 不消耗重试预算', async () => {
    let calls = 0;
    const plugin = new UploadPlugin({
      onUpload: async () => {
        calls++;
        if (calls <= 4) {
          return { success: false, shouldRetry: true, retryReason: 'network' as const };
        }
        return { success: true };
      },
      queue: { maxRetries: 1, deduplicationDelay: 10, suspectedOfflineThreshold: 99 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);

    logger.error('flaky network');
    await vi.advanceTimersByTimeAsync(30000);

    // maxRetries 只有 1，若网络失败也算预算，第 2 次之后就该被丢弃
    expect(calls).toBe(5);
    expect(plugin.getQueueStatus().length).toBe(0);
  });

  it('retryReason: payload 立即丢弃，不做无意义的重试', async () => {
    const onDrop = vi.fn();
    const plugin = new UploadPlugin({
      onUpload: async () => ({
        success: false,
        shouldRetry: true,
        retryReason: 'payload' as const,
        error: '413 too large',
      }),
      queue: { deduplicationDelay: 10 },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop,
    });
    logger.use(plugin);

    logger.error('bad payload');
    await vi.advanceTimersByTimeAsync(2000);

    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop.mock.calls[0]![1]).toMatchObject({ reason: 'no-retry', error: '413 too large' });
  });

  it('队列溢出应触发 onDrop 而不是静默消失', async () => {
    const onDrop = vi.fn();
    const plugin = new UploadPlugin({
      onUpload: vi.fn().mockResolvedValue({ success: true } as UploadResult),
      queue: { maxSize: 2, deduplicationDelay: 10000 },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop,
    });
    logger.use(plugin);

    logger.debug('d1');
    logger.debug('d2');
    logger.debug('d3');

    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop.mock.calls[0]![1]).toMatchObject({ reason: 'queue-overflow' });
  });

  it('never evicts a claimed receipt from synchronous queue capacity planning', async () => {
    setOnLine(false);
    const onDrop = vi.fn();
    const plugin = new UploadPlugin({
      onUpload: vi.fn().mockResolvedValue({ success: true } as UploadResult),
      queue: { maxSize: 1, deduplicationDelay: 60_000 },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop,
    });
    logger.use(plugin);
    const receipt = makeReceipt('durable-capacity-owner');
    await plugin.requeueCoordinated([
      {
        log: makeEntry({
          logId: 'durable-capacity-owner',
          message: 'durable owner',
        }),
        priority: 1,
        receipt,
      },
    ]);

    plugin.requeue(
      makeEntry({ logId: 'ordinary-incoming', message: 'ordinary incoming' }),
      { priority: 100 },
    );

    expect(plugin.isPending('durable-capacity-owner')).toBe(true);
    expect(plugin.isPending('ordinary-incoming')).toBe(false);
    expect(receipt.retry).not.toHaveBeenCalled();
    expect(onDrop).toHaveBeenCalledWith(
      expect.objectContaining({ logId: 'ordinary-incoming' }),
      expect.objectContaining({ reason: 'queue-overflow' }),
    );
  });

  it('returns an in-flight receipt to durable ownership when suspected offline pauses the queue', async () => {
    const receipt = makeReceipt('coordinated-offline-handoff');
    const uploadFn = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: {
        maxSize: 10,
        deduplicationDelay: 0,
        suspectedOfflineThreshold: 1,
      },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);
    await plugin.requeueCoordinated([
      {
        log: makeEntry({
          logId: 'coordinated-offline-handoff',
          message: 'handoff after network failure',
        }),
        receipt,
      },
    ]);
    await vi.advanceTimersByTimeAsync(100);

    expect(uploadFn).toHaveBeenCalledTimes(1);
    expect(receipt.beginAttempt).toHaveBeenCalledTimes(1);
    expect(receipt.retry).toHaveBeenCalledWith(
      expect.objectContaining({
        lastRetryReason: 'suspected-offline',
      }),
    );
    expect(plugin.getQueueStatus()).toMatchObject({
      paused: true,
      length: 0,
    });
  });

  it('上报的副本带 uploadedAt，且不污染队列里的原始日志', async () => {
    const uploadFn = vi.fn().mockResolvedValue({ success: true } as UploadResult);
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { deduplicationDelay: 10 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);

    const captured: LogEntry[] = [];
    logger.on('log', ((entry: LogEntry) => captured.push(entry)) as never);

    logger.error('stamped');
    await vi.advanceTimersByTimeAsync(500);

    const sent = uploadFn.mock.calls[0]![0] as LogEntry;
    expect(typeof sent.tags?.uploadedAt).toBe('number');
    expect(sent.timestamp).toBe(captured[0]!.timestamp);
    // 原始 entry 不应被就地修改
    expect(captured[0]!.tags?.uploadedAt).toBeUndefined();
  });

  it('丢弃计数会随下一条成功上报的日志带出', async () => {
    let allow = false;
    const uploadFn = vi.fn(async (_log: LogEntry) => {
      if (!allow) {
        return { success: false, shouldRetry: false } as UploadResult;
      }
      return { success: true } as UploadResult;
    });
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { deduplicationDelay: 10 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);

    logger.error('doomed 1');
    await vi.advanceTimersByTimeAsync(500);
    logger.error('doomed 2');
    await vi.advanceTimersByTimeAsync(500);

    allow = true;
    logger.error('survivor');
    await vi.advanceTimersByTimeAsync(500);

    const last = uploadFn.mock.calls[uploadFn.mock.calls.length - 1]![0];
    expect(last.tags?.droppedSinceLastReport).toBe(2);
    expect(plugin.getQueueStatus().drops.total).toBe(2);
    expect(plugin.getQueueStatus().drops.byReason['no-retry']).toBe(2);
  });

  it('requeue 只进上传队列，不触发日志管道', async () => {
    const uploadFn = vi.fn().mockResolvedValue({ success: true } as UploadResult);
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { deduplicationDelay: 10 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);

    const seenByListeners: LogEntry[] = [];
    logger.on('log', ((entry: LogEntry) => seenByListeners.push(entry)) as never);

    const entry = makeEntry({ message: 'from offline store' });
    plugin.requeue(entry, { source: 'offline-replay' });
    await vi.advanceTimersByTimeAsync(500);

    expect(uploadFn).toHaveBeenCalledTimes(1);
    expect((uploadFn.mock.calls[0]![0] as LogEntry).message).toBe('from offline store');
    // 业务侧的 logger.on('log') 不该被补传打扰
    expect(seenByListeners).toHaveLength(0);
  });

  it('requeue 保留原始捕获时间', async () => {
    const uploadFn = vi.fn().mockResolvedValue({ success: true } as UploadResult);
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { deduplicationDelay: 10 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);

    const capturedAt = Date.now() - 3_600_000;
    plugin.requeue(makeEntry({ timestamp: capturedAt }), { source: 'offline-replay' });
    await vi.advanceTimersByTimeAsync(500);

    const sent = uploadFn.mock.calls[0]![0] as LogEntry;
    expect(sent.timestamp).toBe(capturedAt);
    expect(sent.tags!.uploadedAt as number).toBeGreaterThan(capturedAt);
  });
});

describe('UploadPlugin — 缓存 TTL', () => {
  let logger: AemeathLogger;
  const CACHE_KEY = '__ttl_test_cache__';

  beforeEach(() => {
    vi.useFakeTimers();
    setOnLine(true);
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
    vi.useRealTimers();
  });

  it('超过 TTL 的缓存日志会被丢弃并通知', () => {
    const onDrop = vi.fn();
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify([
        {
          log: makeEntry({ logId: 'stale' }),
          priority: 50,
          retryCount: 0,
          timestamp: Date.now() - 10_000,
          cachedAt: Date.now() - 10_000,
        },
      ]),
    );

    const plugin = new UploadPlugin({
      onUpload: vi.fn().mockResolvedValue({ success: true } as UploadResult),
      cache: { enabled: true, key: CACHE_KEY, ttl: 5000 },
      queue: { deduplicationDelay: 10 },
      saveOnUnload: false,
      onDrop,
    });
    logger.use(plugin);

    expect(plugin.getQueueStatus().length).toBe(0);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop.mock.calls[0]![1]).toMatchObject({ reason: 'cache-expired' });
  });

  it('TTL 内的缓存日志会被恢复并上报', async () => {
    const uploadFn = vi.fn().mockResolvedValue({ success: true } as UploadResult);
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify([
        {
          log: makeEntry({ logId: 'fresh' }),
          priority: 50,
          retryCount: 0,
          timestamp: Date.now() - 1000,
          cachedAt: Date.now() - 1000,
        },
      ]),
    );

    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      cache: { enabled: true, key: CACHE_KEY, ttl: 60_000 },
      queue: { deduplicationDelay: 10 },
      saveOnUnload: false,
    });
    logger.use(plugin);
    await vi.advanceTimersByTimeAsync(500);

    expect(uploadFn).toHaveBeenCalledTimes(1);
    expect((uploadFn.mock.calls[0]![0] as LogEntry).logId).toBe('fresh');
  });

  it('旧格式缓存（无 cachedAt）退回用入队时间判断，保持兼容', async () => {
    const uploadFn = vi.fn().mockResolvedValue({ success: true } as UploadResult);
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify([
        {
          log: makeEntry({ logId: 'legacy-format' }),
          priority: 50,
          retryCount: 1,
          timestamp: Date.now() - 1000,
        },
      ]),
    );

    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      cache: { enabled: true, key: CACHE_KEY, ttl: 60_000 },
      queue: { deduplicationDelay: 10 },
      saveOnUnload: false,
    });
    logger.use(plugin);
    await vi.advanceTimersByTimeAsync(500);

    expect(uploadFn).toHaveBeenCalledTimes(1);
    expect((uploadFn.mock.calls[0]![0] as LogEntry).logId).toBe('legacy-format');
  });
});
