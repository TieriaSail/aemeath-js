/**
 * Performance monitoring plugin — Web Vitals & custom metrics
 *
 * Design principles:
 * 1. Lightweight: zero dependencies, pure PerformanceObserver API
 * 2. Safe: all browser API calls are wrapped in try/catch, never breaks the app
 * 3. Accurate: LCP/CLS/INP report final values on visibilitychange, no noise
 * 4. Modern: uses INP (replaced FID as Core Web Vital since 2024)
 */

import type { AemeathPlugin, AemeathInterface } from '../types';
import { RouteMatcher, type RouteMatchConfig } from '../utils/routeMatcher';

export interface WebVitalsOptions {
  /** Monitor LCP @default true */
  lcp?: boolean;
  /** Monitor INP @default true */
  inp?: boolean;
  /** Monitor CLS @default true */
  cls?: boolean;
  /** Monitor FCP @default true */
  fcp?: boolean;
  /** Monitor TTFB @default true */
  ttfb?: boolean;
}

export interface PerformancePluginOptions {
  /**
   * Web Vitals monitoring.
   * - `true` (default): monitor all Web Vitals
   * - `false`: disable all Web Vitals
   * - `WebVitalsOptions`: fine-grained control per metric
   */
  monitorWebVitals?: boolean | WebVitalsOptions;

  /** Monitor slow resource loading @default false */
  monitorResources?: boolean;

  /** Monitor long tasks (main thread blocking) @default false */
  monitorLongTasks?: boolean;

  /** Long task threshold (ms) @default 50 */
  longTaskThreshold?: number;

  /** Slow resource threshold (ms) @default 1000 */
  slowResourceThreshold?: number;

  /** Sampling rate for auto-collection (0-1), does not affect manual mark/measure @default 1 */
  sampleRate?: number;

  /**
   * 插件级路由匹配配置
   * 在全局 routeMatch 基础上进一步限定性能监控的路由范围
   */
  routeMatch?: RouteMatchConfig;
}

interface PerformanceMetric {
  name: string;
  value: number;
  rating: 'good' | 'needs-improvement' | 'poor';
  delta?: number;
}

interface ResolvedConfig {
  vitals: Required<WebVitalsOptions>;
  monitorResources: boolean;
  monitorLongTasks: boolean;
  longTaskThreshold: number;
  slowResourceThreshold: number;
  sampleRate: number;
}

export class PerformancePlugin implements AemeathPlugin {
  readonly name = 'performance';
  readonly version = '1.2.0';
  readonly description = 'Performance monitoring';

  private readonly config: ResolvedConfig;
  private readonly pluginRouteMatch: RouteMatchConfig | undefined;
  private routeMatcher!: RouteMatcher;
  private logger: AemeathInterface | null = null;
  private observers: PerformanceObserver[] = [];
  private readonly marks: Map<string, number> = new Map();

  private lcpValue: number = -1;
  private lcpReported = false;

  private clsSessionValue = 0;
  private clsSessionEntries: number[] = [];
  private clsMaxSessionValue = 0;
  private clsLastEntryTime = 0;
  private clsReported = false;

  private inpWorstLatency = 0;
  private inpReported = false;

  private sampled = true;
  private boundOnHidden: (() => void) | null = null;

  constructor(options: PerformancePluginOptions = {}) {
    const mwv = options.monitorWebVitals;
    let vitals: Required<WebVitalsOptions>;
    if (mwv === false) {
      vitals = { lcp: false, inp: false, cls: false, fcp: false, ttfb: false };
    } else if (typeof mwv === 'object') {
      vitals = {
        lcp: mwv.lcp ?? true,
        inp: mwv.inp ?? true,
        cls: mwv.cls ?? true,
        fcp: mwv.fcp ?? true,
        ttfb: mwv.ttfb ?? true,
      };
    } else {
      vitals = { lcp: true, inp: true, cls: true, fcp: true, ttfb: true };
    }

    this.config = {
      vitals,
      monitorResources: options.monitorResources ?? false,
      monitorLongTasks: options.monitorLongTasks ?? false,
      longTaskThreshold: options.longTaskThreshold ?? 50,
      slowResourceThreshold: options.slowResourceThreshold ?? 1000,
      sampleRate: options.sampleRate ?? 1,
    };
    this.pluginRouteMatch = options.routeMatch;
  }

