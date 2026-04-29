/**
 * early-error-script 共享脚本测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getEarlyErrorCaptureScript } from '../src/build-plugins/early-error-script';

describe('getEarlyErrorCaptureScript', () => {
  // ==================== 基础脚本（无参数） ====================

  describe('基础脚本（无参数）', () => {
    it('应返回非空字符串', () => {
      const script = getEarlyErrorCaptureScript();
      expect(script).toBeTruthy();
      expect(typeof script).toBe('string');
    });

    it('应包含 IIFE 结构', () => {
      const script = getEarlyErrorCaptureScript();
      expect(script).toContain('(function()');
      expect(script).toContain('})()');
    });

    it('应初始化 __EARLY_ERRORS__', () => {
      const script = getEarlyErrorCaptureScript();
      expect(script).toContain('window.__EARLY_ERRORS__');
    });

    it('应初始化 __LOGGER_INITIALIZED__', () => {
      const script = getEarlyErrorCaptureScript();
      expect(script).toContain('window.__LOGGER_INITIALIZED__');
    });

    it('应包含 __flushEarlyErrors__ 函数', () => {
      const script = getEarlyErrorCaptureScript();
      expect(script).toContain('window.__flushEarlyErrors__');
    });

    it('应监听 error 事件', () => {
      const script = getEarlyErrorCaptureScript();
      expect(script).toContain("addEventListener('error'");
    });

    it('应监听 unhandledrejection 事件', () => {
      const script = getEarlyErrorCaptureScript();
      expect(script).toContain("addEventListener('unhandledrejection'");
    });

    it('应捕获资源加载错误（script/link/img）', () => {
      const script = getEarlyErrorCaptureScript();
      expect(script).toContain('tagName');
      expect(script).toContain("type: 'resource'");
    });

    it('每次调用应返回相同内容', () => {
      const script1 = getEarlyErrorCaptureScript();
      const script2 = getEarlyErrorCaptureScript();
      expect(script1).toBe(script2);
    });

    it('应包含 MAX_ERRORS 保护', () => {
      const script = getEarlyErrorCaptureScript();
      expect(script).toContain('MAX_ERRORS');
    });

    it('默认 MAX_ERRORS 应为 50', () => {
      const script = getEarlyErrorCaptureScript();
      expect(script).toContain('var MAX_ERRORS = 50');
    });

    it('应包含 deviceInfo 采集', () => {
      const script = getEarlyErrorCaptureScript();
      expect(script).toContain('deviceInfo');
      expect(script).toContain('navigator.userAgent');
    });

    it('应包含 chunk 自动刷新逻辑', () => {
      const script = getEarlyErrorCaptureScript();
      expect(script).toContain('__chunk_refreshed__');
      expect(script).toContain('sessionStorage');
    });

    it('应包含兼容性检查', () => {
      const script = getEarlyErrorCaptureScript();
      expect(script).toContain("type: 'compatibility'");
      expect(script).toContain('window.Promise');
    });

    it('无 fallback 时不应包含 FALLBACK_ENDPOINT', () => {
      const script = getEarlyErrorCaptureScript();
      expect(script).not.toContain('FALLBACK_ENDPOINT');
    });

    it('应包含全局 try-catch 错误兜底', () => {
      const script = getEarlyErrorCaptureScript();
      expect(script).toContain('} catch (__earlyErr__)');
      expect(script).toContain('[EarlyErrorCapture] Script init error:');
    });

    it('flush 时应清理 fallback 定时器', () => {
      const script = getEarlyErrorCaptureScript();
      expect(script).toContain('__FALLBACK_TIMER__');
      expect(script).toContain('clearTimeout(__FALLBACK_TIMER__)');
    });
  });

  // ==================== 配置项控制 ====================

  describe('配置项控制', () => {
    it('自定义 maxErrors', () => {
      const script = getEarlyErrorCaptureScript({ maxErrors: 100 });
      expect(script).toContain('var MAX_ERRORS = 100');
    });

    it('禁用 chunk 自动刷新', () => {
      const script = getEarlyErrorCaptureScript({ autoRefreshOnChunkError: false });
      expect(script).not.toContain('__chunk_refreshed__');
    });

    it('禁用兼容性检查', () => {
      const script = getEarlyErrorCaptureScript({ checkCompatibility: false });
      expect(script).not.toContain("type: 'compatibility'");
    });
  });

  // ==================== Fallback 上报 ====================

  describe('fallback 上报', () => {
    it('配置 fallbackEndpoint 后应包含 fallback 逻辑', () => {
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: 'https://example.com/api/logs',
      });
      expect(script).toContain('FALLBACK_ENDPOINT');
      expect(script).toContain('"https://example.com/api/logs"');
      expect(script).toContain('doFallback');
    });

    it('自定义 fallbackTimeout', () => {
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: '/api/logs',
        fallbackTimeout: 5000,
      });
      expect(script).toContain('var FALLBACK_TIMEOUT = 5000');
    });

    it('默认 fallbackTimeout 应为 30000', () => {
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: '/api/logs',
      });
      expect(script).toContain('var FALLBACK_TIMEOUT = 30000');
    });

    it('fallback 应使用 Blob 发送 sendBeacon', () => {
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: '/api/logs',
        fallbackTransport: 'auto',
      });
      expect(script).toContain("new Blob([payloadStr], { type: 'application/json' })");
    });

    it('fallback 默认 payload 应包含 deviceInfo', () => {
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: '/api/logs',
      });
      expect(script).toContain('device: deviceInfo');
      expect(script).toContain("type: 'early-error-fallback'");
    });

    it('fallback 发送后应标记 __LOGGER_INITIALIZED__', () => {
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: '/api/logs',
      });
      // doFallback 函数内部应设置 __LOGGER_INITIALIZED__ = true
      expect(script).toMatch(/function doFallback[\s\S]*?__LOGGER_INITIALIZED__ = true/);
    });

    it('XHR 失败时应在 onerror 内告警（best-effort 语义，不再写回 __EARLY_ERRORS__）', () => {
      // 旧实现：xhr.onerror 把 errors 写回 __EARLY_ERRORS__——但
      // (1) `errors` 是 doFallback 局部变量，sendPayload 作用域里访问会 ReferenceError；
      // (2) 即便变量正确，__LOGGER_INITIALIZED__ 已为 true 没人再消费，等于静默丢日志。
      // 现在的契约：fallback = best-effort 一次性 send，失败仅 console.warn。
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: '/api/logs',
        fallbackTransport: 'xhr',
      });
      expect(script).toContain('xhr.onerror');
      expect(script).not.toContain('errors.concat(window.__EARLY_ERRORS__)');
      expect(script).toContain('Fallback XHR failed');
    });
  });

  // ==================== fallbackTransport ====================

  describe('fallbackTransport', () => {
    it("transport='xhr' 不应包含 sendBeacon 调用", () => {
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: '/api/logs',
        fallbackTransport: 'xhr',
      });
      expect(script).toContain('"xhr"');
      expect(script).toContain('XMLHttpRequest');
    });

    it("transport='beacon' 应使用 sendBeacon", () => {
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: '/api/logs',
        fallbackTransport: 'beacon',
      });
      expect(script).toContain('"beacon"');
      expect(script).toContain('sendBeacon');
    });

    it("transport='auto' 应同时包含 sendBeacon 和 XHR", () => {
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: '/api/logs',
        fallbackTransport: 'auto',
      });
      expect(script).toContain('"auto"');
      expect(script).toContain('sendBeacon');
      expect(script).toContain('XMLHttpRequest');
    });

    it('配置 headers 时默认 transport 应自动切换为 xhr', () => {
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: '/api/logs',
        fallbackHeaders: { 'X-Token': 'abc' },
      });
      // 有 headers 但未指定 transport，应自动用 xhr
      expect(script).toContain('"xhr"');
    });
  });

  // ==================== fallbackHeaders ====================

  describe('fallbackHeaders', () => {
    it('应将自定义 headers 序列化到脚本中', () => {
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: '/api/logs',
        fallbackTransport: 'xhr',
        fallbackHeaders: {
          'X-App-Name': 'my-app',
          'X-Log-Source': 'early-error',
        },
      });
      expect(script).toContain('"X-App-Name"');
      expect(script).toContain('"my-app"');
      expect(script).toContain('"X-Log-Source"');
      expect(script).toContain('"early-error"');
    });

    it('无 headers 时 FALLBACK_HEADERS 应为 null', () => {
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: '/api/logs',
      });
      expect(script).toContain('var FALLBACK_HEADERS = null');
    });

    it('XHR 应默认设置 Content-Type', () => {
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: '/api/logs',
        fallbackTransport: 'xhr',
      });
      expect(script).toContain("'Content-Type': 'application/json'");
    });
  });

  // ==================== formatPayload ====================

  describe('formatPayload', () => {
    it('应将 formatPayload 函数序列化到脚本中', () => {
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: '/api/logs',
        formatPayload: function (errors, meta) {
          return errors.map(function (e: any) {
            return { msg: e.message, ua: (meta as any).ua };
          });
        },
      });
      expect(script).toContain('formatPayload');
      expect(script).toContain('errors.map');
    });

    it('无 formatPayload 时 formatPayload 变量应为 null', () => {
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: '/api/logs',
      });
      expect(script).toContain('var formatPayload = null');
    });

    it('formatPayload 返回数组时应逐条发送（携带 errors 闭包）', () => {
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: '/api/logs',
        formatPayload: function (errors) { return errors; },
      });
      expect(script).toContain('Array.isArray(result)');
      // 升级回归（Bug 4）：sendPayload 必须接收第二个参数 errorsBatch，
      // 否则 xhr.onerror 内部访问 errors 会触发 ReferenceError。
      expect(script).toMatch(/sendPayload\(result\[i\],\s*errors\[i\]/);
    });

    it('formatPayload 抛错时应回退到默认格式', () => {
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: '/api/logs',
        formatPayload: function () { throw new Error('test'); },
      });
      expect(script).toContain('formatPayload error, using default format');
      expect(script).toContain("type: 'early-error-fallback'");
    });
  });

  // ==================== 升级回归保护 ====================

  describe('升级回归（v2.2.0-beta.1 early-handoff bug）', () => {
    it('Bug 4: sendPayload 签名必须是 (data, errorsBatch)，xhr.onerror 不再引用顶层 errors', () => {
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: '/api/logs',
        fallbackTransport: 'xhr',
      });
      // sendPayload 必须接收两个参数
      expect(script).toMatch(/function\s+sendPayload\s*\(\s*data\s*,\s*errorsBatch\s*\)/);
      // xhr.onerror 不能再写 `errors.concat(window.__EARLY_ERRORS__)`
      // （旧实现：var __EARLY_ERRORS__ = errors.concat(...) → ReferenceError）
      expect(script).not.toMatch(/onerror\s*=\s*function[^{]*\{[^}]*errors\.concat/);
    });

    it('Bug 5: doFallback catch 分支不再 reassign __EARLY_ERRORS__（重传死路）', () => {
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: '/api/logs',
      });
      // 旧实现：catch (e) { window.__EARLY_ERRORS__ = errors.concat(window.__EARLY_ERRORS__); ... }
      // 这条重新入栈在翻牌后无人消费，等于静默丢失，已删除。
      expect(script).not.toMatch(/catch\s*\([^)]+\)\s*\{[^}]*__EARLY_ERRORS__\s*=\s*errors\.concat/);
    });

    it('Bug 5: 失败路径以 console.warn 告警（明确 best-effort 语义，不制造重传幻觉）', () => {
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: '/api/logs',
        fallbackTransport: 'xhr',
      });
      expect(script).toContain('Fallback XHR failed');
      expect(script).toContain('early errors are lost');
    });
  });

  // ==================== 运行时集成测试（在 jsdom 中执行生成脚本） ====================

  describe('运行时集成（在 jsdom 中执行生成脚本）', () => {
    const cleanupGlobals = () => {
      delete (window as any).__EARLY_ERRORS__;
      delete (window as any).__LOGGER_INITIALIZED__;
      delete (window as any).__flushEarlyErrors__;
      delete (window as any).__EARLY_ERROR_CAPTURE_LOADED__;
    };

    beforeEach(() => {
      vi.useFakeTimers();
      cleanupGlobals();
    });

    afterEach(() => {
      cleanupGlobals();
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    /**
     * 升级回归（Bug 4 真·运行时验证）：
     * 旧实现 xhr.onerror 触发时 throw `ReferenceError: errors is not defined`，
     * 直接断送 fallback 通道。本测试用 mock XHR 强制触发 onerror，
     * 验证修复后 onerror 仅产生 console.warn，不抛任何异常。
     */
    it('Bug 4: doFallback 触发 + xhr.onerror 触发，不应抛 ReferenceError', () => {
      let capturedXhr: any = null;

      class MockXHR {
        public onerror: ((this: any, ev: any) => any) | null = null;
        public onload: (() => void) | null = null;
        open() {}
        setRequestHeader() {}
        send() {
          capturedXhr = this;
        }
      }
      const origXHR = (window as any).XMLHttpRequest;
      (window as any).XMLHttpRequest = MockXHR as any;
      // 同时屏蔽 sendBeacon，确保走 XHR 分支
      const origSendBeacon = (navigator as any).sendBeacon;
      (navigator as any).sendBeacon = undefined;

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const script = getEarlyErrorCaptureScript({
          fallbackEndpoint: '/api/logs',
          fallbackTimeout: 100,
          fallbackTransport: 'xhr',
          checkCompatibility: false,
          autoRefreshOnChunkError: false,
        });

        // 在当前 window 上执行 IIFE 脚本（模拟浏览器加载内联脚本）
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        new Function(script)();

        // 制造一条早期错误并推进时间到 fallback 触发点
        (window as any).__EARLY_ERRORS__.push({
          type: 'unhandledrejection',
          message: 'test',
          stack: null,
          timestamp: Date.now(),
          device: {},
        });
        vi.advanceTimersByTime(150);

        // 验证 doFallback 已经发起 XHR
        expect(capturedXhr).not.toBeNull();
        expect(typeof capturedXhr.onerror).toBe('function');

        // 关键断言：手动触发 onerror，不应抛 ReferenceError
        expect(() => capturedXhr.onerror()).not.toThrow();

        // 应仅产生 warn（不再 reassign __EARLY_ERRORS__）
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Fallback XHR failed'),
        );
      } finally {
        (window as any).XMLHttpRequest = origXHR;
        (navigator as any).sendBeacon = origSendBeacon;
      }
    });

    /**
     * 升级回归（健康路径 P0）：
     * 主 Logger 启动后调一次 `__flushEarlyErrors__(() => {})`
     * 应当：
     *   1. 把 `__LOGGER_INITIALIZED__` 翻为 true
     *   2. 清掉 fallback 定时器（即使后续推进 timeout 也不会调用 XHR）
     */
    it('Bug 1+2: __flushEarlyErrors__ 调用后 fallback 定时器必须被清除', () => {
      let xhrCalled = false;
      class MockXHR {
        onerror: any = null;
        open() {}
        setRequestHeader() {}
        send() {
          xhrCalled = true;
        }
      }
      const origXHR = (window as any).XMLHttpRequest;
      (window as any).XMLHttpRequest = MockXHR as any;
      const origSendBeacon = (navigator as any).sendBeacon;
      (navigator as any).sendBeacon = undefined;

      try {
        const script = getEarlyErrorCaptureScript({
          fallbackEndpoint: '/api/logs',
          fallbackTimeout: 100,
          fallbackTransport: 'xhr',
          checkCompatibility: false,
          autoRefreshOnChunkError: false,
        });
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        new Function(script)();

        // 模拟健康加载：业务期间产生一条 promise rejection
        (window as any).__EARLY_ERRORS__.push({
          type: 'unhandledrejection',
          message: 'test',
          stack: null,
          timestamp: Date.now(),
          device: {},
        });

        // 模拟 EarlyErrorCapturePlugin.flushEarlyErrors() 的修复后行为：
        // 无条件 flush（即使 callback 不做任何事）
        const errorsHandedOff: any[] = [];
        (window as any).__flushEarlyErrors__((errs: any[]) => {
          errorsHandedOff.push(...errs);
        });

        expect((window as any).__LOGGER_INITIALIZED__).toBe(true);
        expect(errorsHandedOff).toHaveLength(1);

        // 推进时间超过 fallbackTimeout：定时器应已被清除，不应触发 XHR
        vi.advanceTimersByTime(500);
        expect(xhrCalled).toBe(false);
      } finally {
        (window as any).XMLHttpRequest = origXHR;
        (navigator as any).sendBeacon = origSendBeacon;
      }
    });
  });

  // ==================== 向后兼容: generateEarlyErrorScript ====================

  describe('向后兼容: generateEarlyErrorScript', () => {
    it('应标记为 deprecated 但仍然可用', async () => {
      const { generateEarlyErrorScript } = await import(
        '../src/plugins/EarlyErrorCapturePlugin'
      );
      const script = generateEarlyErrorScript({
        enabled: true,
        maxErrors: 50,
        fallbackEndpoint: '/api/logs',
        fallbackTimeout: 30000,
        autoRefreshOnChunkError: true,
        checkCompatibility: true,
        fallbackTransport: 'auto',
        routeMatch: undefined as any,
        fallbackHeaders: {},
        formatPayload: (errors) => errors,
      });
      expect(script).toContain('FALLBACK_ENDPOINT');
      expect(script).toContain('__EARLY_ERRORS__');
    });
  });
});
