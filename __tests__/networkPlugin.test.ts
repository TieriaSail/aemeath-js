/**
 * NetworkPlugin 集成测试
 *
 * 验证 NetworkPlugin 通过 instrumentation 层正确地：
 * - 拦截 fetch 请求
 * - 根据 logTypes 过滤
 * - 处理慢请求
 * - 提取业务响应码
 * - 安装/卸载生命周期正确
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NetworkPlugin } from '../src/plugins/NetworkPlugin';
import { AemeathLogger } from '../src/core/Logger';
import { _resetFetchInstrumentation } from '../src/instrumentation/fetch';
import { _resetXHRInstrumentation } from '../src/instrumentation/xhr';

describe('NetworkPlugin', () => {
  let logger: AemeathLogger;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    _resetFetchInstrumentation();
    _resetXHRInstrumentation();
    originalFetch = window.fetch;
  });

  afterEach(() => {
    if (logger) {
      logger.destroy();
    }
    _resetFetchInstrumentation();
    _resetXHRInstrumentation();
    window.fetch = originalFetch;
  });

  function createLogger(): AemeathLogger {
    logger = new AemeathLogger({ enableConsole: false });
    return logger;
  }

  // ==================== 安装与卸载 ====================

  describe('安装与卸载', () => {
    it('应正确安装', () => {
      const l = createLogger();
      const plugin = new NetworkPlugin();
      l.use(plugin);
      expect(l.hasPlugin('network')).toBe(true);
    });

    it('卸载后不再有插件', () => {
      const l = createLogger();
      const plugin = new NetworkPlugin();
      l.use(plugin);
      l.uninstall('network');
      expect(l.hasPlugin('network')).toBe(false);
    });

    it('手动调用 uninstall 应恢复 fetch', () => {
      const beforeFetch = window.fetch;
      const l = createLogger();
      const plugin = new NetworkPlugin();
      l.use(plugin);
      expect(window.fetch).not.toBe(beforeFetch);

      plugin.uninstall();
      expect(window.fetch).toBe(beforeFetch);
    });

    it('interceptFetch=false 时不替换 fetch', () => {
      const beforeFetch = window.fetch;
      const l = createLogger();
      const plugin = new NetworkPlugin({ interceptFetch: false });
      l.use(plugin);
      expect(window.fetch).toBe(beforeFetch);
    });
  });

  // ==================== URL 过滤 ====================

  describe('URL 过滤', () => {
    it('应排除日志上报接口', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 200 }), { status: 200 }),
      );
      window.fetch = mockFetch;

      const l = createLogger();
      const logListener = vi.fn();
      l.on('log', logListener);

      const plugin = new NetworkPlugin();
      l.use(plugin);

      await window.fetch('/api/logs', { method: 'POST' });
      expect(logListener).not.toHaveBeenCalled();
    });

    it('urlFilter 返回 false 的 URL 不应被记录', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 200 }), { status: 200 }),
      );
      window.fetch = mockFetch;

      const l = createLogger();
      const logListener = vi.fn();
      l.on('log', logListener);

      const plugin = new NetworkPlugin({
        urlFilter: (url) => !url.includes('/health'),
      });
      l.use(plugin);

      await window.fetch('/health');
      expect(logListener).not.toHaveBeenCalled();
    });
  });

  // ==================== Fetch 拦截 ====================

  describe('Fetch 拦截', () => {
    it('应记录成功的 fetch 请求', async () => {
      const mockResponse = new Response(
        JSON.stringify({ code: 200, data: 'ok' }),
        { status: 200, statusText: 'OK' },
      );
      const mockFetch = vi.fn().mockResolvedValue(mockResponse);
      window.fetch = mockFetch;

      const l = createLogger();
      const logListener = vi.fn();
      l.on('log', logListener);

      const plugin = new NetworkPlugin();
      l.use(plugin);

      await window.fetch('/api/data', { method: 'GET' });

      expect(logListener).toHaveBeenCalled();
      const entry = logListener.mock.calls[0][0];
      expect(entry.level).toBe('info');
      expect(entry.message).toContain('/api/data');
      expect(entry.tags?.errorCategory).toBe('http');
      expect(entry.tags?.method).toBe('GET');
    });

    it('应记录失败的 fetch 请求（状态码 >= 400）', async () => {
      const mockResponse = new Response(
        JSON.stringify({ code: 500, message: 'Internal Error' }),
        { status: 500, statusText: 'Internal Server Error' },
      );
      const mockFetch = vi.fn().mockResolvedValue(mockResponse);
      window.fetch = mockFetch;

      const l = createLogger();
      const logListener = vi.fn();
      l.on('log', logListener);

      const plugin = new NetworkPlugin();
      l.use(plugin);

      await window.fetch('/api/data', { method: 'POST' });

      expect(logListener).toHaveBeenCalled();
      const entry = logListener.mock.calls[0][0];
      expect(entry.level).toBe('error');
      expect(entry.context?.status).toBe(500);
    });

    it('应记录网络错误（fetch 抛异常）', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
      window.fetch = mockFetch;

      const l = createLogger();
      const logListener = vi.fn();
      l.on('log', logListener);

      const plugin = new NetworkPlugin();
      l.use(plugin);

      try {
        await window.fetch('/api/data');
      } catch {
        // expected
      }

      expect(logListener).toHaveBeenCalled();
      const entry = logListener.mock.calls[0][0];
      expect(entry.level).toBe('error');
      expect(entry.context?.error).toContain('Failed to fetch');
    });

    it('应捕获请求体', async () => {
      const mockResponse = new Response(
        JSON.stringify({ code: 200 }),
        { status: 200 },
      );
      const mockFetch = vi.fn().mockResolvedValue(mockResponse);
      window.fetch = mockFetch;

      const l = createLogger();
      const logListener = vi.fn();
      l.on('log', logListener);

      const plugin = new NetworkPlugin({ captureRequestBody: true });
      l.use(plugin);

      await window.fetch('/api/data', {
        method: 'POST',
        body: JSON.stringify({ name: 'test' }),
      });

      const entry = logListener.mock.calls[0][0];
      expect(entry.context?.requestData).toBeDefined();
    });

    it('captureRequestBody=false 时不应捕获请求体', async () => {
      const mockResponse = new Response(
        JSON.stringify({ code: 200 }),
        { status: 200 },
      );
      const mockFetch = vi.fn().mockResolvedValue(mockResponse);
      window.fetch = mockFetch;

      const l = createLogger();
      const logListener = vi.fn();
      l.on('log', logListener);

      const plugin = new NetworkPlugin({ captureRequestBody: false });
      l.use(plugin);

      await window.fetch('/api/data', {
        method: 'POST',
        body: JSON.stringify({ name: 'test' }),
      });

      const entry = logListener.mock.calls[0][0];
      expect(entry.context?.requestData).toBeUndefined();
    });
  });

  // ==================== logTypes 过滤 ====================

  describe('logTypes 过滤', () => {
    it("logTypes=['error'] 时只记录错误请求", async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        callCount++;
        if (url.includes('/api/ok')) {
          return new Response(JSON.stringify({ code: 200 }), { status: 200 });
        }
        return new Response(JSON.stringify({ code: 500 }), { status: 500 });
      });
      window.fetch = mockFetch;

      const l = createLogger();
      const logListener = vi.fn();
      l.on('log', logListener);

      const plugin = new NetworkPlugin({ logTypes: ['error'] });
      l.use(plugin);

      await window.fetch('/api/ok');
      expect(logListener).not.toHaveBeenCalled();

      await window.fetch('/api/error');
      expect(logListener).toHaveBeenCalled();
      expect(logListener.mock.calls[0][0].level).toBe('error');
    });
  });

  // ==================== 慢请求 ====================

  describe('慢请求', () => {
    it('超过 slowThreshold 应记录为慢请求', async () => {
      vi.useFakeTimers();

      const mockFetch = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return new Response(JSON.stringify({ code: 200 }), { status: 200 });
      });
      window.fetch = mockFetch;

      const l = createLogger();
      const logListener = vi.fn();
      l.on('log', logListener);

      const plugin = new NetworkPlugin({
        slowThreshold: 100,
        logTypes: ['slow'],
      });
      l.use(plugin);

      const fetchPromise = window.fetch('/api/slow-data');
      await vi.advanceTimersByTimeAsync(200);
      await fetchPromise;

      expect(logListener).toHaveBeenCalled();
      const entry = logListener.mock.calls[0][0];
      expect(entry.level).toBe('warn');
      expect(entry.tags?.slow).toBe(true);

      vi.useRealTimers();
    });

    it('慢请求排除模式应忽略匹配的 URL', async () => {
      vi.useFakeTimers();

      const mockFetch = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return new Response('audio data', { status: 200 });
      });
      window.fetch = mockFetch;

      const l = createLogger();
      const logListener = vi.fn();
      l.on('log', logListener);

      const plugin = new NetworkPlugin({
        slowThreshold: 100,
        logTypes: ['slow'],
        slowRequestExcludePatterns: ['.mp3'],
      });
      l.use(plugin);

      const fetchPromise = window.fetch('/audio/song.mp3');
      await vi.advanceTimersByTimeAsync(200);
      await fetchPromise;

      expect(logListener).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  // ==================== 业务码提取 ====================

  describe('业务码提取', () => {
    it('应从响应中提取 code 和 message', async () => {
      const mockResponse = new Response(
        JSON.stringify({ code: 10001, message: '参数错误' }),
        { status: 200 },
      );
      const mockFetch = vi.fn().mockResolvedValue(mockResponse);
      window.fetch = mockFetch;

      const l = createLogger();
      const logListener = vi.fn();
      l.on('log', logListener);

      const plugin = new NetworkPlugin();
      l.use(plugin);

      await window.fetch('/api/data');

      const entry = logListener.mock.calls[0][0];
      expect(entry.context?.responseCode).toBe(10001);
      expect(entry.context?.responseMessage).toBe('参数错误');
    });
  });
});
