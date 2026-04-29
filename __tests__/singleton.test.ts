/**
 * Singleton 单例模式测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Singleton (initAemeath / getAemeath)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // 测试隔离卫生：清掉 jsdom window 上的 early-error globals 和所有 mock
  // （包含 console.warn spy）。避免一个测试 set 了 __flushEarlyErrors__ 后，
  // 下一个测试 getAemeath() 误进入 EarlyErrorCapturePlugin 装载分支，
  // 触发不预期的 console.warn 计数。
  afterEach(() => {
    delete (window as { __flushEarlyErrors__?: unknown }).__flushEarlyErrors__;
    delete (window as { __EARLY_ERRORS__?: unknown[] }).__EARLY_ERRORS__;
    delete (window as { __LOGGER_INITIALIZED__?: boolean }).__LOGGER_INITIALIZED__;
    vi.restoreAllMocks();
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

    it('早期脚本已注入时，兜底创建路径也应装载 EarlyErrorCapturePlugin 并 console.warn', async () => {
      // 升级回归（v2.2.0-beta.1 early-handoff bug）：
      // 如果只用 getAemeath() 而不调 initAemeath()（少见但合法），早期脚本接管
      // 也必须发生，否则 __LOGGER_INITIALIZED__ 永不翻牌、fallback 定时器照样开火。
      // 同时（Bug C）：本兜底路径没有 UploadPlugin，必须 console.warn 提示用户
      // 「早期错误已接管但不会上传」，避免误以为 plugin 装了就万事大吉。
      const mod = await import('../src/singleton/index');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const flushFn = vi.fn((cb: (errs: unknown[]) => void) => {
        (window as { __LOGGER_INITIALIZED__?: boolean }).__LOGGER_INITIALIZED__ = true;
        cb([]);
      });
      (window as { __flushEarlyErrors__?: unknown }).__flushEarlyErrors__ = flushFn;
      (window as { __EARLY_ERRORS__?: unknown[] }).__EARLY_ERRORS__ = [];

      const logger = mod.getAemeath();

      expect(logger.hasPlugin('EarlyErrorCapture')).toBe(true);
      expect(flushFn).toHaveBeenCalledTimes(1);
      expect((window as { __LOGGER_INITIALIZED__?: boolean }).__LOGGER_INITIALIZED__).toBe(true);
      // Bug C 警告必须发出（提示「不会上传」）
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('will NOT be uploaded'),
      );

      warnSpy.mockRestore();
      mod.resetAemeath();
      delete (window as { __flushEarlyErrors__?: unknown }).__flushEarlyErrors__;
      delete (window as { __EARLY_ERRORS__?: unknown[] }).__EARLY_ERRORS__;
      delete (window as { __LOGGER_INITIALIZED__?: boolean }).__LOGGER_INITIALIZED__;
    });

    it('早期脚本未注入时，兜底创建路径不应尝试装载 EarlyErrorCapturePlugin', async () => {
      const mod = await import('../src/singleton/index');
      delete (window as { __flushEarlyErrors__?: unknown }).__flushEarlyErrors__;
      delete (window as { __EARLY_ERRORS__?: unknown[] }).__EARLY_ERRORS__;

      const logger = mod.getAemeath();
      expect(logger.hasPlugin('EarlyErrorCapture')).toBe(false);

      mod.resetAemeath();
    });

    // 升级回归（Bug D — 与 Bug C 配套）：
    // 「先 getAemeath() 后 initAemeath({ upload })」过去 upload 会被静默丢弃，
    // 这让 Bug C 的 warn「Call initAemeath({ upload }) afterwards」变成空头支票。
    // 修复后必须支持「增量补装 UploadPlugin」。
    it('Bug D: 先 getAemeath() 后 initAemeath({ upload }) 必须增量补装 UploadPlugin', async () => {
      const mod = await import('../src/singleton/index');
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      // 第一步：getAemeath() 兜底创建（无 UploadPlugin）
      const logger1 = mod.getAemeath();
      expect(logger1.hasPlugin('upload')).toBe(false);

      // 第二步：initAemeath({ upload }) 必须增量补装
      const uploadFn = vi.fn(async () => ({ success: true as const }));
      const logger2 = mod.initAemeath({ upload: uploadFn });

      expect(logger2).toBe(logger1);
      expect(logger2.hasPlugin('upload')).toBe(true);

      // 真实端到端：发一条 log，确认 uploadFn 被调用
      logger2.error('post-incremental-upload');
      await new Promise((r) => setTimeout(r, 50));
      expect(uploadFn).toHaveBeenCalled();

      mod.resetAemeath();
    });

    it('Bug D: 增量补装时 console.warn 应明确「upload was honored」', async () => {
      const mod = await import('../src/singleton/index');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      mod.getAemeath();
      mod.initAemeath({
        upload: async () => ({ success: true as const }),
        environment: 'production',
      });

      const warnTexts = warnSpy.mock.calls.map((c) => String(c[0]));
      const hit = warnTexts.find((t) => t.includes('initAemeath() called after the global instance'));
      expect(hit).toBeDefined();
      expect(hit).toContain('honored: upload');
      expect(hit).toContain('ignored: environment');

      mod.resetAemeath();
    });

    it('Bug D: 重复 init({ upload }) 时不应重复装载（防止 pipeline 出现两个 UploadPlugin）', async () => {
      const mod = await import('../src/singleton/index');
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      mod.getAemeath();
      mod.initAemeath({ upload: async () => ({ success: true as const }) });
      const firstCount = mod.getAemeath().getPlugins().filter((p) => p.name === 'upload').length;
      expect(firstCount).toBe(1);

      // 第二次 init 不应该再加一个
      mod.initAemeath({ upload: async () => ({ success: true as const }) });
      const secondCount = mod.getAemeath().getPlugins().filter((p) => p.name === 'upload').length;
      expect(secondCount).toBe(1);

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

    /**
     * R15.2 回归：resetAemeath() 必须清理 window 上的 early-error globals，
     * 让 reset 真正彻底。否则下次 initAemeath() 会被残留 __LOGGER_INITIALIZED__、
     * __EARLY_ERRORS__、__flushEarlyErrors__、__EARLY_ERROR_CAPTURE_LOADED__ 影响。
     */
    it('R15.2: resetAemeath 必须清理 window 上所有 early-error globals', async () => {
      // 先模拟早期脚本注入的全局
      (window as any).__EARLY_ERRORS__ = [{ type: 'error', message: 'leftover', stack: null, timestamp: 0, device: {} }];
      (window as any).__flushEarlyErrors__ = () => {};
      (window as any).__LOGGER_INITIALIZED__ = false;
      (window as any).__EARLY_ERROR_CAPTURE_LOADED__ = true;

      const mod = await import('../src/singleton/index');
      mod.initAemeath();
      mod.resetAemeath();

      // 关键断言：resetAemeath 后所有 early-error globals 必须被删除
      expect((window as any).__EARLY_ERRORS__).toBeUndefined();
      expect((window as any).__flushEarlyErrors__).toBeUndefined();
      expect((window as any).__LOGGER_INITIALIZED__).toBeUndefined();
      expect((window as any).__EARLY_ERROR_CAPTURE_LOADED__).toBeUndefined();
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

