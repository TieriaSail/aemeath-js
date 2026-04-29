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

    it('formatPayload 返回数组时应逐条发送（携带 maxLost 上界）', () => {
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: '/api/logs',
        formatPayload: function (errors) { return errors; },
      });
      expect(script).toContain('Array.isArray(result)');
      // 升级回归（Bug 4 + Bug B）：sendPayload 必须接收第二个参数（告警计数上界），
      // 否则 xhr.onerror 内部访问 errors 会触发 ReferenceError；计数必须用 maxLost
      // （= errors.length 整批上界）而非 errors[i]，否则 batch 写法少报丢失数量。
      expect(script).toMatch(/sendPayload\(result\[i\],\s*maxLost\)/);
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
    it('Bug 4: sendPayload 签名必须接收第二个参数（告警计数），xhr.onerror 不再引用顶层 errors', () => {
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: '/api/logs',
        fallbackTransport: 'xhr',
      });
      // sendPayload 必须接收两个参数（参数名为 maxLostCount，避免 batch 写法少报丢失）
      expect(script).toMatch(/function\s+sendPayload\s*\(\s*data\s*,\s*maxLostCount\s*\)/);
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
      // 升级回归（Bug B）：告警措辞改为 "up to N early errors may be lost"，
      // 避免在 batch formatPayload 写法下少报丢失数量
      expect(script).toContain('up to');
      expect(script).toContain('early errors may be lost');
    });

    it('Bug B: 所有 sendPayload 调用必须用同一个 maxLost（doFallback 中 errors.length），不能用 errors[i]', () => {
      // 旧实现：sendPayload(result[i], errors[i] ? [errors[i]] : []) → 在 batch 写法下
      // 单条 send 失败只报告 1 条丢失，但实际可能 N 条都在这条 batch 里 → 严重少报。
      // 新实现：sendPayload(result[i], maxLost) → maxLost 是 errors 总数，永远是上界。
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: '/api/logs',
        formatPayload: function (errors) { return errors; },
      });
      expect(script).not.toMatch(/sendPayload\(result\[i\],\s*errors\[i\]\s*\?/);
      expect(script).toMatch(/var\s+maxLost\s*=\s*errors\.length/);
      expect(script).toMatch(/sendPayload\(result\[i\],\s*maxLost\)/);
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

    /**
     * 升级回归（Bug B 真·运行时验证）：
     * 当 formatPayload 返回数组（典型 batch 写法 [{ batch: errors }]）时，
     * 哪怕只有 1 条 payload，xhr.onerror 触发的告警也必须报告**整个 fallback 周期**
     * 的 errors 总数（上界），而非 errors[i] 的精确数量。否则 N 条丢失只报 1 条 →
     * 用户严重低估影响。
     */
    it('Bug B: batch formatPayload + xhr.onerror 必须报告 errors 总数（上界），不能少报', () => {
      let capturedXhr: any = null;
      class MockXHR {
        onerror: any = null;
        open() {}
        setRequestHeader() {}
        send() {
          capturedXhr = this;
        }
      }
      const origXHR = (window as any).XMLHttpRequest;
      (window as any).XMLHttpRequest = MockXHR as any;
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
          // 模拟 batch 写法：1 条 payload 包含全部 errors
          formatPayload: function (errors: any[]) {
            return [{ batch: errors }];
          },
        });
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        new Function(script)();

        // 推 3 条早期错误（doFallback 周期）
        for (let i = 0; i < 3; i++) {
          (window as any).__EARLY_ERRORS__.push({
            type: 'error',
            message: 'err' + i,
            stack: null,
            timestamp: Date.now(),
            device: {},
          });
        }
        vi.advanceTimersByTime(150);

        expect(capturedXhr).not.toBeNull();
        capturedXhr.onerror();

        const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
        const xhrFailedCall = warnCalls.find((s) => s.includes('Fallback XHR failed'));
        expect(xhrFailedCall).toBeDefined();
        // 关键断言：告警必须含 "up to 3"，不能是 "up to 1"（旧 bug 的少报）
        expect(xhrFailedCall).toContain('up to 3');
        expect(xhrFailedCall).toContain('may be lost');
      } finally {
        (window as any).XMLHttpRequest = origXHR;
        (navigator as any).sendBeacon = origSendBeacon;
      }
    });

    /**
     * 升级回归（R13.4 真·运行时验证）：
     * FALLBACK_TRANSPORT === 'beacon' 强制模式下，如果运行环境不支持 navigator.sendBeacon，
     * 必须 graceful detect 并明确告警，而不是依赖外层 try/catch 兜底。
     */
    it('R13.4: beacon 强制但环境不支持时必须 graceful 告警，不能 fall through xhr', () => {
      const origSendBeacon = (navigator as any).sendBeacon;
      // 模拟环境不支持 sendBeacon
      (navigator as any).sendBeacon = undefined;
      const xhrCalls: any[] = [];
      const origXHR = (window as any).XMLHttpRequest;
      class MockXHR {
        open() { xhrCalls.push('open'); }
        setRequestHeader() {}
        send() { xhrCalls.push('send'); }
      }
      (window as any).XMLHttpRequest = MockXHR;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const script = getEarlyErrorCaptureScript({
          fallbackEndpoint: '/api/logs',
          fallbackTimeout: 100,
          fallbackTransport: 'beacon',
          checkCompatibility: false,
          autoRefreshOnChunkError: false,
        });
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        new Function(script)();

        (window as any).__EARLY_ERRORS__.push({
          type: 'error', message: 'no-beacon-env', stack: null,
          timestamp: Date.now(), device: {},
        });
        vi.advanceTimersByTime(150);

        // 关键断言 1：xhr 必须**未被调用**（beacon 强制下不应 fall through）
        expect(xhrCalls).toHaveLength(0);
        // 关键断言 2：必须有「unavailable」告警
        const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
        const unavailableCall = warnCalls.find((s) => s.includes('beacon unavailable'));
        expect(unavailableCall).toBeDefined();
        expect(unavailableCall).toContain('up to 1');
      } finally {
        (navigator as any).sendBeacon = origSendBeacon;
        (window as any).XMLHttpRequest = origXHR;
      }
    });

    /**
     * 升级回归（Bug G 真·运行时验证）：
     * autoRefreshOnChunkError 触发 location.reload() 后，整个 window.__EARLY_ERRORS__
     * 被销毁。即使配了 fallbackEndpoint，30s fallback timer 来不及开火 →
     * chunk error 永远丢失。修复后必须在 reload 前同步调 doFallback() 用 sendBeacon
     * （或 xhr）立即推送 buffer。
     */
    it('Bug G: chunk error reload 前必须主动 fallback 一次，避免 reload 后 buffer 丢失', () => {
      const sendBeaconCalls: Array<{ size: number }> = [];
      const origSendBeacon = (navigator as any).sendBeacon;
      (navigator as any).sendBeacon = (_url: string, blob: Blob) => {
        sendBeaconCalls.push({ size: blob.size });
        return true;
      };
      // mock sessionStorage
      const sessionStore: Record<string, string> = {};
      (window as any).sessionStorage = {
        getItem: (k: string) => sessionStore[k] ?? null,
        setItem: (k: string, v: string) => { sessionStore[k] = v; },
        removeItem: (k: string) => { delete sessionStore[k]; },
      };
      // mock location.reload
      const reloadSpy = vi.fn();
      const origLocation = window.location;
      try {
        Object.defineProperty(window, 'location', {
          value: { ...origLocation, reload: reloadSpy, href: 'http://t/' },
          configurable: true,
          writable: true,
        });
      } catch {
        (window as any).location = { ...origLocation, reload: reloadSpy, href: 'http://t/' };
      }

      try {
        const script = getEarlyErrorCaptureScript({
          fallbackEndpoint: '/api/logs',
          fallbackTimeout: 30000, // 远大于 reload 100ms
          fallbackTransport: 'beacon',
          autoRefreshOnChunkError: true,
          checkCompatibility: false,
        });
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        new Function(script)();

        // 模拟 chunk script error
        const fakeScript = document.createElement('script');
        Object.defineProperty(fakeScript, 'src', {
          value: 'http://t/static/js/chunk-abc.js',
          configurable: true,
        });
        document.body.appendChild(fakeScript);

        const event = new Event('error', { bubbles: true });
        Object.defineProperty(event, 'target', { value: fakeScript, configurable: true });
        window.dispatchEvent(event);

        // 关键断言 1：sendBeacon 必须在 reload 触发前被调过（即 doFallback 已同步执行）
        expect(sendBeaconCalls.length).toBeGreaterThanOrEqual(1);
        // 关键断言 2：buffer 被 doFallback 清空
        expect((window as any).__EARLY_ERRORS__).toHaveLength(0);
        // 关键断言 3：__LOGGER_INITIALIZED__ 翻为 true（doFallback 内部行为）
        expect((window as any).__LOGGER_INITIALIZED__).toBe(true);

        // 100ms 后 reload 才会触发
        vi.advanceTimersByTime(150);
        expect(reloadSpy).toHaveBeenCalled();
      } finally {
        (navigator as any).sendBeacon = origSendBeacon;
        try {
          Object.defineProperty(window, 'location', {
            value: origLocation, configurable: true, writable: true,
          });
        } catch {
          (window as any).location = origLocation;
        }
      }
    });

    /**
     * 升级回归（Bug F 真·运行时验证）：
     * micro-frontend 多 host 注入场景下，第二次注入必须**幂等退出**，不能：
     *   1. 重置 __EARLY_ERRORS__（丢失第一份脚本已收集的所有错误）
     *   2. 覆盖 __flushEarlyErrors__（让主 Logger 错过早期错误）
     *   3. 启动第二个 fallback timer（造成双轨上报）
     */
    it('Bug F: 第二次注入必须幂等退出，保留全部既有状态', () => {
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: '/api/logs',
        fallbackTimeout: 1000,
        fallbackTransport: 'xhr',
        checkCompatibility: false,
        autoRefreshOnChunkError: false,
      });
      // 第一次注入
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new Function(script)();

      // 模拟第一份脚本已收集的早期错误
      (window as any).__EARLY_ERRORS__.push({
        type: 'error',
        message: 'first-script-error',
        stack: null,
        timestamp: Date.now(),
        device: {},
      });
      const firstFlush = (window as any).__flushEarlyErrors__;
      expect(typeof firstFlush).toBe('function');
      expect((window as any).__EARLY_ERROR_CAPTURE_LOADED__).toBe(true);

      // 第二次注入（micro-frontend 中第二个子应用）
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new Function(script)();

      // 关键断言 1：第一份脚本收集的错误必须保留
      expect((window as any).__EARLY_ERRORS__).toHaveLength(1);
      expect((window as any).__EARLY_ERRORS__[0].message).toBe('first-script-error');

      // 关键断言 2：__flushEarlyErrors__ 必须是第一份脚本的引用，未被覆盖
      expect((window as any).__flushEarlyErrors__).toBe(firstFlush);

      // 关键断言 3：__LOGGER_INITIALIZED__ 仍为 false（第一份脚本初值），未被重置
      expect((window as any).__LOGGER_INITIALIZED__).toBe(false);
    });

    /**
     * 升级回归（Bug F 进阶）：第二次注入发生时，主 Logger 已经接管了第一份脚本，
     * __LOGGER_INITIALIZED__ === true。第二次注入也必须幂等退出，不能把它重置为 false。
     */
    it('Bug F: 第二次注入时 __LOGGER_INITIALIZED__ === true 不应被重置为 false', () => {
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: '/api/logs',
        fallbackTimeout: 1000,
        fallbackTransport: 'xhr',
        checkCompatibility: false,
        autoRefreshOnChunkError: false,
      });
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new Function(script)();
      // 模拟主 Logger 接管：调 __flushEarlyErrors__
      (window as any).__flushEarlyErrors__(() => {});
      expect((window as any).__LOGGER_INITIALIZED__).toBe(true);

      // 第二次注入
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new Function(script)();
      // 必须保持 true，否则后续若有错误会被早期脚本误捕获
      expect((window as any).__LOGGER_INITIALIZED__).toBe(true);
    });

    /**
     * 升级回归（Bug B beacon 路径真·运行时验证）：
     * fallback 默认走 'auto' 即「优先 sendBeacon → 失败回 XHR」。如果 beacon 失败
     * 且 transport='beacon'（强制）的告警上界也必须用 maxLost，不能少报。
     */
    it('Bug B (beacon): beacon 失败时也必须用 maxLost 报告，不能少报', () => {
      const sendBeaconCalls: Array<{ payload: string; size: number }> = [];
      const origSendBeacon = (navigator as any).sendBeacon;
      // 强制 sendBeacon 返回 false 触发 fallback warn 路径
      (navigator as any).sendBeacon = (_url: string, blob: Blob) => {
        sendBeaconCalls.push({ payload: '', size: blob.size });
        return false;
      };
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const script = getEarlyErrorCaptureScript({
          fallbackEndpoint: '/api/logs',
          fallbackTimeout: 100,
          fallbackTransport: 'beacon',
          checkCompatibility: false,
          autoRefreshOnChunkError: false,
          formatPayload: function (errors: any[]) {
            return [{ batch: errors }];
          },
        });
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        new Function(script)();

        for (let i = 0; i < 4; i++) {
          (window as any).__EARLY_ERRORS__.push({
            type: 'error',
            message: 'beacon-err' + i,
            stack: null,
            timestamp: Date.now(),
            device: {},
          });
        }
        vi.advanceTimersByTime(150);

        expect(sendBeaconCalls).toHaveLength(1);

        const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
        const beaconFailedCall = warnCalls.find((s) => s.includes('Fallback beacon failed'));
        expect(beaconFailedCall).toBeDefined();
        // 关键断言：必须含 "up to 4"，不能是 "up to 1"
        expect(beaconFailedCall).toContain('up to 4');
        expect(beaconFailedCall).toContain('may be lost');
      } finally {
        (navigator as any).sendBeacon = origSendBeacon;
      }
    });

    /**
     * 升级回归（Bug 5 真·运行时验证）：
     * xhr.onerror 触发后**禁止**把 errors 写回 __EARLY_ERRORS__（重传死路）。
     * __LOGGER_INITIALIZED__ 已为 true，写回去也没人取，只是制造重传幻觉。
     */
    it('Bug 5: xhr.onerror 触发后 __EARLY_ERRORS__ 必须保持为空，不应重新入栈', () => {
      let capturedXhr: any = null;
      class MockXHR {
        onerror: any = null;
        open() {}
        setRequestHeader() {}
        send() {
          capturedXhr = this;
        }
      }
      const origXHR = (window as any).XMLHttpRequest;
      (window as any).XMLHttpRequest = MockXHR as any;
      const origSendBeacon = (navigator as any).sendBeacon;
      (navigator as any).sendBeacon = undefined;

      vi.spyOn(console, 'warn').mockImplementation(() => {});

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

        for (let i = 0; i < 2; i++) {
          (window as any).__EARLY_ERRORS__.push({
            type: 'error',
            message: 'e' + i,
            stack: null,
            timestamp: Date.now(),
            device: {},
          });
        }
        vi.advanceTimersByTime(150);

        // doFallback 已 splice 了 __EARLY_ERRORS__ → []
        expect((window as any).__EARLY_ERRORS__).toHaveLength(0);

        capturedXhr.onerror();

        // Bug 5 关键断言：xhr.onerror 后仍然为空（绝不重新写入「重传死路」）
        expect((window as any).__EARLY_ERRORS__).toHaveLength(0);
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
