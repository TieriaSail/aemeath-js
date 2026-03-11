/**
 * PerformancePlugin 性能监控插件测试
 *
 * 测试策略：通过可控的 PerformanceObserver mock 模拟浏览器行为，
 * 使用 document visibilitychange 事件触发最终指标上报。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PerformancePlugin } from '../src/plugins/PerformancePlugin';
import { AemeathLogger } from '../src/core/Logger';
import type { LogEntry } from '../src/types';

// ==================== Mock 基础设施 ====================

type ObserverCallback = (list: { getEntries: () => any[] }) => void;
let registeredCallbacks: Map<string, ObserverCallback>;
let disconnectCalls: number;

function setupMocks() {
  registeredCallbacks = new Map();
  disconnectCalls = 0;

  // Mock PerformanceObserver — 使用 function 形式避免 vitest 警告
  vi.stubGlobal('PerformanceObserver', function MockPerformanceObserver(this: any, callback: ObserverCallback) {
    this._callback = callback;
    this.observe = function (opts: any) {
      registeredCallbacks.set(opts.type, callback);
    };
    this.disconnect = function () {
      disconnectCalls++;
    };
  });

  // Mock performance API
  vi.stubGlobal('performance', {
    getEntriesByType: vi.fn().mockReturnValue([]),
    getEntriesByName: vi.fn().mockReturnValue([]),
    mark: vi.fn(),
    measure: vi.fn(),
  });
}

function triggerEntries(type: string, entries: any[]) {
  const cb = registeredCallbacks.get(type);
  if (cb) {
    cb({ getEntries: () => entries });
  }
}

function triggerHidden() {
  Object.defineProperty(document, 'visibilityState', {
    value: 'hidden', writable: true, configurable: true,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

function resetVisibility() {
  Object.defineProperty(document, 'visibilityState', {
    value: 'visible', writable: true, configurable: true,
  });
}

// ==================== 测试 ====================

describe('PerformancePlugin', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    vi.useFakeTimers();
    resetVisibility();
    setupMocks();
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Helper: 获取特定 metric 的日志
  function getMetricLogs(listener: ReturnType<typeof vi.fn>, metricName: string) {
    return listener.mock.calls.filter(
      (c: any) => c[0]?.tags?.metric === metricName,
    );
  }

  function getTypeLogs(listener: ReturnType<typeof vi.fn>, type: string) {
    return listener.mock.calls.filter(
      (c: any) => c[0]?.tags?.type === type,
    );
  }

  // ==================== 安装与卸载 ====================

  describe('安装与卸载', () => {
    it('应正确安装', () => {
      logger.use(new PerformancePlugin());
      expect(logger.hasPlugin('performance')).toBe(true);
    });

    it('安装后应给 logger 添加 startMark/endMark/measure', () => {
      logger.use(new PerformancePlugin());
      expect(logger.extensions.startMark).toBeTypeOf('function');
      expect(logger.extensions.endMark).toBeTypeOf('function');
      expect(logger.extensions.measure).toBeTypeOf('function');
    });

    it('卸载后应清理 API', () => {
      logger.use(new PerformancePlugin());
      logger.uninstall('performance');

      expect(logger.hasPlugin('performance')).toBe(false);
      expect(logger.extensions.startMark).toBeUndefined();
      expect(logger.extensions.endMark).toBeUndefined();
      expect(logger.extensions.measure).toBeUndefined();
      expect(disconnectCalls).toBeGreaterThan(0);
    });
  });

  // ==================== 采样率 ====================

  describe('采样率', () => {
    it('sampleRate=0 时不应启动 observer，但 mark API 仍可用', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);

      logger.use(new PerformancePlugin({ sampleRate: 0 }));

      // 没有注册任何 observer
      expect(registeredCallbacks.size).toBe(0);

      // 但 mark API 仍可用
      expect(logger.extensions.startMark).toBeTypeOf('function');
      expect(logger.extensions.endMark).toBeTypeOf('function');
    });

    it('sampleRate=1 时应启动 observer', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);

      logger.use(new PerformancePlugin({ sampleRate: 1 }));

      // 至少注册了 Web Vitals 的 observer
      expect(registeredCallbacks.size).toBeGreaterThan(0);
    });
  });

  // ==================== LCP ====================

  describe('LCP', () => {
    it('LCP 触发时不应立即上报', () => {
      const listener = vi.fn();
      logger.on('log', listener);
      logger.use(new PerformancePlugin());

      triggerEntries('largest-contentful-paint', [
        { renderTime: 1500, loadTime: 1600 },
      ]);

      expect(getMetricLogs(listener, 'LCP')).toHaveLength(0);
    });

    it('visibilitychange 时应上报最后一个 LCP 值', () => {
      const listener = vi.fn();
      logger.on('log', listener);
      logger.use(new PerformancePlugin());

      // 浏览器多次触发 LCP（发现更大内容时）
      triggerEntries('largest-contentful-paint', [{ renderTime: 1500, loadTime: 1600 }]);
      triggerEntries('largest-contentful-paint', [{ renderTime: 2200, loadTime: 2300 }]);

      triggerHidden();

      const lcpLogs = getMetricLogs(listener, 'LCP');
      expect(lcpLogs).toHaveLength(1);
      expect(lcpLogs[0]![0].context.metric.value).toBe(2200);
      expect(lcpLogs[0]![0].context.metric.rating).toBe('good');
    });

    it('LCP 只上报一次（幂等）', () => {
      const listener = vi.fn();
      logger.on('log', listener);
      logger.use(new PerformancePlugin());

      triggerEntries('largest-contentful-paint', [{ renderTime: 1000, loadTime: 1100 }]);

      triggerHidden();
      resetVisibility();
      triggerHidden();

      expect(getMetricLogs(listener, 'LCP')).toHaveLength(1);
    });
  });

  // ==================== INP ====================

  describe('INP', () => {
    it('应在 visibilitychange 时上报最慢的交互延迟', () => {
      const listener = vi.fn();
      logger.on('log', listener);
      logger.use(new PerformancePlugin());

      triggerEntries('event', [
        { interactionId: 1, duration: 80 },
        { interactionId: 2, duration: 250 },
        { interactionId: 3, duration: 120 },
      ]);

      triggerHidden();

      const inpLogs = getMetricLogs(listener, 'INP');
      expect(inpLogs).toHaveLength(1);
      expect(inpLogs[0]![0].context.metric.value).toBe(250);
      expect(inpLogs[0]![0].context.metric.rating).toBe('needs-improvement');
    });

    it('无交互时不应上报 INP', () => {
      const listener = vi.fn();
      logger.on('log', listener);
      logger.use(new PerformancePlugin());

      triggerHidden();

      expect(getMetricLogs(listener, 'INP')).toHaveLength(0);
    });

    it('interactionId 为 0 或 undefined 的事件应被忽略', () => {
      const listener = vi.fn();
      logger.on('log', listener);
      logger.use(new PerformancePlugin());

      triggerEntries('event', [
        { interactionId: 0, duration: 999 },
        { duration: 888 },
        { interactionId: 1, duration: 100 },
      ]);

      triggerHidden();

      const inpLogs = getMetricLogs(listener, 'INP');
      expect(inpLogs).toHaveLength(1);
      expect(inpLogs[0]![0].context.metric.value).toBe(100);
    });

    it('INP ≤200ms 应评级为 good', () => {
      const listener = vi.fn();
      logger.on('log', listener);
      logger.use(new PerformancePlugin());

      triggerEntries('event', [{ interactionId: 1, duration: 150 }]);
      triggerHidden();

      const inpLogs = getMetricLogs(listener, 'INP');
      expect(inpLogs[0]![0].context.metric.rating).toBe('good');
    });

    it('INP >500ms 应评级为 poor', () => {
      const listener = vi.fn();
      logger.on('log', listener);
      logger.use(new PerformancePlugin());

      triggerEntries('event', [{ interactionId: 1, duration: 600 }]);
      triggerHidden();

      const inpLogs = getMetricLogs(listener, 'INP');
      expect(inpLogs[0]![0].context.metric.rating).toBe('poor');
    });
  });

  // ==================== CLS (Session Window) ====================

  describe('CLS (Session Window)', () => {
    it('应取最大 session window 值', () => {
      const listener = vi.fn();
      logger.on('log', listener);
      logger.use(new PerformancePlugin());

      // Session 1: 间隔 <1s → 同一 session
      triggerEntries('layout-shift', [{ hadRecentInput: false, value: 0.05, startTime: 1000 }]);
      triggerEntries('layout-shift', [{ hadRecentInput: false, value: 0.08, startTime: 1500 }]);
      // session 1 total = 0.13

      // 间隔 >1s → 新 session
      triggerEntries('layout-shift', [{ hadRecentInput: false, value: 0.02, startTime: 3000 }]);
      // session 2 total = 0.02

      triggerHidden();

      const clsLogs = getMetricLogs(listener, 'CLS');
      expect(clsLogs).toHaveLength(1);
      expect(clsLogs[0]![0].context.metric.value).toBe(0.13);
    });

    it('hadRecentInput=true 的 shift 应被忽略', () => {
      const listener = vi.fn();
      logger.on('log', listener);
      logger.use(new PerformancePlugin());

      triggerEntries('layout-shift', [{ hadRecentInput: true, value: 0.5, startTime: 1000 }]);

      triggerHidden();

      const clsLogs = getMetricLogs(listener, 'CLS');
      expect(clsLogs).toHaveLength(1);
      expect(clsLogs[0]![0].context.metric.value).toBe(0);
    });

    it('CLS 只上报一次', () => {
      const listener = vi.fn();
      logger.on('log', listener);
      logger.use(new PerformancePlugin());

      triggerEntries('layout-shift', [{ hadRecentInput: false, value: 0.05, startTime: 1000 }]);

      triggerHidden();
      resetVisibility();
      triggerHidden();

      expect(getMetricLogs(listener, 'CLS')).toHaveLength(1);
    });
  });

  // ==================== FCP ====================

  describe('FCP', () => {
    it('应立即上报 FCP', () => {
      const listener = vi.fn();
      logger.on('log', listener);
      logger.use(new PerformancePlugin());

      triggerEntries('paint', [{ name: 'first-contentful-paint', startTime: 850 }]);

      const fcpLogs = getMetricLogs(listener, 'FCP');
      expect(fcpLogs).toHaveLength(1);
      expect(fcpLogs[0]![0].context.metric.value).toBe(850);
      expect(fcpLogs[0]![0].context.metric.rating).toBe('good');
    });

    it('FCP >3000ms 应评级为 poor', () => {
      const listener = vi.fn();
      logger.on('log', listener);
      logger.use(new PerformancePlugin());

      triggerEntries('paint', [{ name: 'first-contentful-paint', startTime: 3500 }]);

      const fcpLogs = getMetricLogs(listener, 'FCP');
      expect(fcpLogs[0]![0].context.metric.rating).toBe('poor');
    });

    it('非 FCP 的 paint entry 应被忽略', () => {
      const listener = vi.fn();
      logger.on('log', listener);
      logger.use(new PerformancePlugin());

      triggerEntries('paint', [{ name: 'first-paint', startTime: 300 }]);

      expect(getMetricLogs(listener, 'FCP')).toHaveLength(0);
    });
  });

  // ==================== TTFB ====================

  describe('TTFB', () => {
    it('有 navigation entry 时应上报 TTFB', () => {
      (performance.getEntriesByType as any).mockReturnValue([
        { responseStart: 150, requestStart: 10 },
      ]);

      const listener = vi.fn();
      logger.on('log', listener);
      logger.use(new PerformancePlugin());

      const ttfbLogs = getMetricLogs(listener, 'TTFB');
      expect(ttfbLogs).toHaveLength(1);
      expect(ttfbLogs[0]![0].context.metric.value).toBe(140);
      expect(ttfbLogs[0]![0].context.metric.rating).toBe('good');
    });

    it('无 navigation entry 时不应上报', () => {
      const listener = vi.fn();
      logger.on('log', listener);
      logger.use(new PerformancePlugin());

      expect(getMetricLogs(listener, 'TTFB')).toHaveLength(0);
    });
  });

  // ==================== 慢资源监控 ====================

  describe('慢资源监控', () => {
    it('超过阈值的资源应记录为 warn', () => {
      const listener = vi.fn();
      logger.on('log', listener);
      logger.use(new PerformancePlugin({
        monitorResources: true,
        slowResourceThreshold: 500,
      }));

      triggerEntries('resource', [
        { name: 'https://cdn.example.com/large.js', initiatorType: 'script', duration: 800, transferSize: 102400 },
      ]);

      const logs = getTypeLogs(listener, 'slow-resource');
      expect(logs).toHaveLength(1);
      expect(logs[0]![0].level).toBe('warn');
      expect(logs[0]![0].context.resource.duration).toBe(800);
    });

    it('低于阈值的资源不应记录', () => {
      const listener = vi.fn();
      logger.on('log', listener);
      logger.use(new PerformancePlugin({
        monitorResources: true,
        slowResourceThreshold: 500,
      }));

      triggerEntries('resource', [
        { name: 'small.js', initiatorType: 'script', duration: 200, transferSize: 1024 },
      ]);

      expect(getTypeLogs(listener, 'slow-resource')).toHaveLength(0);
    });

    it('默认阈值为 1000ms', () => {
      const listener = vi.fn();
      logger.on('log', listener);
      logger.use(new PerformancePlugin({ monitorResources: true }));

      triggerEntries('resource', [
        { name: 'mid.js', duration: 900, initiatorType: 'script', transferSize: 0 },
      ]);
      expect(getTypeLogs(listener, 'slow-resource')).toHaveLength(0);

      triggerEntries('resource', [
        { name: 'slow.js', duration: 1100, initiatorType: 'script', transferSize: 0 },
      ]);
      expect(getTypeLogs(listener, 'slow-resource')).toHaveLength(1);
    });
  });

  // ==================== 长任务监控 ====================

  describe('长任务监控', () => {
    it('超过阈值的长任务应记录', () => {
      const listener = vi.fn();
      logger.on('log', listener);
      logger.use(new PerformancePlugin({
        monitorLongTasks: true,
        longTaskThreshold: 100,
      }));

      triggerEntries('longtask', [
        { duration: 150, startTime: 5000, name: 'self' },
      ]);

      const logs = getTypeLogs(listener, 'long-task');
      expect(logs).toHaveLength(1);
      expect(logs[0]![0].level).toBe('warn');
    });

    it('低于阈值的长任务不应记录', () => {
      const listener = vi.fn();
      logger.on('log', listener);
      logger.use(new PerformancePlugin({
        monitorLongTasks: true,
        longTaskThreshold: 100,
      }));

      triggerEntries('longtask', [{ duration: 80, startTime: 1000, name: 'self' }]);

      expect(getTypeLogs(listener, 'long-task')).toHaveLength(0);
    });
  });

  // ==================== 自定义标记 API ====================

  describe('自定义标记 API (startMark / endMark)', () => {
    it('startMark + endMark 应记录耗时', () => {
      const plugin = new PerformancePlugin();
      logger.use(plugin);
      const listener = vi.fn();
      logger.on('log', listener);

      plugin.startMark('api-call');
      vi.advanceTimersByTime(500);
      const duration = plugin.endMark('api-call');

      expect(duration).toBe(500);
      expect(listener).toHaveBeenCalled();
      const entry = listener.mock.calls[0]![0] as LogEntry;
      expect(entry.tags?.category).toBe('performance');
      expect(entry.tags?.type).toBe('measurement');
      expect(entry.tags?.name).toBe('api-call');
      expect(entry.context?.measurement?.duration).toBe(500);
    });

    it('endMark 未匹配的标记应返回 null', () => {
      logger.use(new PerformancePlugin());
      const plugin = logger.getPlugins().find(p => p.name === 'performance');
      // 通过实例测试
      const p = new PerformancePlugin();
      logger.destroy();
      logger = new AemeathLogger({ enableConsole: false });
      logger.use(p);
      expect(p.endMark('nonexistent')).toBeNull();
    });

    it('多个标记应互不干扰', () => {
      const plugin = new PerformancePlugin();
      logger.use(plugin);

      plugin.startMark('task-a');
      vi.advanceTimersByTime(100);
      plugin.startMark('task-b');
      vi.advanceTimersByTime(200);

      expect(plugin.endMark('task-b')).toBe(200);
      expect(plugin.endMark('task-a')).toBe(300);
    });

    it('endMark 后再次 endMark 同一标记应返回 null', () => {
      const plugin = new PerformancePlugin();
      logger.use(plugin);

      plugin.startMark('once');
      vi.advanceTimersByTime(100);
      plugin.endMark('once');

      expect(plugin.endMark('once')).toBeNull();
    });
  });

  // ==================== 日志消息格式 ====================

  describe('日志消息格式', () => {
    it('Web Vitals 日志消息应为英文 key', () => {
      const listener = vi.fn();
      logger.on('log', listener);
      logger.use(new PerformancePlugin());

      triggerEntries('paint', [{ name: 'first-contentful-paint', startTime: 850 }]);

      const entry = listener.mock.calls[0]![0] as LogEntry;
      expect(entry.message).toBe('[performance] web-vital');
    });

    it('慢资源日志消息应为英文 key', () => {
      const listener = vi.fn();
      logger.on('log', listener);
      logger.use(new PerformancePlugin({ monitorResources: true, slowResourceThreshold: 100 }));

      triggerEntries('resource', [
        { name: 'big.js', initiatorType: 'script', duration: 500, transferSize: 0 },
      ]);

      const entry = listener.mock.calls[0]![0] as LogEntry;
      expect(entry.message).toBe('[performance] slow-resource');
    });

    it('长任务日志消息应为英文 key', () => {
      const listener = vi.fn();
      logger.on('log', listener);
      logger.use(new PerformancePlugin({ monitorLongTasks: true }));

      triggerEntries('longtask', [{ duration: 150, startTime: 5000, name: 'self' }]);

      const entry = listener.mock.calls[0]![0] as LogEntry;
      expect(entry.message).toBe('[performance] long-task');
    });

    it('手动测量日志消息应为英文 key', () => {
      const plugin = new PerformancePlugin();
      logger.use(plugin);
      const listener = vi.fn();
      logger.on('log', listener);

      plugin.startMark('test-mark');
      vi.advanceTimersByTime(100);
      plugin.endMark('test-mark');

      const entry = listener.mock.calls[0]![0] as LogEntry;
      expect(entry.message).toBe('[performance] measurement');
    });
  });

  // ==================== 安全性 ====================

  describe('安全性（不报错不影响业务）', () => {
    it('PerformanceObserver 不可用时应静默降级', () => {
      vi.stubGlobal('PerformanceObserver', undefined);
      expect(() => logger.use(new PerformancePlugin())).not.toThrow();
      expect(logger.hasPlugin('performance')).toBe(true);
    });

    it('observer.observe 抛出异常时应静默降级', () => {
      vi.stubGlobal('PerformanceObserver', function (this: any) {
        this.observe = () => { throw new Error('not supported'); };
        this.disconnect = () => {};
      });
      expect(() => logger.use(new PerformancePlugin())).not.toThrow();
    });

    it('performance API 不可用时 mark/endMark 仍应工作', () => {
      vi.stubGlobal('performance', undefined);

      const plugin = new PerformancePlugin();
      logger.use(plugin);

      plugin.startMark('test');
      vi.advanceTimersByTime(50);
      expect(() => plugin.endMark('test')).not.toThrow();
    });

    it('回调抛出异常不应影响后续 entry', () => {
      const listener = vi.fn();
      logger.on('log', listener);
      logger.use(new PerformancePlugin({ monitorResources: true, slowResourceThreshold: 100 }));

      // 第一个 entry 正常，第二个 duration 是字符串（异常数据）
      triggerEntries('resource', [
        { name: 'a.js', duration: 200, initiatorType: 'script', transferSize: 0 },
      ]);

      // 不应抛出
      expect(() => {
        triggerEntries('resource', [
          { name: null, duration: null, initiatorType: null, transferSize: null },
        ]);
      }).not.toThrow();
    });
  });

  // ==================== 配置项 ====================

  describe('配置项', () => {
    it('默认应启用 WebVitals，不启用资源和长任务', () => {
      logger.use(new PerformancePlugin());
      // Web Vitals: largest-contentful-paint, event, layout-shift, paint
      expect(registeredCallbacks.has('largest-contentful-paint')).toBe(true);
      expect(registeredCallbacks.has('layout-shift')).toBe(true);
      expect(registeredCallbacks.has('paint')).toBe(true);
      // 不应有 resource / longtask
      expect(registeredCallbacks.has('resource')).toBe(false);
      expect(registeredCallbacks.has('longtask')).toBe(false);
    });

    it('monitorWebVitals=false 时不应注册 Web Vitals observer', () => {
      logger.use(new PerformancePlugin({ monitorWebVitals: false }));
      expect(registeredCallbacks.has('largest-contentful-paint')).toBe(false);
      expect(registeredCallbacks.has('layout-shift')).toBe(false);
      expect(registeredCallbacks.has('event')).toBe(false);
      expect(registeredCallbacks.has('paint')).toBe(false);
    });

    it('细粒度 WebVitals: 只启用 LCP 和 FCP', () => {
      logger.use(new PerformancePlugin({
        monitorWebVitals: { lcp: true, inp: false, cls: false, fcp: true, ttfb: false },
      }));
      expect(registeredCallbacks.has('largest-contentful-paint')).toBe(true);
      expect(registeredCallbacks.has('paint')).toBe(true);
      expect(registeredCallbacks.has('event')).toBe(false);
      expect(registeredCallbacks.has('layout-shift')).toBe(false);
    });

    it('细粒度 WebVitals: 只关闭 CLS', () => {
      logger.use(new PerformancePlugin({
        monitorWebVitals: { cls: false },
      }));
      expect(registeredCallbacks.has('largest-contentful-paint')).toBe(true);
      expect(registeredCallbacks.has('event')).toBe(true);
      expect(registeredCallbacks.has('paint')).toBe(true);
      expect(registeredCallbacks.has('layout-shift')).toBe(false);
    });

    it('细粒度 WebVitals: 全部关闭等同于 false', () => {
      logger.use(new PerformancePlugin({
        monitorWebVitals: { lcp: false, inp: false, cls: false, fcp: false, ttfb: false },
      }));
      expect(registeredCallbacks.size).toBe(0);
    });

    it('monitorResources=true 时应注册 resource observer', () => {
      logger.use(new PerformancePlugin({ monitorResources: true }));
      expect(registeredCallbacks.has('resource')).toBe(true);
    });

    it('monitorLongTasks=true 时应注册 longtask observer', () => {
      logger.use(new PerformancePlugin({ monitorLongTasks: true }));
      expect(registeredCallbacks.has('longtask')).toBe(true);
    });
  });
});
