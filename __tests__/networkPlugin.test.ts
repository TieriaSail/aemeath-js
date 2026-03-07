/**
 * NetworkPlugin 网络请求监控插件测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NetworkPlugin } from '../src/plugins/NetworkPlugin';
import { AemeathLogger } from '../src/core/Logger';

describe('NetworkPlugin', () => {
  let logger: AemeathLogger;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = new AemeathLogger({ enableConsole: false });
    originalFetch = window.fetch;
  });

  afterEach(() => {
    logger.destroy();
    // 确保 fetch 被恢复
    window.fetch = originalFetch;
    vi.useRealTimers();
  });

  // ==================== 安装与卸载 ====================

  describe('安装与卸载', () => {
    it('应正确安装', () => {
      const plugin = new NetworkPlugin();
      logger.use(plugin);
      expect(logger.hasPlugin('network')).toBe(true);
    });

    it('卸载后不再有插件', () => {
      const plugin = new NetworkPlugin();
      logger.use(plugin);
      expect(logger.hasPlugin('network')).toBe(true);

      logger.uninstall('network');
      expect(logger.hasPlugin('network')).toBe(false);
    });

    it('手动调用 uninstall 应恢复 fetch', () => {
      const beforeFetch = window.fetch;
      const plugin = new NetworkPlugin();
      logger.use(plugin);

      // fetch 应该被替换
      expect(window.fetch).not.toBe(beforeFetch);

      // 直接调用插件的 uninstall
      plugin.uninstall();
      expect(window.fetch).toBe(beforeFetch);
    });

    it('interceptFetch=false 时不应拦截 fetch', () => {
      const beforeFetch = window.fetch;
      const plugin = new NetworkPlugin({ interceptFetch: false });
      logger.use(plugin);

      // fetch 不应被替换
      expect(window.fetch).toBe(beforeFetch);
    });
  });

  // ==================== URL 过滤 ====================

  describe('URL 过滤', () => {
    it('应排除日志上报接口', async () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      // 模拟 fetch 返回成功
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 200 }), { status: 200 }),
      );
      window.fetch = mockFetch;

      const plugin = new NetworkPlugin();
      logger.use(plugin);

      // 调用日志上报接口
      await window.fetch('/api/logs', { method: 'POST' });

      // 不应有日志记录（被排除了）
      expect(logListener).not.toHaveBeenCalled();
    });

    it('urlFilter 返回 false 的 URL 不应被记录', async () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 200 }), { status: 200 }),
      );
      window.fetch = mockFetch;

      const plugin = new NetworkPlugin({
        urlFilter: (url) => !url.includes('/health'),
      });
      logger.use(plugin);

      await window.fetch('/health');
      expect(logListener).not.toHaveBeenCalled();
    });
  });

  // ==================== Fetch 拦截 ====================

  describe('Fetch 拦截', () => {
    it('应记录成功的 fetch 请求', async () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      const mockResponse = new Response(
        JSON.stringify({ code: 200, data: 'ok' }),
        { status: 200, statusText: 'OK' },
      );
      const mockFetch = vi.fn().mockResolvedValue(mockResponse);
      window.fetch = mockFetch;

      const plugin = new NetworkPlugin();
      logger.use(plugin);

      await window.fetch('/api/data', { method: 'GET' });

      expect(logListener).toHaveBeenCalled();
      const entry = logListener.mock.calls[0][0];
      expect(entry.level).toBe('info');
      expect(entry.message).toContain('/api/data');
      expect(entry.tags?.errorCategory).toBe('http');
      expect(entry.tags?.method).toBe('GET');
    });

    it('应记录失败的 fetch 请求（状态码 >= 400）', async () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      const mockResponse = new Response(
        JSON.stringify({ code: 500, message: 'Internal Error' }),
        { status: 500, statusText: 'Internal Server Error' },
      );
      const mockFetch = vi.fn().mockResolvedValue(mockResponse);
      window.fetch = mockFetch;

      const plugin = new NetworkPlugin();
      logger.use(plugin);

      await window.fetch('/api/data', { method: 'POST' });

      expect(logListener).toHaveBeenCalled();
      const entry = logListener.mock.calls[0][0];
      expect(entry.level).toBe('error');
      expect(entry.context?.status).toBe(500);
    });

    it('应记录网络错误（fetch 抛异常）', async () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      const mockFetch = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
      window.fetch = mockFetch;

      const plugin = new NetworkPlugin();
      logger.use(plugin);

      try {
        await window.fetch('/api/data');
      } catch {
        // 预期抛出
      }

      expect(logListener).toHaveBeenCalled();
      const entry = logListener.mock.calls[0][0];
      expect(entry.level).toBe('error');
      expect(entry.context?.error).toContain('Failed to fetch');
    });

    it('应捕获请求体', async () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      const mockResponse = new Response(
        JSON.stringify({ code: 200 }),
        { status: 200 },
      );
      const mockFetch = vi.fn().mockResolvedValue(mockResponse);
      window.fetch = mockFetch;

      const plugin = new NetworkPlugin({ captureRequestBody: true });
      logger.use(plugin);

      await window.fetch('/api/data', {
        method: 'POST',
        body: JSON.stringify({ name: 'test' }),
      });

      const entry = logListener.mock.calls[0][0];
      expect(entry.context?.requestData).toBeDefined();
    });

    it('captureRequestBody=false 时不应捕获请求体', async () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      const mockResponse = new Response(
        JSON.stringify({ code: 200 }),
        { status: 200 },
      );
      const mockFetch = vi.fn().mockResolvedValue(mockResponse);
      window.fetch = mockFetch;

      const plugin = new NetworkPlugin({ captureRequestBody: false });
      logger.use(plugin);

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
      const logListener = vi.fn();
      logger.on('log', logListener);

      const plugin = new NetworkPlugin({ logTypes: ['error'] });
      logger.use(plugin);

      // 成功请求
      const successResponse = new Response(
        JSON.stringify({ code: 200 }),
        { status: 200 },
      );
      const mockFetch = vi.fn().mockResolvedValue(successResponse);
      window.fetch = mockFetch;

      // 需要重新安装来拦截新的 fetch
      logger.uninstall('network');
      const plugin2 = new NetworkPlugin({ logTypes: ['error'] });
      window.fetch = mockFetch;
      logger.use(plugin2);

      await window.fetch('/api/ok');
      expect(logListener).not.toHaveBeenCalled();

      // 错误请求
      const errorResponse = new Response(
        JSON.stringify({ code: 500 }),
        { status: 500 },
      );
      const mockFetch2 = vi.fn().mockResolvedValue(errorResponse);
      // 卸载再安装
      logger.uninstall('network');
      window.fetch = mockFetch2;
      const plugin3 = new NetworkPlugin({ logTypes: ['error'] });
      logger.use(plugin3);

      await window.fetch('/api/error');
      expect(logListener).toHaveBeenCalled();
      expect(logListener.mock.calls[0][0].level).toBe('error');
    });
  });

  // ==================== 慢请求 ====================

  describe('慢请求', () => {
    it('超过 slowThreshold 应记录为慢请求', async () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      const plugin = new NetworkPlugin({
        slowThreshold: 100,
        logTypes: ['slow'],
      });

      // 模拟一个需要时间的 fetch
      const mockFetch = vi.fn().mockImplementation(async () => {
        // 模拟延迟
        await new Promise((resolve) => setTimeout(resolve, 200));
        return new Response(JSON.stringify({ code: 200 }), { status: 200 });
      });
      window.fetch = mockFetch;
      logger.use(plugin);

      const fetchPromise = window.fetch('/api/slow-data');
      await vi.advanceTimersByTimeAsync(200);
      await fetchPromise;

      expect(logListener).toHaveBeenCalled();
      const entry = logListener.mock.calls[0][0];
      expect(entry.level).toBe('warn');
      expect(entry.tags?.slow).toBe(true);
    });

    it('慢请求排除模式应忽略匹配的 URL', async () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      const plugin = new NetworkPlugin({
        slowThreshold: 100,
        logTypes: ['slow'],
        slowRequestExcludePatterns: ['.mp3'],
      });

      const mockFetch = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return new Response('audio data', { status: 200 });
      });
      window.fetch = mockFetch;
      logger.use(plugin);

      const fetchPromise = window.fetch('/audio/song.mp3');
      await vi.advanceTimersByTimeAsync(200);
      await fetchPromise;

      // .mp3 被排除，不应记录慢请求
      expect(logListener).not.toHaveBeenCalled();
    });
  });

  // ==================== 业务码提取 ====================

  describe('业务码提取', () => {
    it('应从响应中提取 code 和 message', async () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      const mockResponse = new Response(
        JSON.stringify({ code: 10001, message: '参数错误' }),
        { status: 200 },
      );
      const mockFetch = vi.fn().mockResolvedValue(mockResponse);
      window.fetch = mockFetch;

      const plugin = new NetworkPlugin();
      logger.use(plugin);

      await window.fetch('/api/data');

      const entry = logListener.mock.calls[0][0];
      expect(entry.context?.responseCode).toBe(10001);
      expect(entry.context?.responseMessage).toBe('参数错误');
    });
  });
});

