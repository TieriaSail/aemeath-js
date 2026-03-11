/**
 * SafeGuardPlugin v2 测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SafeGuardPlugin } from '../src/plugins/SafeGuardPlugin';
import { AemeathLogger } from '../src/core/Logger';

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

    it('安装后应给 logger.extensions 添加 getHealth/pause/resume', () => {
      logger.use(new SafeGuardPlugin());
      expect(logger.extensions.getHealth).toBeTypeOf('function');
      expect(logger.extensions.pause).toBeTypeOf('function');
      expect(logger.extensions.resume).toBeTypeOf('function');
    });

    it('卸载后应移除插件', () => {
      logger.use(new SafeGuardPlugin());
      logger.uninstall('safe-guard');
      expect(logger.hasPlugin('safe-guard')).toBe(false);
    });

    it('默认模式应为 standard', () => {
      const plugin = new SafeGuardPlugin();
      logger.use(plugin);
      expect(plugin.getHealth().mode).toBe('standard');
    });
  });

  // ==================== 健康状态 ====================

  describe('健康状态', () => {
    it('初始状态应是 closed 且健康', () => {
      const plugin = new SafeGuardPlugin();
      logger.use(plugin);

      const health = plugin.getHealth();
      expect(health.state).toBe('closed');
      expect(health.isHealthy).toBe(true);
      expect(health.errorCount).toBe(0);
      expect(health.droppedCount).toBe(0);
      expect(health.mergedCount).toBe(0);
    });
  });

  // ==================== Guard 拦截机制 ====================

  describe('Guard 拦截机制', () => {
    it('正常频率日志应通过 guard 不被拦截', () => {
      logger.use(new SafeGuardPlugin({ rateLimit: 100 }));
      const listener = vi.fn();
      logger.on('log', listener);

      logger.info('hello');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('guard 拦截的日志不应触发 listener', () => {
      const plugin = new SafeGuardPlugin({ rateLimit: 5 });
      logger.use(plugin);
      const listener = vi.fn();
      logger.on('log', listener);

      vi.spyOn(console, 'warn').mockImplementation(() => {});

      // 超频后发送重复日志，重复的会被合并拦截
      for (let i = 0; i < 50; i++) {
        logger.info('repeated-msg');
      }

      // 首条通过，后续重复被合并，listener 收到的日志数应远少于 50
      expect(listener.mock.calls.length).toBeLessThan(50);

      vi.restoreAllMocks();
    });
  });

  // ==================== 递归保护 ====================

  describe('递归保护', () => {
    it('递归调用应被硬拦截', () => {
      const plugin = new SafeGuardPlugin({ rateLimit: 10000 });
      logger.use(plugin);

      let callCount = 0;
      logger.on('log', () => {
        callCount++;
        if (callCount < 10) {
          logger.info('recursive');
        }
      });

      logger.info('trigger');

      // beforeLog hook 会检测递归调用（isInBeforeLog 标记）
      // 关键是不会无限循环
      expect(callCount).toBeLessThan(100);
    });

    it('enableRecursionGuard=false 时不阻止（但不应死循环因为有频率限制）', () => {
      const plugin = new SafeGuardPlugin({
        enableRecursionGuard: false,
        rateLimit: 20,
      });
      logger.use(plugin);

      vi.spyOn(console, 'warn').mockImplementation(() => {});

      let callCount = 0;
      logger.on('log', () => {
        callCount++;
        if (callCount < 100) {
          logger.info('recursive');
        }
      });

      logger.info('trigger');

      // 频率限制会最终阻止
      expect(callCount).toBeLessThan(100);

      vi.restoreAllMocks();
    });
  });

  // ==================== Circuit Breaker ====================

  describe('Circuit Breaker', () => {
    it('错误数超过 maxErrors 应触发熔断（open）', () => {
      const plugin = new SafeGuardPlugin({ maxErrors: 3 });
      logger.use(plugin);

      vi.spyOn(console, 'error').mockImplementation(() => {});

      for (let i = 0; i < 4; i++) {
        logger.emit('error');
      }

      expect(plugin.getHealth().state).toBe('open');

      vi.restoreAllMocks();
    });

    it('open 状态应拦截所有日志', () => {
      const plugin = new SafeGuardPlugin({ maxErrors: 2 });
      logger.use(plugin);
      const listener = vi.fn();
      logger.on('log', listener);

      vi.spyOn(console, 'error').mockImplementation(() => {});

      // 触发熔断
      for (let i = 0; i < 3; i++) {
        logger.emit('error');
      }
      expect(plugin.getHealth().state).toBe('open');

      // open 状态下日志应被拦截
      logger.info('should be blocked');
      expect(listener).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it('冷却后应进入 half-open', () => {
      const plugin = new SafeGuardPlugin({ maxErrors: 2, cooldownPeriod: 5000 });
      logger.use(plugin);

      vi.spyOn(console, 'error').mockImplementation(() => {});

      for (let i = 0; i < 3; i++) {
        logger.emit('error');
      }
      expect(plugin.getHealth().state).toBe('open');

      vi.advanceTimersByTime(5000);
      expect(plugin.getHealth().state).toBe('half-open');

      vi.restoreAllMocks();
    });

    it('half-open 状态下成功通过日志应恢复为 closed', () => {
      const plugin = new SafeGuardPlugin({
        maxErrors: 2,
        cooldownPeriod: 5000,
        rateLimit: 100,
      });
      logger.use(plugin);
      const listener = vi.fn();
      logger.on('log', listener);

      vi.spyOn(console, 'error').mockImplementation(() => {});

      for (let i = 0; i < 3; i++) {
        logger.emit('error');
      }

      vi.advanceTimersByTime(5000);
      expect(plugin.getHealth().state).toBe('half-open');

      // half-open 状态下发一条正常日志
      logger.info('probe');
      expect(listener).toHaveBeenCalled();
      expect(plugin.getHealth().state).toBe('closed');

      vi.restoreAllMocks();
    });

    it('状态变化应触发 safeguard:stateChange 事件', () => {
      const plugin = new SafeGuardPlugin({ maxErrors: 2, cooldownPeriod: 5000 });
      logger.use(plugin);

      vi.spyOn(console, 'error').mockImplementation(() => {});

      const stateHandler = vi.fn();
      logger.on('safeguard:stateChange', stateHandler);

      for (let i = 0; i < 3; i++) {
        logger.emit('error');
      }

      expect(stateHandler).toHaveBeenCalledWith(
        expect.objectContaining({ from: 'closed', to: 'open' }),
      );

      vi.advanceTimersByTime(5000);
      expect(stateHandler).toHaveBeenCalledWith(
        expect.objectContaining({ from: 'open', to: 'half-open' }),
      );

      vi.restoreAllMocks();
    });
  });

  // ==================== 滑动窗口频率限制 ====================

  describe('滑动窗口频率限制', () => {
    it('超频时重复日志应被合并拦截', () => {
      const plugin = new SafeGuardPlugin({ rateLimit: 5 });
      logger.use(plugin);
      const listener = vi.fn();
      logger.on('log', listener);

      vi.spyOn(console, 'warn').mockImplementation(() => {});

      // 先发 5 条让频率正常通过，再发 15 条重复日志
      for (let i = 0; i < 5; i++) {
        logger.info(`unique-${i}`);
      }
      for (let i = 0; i < 15; i++) {
        logger.info('repeated-msg');
      }

      // 前 5 条 + 重复日志首条通过 = 6，后续重复被合并
      const callCount = listener.mock.calls.length;
      expect(callCount).toBeGreaterThan(5);
      expect(callCount).toBeLessThan(20);

      vi.restoreAllMocks();
    });

    it('超频应输出 console.warn 警告（仅一次）', () => {
      const plugin = new SafeGuardPlugin({ rateLimit: 3 });
      logger.use(plugin);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      for (let i = 0; i < 20; i++) {
        logger.info(`msg-${i}`);
      }

      const safeguardWarns = warnSpy.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('[SafeGuard]'),
      );
      expect(safeguardWarns.length).toBe(1);

      vi.restoreAllMocks();
    });

    it('窗口滑过后频率应重置', () => {
      const plugin = new SafeGuardPlugin({ rateLimit: 5 });
      logger.use(plugin);
      const listener = vi.fn();
      logger.on('log', listener);

      vi.spyOn(console, 'warn').mockImplementation(() => {});

      for (let i = 0; i < 10; i++) {
        logger.info(`burst-${i}`);
      }
      const countAfterBurst = listener.mock.calls.length;

      // 等待 1 秒，窗口滑过
      vi.advanceTimersByTime(1100);

      listener.mockClear();
      logger.info('after-window');
      expect(listener).toHaveBeenCalledTimes(1);

      vi.restoreAllMocks();
    });
  });

  // ==================== 重复日志合并 ====================

  describe('重复日志合并', () => {
    it('超频时重复日志应被合并', () => {
      const plugin = new SafeGuardPlugin({
        rateLimit: 3,
        mergeWindow: 2000,
      });
      logger.use(plugin);
      const listener = vi.fn();
      logger.on('log', listener);

      vi.spyOn(console, 'warn').mockImplementation(() => {});

      // 发送 20 条相同消息
      for (let i = 0; i < 20; i++) {
        logger.info('same message');
      }

      // 等待合并窗口 flush
      vi.advanceTimersByTime(2100);

      // 应该有合并后的摘要日志（带 repeatedCount tag）
      const mergedLogs = listener.mock.calls.filter(
        (args) => args[0]?.tags?.repeatedCount > 1,
      );
      expect(mergedLogs.length).toBeGreaterThanOrEqual(1);
      expect(plugin.getHealth().mergedCount).toBeGreaterThan(0);

      vi.restoreAllMocks();
    });
  });

  // ==================== 手动 pause/resume ====================

  describe('手动 pause/resume', () => {
    it('手动 pause 应切换到 open 状态', () => {
      const plugin = new SafeGuardPlugin();
      logger.use(plugin);

      (logger.extensions.pause as () => void)();
      expect(plugin.getHealth().state).toBe('open');
    });

    it('手动 resume 应切换到 closed 状态', () => {
      const plugin = new SafeGuardPlugin();
      logger.use(plugin);

      (logger.extensions.pause as () => void)();
      (logger.extensions.resume as () => void)();
      expect(plugin.getHealth().state).toBe('closed');
    });
  });

  // ==================== 三种模式 ====================

  describe('模式：standard', () => {
    it('被拦截的日志应直接丢弃，droppedCount 增加', () => {
      const plugin = new SafeGuardPlugin({ mode: 'standard', maxErrors: 2 });
      logger.use(plugin);

      vi.spyOn(console, 'error').mockImplementation(() => {});

      for (let i = 0; i < 3; i++) {
        logger.emit('error');
      }

      logger.info('blocked');
      expect(plugin.getHealth().droppedCount).toBeGreaterThan(0);
      expect(plugin.getHealth().parkingLotSize).toBe(0);

      vi.restoreAllMocks();
    });
  });

  describe('模式：cautious', () => {
    it('被拦截的日志应存入回收站', () => {
      const plugin = new SafeGuardPlugin({ mode: 'cautious', maxErrors: 2 });
      logger.use(plugin);

      vi.spyOn(console, 'error').mockImplementation(() => {});

      for (let i = 0; i < 3; i++) {
        logger.emit('error');
      }

      logger.info('parked-1');
      logger.info('parked-2');

      const health = plugin.getHealth();
      expect(health.parkingLotSize).toBeGreaterThan(0);

      vi.restoreAllMocks();
    });
  });

  describe('模式：strict', () => {
    it('应配置为 strict 模式', () => {
      const plugin = new SafeGuardPlugin({ mode: 'strict' });
      logger.use(plugin);
      expect(plugin.getHealth().mode).toBe('strict');
    });
  });

  // ==================== 统计信息 ====================

  describe('统计信息', () => {
    it('getHealth 应返回完整统计', () => {
      const plugin = new SafeGuardPlugin();
      logger.use(plugin);

      const health = plugin.getHealth();
      expect(health).toHaveProperty('state');
      expect(health).toHaveProperty('mode');
      expect(health).toHaveProperty('isHealthy');
      expect(health).toHaveProperty('currentRate');
      expect(health).toHaveProperty('errorCount');
      expect(health).toHaveProperty('droppedCount');
      expect(health).toHaveProperty('mergedCount');
      expect(health).toHaveProperty('parkingLotSize');
      expect(health).toHaveProperty('uptime');
    });
  });
});
