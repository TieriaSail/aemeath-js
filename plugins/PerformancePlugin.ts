/**
 * 性能监控插件 - 监控 Web Vitals 和性能指标
 *
 * 体积：~4KB
 * 依赖：无
 * 功能：
 * - Web Vitals（LCP, FID, CLS, FCP, TTFB）
 * - 资源加载时间
 * - 自定义性能标记
 */

import type { AemeathPlugin, AemeathInterface } from '../types';

export interface PerformancePluginOptions {
  /** 是否监控 Web Vitals */
  monitorWebVitals?: boolean;

  /** 是否监控资源加载 */
  monitorResources?: boolean;

  /** 是否监控长任务 */
  monitorLongTasks?: boolean;

  /** 长任务阈值（ms） */
  longTaskThreshold?: number;

  /** 采样率（0-1） */
  sampleRate?: number;
}

interface PerformanceMetric {
  name: string;
  value: number;
  rating: 'good' | 'needs-improvement' | 'poor';
  delta?: number;
  id?: string;
}

type PerformancePluginConfig = Required<PerformancePluginOptions>;

export class PerformancePlugin implements AemeathPlugin {
  readonly name = 'performance';
  readonly version = '1.0.0';
  readonly description = '性能监控';

  private readonly config: PerformancePluginConfig;
  private logger: AemeathInterface | null = null;
  private observers: PerformanceObserver[] = [];
  private readonly marks: Map<string, number> = new Map();

  constructor(options: PerformancePluginOptions = {}) {
    this.config = {
      monitorWebVitals: options.monitorWebVitals ?? true,
      monitorResources: options.monitorResources ?? false,
      monitorLongTasks: options.monitorLongTasks ?? false,
      longTaskThreshold: options.longTaskThreshold ?? 50,
      sampleRate: options.sampleRate ?? 1,
    };
  }

  install(logger: AemeathInterface): void {
    this.logger = logger;

    // 采样检查
    if (Math.random() > this.config.sampleRate) {
      return;
    }

    if (this.config.monitorWebVitals) {
      this.monitorWebVitals();
    }

    if (this.config.monitorResources) {
      this.monitorResources();
    }

    if (this.config.monitorLongTasks) {
      this.monitorLongTasks();
    }

    // 添加自定义 API
    (logger as any).startMark = this.startMark.bind(this);
    (logger as any).endMark = this.endMark.bind(this);
    (logger as any).measure = this.measure.bind(this);
  }

  uninstall(logger: AemeathInterface): void {
    this.observers.forEach((observer) => observer.disconnect());
    this.observers = [];
    this.marks.clear();
    this.logger = null;

    delete (logger as any).startMark;
    delete (logger as any).endMark;
    delete (logger as any).measure;
  }

  private monitorWebVitals(): void {
    if (typeof window === 'undefined' || !('PerformanceObserver' in window)) {
      return;
    }

    // LCP (Largest Contentful Paint)
    this.observeMetric('largest-contentful-paint', (entry: any) => {
      this.reportMetric({
        name: 'LCP',
        value: entry.renderTime || entry.loadTime,
        rating: this.rateLCP(entry.renderTime || entry.loadTime),
        id: entry.id,
      });
    });

    // FID (First Input Delay)
    this.observeMetric('first-input', (entry: any) => {
      this.reportMetric({
        name: 'FID',
        value: entry.processingStart - entry.startTime,
        rating: this.rateFID(entry.processingStart - entry.startTime),
        id: entry.id,
      });
    });

    // CLS (Cumulative Layout Shift)
    let clsValue = 0;
    this.observeMetric('layout-shift', (entry: any) => {
      if (!entry.hadRecentInput) {
        clsValue += entry.value;
        this.reportMetric({
          name: 'CLS',
          value: clsValue,
          rating: this.rateCLS(clsValue),
          delta: entry.value,
        });
      }
    });

    // FCP (First Contentful Paint)
    this.observeMetric('paint', (entry: any) => {
      if (entry.name === 'first-contentful-paint') {
        this.reportMetric({
          name: 'FCP',
          value: entry.startTime,
          rating: this.rateFCP(entry.startTime),
        });
      }
    });

    // TTFB (Time to First Byte)
    if (typeof window !== 'undefined' && 'performance' in window) {
      const navEntry = performance.getEntriesByType(
        'navigation',
      )[0] as PerformanceNavigationTiming;
      if (navEntry) {
        const ttfb = navEntry.responseStart - navEntry.requestStart;
        this.reportMetric({
          name: 'TTFB',
          value: ttfb,
          rating: this.rateTTFB(ttfb),
        });
      }
    }
  }

