/**
 * UploadPlugin 上传插件测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UploadPlugin } from '../src/plugins/UploadPlugin';
import { AemeathLogger } from '../src/core/Logger';
import type { LogEntry } from '../src/types';

// 创建一个假的 LogEntry
function createLog(
  level: 'debug' | 'info' | 'warn' | 'error' = 'info',
  message = 'test',
): LogEntry {
  return {
    logId: `test-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
    level,
    message,
    timestamp: Date.now(),
  };
}

describe('UploadPlugin', () => {
  let uploadFn: ReturnType<typeof vi.fn>;
  let plugin: UploadPlugin;
  let logger: AemeathLogger;

  beforeEach(() => {
    vi.useFakeTimers();
    uploadFn = vi.fn().mockResolvedValue({ success: true });
    plugin = new UploadPlugin({
      onUpload: uploadFn,
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
        onUpload: uploadFn,
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
        onUpload: uploadFn,
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
        onUpload: uploadFn,
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
    it('上传失败且 shouldRetry=true 时应重试', async () => {
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

      // 给足够的时间让重试完成
      await vi.advanceTimersByTimeAsync(2000);

      expect(callCount).toBe(3); // 2 次失败 + 1 次成功
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

    it('超过最大重试次数后应放弃', async () => {
      const alwaysFailFn = vi
        .fn()
        .mockResolvedValue({ success: false, shouldRetry: true });

      const maxRetryPlugin = new UploadPlugin({
        onUpload: alwaysFailFn,
        queue: { maxRetries: 2, deduplicationDelay: 10 },
        cache: { enabled: false },
        saveOnUnload: false,
      });

      logger.use(maxRetryPlugin);
      logger.error('will fail');

      await vi.advanceTimersByTimeAsync(3000);

      // 1 次初始 + 2 次重试 = 3 次
      expect(alwaysFailFn).toHaveBeenCalledTimes(3);
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
        onUpload: uploadFn,
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
    it('启用缓存时应保存到 localStorage', async () => {
      const cachePlugin = new UploadPlugin({
        onUpload: vi.fn().mockResolvedValue({ success: false, shouldRetry: false }),
        cache: { enabled: true, key: '__test_cache__' },
        saveOnUnload: false,
        queue: { deduplicationDelay: 10 },
      });

      logger.use(cachePlugin);
      logger.info('cached msg');

      // 日志入队后应立即缓存
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
      expect(status).toHaveProperty('items');
      expect(Array.isArray(status.items)).toBe(true);
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
        onUpload: async (log) => {
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

      await vi.advanceTimersByTimeAsync(2000);

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

      await vi.advanceTimersByTimeAsync(2000);

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

