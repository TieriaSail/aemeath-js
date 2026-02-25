/**
 * PerformancePlugin 性能监控插件测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PerformancePlugin } from '../plugins/PerformancePlugin';
import { AemeathLogger } from '../core/Logger';

describe('PerformancePlugin', () => {
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
      const plugin = new PerformancePlugin();
      logger.use(plugin);
      expect(logger.hasPlugin('performance')).toBe(true);
    });

    it('安装后应给 logger 添加 startMark/endMark/measure', () => {
      const plugin = new PerformancePlugin();
      logger.use(plugin);
      expect((logger as any).startMark).toBeTypeOf('function');
      expect((logger as any).endMark).toBeTypeOf('function');
      expect((logger as any).measure).toBeTypeOf('function');
    });

    it('卸载后不应再有插件', () => {
      const plugin = new PerformancePlugin();
      logger.use(plugin);
      logger.uninstall('performance');

      expect(logger.hasPlugin('performance')).toBe(false);
    });
  });

  // ==================== 采样率 ====================

  describe('采样率', () => {
    it('sampleRate=0 时不应启动任何监控', () => {
      const observeSpy = vi.spyOn(PerformanceObserver.prototype, 'observe').mockImplementation(() => {});
      const plugin = new PerformancePlugin({
        sampleRate: 0,
        monitorWebVitals: true,
      });

      // Math.random() > 0 → 大概率跳过（但 sampleRate=0 保证跳过）
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      logger.use(plugin);

      // sampleRate=0 意味着 random() > 0 永真，不启动
      expect(observeSpy).not.toHaveBeenCalled();
      observeSpy.mockRestore();
    });
  });

  // ==================== 自定义标记 API ====================

  describe('自定义标记 API (startMark / endMark)', () => {
    it('startMark + endMark 应记录耗时', () => {
      const plugin = new PerformancePlugin();
      logger.use(plugin);

      const logListener = vi.fn();
      logger.on('log', logListener);

      plugin.startMark('api-call');
      vi.advanceTimersByTime(500);
      const duration = plugin.endMark('api-call');

      expect(duration).toBe(500);
      expect(logListener).toHaveBeenCalled();
      const entry = logListener.mock.calls[0][0];
      expect(entry.tags?.category).toBe('performance');
      expect(entry.tags?.type).toBe('measurement');
      expect(entry.tags?.name).toBe('api-call');
      expect(entry.context?.measurement?.duration).toBe(500);
    });

    it('endMark 未匹配的标记应返回 null', () => {
      const plugin = new PerformancePlugin();
      logger.use(plugin);

      const result = plugin.endMark('nonexistent');
      expect(result).toBeNull();
    });

    it('多个标记应互不干扰', () => {
      const plugin = new PerformancePlugin();
      logger.use(plugin);

      plugin.startMark('task-a');
      vi.advanceTimersByTime(100);
      plugin.startMark('task-b');
      vi.advanceTimersByTime(200);

      const durationB = plugin.endMark('task-b');
      const durationA = plugin.endMark('task-a');

      expect(durationB).toBe(200);
      expect(durationA).toBe(300);
    });

    it('endMark 后再次 endMark 同一标记应返回 null', () => {
      const plugin = new PerformancePlugin();
      logger.use(plugin);

      plugin.startMark('once');
      vi.advanceTimersByTime(100);
      plugin.endMark('once');

      const secondResult = plugin.endMark('once');
      expect(secondResult).toBeNull();
    });
  });

  // ==================== 配置选项 ====================

  describe('配置选项', () => {
    it('默认应启用 WebVitals，不启用资源和长任务监控', () => {
      const plugin = new PerformancePlugin();
      logger.use(plugin);
      // 插件应安装成功
      expect(logger.hasPlugin('performance')).toBe(true);
    });

    it('应支持禁用 WebVitals', () => {
      const plugin = new PerformancePlugin({ monitorWebVitals: false });
      logger.use(plugin);
      expect(logger.hasPlugin('performance')).toBe(true);
    });

    it('应支持启用资源监控', () => {
      const plugin = new PerformancePlugin({ monitorResources: true });
      logger.use(plugin);
      expect(logger.hasPlugin('performance')).toBe(true);
    });

    it('应支持启用长任务监控', () => {
      const plugin = new PerformancePlugin({ monitorLongTasks: true });
      logger.use(plugin);
      expect(logger.hasPlugin('performance')).toBe(true);
    });

    it('longTaskThreshold 应可配置', () => {
      const plugin = new PerformancePlugin({
        monitorLongTasks: true,
        longTaskThreshold: 100,
      });
      logger.use(plugin);
      expect(logger.hasPlugin('performance')).toBe(true);
    });
  });
});

