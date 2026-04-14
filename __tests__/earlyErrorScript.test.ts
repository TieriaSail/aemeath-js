/**
 * early-error-script 共享脚本测试
 */
import { describe, it, expect } from 'vitest';
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

    it('XHR 失败时应将错误写回 __EARLY_ERRORS__', () => {
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: '/api/logs',
        fallbackTransport: 'xhr',
      });
      expect(script).toContain('xhr.onerror');
      expect(script).toContain('errors.concat(window.__EARLY_ERRORS__)');
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

    it('formatPayload 返回数组时应逐条发送', () => {
      const script = getEarlyErrorCaptureScript({
        fallbackEndpoint: '/api/logs',
        formatPayload: function (errors) { return errors; },
      });
      expect(script).toContain('Array.isArray(result)');
      expect(script).toContain('sendPayload(result[i])');
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
      });
      expect(script).toContain('FALLBACK_ENDPOINT');
      expect(script).toContain('__EARLY_ERRORS__');
    });
  });
});
