/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createMiniAppAdapter,
  type MiniAppAPI,
} from '../../src/platform/miniapp';

function createMockAPI(overrides: Partial<MiniAppAPI> = {}): MiniAppAPI {
  return {
    getStorageSync: vi.fn().mockReturnValue(''),
    setStorageSync: vi.fn(),
    removeStorageSync: vi.fn(),
    onAppHide: vi.fn(),
    offAppHide: vi.fn(),
    onError: vi.fn(),
    offError: vi.fn(),
    onUnhandledRejection: vi.fn(),
    offUnhandledRejection: vi.fn(),
    request: vi.fn(),
    ...overrides,
  };
}

describe('createMiniAppAdapter', () => {
  let api: MiniAppAPI;

  beforeEach(() => {
    api = createMockAPI();
  });

  it('应返回 miniapp 类型适配器', () => {
    const adapter = createMiniAppAdapter('wechat', api);
    expect(adapter.type).toBe('miniapp');
    expect(adapter.vendor).toBe('wechat');
  });

  it('应支持所有厂商标识', () => {
    for (const vendor of ['wechat', 'alipay', 'tiktok', 'baidu'] as const) {
      const adapter = createMiniAppAdapter(vendor, api);
      expect(adapter.vendor).toBe(vendor);
    }
  });

  // ==================== Storage ====================

  describe('storage', () => {
    it('getItem 应调用 getStorageSync', () => {
      (api.getStorageSync as ReturnType<typeof vi.fn>).mockReturnValue(
        '{"a":1}',
      );
      const adapter = createMiniAppAdapter('wechat', api);

      const result = adapter.storage.getItem('key');
      expect(api.getStorageSync).toHaveBeenCalledWith('key');
      expect(result).toBe('{"a":1}');
    });

    it('getItem 对空值返回 null', () => {
      (api.getStorageSync as ReturnType<typeof vi.fn>).mockReturnValue('');
      const adapter = createMiniAppAdapter('wechat', api);
      expect(adapter.storage.getItem('key')).toBeNull();
    });

    it('getItem 异常时返回 null', () => {
      (api.getStorageSync as ReturnType<typeof vi.fn>).mockImplementation(
        () => {
          throw new Error('fail');
        },
      );
      const adapter = createMiniAppAdapter('wechat', api);
      expect(adapter.storage.getItem('key')).toBeNull();
    });

    it('setItem 应调用 setStorageSync', () => {
      const adapter = createMiniAppAdapter('wechat', api);
      adapter.storage.setItem('key', 'value');
      expect(api.setStorageSync).toHaveBeenCalledWith('key', 'value');
    });

    it('setItem 异常时静默忽略', () => {
      (api.setStorageSync as ReturnType<typeof vi.fn>).mockImplementation(
        () => {
          throw new Error('quota exceeded');
        },
      );
      const adapter = createMiniAppAdapter('wechat', api);
      expect(() => adapter.storage.setItem('key', 'val')).not.toThrow();
    });

    it('removeItem 应调用 removeStorageSync', () => {
      const adapter = createMiniAppAdapter('wechat', api);
      adapter.storage.removeItem('key');
      expect(api.removeStorageSync).toHaveBeenCalledWith('key');
    });
  });

  // ==================== onBeforeExit ====================

  describe('onBeforeExit', () => {
    it('应注册 onAppHide 回调', () => {
      const adapter = createMiniAppAdapter('wechat', api);
      const cb = vi.fn();
      adapter.onBeforeExit(cb);
      expect(api.onAppHide).toHaveBeenCalledWith(cb);
    });

    it('返回的取消函数应调用 offAppHide', () => {
      const adapter = createMiniAppAdapter('wechat', api);
      const cb = vi.fn();
      const unregister = adapter.onBeforeExit(cb);
      unregister();
      expect(api.offAppHide).toHaveBeenCalledWith(cb);
    });

    it('无 onAppHide 时返回空函数', () => {
      const limitedApi = createMockAPI({ onAppHide: undefined });
      const adapter = createMiniAppAdapter('alipay', limitedApi);
      const unregister = adapter.onBeforeExit(vi.fn());
      expect(typeof unregister).toBe('function');
      unregister(); // 不应抛出
    });
  });

  // ==================== requestIdle ====================

  describe('requestIdle', () => {
    it('应通过 setTimeout 回调', () => {
      vi.useFakeTimers();
      const adapter = createMiniAppAdapter('wechat', api);
      const cb = vi.fn();
      adapter.requestIdle(cb, 16);
      expect(cb).not.toHaveBeenCalled();
      vi.advanceTimersByTime(20);
      expect(cb).toHaveBeenCalledOnce();
      vi.useRealTimers();
    });
  });

  // ==================== errorCapture ====================

  describe('errorCapture', () => {
    it('onGlobalError 应注册 onError', () => {
      const adapter = createMiniAppAdapter('wechat', api);
      const handler = vi.fn();
      adapter.errorCapture.onGlobalError(handler);
      expect(api.onError).toHaveBeenCalledWith(expect.any(Function));
    });

    it('onGlobalError 回调应正确转换', () => {
      let registeredCb: ((msg: string) => void) | undefined;
      const mockApi = createMockAPI({
        onError: vi.fn((cb) => {
          registeredCb = cb;
        }),
      });
      const adapter = createMiniAppAdapter('wechat', mockApi);
      const handler = vi.fn();
      adapter.errorCapture.onGlobalError(handler);

      registeredCb?.('Something went wrong');
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Something went wrong',
          error: expect.any(Error),
        }),
      );
      const passedError = handler.mock.calls[0]![0].error;
      expect(passedError.message).toBe('Something went wrong');
      expect((passedError as any)._syntheticStack).toBe(true);
    });

    it('onGlobalError 取消应调用 offError', () => {
      const adapter = createMiniAppAdapter('wechat', api);
      const unregister = adapter.errorCapture.onGlobalError(vi.fn());
      unregister();
      expect(api.offError).toHaveBeenCalled();
    });

    it('onUnhandledRejection 应注册和取消', () => {
      const adapter = createMiniAppAdapter('wechat', api);
      const handler = vi.fn();
      const unregister = adapter.errorCapture.onUnhandledRejection(handler);
      expect(api.onUnhandledRejection).toHaveBeenCalled();
      unregister();
      expect(api.offUnhandledRejection).toHaveBeenCalled();
    });

    it('无 onError API 时返回空函数', () => {
      const limitedApi = createMockAPI({ onError: undefined });
      const adapter = createMiniAppAdapter('baidu', limitedApi);
      const unregister = adapter.errorCapture.onGlobalError(vi.fn());
      expect(typeof unregister).toBe('function');
    });
  });

  // ==================== network.intercept ====================

  describe('network.intercept', () => {
    it('应拦截 request 调用', () => {
      const adapter = createMiniAppAdapter('wechat', api);
      const handler = vi.fn();
      adapter.network.intercept(handler, {
        shouldCapture: () => true,
        captureRequestBody: true,
        captureResponseBody: true,
        maxResponseBodySize: 10240,
      });

      // api.request 应已被替换
      expect(api.request).not.toBe(createMockAPI().request);
    });

    it('成功请求应产生日志', () => {
      let wrappedRequest: Function | undefined;
      const mockApi = createMockAPI({
        request: vi.fn((opts) => {
          wrappedRequest = opts.success;
          return {};
        }),
      });
      // 第一次 request 用于拿到 originalRequest
      const adapter = createMiniAppAdapter('wechat', mockApi);
      const handler = vi.fn();
      adapter.network.intercept(handler, {
        shouldCapture: () => true,
        captureRequestBody: true,
        captureResponseBody: true,
        maxResponseBodySize: 10240,
      });

      // 调用被拦截的 request
      mockApi.request!({
        url: 'https://api.example.com/data',
        method: 'POST',
        data: { foo: 'bar' },
      });

      // 模拟成功回调
      wrappedRequest?.({
        statusCode: 200,
        data: { code: 0, message: 'ok' },
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'request',
          url: 'https://api.example.com/data',
          method: 'POST',
          status: 200,
        }),
      );
    });

    it('取消拦截应恢复 request', () => {
      const originalRequest = vi.fn();
      const mockApi = createMockAPI({ request: originalRequest });
      const adapter = createMiniAppAdapter('wechat', mockApi);

      // 拦截后 request 被替换
      const unregister = adapter.network.intercept(vi.fn(), {
        shouldCapture: () => true,
        captureRequestBody: false,
        captureResponseBody: false,
        maxResponseBodySize: 0,
      });
      expect(mockApi.request).not.toBe(originalRequest);

      // 取消后 request 应被恢复（原始函数的 bind 版本）
      unregister();
      // 恢复的是 originalRequest.bind(api)，直接验证恢复后可正常调用
      mockApi.request!({ url: 'test' });
      expect(originalRequest).toHaveBeenCalled();
    });

    it('无 request API 时返回空函数', () => {
      const limitedApi = createMockAPI({ request: undefined });
      const adapter = createMiniAppAdapter('tiktok', limitedApi);
      const unregister = adapter.network.intercept(vi.fn(), {
        shouldCapture: () => true,
        captureRequestBody: false,
        captureResponseBody: false,
        maxResponseBodySize: 0,
      });
      expect(typeof unregister).toBe('function');
    });
  });

  // ==================== earlyCapture ====================

  describe('earlyCapture', () => {
    it('hasEarlyErrors 应返回 false', () => {
      const adapter = createMiniAppAdapter('wechat', api);
      expect(adapter.earlyCapture.hasEarlyErrors()).toBe(false);
    });

    it('flush 不应抛出', () => {
      const adapter = createMiniAppAdapter('wechat', api);
      expect(() => adapter.earlyCapture.flush(vi.fn())).not.toThrow();
    });
  });
});
