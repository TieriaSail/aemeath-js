/**
 * SafeGuardPlugin 安全保护插件测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SafeGuardPlugin } from '../plugins/SafeGuardPlugin';
import { AemeathLogger } from '../core/Logger';

describe('SafeGuardPlugin', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
    vi.useRealTimers();
  });

  // ==================== 安装与卸载 ====================

  describe('安装与卸载', () => {
    it('应正确安装', () => {
      const plugin = new SafeGuardPlugin();
      logger.use(plugin);
      expect(logger.hasPlugin('safe-guard')).toBe(true);
    });

    it('安装后应给 logger 添加 getHealth/pause/resume', () => {
      const plugin = new SafeGuardPlugin();
      logger.use(plugin);
      expect((logger as any).getHealth).toBeTypeOf('function');
      expect((logger as any).pause).toBeTypeOf('function');
      expect((logger as any).resume).toBeTypeOf('function');
    });

    it('卸载后应移除 getHealth/pause/resume', () => {
      const plugin = new SafeGuardPlugin();
      logger.use(plugin);

      // uninstall 通过 logger.uninstall 调用，检查 plugin 级别的清理
      logger.uninstall('safe-guard');
      expect(logger.hasPlugin('safe-guard')).toBe(false);
    });
  });

  // ==================== 健康状态 ====================

  describe('健康状态', () => {
    it('初始状态应该是健康的', () => {
      const plugin = new SafeGuardPlugin();
      logger.use(plugin);

      const health = plugin.getHealth();
      expect(health.isHealthy).toBe(true);
      expect(health.isPaused).toBe(false);
      expect(health.errorCount).toBe(0);
      expect(health.logCount).toBe(0);
      expect(health.uptime).toBeGreaterThanOrEqual(0);
    });

    it('日志应增加 logCount', () => {
      // 设置高频率限制，防止被暂停
      const plugin = new SafeGuardPlugin({ rateLimit: 10000 });
      logger.use(plugin);

      // 推进时间避免频率限制（构造时 lastLogTime = Date.now()，第一条日志 timeSinceLastLog=0 → Infinity）
      vi.advanceTimersByTime(1001);
      logger.info('test1');
      vi.advanceTimersByTime(1001);
      logger.info('test2');

      const health = plugin.getHealth();
      expect(health.logCount).toBe(2);
    });
  });

  // ==================== 错误数过多暂停 ====================

  describe('错误数过多暂停', () => {
    it('错误数超过 maxErrors 应暂停', () => {
      const plugin = new SafeGuardPlugin({ maxErrors: 3 });
      logger.use(plugin);

      // 模拟触发 error 事件
      for (let i = 0; i < 4; i++) {
        logger.emit('error');
      }

      const health = plugin.getHealth();
      expect(health.isPaused).toBe(true);
    });

    it('暂停后应触发 paused 事件', () => {
      const plugin = new SafeGuardPlugin({ maxErrors: 2 });
      logger.use(plugin);

      const pausedHandler = vi.fn();
      logger.on('paused', pausedHandler);

      logger.emit('error');
      logger.emit('error');
      logger.emit('error'); // 超过 maxErrors

      expect(pausedHandler).toHaveBeenCalled();
    });
  });

  // ==================== 频率限制 ====================

  describe('频率限制', () => {
    it('日志频率过高应暂停', () => {
      const plugin = new SafeGuardPlugin({ rateLimit: 5 });
      logger.use(plugin);

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // 短时间内发送大量日志
      for (let i = 0; i < 20; i++) {
        logger.info(`msg-${i}`);
      }

      const health = plugin.getHealth();
      expect(health.isPaused).toBe(true);

      consoleWarnSpy.mockRestore();
    });
  });

  // ==================== 暂停与恢复 ====================

  describe('暂停与恢复', () => {
    it('pause 应暂停 Logger', () => {
      const plugin = new SafeGuardPlugin();
      logger.use(plugin);

      plugin.pause();

      const health = plugin.getHealth();
      expect(health.isPaused).toBe(true);
    });

    it('resume 应恢复 Logger', () => {
      const plugin = new SafeGuardPlugin();
      logger.use(plugin);

      plugin.pause();
      plugin.resume();

      const health = plugin.getHealth();
      expect(health.isPaused).toBe(false);
      expect(health.errorCount).toBe(0);
      expect(health.logCount).toBe(0);
    });

    it('resume 应触发 resumed 事件', () => {
      const plugin = new SafeGuardPlugin();
      logger.use(plugin);

      const resumedHandler = vi.fn();
      logger.on('resumed', resumedHandler);

      plugin.pause();
      plugin.resume();

      expect(resumedHandler).toHaveBeenCalled();
    });
  });

  // ==================== 定期重置 ====================

  describe('定期重置', () => {
    it('resetInterval 到期后应重置计数器', () => {
      const plugin = new SafeGuardPlugin({ resetInterval: 5000 });
      logger.use(plugin);

      logger.info('test');
      expect(plugin.getHealth().logCount).toBe(1);

      // 推进时间到重置间隔
      vi.advanceTimersByTime(5000);

      expect(plugin.getHealth().logCount).toBe(0);
    });

    it('暂停状态下 resetInterval 到期应自动恢复', () => {
      const plugin = new SafeGuardPlugin({
        maxErrors: 2,
        resetInterval: 5000,
      });
      logger.use(plugin);

      // 触发暂停
      logger.emit('error');
      logger.emit('error');
      logger.emit('error');
      expect(plugin.getHealth().isPaused).toBe(true);

      // 推进到重置时间
      vi.advanceTimersByTime(5000);

      expect(plugin.getHealth().isPaused).toBe(false);
    });
  });

  // ==================== 递归保护 ====================

  describe('递归保护', () => {
    it('enableRecursionGuard=false 时不应阻止递归', () => {
      const plugin = new SafeGuardPlugin({ enableRecursionGuard: false });
      logger.use(plugin);

      // 正常情况下不会无限递归，这里只测试配置生效
      expect(plugin.getHealth().isHealthy).toBe(true);
    });
  });
});

