/**
 * ErrorCapturePlugin 错误捕获插件测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ErrorCapturePlugin } from '../src/plugins/ErrorCapturePlugin';
import { AemeathLogger } from '../src/core/Logger';

/**
 * 创建一个"外部"错误（stack 中不含 aemeath-js 路径）
 * 避免被 isLoggerInternalError 过滤
 */
function createExternalError(message: string): Error {
  const error = new Error(message);
  error.stack = `Error: ${message}\n    at UserApp.render (app.js:10:5)\n    at Object.run (main.js:3:12)`;
  return error;
}

describe('ErrorCapturePlugin', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
  });

  // ==================== 安装与卸载 ====================

  describe('安装与卸载', () => {
    it('应正确安装', () => {
      const plugin = new ErrorCapturePlugin();
      logger.use(plugin);
      expect(logger.hasPlugin('error-capture')).toBe(true);
    });

    it('卸载后不应再捕获', () => {
      const plugin = new ErrorCapturePlugin();
      logger.use(plugin);
      logger.uninstall('error-capture');
      expect(logger.hasPlugin('error-capture')).toBe(false);
    });
  });

  // ==================== 全局错误捕获 ====================

  describe('全局错误捕获 (window.onerror)', () => {
    it('安装后应替换 window.onerror', () => {
      const originalOnerror = window.onerror;
      const plugin = new ErrorCapturePlugin();
      logger.use(plugin);
      expect(window.onerror).not.toBe(originalOnerror);
    });

    it('window.onerror 触发时应记录错误日志', () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      const plugin = new ErrorCapturePlugin();
      logger.use(plugin);

      const testError = createExternalError('test global error');
      if (window.onerror) {
        (window.onerror as Function)(
          'test global error',
          'app.js',
          10,
          5,
          testError,
        );
      }

      expect(logListener).toHaveBeenCalled();
      const entry = logListener.mock.calls[0][0];
      expect(entry.level).toBe('error');
      expect(entry.message).toBe('Global error');
    });
  });

  // ==================== Promise rejection 捕获 ====================

  describe('Promise rejection 捕获', () => {
    it('captureUnhandledRejection=true 时应监听', () => {
      const addSpy = vi.spyOn(window, 'addEventListener');
      const plugin = new ErrorCapturePlugin({
        captureUnhandledRejection: true,
      });
      logger.use(plugin);

      expect(addSpy).toHaveBeenCalledWith(
        'unhandledrejection',
        expect.any(Function),
      );
      addSpy.mockRestore();
    });

    it('captureUnhandledRejection=false 时不应监听', () => {
      const addSpy = vi.spyOn(window, 'addEventListener');
      const plugin = new ErrorCapturePlugin({
        captureUnhandledRejection: false,
      });
      logger.use(plugin);

      const calls = addSpy.mock.calls.filter(
        (c) => c[0] === 'unhandledrejection',
      );
      expect(calls).toHaveLength(0);
      addSpy.mockRestore();
    });
  });

  // ==================== 资源错误捕获 ====================

  describe('资源错误捕获', () => {
    it('captureResourceError=true 时应监听 error 事件（捕获阶段）', () => {
      const addSpy = vi.spyOn(window, 'addEventListener');
      const plugin = new ErrorCapturePlugin({
        captureResourceError: true,
      });
      logger.use(plugin);

      const errorCalls = addSpy.mock.calls.filter(
        (c) => c[0] === 'error' && c[2] === true,
      );
      expect(errorCalls.length).toBeGreaterThan(0);
      addSpy.mockRestore();
    });

    it('captureResourceError=false 时不应监听', () => {
      const addSpy = vi.spyOn(window, 'addEventListener');
      const plugin = new ErrorCapturePlugin({
        captureResourceError: false,
      });
      logger.use(plugin);

      const errorCaptureCalls = addSpy.mock.calls.filter(
        (c) => c[0] === 'error' && c[2] === true,
      );
      expect(errorCaptureCalls).toHaveLength(0);
      addSpy.mockRestore();
    });
  });

  // ==================== console.error 捕获 ====================

  describe('console.error 捕获', () => {
    it('captureConsoleError=true 时应替换 console.error', () => {
      const originalError = console.error;
      const plugin = new ErrorCapturePlugin({
        captureConsoleError: true,
      });
      logger.use(plugin);

      expect(console.error).not.toBe(originalError);
    });

    it('captureConsoleError=false 时不应替换 console.error', () => {
      const originalError = console.error;
      const plugin = new ErrorCapturePlugin({
        captureConsoleError: false,
      });
      logger.use(plugin);

      expect(console.error).toBe(originalError);
    });
  });

  // ==================== 内部错误过滤 ====================

  describe('内部错误过滤', () => {
    it('带 _isAemeathInternalError 标记的错误不应被捕获', () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      const plugin = new ErrorCapturePlugin();
      logger.use(plugin);

      const internalError = new Error('[SafeGuard] 内部错误');
      (internalError as any)._isAemeathInternalError = true;

      if (window.onerror) {
        (window.onerror as Function)(
          internalError.message,
          'internal.js',
          1,
          1,
          internalError,
        );
      }

      expect(logListener).not.toHaveBeenCalled();
    });

    it('包含 AemeathJs 内部前缀的错误不应被捕获', () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      const plugin = new ErrorCapturePlugin();
      logger.use(plugin);

      const loggerError = new Error('[UploadPlugin] upload failed');
      // 清理 stack 避免路径干扰
      loggerError.stack = 'Error: [UploadPlugin] upload failed\n    at upload.js:1:1';

      if (window.onerror) {
        (window.onerror as Function)(
          loggerError.message,
          'upload.js',
          1,
          1,
          loggerError,
        );
      }

      expect(logListener).not.toHaveBeenCalled();
    });
  });

  // ==================== 自定义过滤器 ====================

  describe('自定义过滤器', () => {
    it('errorFilter 返回 false 时不应记录', () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      const plugin = new ErrorCapturePlugin({
        errorFilter: (error) => !error.message.includes('ignore'),
      });
      logger.use(plugin);

      const ignoredError = createExternalError('please ignore this');
      if (window.onerror) {
        (window.onerror as Function)(
          ignoredError.message,
          'app.js',
          1,
          1,
          ignoredError,
        );
      }

      expect(logListener).not.toHaveBeenCalled();
    });

    it('errorFilter 返回 true 时应记录', () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      const plugin = new ErrorCapturePlugin({
        errorFilter: () => true,
      });
      logger.use(plugin);

      const normalError = createExternalError('normal error');
      if (window.onerror) {
        (window.onerror as Function)(
          normalError.message,
          'app.js',
          1,
          1,
          normalError,
        );
      }

      expect(logListener).toHaveBeenCalled();
    });
  });

  // ==================== 路由匹配 ====================

  describe('路由匹配', () => {
    it('当前路由不在白名单时不应捕获', () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      const plugin = new ErrorCapturePlugin({
        routeMatch: { includeRoutes: ['/special-page'] },
      });
      logger.use(plugin);

      const error = createExternalError('should not capture');
      if (window.onerror) {
        (window.onerror as Function)(error.message, 'app.js', 1, 1, error);
      }

      expect(logListener).not.toHaveBeenCalled();
    });

    it('当前路由在白名单时应捕获', () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      // jsdom 默认路径是 '/'
      const plugin = new ErrorCapturePlugin({
        routeMatch: { includeRoutes: ['/'] },
      });
      logger.use(plugin);

      const error = createExternalError('should capture');
      if (window.onerror) {
        (window.onerror as Function)(error.message, 'app.js', 1, 1, error);
      }

      expect(logListener).toHaveBeenCalled();
    });
  });

  // ==================== 错误去重 ====================

  describe('错误去重', () => {
    it('短时间内相同错误只应记录一次', () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      const plugin = new ErrorCapturePlugin();
      logger.use(plugin);

      const error = createExternalError('duplicate error');

      if (window.onerror) {
        (window.onerror as Function)(error.message, 'app.js', 1, 1, error);
        (window.onerror as Function)(error.message, 'app.js', 1, 1, error);
      }

      expect(logListener).toHaveBeenCalledTimes(1);
    });
  });
});
