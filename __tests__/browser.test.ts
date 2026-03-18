/**
 * browser/index.ts IIFE 入口测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { init, getAemeath, AemeathLogger, ErrorCapturePlugin, UploadPlugin, SafeGuardPlugin } from '../src/browser/index';

// 重置全局单例（browser/index.ts 内部的 globalLogger）
// 由于模块级变量无法直接重置，每个测试需要重新 import
// 这里使用 vi.resetModules 来实现

describe('Browser IIFE 入口', () => {
  beforeEach(async () => {
    // 重置模块缓存以获取干净的 globalLogger
    vi.resetModules();
  });

  // ==================== 导出检查 ====================

  describe('导出检查', () => {
    it('应导出 init 函数', () => {
      expect(init).toBeTypeOf('function');
    });

    it('应导出 getAemeath 函数', () => {
      expect(getAemeath).toBeTypeOf('function');
    });

    it('应导出 AemeathLogger 类', () => {
      expect(AemeathLogger).toBeTypeOf('function');
    });

    it('应导出 ErrorCapturePlugin 类', () => {
      expect(ErrorCapturePlugin).toBeTypeOf('function');
    });

    it('应导出 UploadPlugin 类', () => {
      expect(UploadPlugin).toBeTypeOf('function');
    });

    it('应导出 SafeGuardPlugin 类', () => {
      expect(SafeGuardPlugin).toBeTypeOf('function');
    });
  });

  // ==================== init 函数 ====================

  describe('init 函数', () => {
    it('应返回 Logger 实例', async () => {
      const mod = await import('../src/browser/index');
      const logger = mod.init();
      // 动态 import 后 AemeathLogger 类引用不同，使用 instanceof mod.AemeathLogger
      expect(logger).toBeInstanceOf(mod.AemeathLogger);
    });

    it('默认应启用 ErrorCapturePlugin 和 SafeGuardPlugin', async () => {
      const mod = await import('../src/browser/index');
      const logger = mod.init();

      expect(logger.hasPlugin('error-capture')).toBe(true);
      expect(logger.hasPlugin('safe-guard')).toBe(true);
    });

    it('errorCapture=false 时不应安装 ErrorCapturePlugin', async () => {
      const mod = await import('../src/browser/index');
      const logger = mod.init({ errorCapture: false });

      expect(logger.hasPlugin('error-capture')).toBe(false);
    });

    it('safeGuard=false 时不应安装 SafeGuardPlugin', async () => {
      const mod = await import('../src/browser/index');
      const logger = mod.init({ safeGuard: false });

      expect(logger.hasPlugin('safe-guard')).toBe(false);
    });

    it('传入 upload 回调应安装 UploadPlugin', async () => {
      const mod = await import('../src/browser/index');
      const logger = mod.init({
        upload: vi.fn(),
      });

      expect(logger.hasPlugin('upload')).toBe(true);
    });

    it('不传 upload 回调不应安装 UploadPlugin', async () => {
      const mod = await import('../src/browser/index');
      const logger = mod.init();

      expect(logger.hasPlugin('upload')).toBe(false);
    });

    it('重复调用 init 应返回同一实例并警告', async () => {
      const mod = await import('../src/browser/index');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const logger1 = mod.init();
      const logger2 = mod.init();

      expect(logger1).toBe(logger2);
      expect(warnSpy).toHaveBeenCalledWith('[AemeathJs] Already initialized');

      warnSpy.mockRestore();
    });
  });

  // ==================== getAemeath 函数 ====================

  describe('getAemeath 函数', () => {
    it('未初始化时应抛出错误', async () => {
      const mod = await import('../src/browser/index');
      expect(() => mod.getAemeath()).toThrow('Not initialized');
    });

    it('初始化后应返回 AemeathLogger 实例', async () => {
      const mod = await import('../src/browser/index');
      const logger = mod.init();
      const retrieved = mod.getAemeath();
      expect(retrieved).toBe(logger);
    });
  });

  // ==================== 日志级别过滤 ====================

  describe('日志级别过滤', () => {
    it("level='warn' 时 debug 和 info 应被替换为 noop", async () => {
      const mod = await import('../src/browser/index');
      const logger = mod.init({ level: 'warn', errorCapture: false, safeGuard: false });

      const logListener = vi.fn();
      logger.on('log', logListener);

      // debug 和 info 被替换为 noop，不应触发
      logger.debug('d');
      logger.info('i');
      expect(logListener).not.toHaveBeenCalled();

      // warn 和 error 应正常
      logger.warn('w');
      expect(logListener).toHaveBeenCalledTimes(1);
    });

    it("level='error' 时只有 error 生效", async () => {
      const mod = await import('../src/browser/index');
      const logger = mod.init({ level: 'error', errorCapture: false, safeGuard: false });

      const logListener = vi.fn();
      logger.on('log', logListener);

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      expect(logListener).not.toHaveBeenCalled();

      logger.error('e');
      expect(logListener).toHaveBeenCalledTimes(1);
    });

    it("level='debug' 时所有级别都生效", async () => {
      const mod = await import('../src/browser/index');
      const logger = mod.init({ level: 'debug', errorCapture: false, safeGuard: false });

      const logListener = vi.fn();
      logger.on('log', logListener);

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      expect(logListener).toHaveBeenCalledTimes(4);
    });
  });

  // ==================== track 级别过滤 ====================

  describe('track 级别过滤', () => {
    it("level='warn' 时 track 应被替换为 noop", async () => {
      const mod = await import('../src/browser/index');
      const logger = mod.init({
        level: 'warn',
        errorCapture: false,
        safeGuard: false,
      });

      expect(logger.track).toBeDefined();
      const logListener = vi.fn();
      logger.on('log', logListener);
      logger.track('should be noop');
      expect(logListener).not.toHaveBeenCalled();
    });

    it("level='info' 时 track 应生效", async () => {
      const mod = await import('../src/browser/index');
      const logger = mod.init({
        level: 'info',
        errorCapture: false,
        safeGuard: false,
      });

      const logListener = vi.fn();
      logger.on('log', logListener);
      logger.track('should work');
      expect(logListener).toHaveBeenCalledTimes(1);
    });

    it("level='debug' 时 track 应生效", async () => {
      const mod = await import('../src/browser/index');
      const logger = mod.init({
        level: 'debug',
        errorCapture: false,
        safeGuard: false,
      });

      const logListener = vi.fn();
      logger.on('log', logListener);
      logger.track('should work');
      expect(logListener).toHaveBeenCalledTimes(1);
    });
  });

  // ==================== 早期错误刷新 ====================

  describe('早期错误刷新', () => {
    it('应调用 __flushEarlyErrors__ 刷新早期错误', async () => {
      const earlyErrors = [
        { type: 'error', message: 'early error', timestamp: Date.now() },
      ];

      (window as any).__flushEarlyErrors__ = vi.fn((callback: Function) => {
        callback(earlyErrors);
      });
      (window as any).__EARLY_ERRORS__ = earlyErrors;

      const mod = await import('../src/browser/index');
      const logger = mod.init({ errorCapture: false, safeGuard: false });

      expect((window as any).__flushEarlyErrors__).toHaveBeenCalled();

      // 清理
      delete (window as any).__flushEarlyErrors__;
      delete (window as any).__EARLY_ERRORS__;
    });
  });
});

