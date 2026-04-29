/**
 * Singleton 单例模式测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Singleton (initAemeath / getAemeath)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // 测试隔离卫生：清掉 jsdom window 上的 early-error globals 和所有 mock
  // （包含 console.warn spy）。避免一个测试 set 了 __EARLY_ERRORS__ 后，
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

    it('重复调用应返回同一实例并警告', async () => {
      const mod = await import('../src/singleton/index');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const logger1 = mod.initAemeath();
      const logger2 = mod.initAemeath();

      expect(logger1).toBe(logger2);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Already initialized'),
      );

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
    it('未初始化时应返回默认实例并警告', async () => {
      const mod = await import('../src/singleton/index');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const logger = mod.getAemeath();
      expect(logger).toBeDefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Not initialized'),
      );

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

    it('早期脚本已注入时，兜底创建路径也应装载 EarlyErrorCapturePlugin', async () => {
      // 与 initAemeath() 行为对齐，避免 __LOGGER_INITIALIZED__ 永不翻牌。
      const mod = await import('../src/singleton/index');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      (window as { __EARLY_ERRORS__?: unknown[] }).__EARLY_ERRORS__ = [];
      (window as { __flushEarlyErrors__?: unknown }).__flushEarlyErrors__ = vi.fn(
        (cb: (errs: unknown[]) => void) => {
          (window as { __LOGGER_INITIALIZED__?: boolean }).__LOGGER_INITIALIZED__ = true;
          cb([]);
        },
      );

      const logger = mod.getAemeath();
      expect(logger.hasPlugin('EarlyErrorCapture')).toBe(true);
      expect((window as { __LOGGER_INITIALIZED__?: boolean }).__LOGGER_INITIALIZED__).toBe(true);

      warnSpy.mockRestore();
      mod.resetAemeath();
      delete (window as { __EARLY_ERRORS__?: unknown[] }).__EARLY_ERRORS__;
      delete (window as { __flushEarlyErrors__?: unknown }).__flushEarlyErrors__;
      delete (window as { __LOGGER_INITIALIZED__?: boolean }).__LOGGER_INITIALIZED__;
    });

    it('早期脚本未注入时，兜底创建路径不应装载 EarlyErrorCapturePlugin', async () => {
      const mod = await import('../src/singleton/index');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      delete (window as { __EARLY_ERRORS__?: unknown[] }).__EARLY_ERRORS__;
      delete (window as { __flushEarlyErrors__?: unknown }).__flushEarlyErrors__;

      const logger = mod.getAemeath();
      expect(logger.hasPlugin('EarlyErrorCapture')).toBe(false);

      warnSpy.mockRestore();
      mod.resetAemeath();
    });

    // 升级回归（Bug C — 与 dev 对齐）：
    // 兜底接管早期脚本时必须 console.warn 明确告知「不会上传」，否则用户以为
    // 装了 plugin 就万事大吉，错失 init({ upload }) 的机会。
    it('Bug C: 兜底装载 EarlyErrorCapturePlugin 时必须 console.warn 提示「不会上传」', async () => {
      const mod = await import('../src/singleton/index');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      (window as { __EARLY_ERRORS__?: unknown[] }).__EARLY_ERRORS__ = [];

      mod.getAemeath();

      const warnTexts = warnSpy.mock.calls.map((c) => String(c[0]));
      const hit = warnTexts.find((t) => t.includes('will NOT be uploaded'));
      expect(hit).toBeDefined();

      warnSpy.mockRestore();
      mod.resetAemeath();
      delete (window as { __EARLY_ERRORS__?: unknown[] }).__EARLY_ERRORS__;
    });

    // 升级回归（Bug D — 与 dev 对齐）：
    // 「先 getAemeath() 后 initAemeath({ upload })」过去 upload 会被静默丢弃，
    // 这让 Bug C 的 warn「Call initAemeath({ upload }) afterwards」变成空头支票。
    it('Bug D: 先 getAemeath() 后 initAemeath({ upload }) 必须增量补装 UploadPlugin', async () => {
      const mod = await import('../src/singleton/index');
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const logger1 = mod.getAemeath();
      expect(logger1.hasPlugin('upload')).toBe(false);

      const uploadFn = vi.fn(async () => ({ success: true as const }));
      const logger2 = mod.initAemeath({ upload: uploadFn });

      expect(logger2).toBe(logger1);
      expect(logger2.hasPlugin('upload')).toBe(true);

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

    it('Bug D: 重复 init({ upload }) 时不应重复装载 UploadPlugin', async () => {
      const mod = await import('../src/singleton/index');
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      mod.getAemeath();
      mod.initAemeath({ upload: async () => ({ success: true as const }) });
      const firstCount = mod.getAemeath().getPlugins().filter((p) => p.name === 'upload').length;
      expect(firstCount).toBe(1);

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
     * R15.2 回归：resetAemeath() 必须清理 window 上的 early-error globals。
     */
    it('R15.2: resetAemeath 必须清理 window 上所有 early-error globals', async () => {
      (window as any).__EARLY_ERRORS__ = [{ type: 'error', message: 'leftover', stack: null, timestamp: 0, device: {} }];
      (window as any).__flushEarlyErrors__ = () => {};
      (window as any).__LOGGER_INITIALIZED__ = false;
      (window as any).__EARLY_ERROR_CAPTURE_LOADED__ = true;

      const mod = await import('../src/singleton/index');
      mod.initAemeath();
      mod.resetAemeath();

      expect((window as any).__EARLY_ERRORS__).toBeUndefined();
      expect((window as any).__flushEarlyErrors__).toBeUndefined();
      expect((window as any).__LOGGER_INITIALIZED__).toBeUndefined();
      expect((window as any).__EARLY_ERROR_CAPTURE_LOADED__).toBeUndefined();
    });
  });

  // ==================== errorCapture 联合类型 ====================

  describe('errorCapture 联合类型', () => {
    it('errorCapture: false 应禁用错误捕获', async () => {
      const mod = await import('../src/singleton/index');
      const logger = mod.initAemeath({ errorCapture: false });
      expect(logger.hasPlugin('error-capture')).toBe(false);
      mod.resetAemeath();
    });

    it('errorCapture: true 应启用错误捕获', async () => {
      const mod = await import('../src/singleton/index');
      const logger = mod.initAemeath({ errorCapture: true });
      expect(logger.hasPlugin('error-capture')).toBe(true);
      mod.resetAemeath();
    });

    it('errorCapture: { enabled: false } 应禁用错误捕获', async () => {
      const mod = await import('../src/singleton/index');
      const logger = mod.initAemeath({ errorCapture: { enabled: false } });
      expect(logger.hasPlugin('error-capture')).toBe(false);
      mod.resetAemeath();
    });

    it('errorCapture: { routeMatch: {...} } 应启用错误捕获', async () => {
      const mod = await import('../src/singleton/index');
      const logger = mod.initAemeath({
        errorCapture: {
          routeMatch: { excludeRoutes: ['/debug'] },
        },
      });
      expect(logger.hasPlugin('error-capture')).toBe(true);
      mod.resetAemeath();
    });

    it('errorCapture: { enabled: true, routeMatch: {...} } 应启用错误捕获', async () => {
      const mod = await import('../src/singleton/index');
      const logger = mod.initAemeath({
        errorCapture: {
          enabled: true,
          routeMatch: { includeRoutes: ['/app'] },
        },
      });
      expect(logger.hasPlugin('error-capture')).toBe(true);
      mod.resetAemeath();
    });

    it('默认（undefined）应启用错误捕获', async () => {
      const mod = await import('../src/singleton/index');
      const logger = mod.initAemeath({});
      expect(logger.hasPlugin('error-capture')).toBe(true);
      mod.resetAemeath();
    });
  });

  // ==================== 全局 routeMatch ====================

  describe('全局 routeMatch', () => {
    it('应传递 routeMatch 到 logger', async () => {
      const mod = await import('../src/singleton/index');
      const logger = mod.initAemeath({
        routeMatch: { excludeRoutes: ['/debug'] },
      });
      expect(logger.routeMatcher).toBeDefined();
      expect(logger.routeMatcher.shouldCapturePath('/home')).toBe(true);
      expect(logger.routeMatcher.shouldCapturePath('/debug')).toBe(false);
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
});