  install(logger: AemeathInterface): void {
    this.logger = logger;

    this.routeMatcher = RouteMatcher.compose(
      logger.routeMatcher,
      this.pluginRouteMatch,
      { debugPrefix: '[PerformancePlugin]' },
    );

    // 手动 mark/measure API 始终可用，不受采样率限制
    (logger as any).startMark = this.startMark.bind(this);
    (logger as any).endMark = this.endMark.bind(this);
    (logger as any).measure = this.measure.bind(this);

    // 自动采集受采样率控制
    this.sampled = Math.random() < this.config.sampleRate;
    if (!this.sampled) {
      return;
    }

    const v = this.config.vitals;
    if (v.lcp || v.inp || v.cls || v.fcp || v.ttfb) {
      this.monitorWebVitals();
    }

    if (this.config.monitorResources) {
      this.monitorResources();
    }

    if (this.config.monitorLongTasks) {
      this.monitorLongTasks();
    }
  }

  uninstall(logger: AemeathInterface): void {
    // 断开所有 PerformanceObserver
    for (const observer of this.observers) {
      try { observer.disconnect(); } catch { /* safe */ }
    }
    this.observers = [];

    // 清理 visibilitychange 监听
    if (this.boundOnHidden) {
      try {
        document.removeEventListener('visibilitychange', this.boundOnHidden);
      } catch { /* safe: SSR */ }
      this.boundOnHidden = null;
    }

    this.marks.clear();
    this.logger = null;

    // 重置状态
    this.lcpValue = -1;
    this.lcpReported = false;
    this.clsSessionValue = 0;
    this.clsSessionEntries = [];
    this.clsMaxSessionValue = 0;
    this.clsLastEntryTime = 0;
    this.clsReported = false;
    this.inpWorstLatency = 0;
    this.inpReported = false;

    delete (logger as any).startMark;
    delete (logger as any).endMark;
    delete (logger as any).measure;
  }

  // ==================== Web Vitals ====================

  private monitorWebVitals(): void {
    if (typeof window === 'undefined' || !('PerformanceObserver' in window)) {
      return;
    }

    const v = this.config.vitals;
    if (v.lcp) this.observeLCP();
    if (v.inp) this.observeINP();
    if (v.cls) this.observeCLS();
    if (v.fcp) this.observeFCP();
    if (v.ttfb) this.observeTTFB();

    // LCP/CLS/INP are cumulative — report final values when page is hidden
    if (v.lcp || v.inp || v.cls) {
      this.boundOnHidden = () => {
        if (document.visibilityState === 'hidden') {
          this.flushFinalMetrics();
        }
      };
      try {
        document.addEventListener('visibilitychange', this.boundOnHidden);
      } catch { /* safe: SSR */ }
    }
  }

  /**
   * 页面隐藏时上报累积型指标的最终值
   * LCP、CLS、INP 都属于"需要等到最后才知道最终值"的指标
   */
  private flushFinalMetrics(): void {
    // LCP: 上报最后一个候选值
    if (!this.lcpReported && this.lcpValue >= 0) {
      this.lcpReported = true;
      this.reportMetric({
        name: 'LCP',
        value: this.lcpValue,
        rating: this.rateLCP(this.lcpValue),
      });
    }

    // CLS: 上报最大 session window 值
    if (!this.clsReported) {
      this.clsReported = true;
      // 最终的 session 可能还没结算，取 max
      const finalCLS = Math.max(this.clsMaxSessionValue, this.clsSessionValue);
      this.reportMetric({
        name: 'CLS',
        value: Math.round(finalCLS * 10000) / 10000,
        rating: this.rateCLS(finalCLS),
      });
    }

    // INP: 上报最慢交互延迟
    if (!this.inpReported && this.inpWorstLatency > 0) {
      this.inpReported = true;
      this.reportMetric({
        name: 'INP',
        value: this.inpWorstLatency,
        rating: this.rateINP(this.inpWorstLatency),
      });
    }
  }

