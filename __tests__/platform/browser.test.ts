/**
 * Browser adapter tests
 *
 * Uses jsdom environment (default) to test browser-specific APIs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBrowserAdapter } from '../../src/platform/browser';
import type { PlatformAdapter } from '../../src/platform/types';

describe('createBrowserAdapter', () => {
  let adapter: PlatformAdapter;

  beforeEach(() => {
    adapter = createBrowserAdapter();
  });

  it('应返回 browser 类型', () => {
    expect(adapter.type).toBe('browser');
    expect(adapter.vendor).toBeUndefined();
  });

  // ==================== storage ====================

  describe('storage', () => {
    it('getItem 应调用 localStorage.getItem', () => {
      localStorage.setItem('test-key', 'test-value');
      expect(adapter.storage.getItem('test-key')).toBe('test-value');
    });

    it('getItem 不存在时返回 null', () => {
      expect(adapter.storage.getItem('nonexistent')).toBeNull();
    });

    it('setItem 应调用 localStorage.setItem', () => {
      adapter.storage.setItem('k', 'v');
      expect(localStorage.getItem('k')).toBe('v');
    });

    it('removeItem 应调用 localStorage.removeItem', () => {
      localStorage.setItem('k', 'v');
      adapter.storage.removeItem('k');
      expect(localStorage.getItem('k')).toBeNull();
    });
  });

  // ==================== onBeforeExit ====================

  describe('onBeforeExit', () => {
    it('应注册 beforeunload 事件', () => {
      const spy = vi.spyOn(window, 'addEventListener');
      const cb = vi.fn();
      adapter.onBeforeExit(cb);
      expect(spy).toHaveBeenCalledWith('beforeunload', cb);
    });

    it('取消函数应移除 beforeunload 事件', () => {
      const spy = vi.spyOn(window, 'removeEventListener');
      const cb = vi.fn();
      const unregister = adapter.onBeforeExit(cb);
      unregister();
      expect(spy).toHaveBeenCalledWith('beforeunload', cb);
    });
  });

  // ==================== requestIdle ====================

  describe('requestIdle', () => {
    it('应在空闲时执行回调', () => {
      vi.useFakeTimers();
      const cb = vi.fn();
      adapter.requestIdle(cb, 5000);
      // jsdom 可能没有 requestIdleCallback，回退到 setTimeout
      vi.advanceTimersByTime(6000);
      expect(cb).toHaveBeenCalledOnce();
      vi.useRealTimers();
    });
  });

  // ==================== getCurrentPath ====================

  describe('getCurrentPath', () => {
    it('应返回当前路径', () => {
      const path = adapter.getCurrentPath();
      expect(typeof path).toBe('string');
    });
  });

  // ==================== errorCapture ====================

  describe('errorCapture', () => {
    it('onGlobalError 应注册 window.onerror', () => {
      const handler = vi.fn();
      const unregister = adapter.errorCapture.onGlobalError(handler);
      expect(typeof unregister).toBe('function');
      unregister();
    });

    it('onGlobalError 触发时应调用 handler', () => {
      const handler = vi.fn();
      adapter.errorCapture.onGlobalError(handler);

      // 触发 window.onerror
      const testError = new Error('test error');
      if (window.onerror) {
        (window.onerror as Function)(
          'test error',
          'test.js',
          1,
          1,
          testError,
        );
      }

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.any(String),
          error: testError,
        }),
      );
    });

    it('onGlobalError 取消应恢复原始 handler', () => {
      const original = window.onerror;
      const handler = vi.fn();
      const unregister = adapter.errorCapture.onGlobalError(handler);
      unregister();
      expect(window.onerror).toBe(original);
    });

    it('onUnhandledRejection 应注册和取消', () => {
      const addSpy = vi.spyOn(window, 'addEventListener');
      const removeSpy = vi.spyOn(window, 'removeEventListener');
      const handler = vi.fn();
      const unregister = adapter.errorCapture.onUnhandledRejection(handler);
      expect(addSpy).toHaveBeenCalledWith(
        'unhandledrejection',
        expect.any(Function),
      );
      unregister();
      expect(removeSpy).toHaveBeenCalledWith(
        'unhandledrejection',
        expect.any(Function),
      );
    });

    it('onResourceError 应注册 error 捕获', () => {
      const addSpy = vi.spyOn(window, 'addEventListener');
      const handler = vi.fn();
      const fn = adapter.errorCapture.onResourceError;
      expect(fn).toBeDefined();
      const unregister = fn!(handler);
      expect(addSpy).toHaveBeenCalledWith('error', handler, true);
      unregister();
    });
  });

  // ==================== network ====================

  describe('network.intercept', () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
      originalFetch = window.fetch;
    });

    afterEach(() => {
      window.fetch = originalFetch;
    });

    it('应替换 fetch', () => {
      const handler = vi.fn();
      adapter.network.intercept(handler, {
        shouldCapture: () => true,
        captureRequestBody: false,
        captureResponseBody: false,
        maxResponseBodySize: 0,
      });
      expect(window.fetch).not.toBe(originalFetch);
    });

    it('取消应恢复 fetch', () => {
      const handler = vi.fn();
      const unregister = adapter.network.intercept(handler, {
        shouldCapture: () => true,
        captureRequestBody: false,
        captureResponseBody: false,
        maxResponseBodySize: 0,
      });
      unregister();
      expect(window.fetch).toBe(originalFetch);
    });

    it('shouldCapture 返回 false 时不拦截', async () => {
      const mockResponse = new Response('ok', { status: 200 });
      window.fetch = vi.fn().mockResolvedValue(mockResponse);
      const savedFetch = window.fetch;

      adapter = createBrowserAdapter();
      const handler = vi.fn();
      adapter.network.intercept(handler, {
        shouldCapture: () => false,
        captureRequestBody: false,
        captureResponseBody: false,
        maxResponseBodySize: 0,
      });

      await window.fetch('https://excluded.com/api');
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ==================== earlyCapture ====================

  describe('earlyCapture', () => {
    it('hasEarlyErrors 无全局变量时返回 false', () => {
      expect(adapter.earlyCapture.hasEarlyErrors()).toBe(false);
    });

    it('hasEarlyErrors 有 __EARLY_ERRORS__ 时返回 true', () => {
      (window as any).__EARLY_ERRORS__ = [{ message: 'test' }];
      (window as any).__flushEarlyErrors__ = vi.fn();

      const freshAdapter = createBrowserAdapter();
      expect(freshAdapter.earlyCapture.hasEarlyErrors()).toBe(true);

      delete (window as any).__EARLY_ERRORS__;
      delete (window as any).__flushEarlyErrors__;
    });

    it('flush 应调用 __flushEarlyErrors__', () => {
      const mockFlush = vi.fn((cb: Function) => cb([]));
      (window as any).__flushEarlyErrors__ = mockFlush;

      const freshAdapter = createBrowserAdapter();
      const callback = vi.fn();
      freshAdapter.earlyCapture.flush(callback);
      expect(mockFlush).toHaveBeenCalled();

      delete (window as any).__flushEarlyErrors__;
    });
  });
});