  private monitorResources(): void {
    if (typeof window === 'undefined' || !('PerformanceObserver' in window)) {
      return;
    }

    this.observeMetric('resource', (entry: any) => {
      // 只记录慢资源
      if (entry.duration > 1000) {
        this.logger?.warn('慢资源加载', {
          tags: { category: 'performance', type: 'slow-resource' },
          context: {
            resource: {
              name: entry.name,
              type: entry.initiatorType,
              duration: entry.duration,
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
      if (entry.duration > this.config.longTaskThreshold) {
        this.logger?.warn('长任务检测', {
          tags: { category: 'performance', type: 'long-task' },
          context: {
            task: {
              duration: entry.duration,
              startTime: entry.startTime,
              name: entry.name,
            },
          },
        });
      }
    });
  }

  private observeMetric(type: string, callback: (entry: any) => void): void {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          callback(entry);
        }
      });
      observer.observe({ type, buffered: true });
      this.observers.push(observer);
    } catch (error) {
      // 某些浏览器可能不支持特定的性能指标
      console.warn(`无法监控 ${type}:`, error);
    }
  }

  private reportMetric(metric: PerformanceMetric): void {
    this.logger?.info('性能指标', {
      tags: {
        category: 'performance',
        metric: metric.name,
        rating: metric.rating,
      },
      context: { metric },
    });
  }

  // Web Vitals 评级标准
  private rateLCP(value: number): 'good' | 'needs-improvement' | 'poor' {
    if (value <= 2500) return 'good';
    if (value <= 4000) return 'needs-improvement';
    return 'poor';
  }

  private rateFID(value: number): 'good' | 'needs-improvement' | 'poor' {
    if (value <= 100) return 'good';
    if (value <= 300) return 'needs-improvement';
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

  // 自定义性能标记 API

  /**
   * 开始性能标记
   */
  startMark(name: string): void {
    this.marks.set(name, Date.now());
    if (typeof window !== 'undefined' && 'performance' in window) {
      performance.mark(`${name}-start`);
    }
  }

  /**
   * 结束性能标记并记录
   */
  endMark(name: string): number | null {
    const startTime = this.marks.get(name);
    if (!startTime) {
      return null;
    }

    const duration = Date.now() - startTime;
    this.marks.delete(name);

    if (typeof window !== 'undefined' && 'performance' in window) {
      performance.mark(`${name}-end`);
      try {
        performance.measure(name, `${name}-start`, `${name}-end`);
      } catch {
        // 忽略错误
      }
    }

    this.logger?.info('性能测量', {
      tags: { category: 'performance', type: 'measurement', name },
      context: {
        measurement: {
          name,
          duration,
          timestamp: Date.now(),
        },
      },
    });

    return duration;
  }

  /**
   * 测量两个标记之间的时间
   */
  measure(name: string, startMark: string, endMark: string): number | null {
    if (typeof window === 'undefined' || !('performance' in window)) {
      return null;
    }

    try {
      performance.measure(name, startMark, endMark);
      const measures = performance.getEntriesByName(name, 'measure');
      if (measures.length > 0) {
        const duration = measures[measures.length - 1]!.duration;
        this.logger?.info('性能测量', {
          tags: { category: 'performance', type: 'measurement', name },
          context: {
            measurement: {
              name,
              duration,
              startMark,
              endMark,
              timestamp: Date.now(),
            },
          },
        });
        return duration;
      }
    } catch (error) {
      console.warn(`性能测量失败: ${name}`, error);
    }

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
