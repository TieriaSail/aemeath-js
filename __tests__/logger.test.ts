/**
 * AemeathLogger 核心测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AemeathLogger } from '../core/Logger';
import type { AemeathPlugin, LogEntry } from '../types';

describe('AemeathLogger Core', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    logger = new AemeathLogger({ enableConsole: false });
  });

  // ==================== 基础日志方法 ====================

  describe('基础日志方法', () => {
    it('应该能调用 debug/info/warn/error 方法', () => {
      expect(() => logger.debug('debug msg')).not.toThrow();
      expect(() => logger.info('info msg')).not.toThrow();
      expect(() => logger.warn('warn msg')).not.toThrow();
      expect(() => logger.error('error msg')).not.toThrow();
    });

    it('日志应该触发监听器', () => {
      const listener = vi.fn();
      logger.on('log', listener);

      logger.info('test message');

      expect(listener).toHaveBeenCalledTimes(1);
      const entry: LogEntry = listener.mock.calls[0][0];
      expect(entry.level).toBe('info');
      expect(entry.message).toBe('test message');
      expect(entry.timestamp).toBeTypeOf('number');
    });

    it('每个级别应该正确传递 level 字段', () => {
      const listener = vi.fn();
      logger.on('log', listener);

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      expect(listener).toHaveBeenCalledTimes(4);
      expect(listener.mock.calls[0][0].level).toBe('debug');
      expect(listener.mock.calls[1][0].level).toBe('info');
      expect(listener.mock.calls[2][0].level).toBe('warn');
      expect(listener.mock.calls[3][0].level).toBe('error');
    });

    it('应该能传递 tags', () => {
      const listener = vi.fn();
      logger.on('log', listener);

      logger.info('test', { tags: { component: 'App', action: 'init' } });

      const entry: LogEntry = listener.mock.calls[0][0];
      expect(entry.tags?.component).toBe('App');
      expect(entry.tags?.action).toBe('init');
    });

    it('应该能传递 error 对象', () => {
      const listener = vi.fn();
      logger.on('log', listener);

      const error = new Error('test error');
      logger.error('caught error', { error });

      const entry: LogEntry = listener.mock.calls[0][0];
      expect(entry.error).toBeDefined();
      expect(entry.error?.type).toBe('Error');
      expect(entry.error?.value).toBe('test error');
    });
  });

  // ==================== 控制台输出 ====================

  describe('控制台输出', () => {
    it('enableConsole=true 时应输出到控制台', () => {
      const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const consoleLogger = new AemeathLogger({ enableConsole: true });

      consoleLogger.info('hello');

      expect(consoleInfoSpy).toHaveBeenCalled();
    });

    it('enableConsole=false 时不应输出到控制台', () => {
      const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      logger.info('hello');

      expect(consoleInfoSpy).not.toHaveBeenCalled();
    });

    it('setConsoleEnabled 可以动态切换', () => {
      const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      logger.info('before');
      expect(consoleInfoSpy).not.toHaveBeenCalled();

      logger.setConsoleEnabled(true);
      logger.info('after');
      expect(consoleInfoSpy).toHaveBeenCalled();
    });
  });

  // ==================== 上下文管理 ====================

  describe('上下文管理', () => {
    it('setContext 应设置静态上下文', () => {
      logger.setContext({ userId: '123', env: 'test' });

      const listener = vi.fn();
      logger.on('log', listener);
      logger.info('test');

      const entry: LogEntry = listener.mock.calls[0][0];
      expect(entry.context?.userId).toBe('123');
      expect(entry.context?.env).toBe('test');
    });

    it('updateContext 应更新单个上下文字段', () => {
      logger.setContext({ userId: '123' });
      logger.updateContext('role', 'admin');

      const listener = vi.fn();
      logger.on('log', listener);
      logger.info('test');

      const entry: LogEntry = listener.mock.calls[0][0];
      expect(entry.context?.userId).toBe('123');
      expect(entry.context?.role).toBe('admin');
    });

    it('clearContext 应清除所有上下文', () => {
      logger.setContext({ userId: '123' });
      logger.clearContext();

      const listener = vi.fn();
      logger.on('log', listener);
      logger.info('test');

      const entry: LogEntry = listener.mock.calls[0][0];
      // context 为空时不设置
      expect(entry.context).toBeUndefined();
    });

    it('clearContext(keys) 应只清除指定字段', () => {
      logger.setContext({ userId: '123', role: 'admin' });
      logger.clearContext(['role']);

      const listener = vi.fn();
      logger.on('log', listener);
      logger.info('test');

      const entry: LogEntry = listener.mock.calls[0][0];
      expect(entry.context?.userId).toBe('123');
      expect(entry.context?.role).toBeUndefined();
    });

    it('getContext 应返回当前上下文副本', () => {
      logger.setContext({ a: 1 });
      const ctx = logger.getContext();
      expect(ctx).toEqual({ a: 1 });

      // 修改返回值不应影响内部状态
      ctx.a = 999;
      expect(logger.getContext()).toEqual({ a: 1 });
    });

    it('动态上下文应在每次日志时重新计算', () => {
      let counter = 0;
      logger.updateContext('count', () => {
        counter++;
        return { count: counter };
      });

      const listener = vi.fn();
      logger.on('log', listener);

      logger.info('first');
      logger.info('second');

      expect(listener.mock.calls[0][0].context?.count).toBe(1);
      expect(listener.mock.calls[1][0].context?.count).toBe(2);
    });
  });

  // ==================== 事件系统 ====================

  describe('事件系统', () => {
    it('on/emit 应正确工作', () => {
      const handler = vi.fn();
      logger.on('custom-event', handler);

      logger.emit('custom-event', 'arg1', 'arg2');

      expect(handler).toHaveBeenCalledWith('arg1', 'arg2');
    });

    it('off 应移除监听器', () => {
      const handler = vi.fn();
      logger.on('custom-event', handler);
      logger.off('custom-event', handler);

      logger.emit('custom-event');

      expect(handler).not.toHaveBeenCalled();
    });

    it('多个监听器应都被触发', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      logger.on('evt', handler1);
      logger.on('evt', handler2);
      logger.emit('evt');

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('监听器抛出异常不应影响其他监听器', () => {
      const handler1 = vi.fn(() => {
        throw new Error('boom');
      });
      const handler2 = vi.fn();

      logger.on('evt', handler1);
      logger.on('evt', handler2);

      // 不应抛出
      expect(() => logger.emit('evt')).not.toThrow();
      expect(handler2).toHaveBeenCalled();
    });
  });

  // ==================== 插件系统 ====================

  describe('插件系统', () => {
    it('use 应安装插件', () => {
      const plugin: AemeathPlugin = {
        name: 'test-plugin',
        version: '1.0.0',
        install: vi.fn(),
      };

      logger.use(plugin);

      expect(plugin.install).toHaveBeenCalledWith(logger, undefined);
      expect(logger.hasPlugin('test-plugin')).toBe(true);
    });

    it('重复安装同名插件应被忽略', () => {
      const plugin: AemeathPlugin = {
        name: 'test',
        install: vi.fn(),
      };

      logger.use(plugin);
      logger.use(plugin);

      expect(plugin.install).toHaveBeenCalledTimes(1);
    });

    it('uninstall 应卸载插件', () => {
      const plugin: AemeathPlugin = {
        name: 'test',
        install: vi.fn(),
      };

      logger.use(plugin);
      expect(logger.hasPlugin('test')).toBe(true);

      logger.uninstall('test');
      expect(logger.hasPlugin('test')).toBe(false);
    });

    it('插件依赖不满足时应抛出错误', () => {
      const plugin: AemeathPlugin = {
        name: 'child',
        dependencies: ['parent'],
        install: vi.fn(),
      };

      expect(() => logger.use(plugin)).toThrow('requires "parent"');
    });

    it('getPlugins 应返回已安装插件列表', () => {
      logger.use({ name: 'a', install: vi.fn() });
      logger.use({ name: 'b', install: vi.fn() });

      const plugins = logger.getPlugins();
      expect(plugins).toHaveLength(2);
      expect(plugins.map((p) => p.name)).toEqual(['a', 'b']);
    });

    it('use 应支持链式调用', () => {
      const result = logger
        .use({ name: 'a', install: vi.fn() })
        .use({ name: 'b', install: vi.fn() });

      expect(result).toBe(logger);
    });
  });

  // ==================== environment / release ====================

  describe('environment / release', () => {
    it('应自动注入 environment 和 release', () => {
      const envLogger = new AemeathLogger({
        enableConsole: false,
        environment: 'production',
        release: '1.0.0',
      });

      const listener = vi.fn();
      envLogger.on('log', listener);
      envLogger.info('test');

      const entry: LogEntry = listener.mock.calls[0][0];
      expect(entry.environment).toBe('production');
      expect(entry.release).toBe('1.0.0');
    });
  });

  // ==================== destroy ====================

  describe('destroy', () => {
    it('destroy 后应清理所有插件和监听器', () => {
      const listener = vi.fn();
      logger.on('log', listener);
      logger.use({ name: 'test', install: vi.fn() });

      logger.destroy();

      expect(logger.hasPlugin('test')).toBe(false);

      // destroy 后日志不应再触发监听器
      logger.info('after destroy');
      expect(listener).not.toHaveBeenCalled();
    });
  });
});

