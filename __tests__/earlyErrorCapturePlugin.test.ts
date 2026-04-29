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

    it('空错误数组不应记录日志，但 flush 必须被调用以翻 __LOGGER_INITIALIZED__', () => {
      // 升级回归保护（v2.2.0-beta.1 early-handoff bug）：
      // 即使没有累计早期错误，flush() 也必须被调用——否则 __LOGGER_INITIALIZED__
      // 永远不会被翻为 true，早期脚本继续在背景活着、fallback 定时器到点重复上报。
      const flushFn = vi.fn((cb: Function) => {
        (window as any).__LOGGER_INITIALIZED__ = true;
        cb([]);
      });
      (window as any).__flushEarlyErrors__ = flushFn;
      (window as any).__EARLY_ERRORS__ = [];

      const logListener = vi.fn();
      logger.on('log', logListener);

      const plugin = new EarlyErrorCapturePlugin();
      logger.use(plugin);

      expect(flushFn).toHaveBeenCalledTimes(1);
      expect((window as any).__LOGGER_INITIALIZED__).toBe(true);
      expect(logListener).not.toHaveBeenCalled();
    });

    it('健康加载（脚本注入但无早期错误）也必须翻 __LOGGER_INITIALIZED__（升级回归 P0）', () => {
      // Bug 1+2 的核心：绝大多数页面都是这条路径。
      const flushFn = vi.fn((cb: Function) => {
        (window as any).__LOGGER_INITIALIZED__ = true;
        cb([]);
      });
      (window as any).__flushEarlyErrors__ = flushFn;
      (window as any).__EARLY_ERRORS__ = [];

      const plugin = new EarlyErrorCapturePlugin();
      logger.use(plugin);

      expect(flushFn).toHaveBeenCalledTimes(1);
      expect((window as any).__LOGGER_INITIALIZED__).toBe(true);
    });

    it('没有 __flushEarlyErrors__ 时应静默跳过（脚本未注入）', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const logListener = vi.fn();
      logger.on('log', logListener);

      const plugin = new EarlyErrorCapturePlugin();
      logger.use(plugin);

      expect(warnSpy).not.toHaveBeenCalled();
      expect(logListener).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  // ==================== 路由匹配 ====================

  describe('路由匹配', () => {
    it('excludeRoutes 匹配当前路由时不应记录日志，但 flush 仍必须被调用', () => {
      // 升级回归：路由不匹配也要 flush（翻牌 + 清 timer），只是不上报错误。
      (window as any).location = { pathname: '/debug' };

      const mockFlush = vi.fn((cb: Function) => {
        (window as any).__LOGGER_INITIALIZED__ = true;
        cb([
          {
            type: 'error',
            message: 'test',
            stack: null,
            timestamp: Date.now(),
            device: { ua: '', lang: '', screen: '', url: '', time: 0 },
          },
        ]);
      });
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

      expect(mockFlush).toHaveBeenCalledTimes(1);
      expect((window as any).__LOGGER_INITIALIZED__).toBe(true);
      expect(logListener).not.toHaveBeenCalled();

      (window as any).location = { pathname: '/' };
    });

    it('includeRoutes 不匹配当前路由时不应记录日志，但 flush 仍必须被调用', () => {
      (window as any).location = { pathname: '/other' };

      const mockFlush = vi.fn((cb: Function) => {
        (window as any).__LOGGER_INITIALIZED__ = true;
        cb([]);
      });
      (window as any).__flushEarlyErrors__ = mockFlush;
      (window as any).__EARLY_ERRORS__ = [];

      const logListener = vi.fn();
      logger.on('log', logListener);

      const plugin = new EarlyErrorCapturePlugin({
        routeMatch: { includeRoutes: ['/home'] },
      });
      logger.use(plugin);

      expect(mockFlush).toHaveBeenCalledTimes(1);
      expect((window as any).__LOGGER_INITIALIZED__).toBe(true);
      expect(logListener).not.toHaveBeenCalled();

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
