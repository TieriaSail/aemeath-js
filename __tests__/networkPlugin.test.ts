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
    window.history.pushState({}, '', '/');
    vi.useRealTimers();
  });

  async function waitForLog(logListener: ReturnType<typeof vi.fn>): Promise<void> {
    await vi.waitFor(() => expect(logListener).toHaveBeenCalled());
  }

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
      await waitForLog(logListener);

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
      await waitForLog(logListener);

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
      await waitForLog(logListener);

      const entry = logListener.mock.calls[0][0];
      expect(entry.context?.requestData).toBeDefined();
    });

    it('Request 对象的请求体应在不消费 stream 的情况下记录占位信息', async () => {
      const mockResponse = new Response('{"code":200}', {
        headers: { 'content-type': 'application/json' },
      });
      window.fetch = vi.fn().mockResolvedValue(mockResponse);
      const logListener = vi.fn();
      logger.on('log', logListener);
      logger.use(new NetworkPlugin({ captureRequestBody: true }));
      const request = new Request('https://example.com/api', {
        method: 'POST',
        body: '{"name":"test"}',
      });

      await window.fetch(request);
      await waitForLog(logListener);

      expect(logListener.mock.calls[0][0].context?.requestData).toBe(
        '[ReadableStream]',
      );
      expect(request.bodyUsed).toBe(false);
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
      await waitForLog(logListener);

      const entry = logListener.mock.calls[0][0];
      expect(entry.context?.requestData).toBeUndefined();
    });

    it('文本响应体未完成时也应立即向业务返回 Response', async () => {
      const logListener = vi.fn();
      logger.on('log', logListener);
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
      window.fetch = vi.fn().mockResolvedValue(response);
      logger.use(new NetworkPlugin());

      const businessResponse = await window.fetch('/api/streamed-json');

      expect(businessResponse).toBe(response);
      expect(logListener).not.toHaveBeenCalled();

      streamController.enqueue(
        new TextEncoder().encode('{"code":200,"message":"ok"}'),
      );
      streamController.close();
      await expect(businessResponse.text()).resolves.toBe(
        '{"code":200,"message":"ok"}',
      );
      await waitForLog(logListener);
      expect(logListener.mock.calls[0][0].context?.responseCode).toBe(200);
    });

    it('20 MB 音频错误响应应保留元数据且不 clone body', async () => {
      const logListener = vi.fn();
      logger.on('log', logListener);
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
          },
        }),
        {
          status: 500,
          headers: {
            'content-type': 'audio/mpeg',
            'content-length': String(20 * 1024 * 1024),
          },
        },
      );
      const cloneSpy = vi.spyOn(response, 'clone');
      window.fetch = vi.fn().mockResolvedValue(response);
      logger.use(new NetworkPlugin({ logTypes: ['error'] }));

      const businessResponse = await window.fetch('/media/audio');

      expect(businessResponse).toBe(response);
      expect(cloneSpy).not.toHaveBeenCalled();
      expect(logListener).toHaveBeenCalledOnce();
      const entry = logListener.mock.calls[0][0];
      expect(entry.context?.status).toBe(500);
      expect(entry.context?.responseData).toBeUndefined();
      streamController.close();
    });

    it.each([
      ['SSE', { 'content-type': 'text/event-stream' }],
      [
        'attachment',
        {
          'content-type': 'text/plain',
          'content-disposition': 'attachment; filename="data.txt"',
        },
      ],
    ])('默认应跳过 %s 响应体', async (_label, headers) => {
      const logListener = vi.fn();
      logger.on('log', logListener);
      const response = new Response('data', { headers });
      const cloneSpy = vi.spyOn(response, 'clone');
      window.fetch = vi.fn().mockResolvedValue(response);
      logger.use(new NetworkPlugin());

      await window.fetch('/download');

      expect(cloneSpy).not.toHaveBeenCalled();
      expect(logListener).toHaveBeenCalledOnce();
      expect(logListener.mock.calls[0][0].context?.responseData).toBeUndefined();
    });

    it('默认应跳过缺少 Content-Type 的响应体', async () => {
      const logListener = vi.fn();
      logger.on('log', logListener);
      const response = new Response(new Uint8Array([1, 2, 3]));
      const cloneSpy = vi.spyOn(response, 'clone');
      window.fetch = vi.fn().mockResolvedValue(response);
      logger.use(new NetworkPlugin());

      await window.fetch('/unknown');

      expect(cloneSpy).not.toHaveBeenCalled();
      expect(logListener).toHaveBeenCalledOnce();
    });

    it('shouldCaptureResponseBody 应支持显式捕获自定义文本类型', async () => {
      const logListener = vi.fn();
      logger.on('log', logListener);
      const filter = vi.fn().mockReturnValue(true);
      const response = new Response('{"code":7}', {
        headers: { 'content-type': 'application/octet-stream' },
      });
      window.fetch = vi.fn().mockResolvedValue(response);
      logger.use(new NetworkPlugin({ shouldCaptureResponseBody: filter }));

      await window.fetch(
        new Request('https://example.com/custom-binary', { method: 'POST' }),
      );
      await waitForLog(logListener);

      expect(filter).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://example.com/custom-binary',
          method: 'POST',
          status: 200,
        }),
      );
      expect(logListener.mock.calls[0][0].context?.responseCode).toBe(7);
    });

    it('停滞响应体应按截止时间取消并释放业务 cancel', async () => {
      const logListener = vi.fn();
      logger.on('log', logListener);
      const sourceCancel = vi.fn();
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
          },
          cancel: sourceCancel,
        }),
        { headers: { 'content-type': 'application/json' } },
      );
      window.fetch = vi.fn().mockResolvedValue(response);
      logger.use(new NetworkPlugin({ responseBodyCaptureTimeout: 20 }));

      const businessResponse = await window.fetch('/api/stalled-json');
      const businessCancel = businessResponse.body!.cancel();
      await vi.advanceTimersByTimeAsync(20);
      await waitForLog(logListener);

      await expect(businessCancel).resolves.toBeUndefined();
      expect(logListener.mock.calls[0][0].context?.responseData).toBe('{');
      expect(
        logListener.mock.calls[0][0].context?.responseDataTruncated,
      ).toBe(true);
      expect(sourceCancel).toHaveBeenCalledOnce();
    });

    it('卸载插件应取消待处理的响应体读取', async () => {
      const logListener = vi.fn();
      logger.on('log', logListener);
      const sourceCancel = vi.fn();
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
          },
          cancel: sourceCancel,
        }),
        { headers: { 'content-type': 'application/json' } },
      );
      window.fetch = vi.fn().mockResolvedValue(response);
      logger.use(new NetworkPlugin({ responseBodyCaptureTimeout: 10_000 }));

      const businessResponse = await window.fetch('/api/stalled-json');
      logger.uninstall('network');

      await expect(businessResponse.body!.cancel()).resolves.toBeUndefined();
      await Promise.resolve();
      expect(logListener).not.toHaveBeenCalled();
      expect(sourceCancel).toHaveBeenCalledOnce();
    });

    it('应按请求开始时的路由归属记录后台响应体', async () => {
      const logListener = vi.fn();
      logger.on('log', logListener);
      window.history.pushState({}, '', '/network-included');
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
      window.fetch = vi.fn().mockResolvedValue(response);
      logger.use(
        new NetworkPlugin({
          routeMatch: { includeRoutes: ['/network-included'] },
        }),
      );

      const businessResponse = await window.fetch('/api/route-snapshot');
      window.history.pushState({}, '', '/network-excluded');
      streamController.enqueue(new TextEncoder().encode('{"ok":true}'));
      streamController.close();
      await businessResponse.text();
      await waitForLog(logListener);

      expect(logListener).toHaveBeenCalledOnce();
      expect(logListener.mock.calls[0][0].context?.url).toBe(
        '/api/route-snapshot',
      );
    });

    it('maxResponseBodySize 应限制实际读取并标记截断', async () => {
      const logListener = vi.fn();
      logger.on('log', logListener);
      const response = new Response('business body', {
        headers: {
          'content-type': 'application/json',
          'content-length': '100',
        },
      });
      const cancel = vi.fn().mockResolvedValue(undefined);
      const read = vi
        .fn()
        .mockResolvedValueOnce({
          done: false,
          value: new TextEncoder().encode('abcdefgh'),
        })
        .mockResolvedValueOnce({
          done: false,
          value: new TextEncoder().encode('ijklmnop'),
        });
      vi.spyOn(response, 'clone').mockReturnValue({
        headers: response.headers,
        body: { getReader: () => ({ read, cancel }) },
      } as unknown as Response);
      window.fetch = vi.fn().mockResolvedValue(response);
      logger.use(new NetworkPlugin({ maxResponseBodySize: 10 }));

      await window.fetch('/api/large-json');
      await waitForLog(logListener);

      const entry = logListener.mock.calls[0][0];
      expect(read).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledOnce();
      expect(entry.context?.responseData).toBe('abcdefghij');
      expect(entry.context?.responseDataTruncated).toBe(true);
    });

    it('无效的响应体大小配置应回退到默认有限上限', async () => {
      const logListener = vi.fn();
      logger.on('log', logListener);
      window.fetch = vi.fn().mockResolvedValue(
        new Response('x'.repeat(11_000), {
          headers: {
            'content-type': 'text/plain',
            'content-length': '11000',
          },
        }),
      );
      logger.use(
        new NetworkPlugin({ maxResponseBodySize: Number.POSITIVE_INFINITY }),
      );

      await window.fetch('/api/invalid-size');
      await waitForLog(logListener);

      const entry = logListener.mock.calls[0][0];
      expect(entry.context?.responseData).toBe('x'.repeat(10_240));
      expect(entry.context?.responseDataTruncated).toBe(true);
    });

    it('后台响应体读取失败不应污染业务 Fetch Promise', async () => {
      const logListener = vi.fn();
      logger.on('log', logListener);
      const response = new Response('business body');
      vi.spyOn(response, 'clone').mockReturnValue({
        headers: response.headers,
        body: {
          getReader: () => ({
            read: () =>
              Promise.reject(new DOMException('aborted', 'AbortError')),
            cancel: vi.fn(),
          }),
        },
      } as unknown as Response);
      window.fetch = vi.fn().mockResolvedValue(response);
      logger.use(new NetworkPlugin());

      await expect(window.fetch('/api/aborted-body')).resolves.toBe(response);
      await waitForLog(logListener);

      const entry = logListener.mock.calls[0][0];
      expect(entry.context?.error).toBeUndefined();
      expect(entry.context?.responseData).toBe(
        '[Unable to read response body]',
      );
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
      await waitForLog(logListener);
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
      await waitForLog(logListener);

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

  // ==================== routeMatch ====================

  describe('routeMatch', () => {
    it('当路由不在全局白名单时不应记录网络请求', async () => {
      const logListener = vi.fn();
      const routeLogger = new AemeathLogger({
        routeMatch: { includeRoutes: ['/allowed'] },
      });
      routeLogger.on('log', logListener);

      const mockResponse = new Response('ok', { status: 200 });
      window.fetch = vi.fn().mockResolvedValue(mockResponse);

      const plugin = new NetworkPlugin();
      routeLogger.use(plugin);

      await window.fetch('/api/data');
      expect(logListener).not.toHaveBeenCalled();
    });

    it('插件级 routeMatch 应在全局基础上进一步限定', async () => {
      const logListener = vi.fn();
      const routeLogger = new AemeathLogger();
      routeLogger.on('log', logListener);

      const mockResponse = new Response('ok', { status: 200 });
      window.fetch = vi.fn().mockResolvedValue(mockResponse);

      const plugin = new NetworkPlugin({
        routeMatch: { includeRoutes: ['/special'] },
      });
      routeLogger.use(plugin);

      await window.fetch('/api/data');
      expect(logListener).not.toHaveBeenCalled();
    });
  });

  // ==================== XHR readystatechange 防御 (WKWebView) ====================

  describe('XHR readystatechange 防御', () => {
    let originalXHROpen: typeof XMLHttpRequest.prototype.open;
    let originalXHRSend: typeof XMLHttpRequest.prototype.send;

    beforeEach(() => {
      originalXHROpen = XMLHttpRequest.prototype.open;
      originalXHRSend = XMLHttpRequest.prototype.send;
    });

    afterEach(() => {
      XMLHttpRequest.prototype.open = originalXHROpen;
      XMLHttpRequest.prototype.send = originalXHRSend;
    });

    it('should capture via readystatechange and block spurious error (WKWebView defense)', () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      const plugin = new NetworkPlugin({ interceptXHR: true });
      logger.use(plugin);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/test');
      xhr.send(null);

      // Step 1: readystatechange fires with valid response
      Object.defineProperty(xhr, 'readyState', { value: 4, writable: true, configurable: true });
      Object.defineProperty(xhr, 'status', { value: 200, writable: true, configurable: true });
      Object.defineProperty(xhr, 'statusText', { value: 'OK', writable: true, configurable: true });
      Object.defineProperty(xhr, 'responseText', { value: '{"code":200}', writable: true, configurable: true });
      xhr.dispatchEvent(new Event('readystatechange'));

      // Should have captured the successful request
      expect(logListener).toHaveBeenCalledTimes(1);
      const entry1 = logListener.mock.calls[0][0];
      expect(entry1.level).toBe('info');
      expect(entry1.context?.status).toBe(200);

      // Step 2: WKWebView fires spurious error (status reset to 0)
      Object.defineProperty(xhr, 'status', { value: 0, writable: true, configurable: true });
      xhr.dispatchEvent(new Event('error'));

      // Should still be 1 log — the spurious error is blocked
      expect(logListener).toHaveBeenCalledTimes(1);
    });

    it('should let real network errors through when status=0', () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      const plugin = new NetworkPlugin({ interceptXHR: true });
      logger.use(plugin);

      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/fail');
      xhr.send(null);

      // readystatechange with status=0 — should be skipped
      Object.defineProperty(xhr, 'readyState', { value: 4, writable: true, configurable: true });
      Object.defineProperty(xhr, 'status', { value: 0, writable: true, configurable: true });
      Object.defineProperty(xhr, 'statusText', { value: '', writable: true, configurable: true });
      xhr.dispatchEvent(new Event('readystatechange'));

      expect(logListener).not.toHaveBeenCalled();

      // error handler should capture
      xhr.dispatchEvent(new Event('error'));
      expect(logListener).toHaveBeenCalledTimes(1);
      expect(logListener.mock.calls[0][0].level).toBe('error');
    });
  });

  // ==================== abort 识别与 ignoreErrorTypes ====================

  describe('abort 识别与 ignoreErrorTypes', () => {
    let originalXHROpen: typeof XMLHttpRequest.prototype.open;
    let originalXHRSend: typeof XMLHttpRequest.prototype.send;

    beforeEach(() => {
      originalXHROpen = XMLHttpRequest.prototype.open;
      originalXHRSend = XMLHttpRequest.prototype.send;
    });

    afterEach(() => {
      XMLHttpRequest.prototype.open = originalXHROpen;
      XMLHttpRequest.prototype.send = originalXHRSend;
    });

    function dispatchXHRAbort() {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/cancelled');
      xhr.send(null);
      Object.defineProperty(xhr, 'readyState', { value: 4, writable: true, configurable: true });
      Object.defineProperty(xhr, 'status', { value: 0, writable: true, configurable: true });
      Object.defineProperty(xhr, 'statusText', { value: '', writable: true, configurable: true });
      xhr.dispatchEvent(new Event('abort'));
      xhr.dispatchEvent(new Event('loadend'));
      return xhr;
    }

    it('XHR abort 默认不应被记录（captureAborted 默认 false）', () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      const plugin = new NetworkPlugin({ interceptXHR: true });
      logger.use(plugin);

      dispatchXHRAbort();

      expect(logListener).not.toHaveBeenCalled();
    });

    it('captureAborted=true 时 XHR abort 应记录为 network.aborted', () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      const plugin = new NetworkPlugin({ interceptXHR: true, captureAborted: true });
      logger.use(plugin);

      dispatchXHRAbort();

      expect(logListener).toHaveBeenCalledTimes(1);
      const entry = logListener.mock.calls[0][0];
      expect(entry.tags?.networkErrorType).toBe('network.aborted');
      expect(entry.context?.errorType).toBe('network.aborted');
      expect(entry.context?.error).toBe('Network Error: Request aborted');
    });

    it('fetch AbortError 默认不应被记录', async () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      window.fetch = vi.fn().mockRejectedValue(
        new DOMException('The user aborted a request.', 'AbortError'),
      );

      const plugin = new NetworkPlugin();
      logger.use(plugin);

      try {
        await window.fetch('/api/cancelled');
      } catch {
        // 预期抛出
      }

      expect(logListener).not.toHaveBeenCalled();
    });

    it('captureAborted=true 时 fetch AbortError 应记录为 network.aborted', async () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      window.fetch = vi.fn().mockRejectedValue(
        new DOMException('The user aborted a request.', 'AbortError'),
      );

      const plugin = new NetworkPlugin({ captureAborted: true });
      logger.use(plugin);

      try {
        await window.fetch('/api/cancelled');
      } catch {
        // 预期抛出
      }

      expect(logListener).toHaveBeenCalledTimes(1);
      const entry = logListener.mock.calls[0][0];
      expect(entry.tags?.networkErrorType).toBe('network.aborted');
    });

    it('XHR error 事件应分类为 network.unknown 且不受 abort 过滤影响', () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      const plugin = new NetworkPlugin({ interceptXHR: true });
      logger.use(plugin);

      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/fail');
      xhr.send(null);
      Object.defineProperty(xhr, 'readyState', { value: 4, writable: true, configurable: true });
      Object.defineProperty(xhr, 'status', { value: 0, writable: true, configurable: true });
      xhr.dispatchEvent(new Event('error'));

      expect(logListener).toHaveBeenCalledTimes(1);
      const entry = logListener.mock.calls[0][0];
      expect(entry.tags?.networkErrorType).toBe('network.unknown');
      expect(entry.level).toBe('error');
    });

    it('ignoreErrorTypes 应过滤指定类型（如 network.unknown）', () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      const plugin = new NetworkPlugin({
        interceptXHR: true,
        ignoreErrorTypes: ['network.unknown'],
      });
      logger.use(plugin);

      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/fail');
      xhr.send(null);
      Object.defineProperty(xhr, 'readyState', { value: 4, writable: true, configurable: true });
      Object.defineProperty(xhr, 'status', { value: 0, writable: true, configurable: true });
      xhr.dispatchEvent(new Event('error'));

      expect(logListener).not.toHaveBeenCalled();
    });

    it('错误消息含 abort 字样但 name 非 AbortError 不应被误过滤', async () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      window.fetch = vi.fn().mockRejectedValue(
        new TypeError('connection to /api/abort-flow failed'),
      );

      const plugin = new NetworkPlugin();
      logger.use(plugin);

      try {
        await window.fetch('/api/abort-flow');
      } catch {
        // 预期抛出
      }

      // 真实网络错误（network.unknown）不应被 abort 过滤吞掉
      expect(logListener).toHaveBeenCalledTimes(1);
      expect(logListener.mock.calls[0][0].tags?.networkErrorType).toBe('network.unknown');
    });
  });

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
      await waitForLog(logListener);

      const entry = logListener.mock.calls[0][0];
      expect(entry.context?.responseCode).toBe(10001);
      expect(entry.context?.responseMessage).toBe('参数错误');
    });
  });
});
