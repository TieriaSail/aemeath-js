/**
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import { createNoopAdapter } from '../../src/platform/noop';

describe('createNoopAdapter', () => {
  const adapter = createNoopAdapter();

  it('应返回 unknown 类型', () => {
    expect(adapter.type).toBe('unknown');
    expect(adapter.vendor).toBeUndefined();
  });

  describe('storage', () => {
    it('getItem 应始终返回 null', () => {
      expect(adapter.storage.getItem('any')).toBeNull();
    });

    it('setItem 不应抛出', () => {
      expect(() => adapter.storage.setItem('k', 'v')).not.toThrow();
    });

    it('removeItem 不应抛出', () => {
      expect(() => adapter.storage.removeItem('k')).not.toThrow();
    });
  });

  describe('onBeforeExit', () => {
    it('应返回空函数', () => {
      const unregister = adapter.onBeforeExit(vi.fn());
      expect(typeof unregister).toBe('function');
      unregister(); // 不应抛出
    });
  });

  describe('requestIdle', () => {
    it('应通过 setTimeout 执行回调', () => {
      vi.useFakeTimers();
      const cb = vi.fn();
      adapter.requestIdle(cb);
      expect(cb).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10);
      expect(cb).toHaveBeenCalledOnce();
      vi.useRealTimers();
    });
  });

  describe('getCurrentPath', () => {
    it('应返回空字符串', () => {
      expect(adapter.getCurrentPath()).toBe('');
    });
  });

  describe('errorCapture', () => {
    it('onGlobalError 应返回空函数', () => {
      const unregister = adapter.errorCapture.onGlobalError(vi.fn());
      expect(typeof unregister).toBe('function');
      unregister();
    });

    it('onUnhandledRejection 应返回空函数', () => {
      const unregister = adapter.errorCapture.onUnhandledRejection(vi.fn());
      expect(typeof unregister).toBe('function');
      unregister();
    });

    it('不应有 onResourceError', () => {
      expect(adapter.errorCapture.onResourceError).toBeUndefined();
    });
  });

  describe('earlyCapture', () => {
    it('hasEarlyErrors 应返回 false', () => {
      expect(adapter.earlyCapture.hasEarlyErrors()).toBe(false);
    });

    it('flush 不应抛出', () => {
      expect(() => adapter.earlyCapture.flush(vi.fn())).not.toThrow();
    });

    it('flush 不应调用 callback 传入错误', () => {
      const cb = vi.fn();
      adapter.earlyCapture.flush(cb);
      // noop adapter 不传递任何错误
      expect(cb).not.toHaveBeenCalled();
    });
  });
});
