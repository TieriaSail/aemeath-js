/**
 * EarlyErrorCapturePlugin 早期错误捕获插件测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EarlyErrorCapturePlugin } from '../src/plugins/EarlyErrorCapturePlugin';
import { AemeathLogger } from '../src/core/Logger';

describe('EarlyErrorCapturePlugin', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = new AemeathLogger({ enableConsole: false });
    // 清理全局状态
    delete (window as any).__EARLY_ERRORS__;
    delete (window as any).__flushEarlyErrors__;
    delete (window as any).__LOGGER_INITIALIZED__;
  });

  afterEach(() => {
    logger.destroy();
    delete (window as any).__EARLY_ERRORS__;
    delete (window as any).__flushEarlyErrors__;
    delete (window as any).__LOGGER_INITIALIZED__;
    vi.useRealTimers();
  });

  // ==================== 安装与卸载 ====================

  describe('安装与卸载', () => {
    it('应正确安装', () => {
      const plugin = new EarlyErrorCapturePlugin();
      logger.use(plugin);
      expect(logger.hasPlugin('EarlyErrorCapture')).toBe(true);
    });

    it('卸载后不应有插件', () => {
      const plugin = new EarlyErrorCapturePlugin();
      logger.use(plugin);
      logger.uninstall('EarlyErrorCapture');
      expect(logger.hasPlugin('EarlyErrorCapture')).toBe(false);
    });

    it('enabled=false 时不应刷新错误', () => {
      const mockFlush = vi.fn();
      (window as any).__flushEarlyErrors__ = mockFlush;
      (window as any).__EARLY_ERRORS__ = [];

      const plugin = new EarlyErrorCapturePlugin({ enabled: false });
      logger.use(plugin);

      expect(mockFlush).not.toHaveBeenCalled();
    });
  });

  // ==================== 刷新早期错误 ====================

  describe('刷新早期错误', () => {
    it('应调用 __flushEarlyErrors__ 获取早期错误', () => {
      const earlyErrors = [
        {
          type: 'error' as const,
          message: 'Script error',
          stack: 'Error at app.js:1:1',
          filename: 'app.js',
          lineno: 1,
          colno: 1,
          timestamp: Date.now(),
          device: {
            ua: 'test',
            lang: 'zh-CN',
            screen: '1920x1080',
            url: 'http://localhost',
            time: Date.now(),
          },
        },
      ];

      (window as any).__flushEarlyErrors__ = vi.fn((cb: Function) => {
        cb(earlyErrors);
      });
      (window as any).__EARLY_ERRORS__ = earlyErrors;

      const logListener = vi.fn();
      logger.on('log', logListener);

      const plugin = new EarlyErrorCapturePlugin();
      logger.use(plugin);

      expect(logListener).toHaveBeenCalledTimes(1);
      const entry = logListener.mock.calls[0][0];
      expect(entry.level).toBe('error');
      expect(entry.message).toContain('Early error error');
    });

    it('多个早期错误应全部记录', () => {
      const earlyErrors = [
        {
          type: 'error' as const,
          message: 'Error 1',
          stack: null,
          timestamp: Date.now(),
          device: { ua: '', lang: '', screen: '', url: '', time: 0 },
        },
        {
          type: 'unhandledrejection' as const,
          message: 'Promise Error',
          stack: null,
          timestamp: Date.now(),
          device: { ua: '', lang: '', screen: '', url: '', time: 0 },
        },
        {
          type: 'resource' as const,
          message: 'Resource failed',
          stack: null,
          source: 'style.css',
          timestamp: Date.now(),
          device: { ua: '', lang: '', screen: '', url: '', time: 0 },
        },
      ];

      (window as any).__flushEarlyErrors__ = vi.fn((cb: Function) => {
        cb(earlyErrors);
      });
      (window as any).__EARLY_ERRORS__ = earlyErrors;

      const logListener = vi.fn();
      logger.on('log', logListener);

      const plugin = new EarlyErrorCapturePlugin();
      logger.use(plugin);

      expect(logListener).toHaveBeenCalledTimes(3);
    });

    it('空错误数组不应记录日志', () => {
      (window as any).__flushEarlyErrors__ = vi.fn((cb: Function) => {
        cb([]);
      });
      (window as any).__EARLY_ERRORS__ = [];

      const logListener = vi.fn();
      logger.on('log', logListener);

      const plugin = new EarlyErrorCapturePlugin();
      logger.use(plugin);

      expect(logListener).not.toHaveBeenCalled();
    });

    it('没有 __flushEarlyErrors__ 时应发出警告', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const plugin = new EarlyErrorCapturePlugin();
      logger.use(plugin);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Early error capture script not found'),
      );

      warnSpy.mockRestore();
    });
  });

  // ==================== 路由匹配 ====================

  describe('路由匹配', () => {
    it('excludeRoutes 匹配当前路由时不应刷新错误', () => {
      (window as any).location = { pathname: '/debug' };

      const mockFlush = vi.fn();
      (window as any).__flushEarlyErrors__ = mockFlush;
      (window as any).__EARLY_ERRORS__ = [
        {
          type: 'error' as const,
          message: 'test',
          stack: null,
          timestamp: Date.now(),
          device: { ua: '', lang: '', screen: '', url: '', time: 0 },
        },
      ];

      const logListener = vi.fn();
      logger.on('log', logListener);

      const plugin = new EarlyErrorCapturePlugin({
        routeMatch: { excludeRoutes: ['/debug'] },
      });
      logger.use(plugin);

      // flushFn 会被调用（清空但不上报），但 logListener 不应被调用
      expect(logListener).not.toHaveBeenCalled();

      // 恢复
      (window as any).location = { pathname: '/' };
    });

    it('includeRoutes 不匹配当前路由时不应刷新错误', () => {
      (window as any).location = { pathname: '/other' };

      const mockFlush = vi.fn();
      (window as any).__flushEarlyErrors__ = mockFlush;
      (window as any).__EARLY_ERRORS__ = [];

      const logListener = vi.fn();
      logger.on('log', logListener);

      const plugin = new EarlyErrorCapturePlugin({
        routeMatch: { includeRoutes: ['/home'] },
      });
      logger.use(plugin);

      expect(logListener).not.toHaveBeenCalled();

      // 恢复
      (window as any).location = { pathname: '/' };
    });
  });

  // ==================== getConfig ====================

  describe('getConfig', () => {
    it('应返回配置副本', () => {
      const plugin = new EarlyErrorCapturePlugin({
        maxErrors: 20,
        fallbackEndpoint: '/api/fallback',
      });

      const config = plugin.getConfig();
      expect(config.maxErrors).toBe(20);
      expect(config.fallbackEndpoint).toBe('/api/fallback');
    });

    it('默认配置应正确', () => {
      const plugin = new EarlyErrorCapturePlugin();
      const config = plugin.getConfig();

      expect(config.enabled).toBe(true);
      expect(config.maxErrors).toBe(50);
      expect(config.autoRefreshOnChunkError).toBe(true);
      expect(config.checkCompatibility).toBe(true);
    });

    it('新增配置项应有正确默认值', () => {
      const plugin = new EarlyErrorCapturePlugin();
      const config = plugin.getConfig();

      expect(config.fallbackTransport).toBe('auto');
      expect(config.fallbackHeaders).toBeUndefined();
      expect(config.formatPayload).toBeUndefined();
    });

    it('应正确存储新增配置项', () => {
      const formatFn = (errors: unknown[]) => errors;
      const plugin = new EarlyErrorCapturePlugin({
        fallbackTransport: 'xhr',
        fallbackHeaders: { 'X-Token': 'abc' },
        formatPayload: formatFn,
      });

      const config = plugin.getConfig();
      expect(config.fallbackTransport).toBe('xhr');
      expect(config.fallbackHeaders).toEqual({ 'X-Token': 'abc' });
      expect(config.formatPayload).toBe(formatFn);
    });
  });
});

