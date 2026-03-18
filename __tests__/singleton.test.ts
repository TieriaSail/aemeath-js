/**
 * Singleton 单例模式测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Singleton (initAemeath / getAemeath)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // ==================== initAemeath ====================

  describe('initAemeath', () => {
    it('应返回 AemeathLogger 实例', async () => {
      const mod = await import('../src/singleton/index');
      const logger = mod.initAemeath();
      expect(logger).toBeDefined();
      expect(logger.info).toBeTypeOf('function');
      expect(logger.error).toBeTypeOf('function');
      mod.resetAemeath();
    });

    it('默认应启用 ErrorCapturePlugin 和 SafeGuardPlugin', async () => {
      const mod = await import('../src/singleton/index');
      const logger = mod.initAemeath();

      expect(logger.hasPlugin('error-capture')).toBe(true);
      expect(logger.hasPlugin('safe-guard')).toBe(true);

      mod.resetAemeath();
    });

    it('errorCapture=false 时不应安装 ErrorCapturePlugin', async () => {
      const mod = await import('../src/singleton/index');
      const logger = mod.initAemeath({ errorCapture: false });

      expect(logger.hasPlugin('error-capture')).toBe(false);

      mod.resetAemeath();
    });

    it('传入 upload 时应安装 UploadPlugin', async () => {
      const mod = await import('../src/singleton/index');
      const logger = mod.initAemeath({
        upload: async () => ({ success: true }),
      });

      expect(logger.hasPlugin('upload')).toBe(true);

      mod.resetAemeath();
    });

    it('不传 upload 时不应安装 UploadPlugin', async () => {
      const mod = await import('../src/singleton/index');
      const logger = mod.initAemeath();

      expect(logger.hasPlugin('upload')).toBe(false);

      mod.resetAemeath();
    });

    it('重复调用应返回同一实例（静默）', async () => {
      const mod = await import('../src/singleton/index');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const logger1 = mod.initAemeath();
      const logger2 = mod.initAemeath();

      expect(logger1).toBe(logger2);
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
      mod.resetAemeath();
    });

    it('应传递 environment 和 release', async () => {
      const mod = await import('../src/singleton/index');
      const logger = mod.initAemeath({
        environment: 'production',
        release: '1.0.0',
      });

      const logListener = vi.fn();
      logger.on('log', logListener);
      logger.info('test');

      const entry = logListener.mock.calls[0][0];
      expect(entry.environment).toBe('production');
      expect(entry.release).toBe('1.0.0');

      mod.resetAemeath();
    });

    it('应传递 context', async () => {
      const mod = await import('../src/singleton/index');
      const logger = mod.initAemeath({
        context: { userId: '123', deviceId: 'abc' },
      });

      const logListener = vi.fn();
      logger.on('log', logListener);
      logger.info('test');

      const entry = logListener.mock.calls[0][0];
      expect(entry.context?.userId).toBe('123');
      expect(entry.context?.deviceId).toBe('abc');

      mod.resetAemeath();
    });

    it('safeGuard.enabled=false 时不应安装 SafeGuardPlugin', async () => {
      const mod = await import('../src/singleton/index');
      const logger = mod.initAemeath({
        safeGuard: { enabled: false },
      });

      expect(logger.hasPlugin('safe-guard')).toBe(false);

      mod.resetAemeath();
    });

    it('network.enabled=false 时不应安装 NetworkPlugin', async () => {
      const mod = await import('../src/singleton/index');
      const logger = mod.initAemeath({
        network: { enabled: false },
      });

      expect(logger.hasPlugin('network')).toBe(false);

      mod.resetAemeath();
    });

    it('默认应安装 NetworkPlugin', async () => {
      const mod = await import('../src/singleton/index');
      const logger = mod.initAemeath();

      expect(logger.hasPlugin('network')).toBe(true);

      mod.resetAemeath();
    });
  });

  // ==================== getAemeath ====================

  describe('getAemeath', () => {
    it('未初始化时应返回默认实例（静默创建）', async () => {
      const mod = await import('../src/singleton/index');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const logger = mod.getAemeath();
      expect(logger).toBeDefined();
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
      mod.resetAemeath();
    });

    it('初始化后应返回同一实例', async () => {
      const mod = await import('../src/singleton/index');
      const logger = mod.initAemeath();
      const retrieved = mod.getAemeath();

      expect(retrieved).toBe(logger);

      mod.resetAemeath();
    });
  });

  // ==================== isAemeathInitialized ====================

  describe('isAemeathInitialized', () => {
    it('未初始化时应返回 false', async () => {
      const mod = await import('../src/singleton/index');
      expect(mod.isAemeathInitialized()).toBe(false);
    });

    it('初始化后应返回 true', async () => {
      const mod = await import('../src/singleton/index');
      mod.initAemeath();
      expect(mod.isAemeathInitialized()).toBe(true);
      mod.resetAemeath();
    });
  });

  // ==================== resetAemeath ====================

  describe('resetAemeath', () => {
    it('重置后应该可以重新初始化', async () => {
      const mod = await import('../src/singleton/index');

      const logger1 = mod.initAemeath();
      mod.resetAemeath();

      expect(mod.isAemeathInitialized()).toBe(false);

      const logger2 = mod.initAemeath();
      expect(logger2).not.toBe(logger1);

      mod.resetAemeath();
    });
  });

  // ==================== errorFilter ====================

  describe('errorFilter', () => {
    it('应传递 errorFilter 到 ErrorCapturePlugin', async () => {
      const mod = await import('../src/singleton/index');
      const logger = mod.initAemeath({
        errorFilter: (error) => !error.message.includes('401'),
      });

      // ErrorCapturePlugin 应该已安装
      expect(logger.hasPlugin('error-capture')).toBe(true);

      mod.resetAemeath();
    });
  });

  // ==================== errorCapture union type ====================

  describe('errorCapture 扩展类型', () => {
    it('errorCapture: true 应安装 ErrorCapturePlugin', async () => {
      const mod = await import('../src/singleton/index');
      const logger = mod.initAemeath({ errorCapture: true });
      expect(logger.hasPlugin('error-capture')).toBe(true);
      mod.resetAemeath();
    });

    it('errorCapture: {} 应安装 ErrorCapturePlugin（enabled 默认 true）', async () => {
      const mod = await import('../src/singleton/index');
      const logger = mod.initAemeath({ errorCapture: {} });
      expect(logger.hasPlugin('error-capture')).toBe(true);
      mod.resetAemeath();
    });

    it('errorCapture: { enabled: false } 不应安装 ErrorCapturePlugin', async () => {
      const mod = await import('../src/singleton/index');
      const logger = mod.initAemeath({ errorCapture: { enabled: false } });
      expect(logger.hasPlugin('error-capture')).toBe(false);
      mod.resetAemeath();
    });

    it('errorCapture: { routeMatch } 应安装带路由配置的 ErrorCapturePlugin', async () => {
      const mod = await import('../src/singleton/index');
      const logger = mod.initAemeath({
        errorCapture: {
          routeMatch: { excludeRoutes: ['/internal'] },
        },
      });
      expect(logger.hasPlugin('error-capture')).toBe(true);
      mod.resetAemeath();
    });
  });

  // ==================== 全局 routeMatch ====================

  describe('全局 routeMatch', () => {
    it('应将 routeMatch 传递到 Logger 的 routeMatcher', async () => {
      const mod = await import('../src/singleton/index');
      const logger = mod.initAemeath({
        routeMatch: { excludeRoutes: ['/debug'] },
      });

      expect(logger.routeMatcher).toBeDefined();
      expect(logger.routeMatcher.shouldCapture('/home')).toBe(true);
      expect(logger.routeMatcher.shouldCapture('/debug')).toBe(false);

      mod.resetAemeath();
    });

    it('不配置 routeMatch 时全局 matcher 应允许所有路由', async () => {
      const mod = await import('../src/singleton/index');
      const logger = mod.initAemeath();

      expect(logger.routeMatcher.shouldCapture('/any')).toBe(true);

      mod.resetAemeath();
    });
  });
});