  /**
   * LCP (Largest Contentful Paint)
   * 浏览器会在找到更大元素时多次触发，只缓存不上报
   */
  private observeLCP(): void {
    this.observeMetric('largest-contentful-paint', (entry: any) => {
      const value = entry.renderTime || entry.loadTime;
      if (typeof value === 'number' && value > 0) {
        this.lcpValue = value;
      }
    });
  }

  /**
   * INP (Interaction to Next Paint) - 2024 年起替代 FID 的核心指标
   *
   * 通过 event timing API 监控所有用户交互（click, keydown, pointerdown 等），
   * 取最慢交互的 duration 作为 INP 值。
   *
   * durationThreshold: 16 表示只关注 >16ms 的事件（一帧），
   * 减少回调次数以降低自身性能开销。
   */
  private observeINP(): void {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const e = entry as any;
          // interactionId > 0 表示这是一个真实的用户交互事件
          if (e.interactionId && e.interactionId > 0 && e.duration > this.inpWorstLatency) {
            this.inpWorstLatency = e.duration;
          }
        }
      });
      observer.observe({ type: 'event', buffered: true, durationThreshold: 16 } as any);
      this.observers.push(observer);
    } catch {
      // 浏览器不支持 event timing — 静默降级
    }
  }

  /**
   * CLS (Cumulative Layout Shift) — Session Window 算法
   *
   * Google 标准算法：
   * - 将 layout shift 按时间分组为 session window
   * - 同一 session 内相邻 shift 间隔 ≤1s，session 总时长 ≤5s
   * - 取所有 session 中得分最高的那个作为 CLS 值
   */
  private observeCLS(): void {
    this.observeMetric('layout-shift', (entry: any) => {
      if (entry.hadRecentInput) return;

      const now = entry.startTime;
      const gap = now - this.clsLastEntryTime;

      // 新 session：间隔 >1s 或当前 session 已超 5s
      if (gap > 1000 || (this.clsSessionEntries.length > 0 && now - this.clsSessionEntries[0]! > 5000)) {
        // 结算上一个 session
        if (this.clsSessionValue > this.clsMaxSessionValue) {
          this.clsMaxSessionValue = this.clsSessionValue;
        }
        // 开始新 session
        this.clsSessionValue = 0;
        this.clsSessionEntries = [];
      }

      this.clsSessionValue += entry.value;
      this.clsSessionEntries.push(now);
      this.clsLastEntryTime = now;
    });
  }

  /**
   * FCP (First Contentful Paint) — 一次性指标，立即上报
   */
  private observeFCP(): void {
    this.observeMetric('paint', (entry: any) => {
      if (entry.name === 'first-contentful-paint') {
        this.reportMetric({
          name: 'FCP',
          value: entry.startTime,
          rating: this.rateFCP(entry.startTime),
        });
      }
    });
  }

  /**
   * TTFB (Time to First Byte) — 一次性指标，立即上报
   */
  private observeTTFB(): void {
    try {
      if (typeof window === 'undefined' || !('performance' in window)) return;

      const navEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      if (navEntry && navEntry.responseStart > 0) {
        const ttfb = navEntry.responseStart - navEntry.requestStart;
        if (ttfb >= 0) {
          this.reportMetric({
            name: 'TTFB',
            value: ttfb,
            rating: this.rateTTFB(ttfb),
          });
        }
      }
    } catch { /* safe */ }
  }

  // ==================== 资源 & 长任务 ====================

  private monitorResources(): void {
    if (typeof window === 'undefined' || !('PerformanceObserver' in window)) {
      return;
    }

    this.observeMetric('resource', (entry: any) => {
      if (entry.duration > this.config.slowResourceThreshold && this.routeMatcher.shouldCapture()) {
        this.logger?.warn('[performance] slow-resource', {
          tags: { category: 'performance', type: 'slow-resource' },
          context: {
            resource: {
              name: entry.name,
              type: entry.initiatorType,
              duration: Math.round(entry.duration),
              size: entry.transferSize,
            },
          },
        });
      }
    });
  }

  private monitorLongTasks(): void {
    if (typeof window === 'undefined' || !('PerformanceObserver' in window)) {
      return;
    }

    this.observeMetric('longtask', (entry: any) => {
      if (entry.duration > this.config.longTaskThreshold && this.routeMatcher.shouldCapture()) {
        this.logger?.warn('[performance] long-task', {
          tags: { category: 'performance', type: 'long-task' },
          context: {
            task: {
              duration: Math.round(entry.duration),
              startTime: Math.round(entry.startTime),
              name: entry.name,
            },
          },
        });
      }
    });
  }

  // ==================== 通用 ====================

  private observeMetric(type: string, callback: (entry: any) => void): void {
    try {
      const observer = new PerformanceObserver((list) => {
        try {
          for (const entry of list.getEntries()) {
            callback(entry);
          }
        } catch { /* 回调内异常不外泄 */ }
      });
      observer.observe({ type, buffered: true });
      this.observers.push(observer);
    } catch {
      // 浏览器不支持该指标类型 — 静默降级
    }
  }

  private reportMetric(metric: PerformanceMetric): void {
    if (!this.routeMatcher.shouldCapture()) {
      return;
    }
    try {
      this.logger?.info('[performance] web-vital', {
        tags: {
          category: 'performance',
          metric: metric.name,
          rating: metric.rating,
        },
        context: { metric },
      });
    } catch { /* safe */ }
  }

  // ==================== 评级标准 ====================

  private rateLCP(value: number): 'good' | 'needs-improvement' | 'poor' {
    if (value <= 2500) return 'good';
    if (value <= 4000) return 'needs-improvement';
    return 'poor';
  }

  private rateINP(value: number): 'good' | 'needs-improvement' | 'poor' {
    if (value <= 200) return 'good';
    if (value <= 500) return 'needs-improvement';
    return 'poor';
  }

  private rateCLS(value: number): 'good' | 'needs-improvement' | 'poor' {
    if (value <= 0.1) return 'good';
    if (value <= 0.25) return 'needs-improvement';
    return 'poor';
  }

  private rateFCP(value: number): 'good' | 'needs-improvement' | 'poor' {
    if (value <= 1800) return 'good';
    if (value <= 3000) return 'needs-improvement';
    return 'poor';
  }

  private rateTTFB(value: number): 'good' | 'needs-improvement' | 'poor' {
    if (value <= 800) return 'good';
    if (value <= 1800) return 'needs-improvement';
    return 'poor';
  }

  // ==================== 自定义性能标记 API ====================

  startMark(name: string): void {
    this.marks.set(name, Date.now());
    try {
      if (typeof window !== 'undefined' && 'performance' in window) {
        performance.mark(`${name}-start`);
      }
    } catch { /* safe */ }
  }

  endMark(name: string): number | null {
    const startTime = this.marks.get(name);
    if (startTime === undefined) {
      return null;
    }

    const duration = Date.now() - startTime;
    this.marks.delete(name);

    try {
      if (typeof window !== 'undefined' && 'performance' in window) {
        performance.mark(`${name}-end`);
        performance.measure(name, `${name}-start`, `${name}-end`);
      }
    } catch { /* safe */ }

    try {
      this.logger?.info('[performance] measurement', {
        tags: { category: 'performance', type: 'measurement', name },
        context: {
          measurement: { name, duration, timestamp: Date.now() },
        },
      });
    } catch { /* safe */ }

    return duration;
  }

  measure(name: string, startMark: string, endMark: string): number | null {
    try {
      if (typeof window === 'undefined' || !('performance' in window)) {
        return null;
      }

      performance.measure(name, startMark, endMark);
      const measures = performance.getEntriesByName(name, 'measure');
      if (measures.length > 0) {
        const duration = measures[measures.length - 1]!.duration;
        this.logger?.info('[performance] measurement', {
          tags: { category: 'performance', type: 'measurement', name },
          context: {
            measurement: { name, duration, startMark, endMark, timestamp: Date.now() },
          },
        });
        return duration;
      }
    } catch { /* safe */ }

    return null;
  }
}

// 扩展 Logger 接口（用于 TypeScript 类型提示）
declare module '../types' {
  interface AemeathInterface {
    startMark?(name: string): void;
    endMark?(name: string): number | null;
    measure?(name: string, startMark: string, endMark: string): number | null;
  }
}
