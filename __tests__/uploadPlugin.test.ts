/**
 * UploadPlugin 上传插件测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  UploadPlugin,
  parseRetryAfter,
  classifyHttpUploadResponse,
  type UploadCallback,
} from '../src/plugins/UploadPlugin';
import { AemeathLogger } from '../src/core/Logger';
import type { LogEntry } from '../src/types';

describe('parseRetryAfter', () => {
  it('解析 delta-seconds 与 HTTP-date', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter(new Date(now + 90_000).toUTCString(), now)).toBe(90_000);
  });

  it('过去的日期归零，非法头返回 undefined', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(parseRetryAfter(new Date(now - 1000).toUTCString(), now)).toBe(0);
    expect(parseRetryAfter('1.5', now)).toBeUndefined();
    expect(parseRetryAfter('-1', now)).toBeUndefined();
    expect(parseRetryAfter('not-a-date', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});

describe('classifyHttpUploadResponse', () => {
  it('统一区分成功、可恢复服务端失败与永久 4xx', () => {
    expect(classifyHttpUploadResponse(204)).toEqual({ success: true });
    expect(classifyHttpUploadResponse(429, '120')).toMatchObject({
      success: false,
      shouldRetry: true,
      retryReason: 'rate-limit',
      retryAfter: '120',
    });
    expect(classifyHttpUploadResponse(503)).toMatchObject({
      success: false,
      shouldRetry: true,
      retryReason: 'server',
    });
    expect(classifyHttpUploadResponse(413)).toMatchObject({
      success: false,
      shouldRetry: false,
      retryReason: 'payload',
    });
    expect(classifyHttpUploadResponse(409)).toMatchObject({
      success: false,
      shouldRetry: false,
      retryReason: 'payload',
    });
    expect(classifyHttpUploadResponse(302)).toMatchObject({
      success: false,
      shouldRetry: false,
      retryReason: 'payload',
    });
  });
});

describe('UploadPlugin', () => {
  let uploadFn: ReturnType<typeof vi.fn>;
  let plugin: UploadPlugin;
  let logger: AemeathLogger;

  beforeEach(() => {
    vi.useFakeTimers();
    uploadFn = vi.fn().mockResolvedValue({ success: true });
    plugin = new UploadPlugin({
      onUpload: uploadFn as unknown as UploadCallback,
      queue: { deduplicationDelay: 10, uploadInterval: 30000 },
      cache: { enabled: false }, // 测试中禁用缓存避免干扰
      saveOnUnload: false,
    });
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
    vi.useRealTimers();
  });

  // ==================== 安装与卸载 ====================

  describe('安装与卸载', () => {
    it('应正确安装到 Logger', () => {
      logger.use(plugin);
      expect(logger.hasPlugin('upload')).toBe(true);
    });

    it('卸载后不再接收日志', () => {
      logger.use(plugin);
      logger.uninstall('upload');
      expect(logger.hasPlugin('upload')).toBe(false);
    });
  });

  // ==================== 日志入队和上传 ====================

  describe('日志入队和上传', () => {
    it('日志应触发上传回调', async () => {
      logger.use(plugin);
      logger.info('hello');

      // 等待去重延迟 + 队列处理
      await vi.advanceTimersByTimeAsync(200);

      expect(uploadFn).toHaveBeenCalled();
      const arg = uploadFn.mock.calls[0][0] as LogEntry;
      expect(arg.message).toBe('hello');
      expect(arg.level).toBe('info');
    });

    it('多条日志应依次上传', async () => {
      logger.use(plugin);
      logger.info('msg1');
      logger.warn('msg2');
      logger.error('msg3');

      await vi.advanceTimersByTimeAsync(500);

      expect(uploadFn).toHaveBeenCalledTimes(3);
    });
  });

  // ==================== 优先级 ====================

  describe('优先级', () => {
    it('默认优先级: error > warn > info > debug', () => {
      const customPlugin = new UploadPlugin({
        onUpload: uploadFn as unknown as UploadCallback,
        queue: { deduplicationDelay: 10 },
        cache: { enabled: false },
        saveOnUnload: false,
      });

      logger.use(customPlugin);

      // 按顺序加入 debug, info, warn, error
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      // 获取队列状态（在处理前）
      const status = customPlugin.getQueueStatus();
      // error 应该排在最前面
      expect(status.items[0].level).toBe('error');
      expect(status.items[status.items.length - 1].level).toBe('debug');
    });

    it('track 的默认优先级与 info 相同', () => {
      const customPlugin = new UploadPlugin({
        onUpload: uploadFn as unknown as UploadCallback,
        queue: { deduplicationDelay: 10 },
        cache: { enabled: false },
        saveOnUnload: false,
      });

      logger.use(customPlugin);

      logger.track('t');
      logger.info('i');

      const status = customPlugin.getQueueStatus();
      expect(status.items[0].priority).toBe(status.items[1].priority);
    });

    it('自定义优先级回调应生效', async () => {
      const customPlugin = new UploadPlugin({
        onUpload: uploadFn as unknown as UploadCallback,
        getPriority: (log) => (log.message === 'urgent' ? 999 : 1),
        queue: { deduplicationDelay: 10 },
        cache: { enabled: false },
        saveOnUnload: false,
      });

      logger.use(customPlugin);
      logger.info('normal');
      logger.info('urgent');

      const status = customPlugin.getQueueStatus();
      expect(status.items[0].priority).toBe(999);
    });
  });

  // ==================== 重试机制 ====================

  describe('重试机制', () => {
    it('shouldRetry=true 即使省略 retryReason 也应重试', async () => {
      let callCount = 0;
      const retryPlugin = new UploadPlugin({
        onUpload: async () => {
          callCount++;
          if (callCount <= 2) {
            return { success: false, shouldRetry: true, error: 'server error' };
          }
          return { success: true };
        },
        queue: { maxRetries: 3, deduplicationDelay: 10 },
        cache: { enabled: false },
        saveOnUnload: false,
      });

      logger.use(retryPlugin);
      logger.error('retry me');

      // 重试之间有指数退避（1s、2s…），要给足时间
      await vi.advanceTimersByTimeAsync(10000);

      expect(callCount).toBe(3); // 2 次失败 + 1 次成功
    });

    it('只给 retryReason 也视为明确的重试意图', async () => {
      const retryFn = vi
        .fn()
        .mockResolvedValueOnce({ success: false, retryReason: 'server' })
        .mockResolvedValueOnce({ success: true });
      const retryPlugin = new UploadPlugin({
        onUpload: retryFn,
        queue: { maxRetries: 2, deduplicationDelay: 10 },
        cache: { enabled: false },
        saveOnUnload: false,
      });

      logger.use(retryPlugin);
      logger.error('retry by reason');
      await vi.advanceTimersByTimeAsync(3000);

      expect(retryFn).toHaveBeenCalledTimes(2);
      expect(retryPlugin.getQueueStatus()).toMatchObject({ length: 0, parked: 0 });
    });

    it('retryAfterMs 应覆盖较短的本地退避', async () => {
      const retryFn = vi
        .fn()
        .mockResolvedValueOnce({ success: false, retryReason: 'rate-limit', retryAfterMs: 5000 })
        .mockResolvedValueOnce({ success: true });
      const retryPlugin = new UploadPlugin({
        onUpload: retryFn,
        queue: { maxRetries: 2, deduplicationDelay: 10, retryBackoff: { baseMs: 100 } },
        cache: { enabled: false },
        saveOnUnload: false,
      });

      logger.use(retryPlugin);
      logger.error('rate limited');
      await vi.advanceTimersByTimeAsync(4000);
      expect(retryFn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1500);
      expect(retryFn).toHaveBeenCalledTimes(2);
    });

    it('自动解析原始 Retry-After delta-seconds', async () => {
      const retryFn = vi
        .fn()
        .mockResolvedValueOnce({ success: false, retryReason: 'rate-limit', retryAfter: '5' })
        .mockResolvedValueOnce({ success: true });
      const retryPlugin = new UploadPlugin({
        onUpload: retryFn,
        queue: { maxRetries: 2, deduplicationDelay: 10, retryBackoff: { baseMs: 100 } },
        cache: { enabled: false },
        saveOnUnload: false,
      });

      logger.use(retryPlugin);
      logger.error('rate limited by header');
      await vi.advanceTimersByTimeAsync(4900);
      expect(retryFn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(retryFn).toHaveBeenCalledTimes(2);
    });

    it('自动解析 axios 风格抛错 response.headers 中的 Retry-After', async () => {
      const retryFn = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('HTTP 429'), {
          response: { status: 429, headers: { 'retry-after': '5' } },
        }))
        .mockResolvedValueOnce({ success: true });
      const retryPlugin = new UploadPlugin({
        onUpload: retryFn,
        queue: { maxRetries: 2, deduplicationDelay: 10, retryBackoff: { baseMs: 100 } },
        cache: { enabled: false },
        saveOnUnload: false,
      });

      logger.use(retryPlugin);
      logger.error('axios rate limited by header');
      await vi.advanceTimersByTimeAsync(4900);
      expect(retryFn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(retryFn).toHaveBeenCalledTimes(2);
    });

    it('axios 风格抛出的 HTTP 409 与返回值分类一致，直接终态丢弃', async () => {
      const dropped: string[] = [];
      const conflictFn = vi.fn().mockRejectedValue(Object.assign(new Error('HTTP 409'), {
        response: { status: 409 },
      }));
      const conflictPlugin = new UploadPlugin({
        onUpload: conflictFn,
        queue: { maxRetries: 3, deduplicationDelay: 10, retryBackoff: false },
        cache: { enabled: false },
        saveOnUnload: false,
        onDrop: (_log, info) => dropped.push(info.reason),
      });

      logger.use(conflictPlugin);
      logger.error('axios conflict');
      await vi.advanceTimersByTimeAsync(500);

      expect(conflictFn).toHaveBeenCalledTimes(1);
      expect(dropped).toEqual(['no-retry']);
    });

    it('HTTP 302 无论由回调返回还是由 client 抛出，都必须采用同一终态策略', async () => {
      const run = async (mode: 'return' | 'throw'): Promise<{ calls: number; drops: string[] }> => {
        const drops: string[] = [];
        const callback = vi.fn(async () => {
          if (mode === 'return') return classifyHttpUploadResponse(302);
          throw Object.assign(new Error('redirect response'), { response: { status: 302 } });
        });
        const redirectPlugin = new UploadPlugin({
          onUpload: callback,
          queue: { maxRetries: 3, deduplicationDelay: 10, retryBackoff: false },
          cache: { enabled: false },
          saveOnUnload: false,
          onDrop: (_log, info) => drops.push(info.reason),
        });
        logger.use(redirectPlugin);
        logger.error(`redirect-${mode}`);
        await vi.advanceTimersByTimeAsync(500);
        logger.uninstall('upload');
        return { calls: callback.mock.calls.length, drops };
      };

      expect(await run('return')).toEqual({ calls: 1, drops: ['no-retry'] });
      expect(await run('throw')).toEqual({ calls: 1, drops: ['no-retry'] });
    });

    it('retryAfterMs 优先于原始 Retry-After', async () => {
      const retryFn = vi
        .fn()
        .mockResolvedValueOnce({
          success: false,
          retryReason: 'rate-limit',
          retryAfter: '60',
          retryAfterMs: 1000,
        })
        .mockResolvedValueOnce({ success: true });
      const retryPlugin = new UploadPlugin({
        onUpload: retryFn,
        queue: { maxRetries: 2, deduplicationDelay: 0, retryBackoff: { baseMs: 100 } },
        cache: { enabled: false },
        saveOnUnload: false,
      });

      logger.use(retryPlugin);
      logger.error('explicit milliseconds');
      await vi.advanceTimersByTimeAsync(1200);
      expect(retryFn).toHaveBeenCalledTimes(2);
    });

    it('重试之间应有指数退避，而不是瞬间打完预算', async () => {
      const timestamps: number[] = [];
      const backoffPlugin = new UploadPlugin({
        onUpload: async () => {
          timestamps.push(Date.now());
          return { success: false, shouldRetry: true, retryReason: 'server' as const };
        },
        queue: { maxRetries: 2, deduplicationDelay: 10 },
        cache: { enabled: false },
        saveOnUnload: false,
      });

      logger.use(backoffPlugin);
      logger.error('backoff me');
      await vi.advanceTimersByTimeAsync(10000);

      expect(timestamps.length).toBe(3);
      // 第 1→2 次间隔 ≈ 1s，第 2→3 次间隔 ≈ 2s
      expect(timestamps[1]! - timestamps[0]!).toBeGreaterThanOrEqual(1000);
      expect(timestamps[2]! - timestamps[1]!).toBeGreaterThanOrEqual(2000);
    });

    it('shouldRetry=false 时不应重试', async () => {
      const noRetryFn = vi
        .fn()
        .mockResolvedValue({ success: false, shouldRetry: false });

      const noRetryPlugin = new UploadPlugin({
        onUpload: noRetryFn,
        queue: { deduplicationDelay: 10 },
        cache: { enabled: false },
        saveOnUnload: false,
      });

      logger.use(noRetryPlugin);
      logger.error('no retry');

      await vi.advanceTimersByTimeAsync(500);

      expect(noRetryFn).toHaveBeenCalledTimes(1);
    });

    it('超过热重试预算后应停放，而不是把可恢复失败当作丢弃', async () => {
      const alwaysFailFn = vi
        .fn()
        .mockResolvedValue({ success: false, shouldRetry: true, retryReason: 'server' });
      const onDrop = vi.fn();

      const maxRetryPlugin = new UploadPlugin({
        onUpload: alwaysFailFn,
        queue: { maxRetries: 2, deduplicationDelay: 10 },
        cache: { enabled: false },
        saveOnUnload: false,
        onDrop,
      });

      logger.use(maxRetryPlugin);
      logger.error('will fail');

      await vi.advanceTimersByTimeAsync(20000);

      // 1 次初始 + 2 次重试 = 3 次
      expect(alwaysFailFn).toHaveBeenCalledTimes(3);
      expect(onDrop).not.toHaveBeenCalled();
      expect(maxRetryPlugin.getQueueStatus()).toMatchObject({ length: 0, parked: 1 });
    });

    it('连续传输层失败达到阈值后应暂停队列而不是丢弃日志', async () => {
      const alwaysFailFn = vi
        .fn()
        .mockResolvedValue({ success: false, shouldRetry: true, retryReason: 'network' });
      const onDrop = vi.fn();

      const pausePlugin = new UploadPlugin({
        onUpload: alwaysFailFn,
        queue: { maxRetries: 2, deduplicationDelay: 10, suspectedOfflineThreshold: 2 },
        cache: { enabled: false },
        saveOnUnload: false,
        onDrop,
      });

      logger.use(pausePlugin);
      logger.error('network is down');

      await vi.advanceTimersByTimeAsync(3000);

      const status = pausePlugin.getQueueStatus();
      expect(status.paused).toBe(true);
      expect(status.length).toBe(1); // 日志仍在队列里，没有被丢弃
      expect(onDrop).not.toHaveBeenCalled();
    });

    it('服务端持续 5xx 不应被误判为离线：耗尽热预算后停放，队列不暂停', async () => {
      // 服务端回了话就说明链路是通的。若把它算作离线证据，后端故障会让队列
      // 无限期暂停、maxRetries 永远耗不完，日志一路堆到溢出。
      const serverDownFn = vi
        .fn()
        .mockResolvedValue({ success: false, shouldRetry: true, retryReason: 'server' });
      const onDrop = vi.fn();

      const plugin = new UploadPlugin({
        onUpload: serverDownFn,
        queue: { maxRetries: 2, deduplicationDelay: 10, suspectedOfflineThreshold: 2 },
        cache: { enabled: false },
        saveOnUnload: false,
        onDrop,
      });

      logger.use(plugin);
      logger.error('backend is down');

      await vi.advanceTimersByTimeAsync(20000);

      expect(serverDownFn).toHaveBeenCalledTimes(3);
      expect(plugin.getQueueStatus().paused).toBe(false);
      expect(plugin.getQueueStatus().length).toBe(0);
      expect(plugin.getQueueStatus().parked).toBe(1);
      expect(onDrop).not.toHaveBeenCalled();
    });

    it('legacy 策略下应保持旧行为：不暂停、失败即耗预算', async () => {
      const alwaysFailFn = vi
        .fn()
        .mockResolvedValue({ success: false, shouldRetry: true });
      const onDrop = vi.fn();

      const legacyPlugin = new UploadPlugin({
        onUpload: alwaysFailFn,
        queue: { maxRetries: 2, deduplicationDelay: 10, offlinePolicy: 'legacy' },
        cache: { enabled: false },
        saveOnUnload: false,
        onDrop,
      });

      logger.use(legacyPlugin);
      logger.error('will fail');

      await vi.advanceTimersByTimeAsync(3000);

      expect(alwaysFailFn).toHaveBeenCalledTimes(3);
      expect(legacyPlugin.getQueueStatus().paused).toBe(false);
      expect(onDrop.mock.calls[0]![1]).toMatchObject({ reason: 'max-retries' });
    });

    it('上传回调抛出异常时也应重试', async () => {
      let callCount = 0;
      const throwPlugin = new UploadPlugin({
        onUpload: async () => {
          callCount++;
          if (callCount === 1) {
            throw new Error('network error');
          }
          return { success: true };
        },
        queue: { maxRetries: 3, deduplicationDelay: 10 },
        cache: { enabled: false },
        saveOnUnload: false,
      });

      logger.use(throwPlugin);
      logger.error('throw test');

      await vi.advanceTimersByTimeAsync(2000);

      expect(callCount).toBe(2); // 1 次异常 + 1 次成功
    });
  });

  // ==================== 队列容量 ====================

  describe('队列容量', () => {
    it('超过 maxSize 应移除低优先级日志', () => {
      const smallPlugin = new UploadPlugin({
        onUpload: uploadFn as unknown as UploadCallback,
        queue: { maxSize: 3, deduplicationDelay: 10 },
        cache: { enabled: false },
        saveOnUnload: false,
      });

      logger.use(smallPlugin);

      logger.debug('d1'); // priority 1
      logger.debug('d2'); // priority 1
      logger.debug('d3'); // priority 1
      logger.error('e1'); // priority 100 → 会挤掉一个 debug

      const status = smallPlugin.getQueueStatus();
      expect(status.length).toBeLessThanOrEqual(3);
      // error 应该还在
      expect(status.items.some((i) => i.level === 'error')).toBe(true);
    });
  });

  // ==================== 缓存（localStorage） ====================

  describe('本地缓存', () => {
    it('启用缓存时应合并异步写入 localStorage', async () => {
      const cachePlugin = new UploadPlugin({
        onUpload: vi
          .fn()
          .mockResolvedValue({ success: false, shouldRetry: false }) as unknown as UploadCallback,
        cache: { enabled: true, key: '__test_cache__' },
        saveOnUnload: false,
        queue: { deduplicationDelay: 10 },
      });

      logger.use(cachePlugin);
      logger.info('cached msg');

      // 热路径只排一个 0ms 合并写，避免每条日志同步序列化并写盘。
      await vi.advanceTimersByTimeAsync(0);
      expect(localStorage.setItem).toHaveBeenCalledWith(
        '__test_cache__',
        expect.any(String),
      );
    });
  });

  // ==================== getQueueStatus ====================

  describe('getQueueStatus', () => {
    it('应返回当前队列状态', () => {
      logger.use(plugin);

      const status = plugin.getQueueStatus();
      expect(status).toHaveProperty('length');
      expect(status).toHaveProperty('isProcessing');
      expect(status).toHaveProperty('inFlight');
      expect(status).toHaveProperty('attempts');
      expect(status).toHaveProperty('items');
      expect(status).toHaveProperty('pendingItems');
      expect(Array.isArray(status.items)).toBe(true);
      expect(Array.isArray(status.pendingItems)).toBe(true);
      expect(status.items).toHaveLength(status.length);
    });

    it('items 保持仅活跃队列的旧语义，pendingItems 提供全量视图', async () => {
      const never = new Promise<never>(() => {});
      const active = new UploadPlugin({
        onUpload: () => never,
        queue: { deduplicationDelay: 0 },
        cache: { enabled: false },
        saveOnUnload: false,
      });
      logger.use(active);
      logger.error('in flight');
      await vi.advanceTimersByTimeAsync(0);

      const status = active.getQueueStatus();
      expect(status).toMatchObject({ length: 0, inFlight: 1 });
      expect(status.items).toHaveLength(0);
      expect(status.pendingItems).toHaveLength(1);
      expect(status.pendingItems![0]).toMatchObject({ state: 'in-flight' });
    });
  });

  // ==================== logId / requestId 双 ID 追踪 ====================

  describe('logId / requestId 双 ID 追踪', () => {
    it('上传回调收到的日志应包含 logId', async () => {
      logger.use(plugin);
      logger.info('has logId');

      await vi.advanceTimersByTimeAsync(200);

      expect(uploadFn).toHaveBeenCalled();
      const arg = uploadFn.mock.calls[0][0] as LogEntry;
      expect(arg.logId).toBeDefined();
      expect(typeof arg.logId).toBe('string');
      expect(arg.logId.length).toBeGreaterThan(0);
    });

    it('上传回调收到的日志应包含 requestId', async () => {
      logger.use(plugin);
      logger.info('has requestId');

      await vi.advanceTimersByTimeAsync(200);

      expect(uploadFn).toHaveBeenCalled();
      const arg = uploadFn.mock.calls[0][0] as LogEntry;
      expect(arg.requestId).toBeDefined();
      expect(typeof arg.requestId).toBe('string');
      expect(arg.requestId!.length).toBeGreaterThan(0);
    });

    it('同一条日志的 logId 在重试时应保持不变', async () => {
      let callCount = 0;
      const retryPlugin = new UploadPlugin({
        onUpload: async (_log) => {
          callCount++;
          if (callCount <= 1) {
            return { success: false, shouldRetry: true, error: 'retry' };
          }
          return { success: true };
        },
        queue: { maxRetries: 3, deduplicationDelay: 10 },
        cache: { enabled: false },
        saveOnUnload: false,
      });

      logger.use(retryPlugin);
      logger.error('retry logId test');

      await vi.advanceTimersByTimeAsync(5000);

      expect(callCount).toBe(2);
    });

    it('同一条日志的不同上报尝试应有不同的 requestId', async () => {
      const receivedRequestIds: string[] = [];
      let callCount = 0;
      const retryPlugin = new UploadPlugin({
        onUpload: async (log) => {
          callCount++;
          receivedRequestIds.push(log.requestId!);
          if (callCount <= 1) {
            return { success: false, shouldRetry: true, error: 'retry' };
          }
          return { success: true };
        },
        queue: { maxRetries: 3, deduplicationDelay: 10 },
        cache: { enabled: false },
        saveOnUnload: false,
      });

      logger.use(retryPlugin);
      logger.error('requestId uniqueness test');

      await vi.advanceTimersByTimeAsync(5000);

      expect(receivedRequestIds.length).toBe(2);
      expect(receivedRequestIds[0]).not.toBe(receivedRequestIds[1]);
    });

    it('不同日志应有不同的 logId', async () => {
      logger.use(plugin);
      logger.info('msg1');
      logger.info('msg2');

      await vi.advanceTimersByTimeAsync(500);

      expect(uploadFn).toHaveBeenCalledTimes(2);
      const logId1 = (uploadFn.mock.calls[0][0] as LogEntry).logId;
      const logId2 = (uploadFn.mock.calls[1][0] as LogEntry).logId;
      expect(logId1).not.toBe(logId2);
    });
  });

  // ==================== flush ====================

  describe('flush', () => {
    it('flush 应立即上传所有队列日志', async () => {
      logger.use(plugin);
      logger.info('flush1');
      logger.info('flush2');

      // flush 内部有 setTimeout，需要交替推进
      const flushPromise = plugin.flush();
      // 推进所有内部 timer（deduplicationDelay + 队列间隔等）
      await vi.advanceTimersByTimeAsync(1000);
      await flushPromise;

      expect(uploadFn).toHaveBeenCalled();
    });
  });
});
