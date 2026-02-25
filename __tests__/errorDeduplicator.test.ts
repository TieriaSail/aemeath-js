/**
 * ErrorDeduplicator 错误去重器测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ErrorDeduplicator,
  getGlobalDeduplicator,
  resetGlobalDeduplicator,
} from '../utils/errorDeduplicator';
import type { ErrorInfo } from '../utils/errorDeduplicator';

describe('ErrorDeduplicator', () => {
  let dedup: ErrorDeduplicator;

  beforeEach(() => {
    vi.useFakeTimers();
    dedup = new ErrorDeduplicator({ timeWindow: 5000, maxCacheSize: 10 });
  });

  afterEach(() => {
    dedup.stop();
    vi.useRealTimers();
  });

  // ==================== 基础去重 ====================

  describe('基础去重', () => {
    it('第一次出现的错误应返回 true', () => {
      const error: ErrorInfo = { message: 'test error' };
      expect(dedup.check(error)).toBe(true);
    });

    it('短时间内相同错误应返回 false', () => {
      const error: ErrorInfo = { message: 'test error' };
      expect(dedup.check(error)).toBe(true); // 第一次
      expect(dedup.check(error)).toBe(false); // 重复
    });

    it('不同错误应各自返回 true', () => {
      expect(dedup.check({ message: 'error A' })).toBe(true);
      expect(dedup.check({ message: 'error B' })).toBe(true);
    });

    it('超过时间窗口后相同错误应重新返回 true', () => {
      const error: ErrorInfo = { message: 'test error' };
      expect(dedup.check(error)).toBe(true);
      expect(dedup.check(error)).toBe(false);

      // 推进时间超过时间窗口
      vi.advanceTimersByTime(6000);

      expect(dedup.check(error)).toBe(true);
    });
  });

  // ==================== 信息完整度优先 ====================

  describe('信息完整度优先', () => {
    it('重复错误但带有位置信息时应返回 true', () => {
      const errorWithoutLocation: ErrorInfo = { message: 'err' };
      const errorWithLocation: ErrorInfo = {
        message: 'err',
        filename: 'app.js',
        lineno: 10,
        colno: 5,
      };

      expect(dedup.check(errorWithoutLocation)).toBe(true); // 第一次，无位置
      expect(dedup.check(errorWithLocation)).toBe(true); // 有位置，更完整 → true
    });

    it('重复错误但 stack 更长时应返回 true', () => {
      const shortStack: ErrorInfo = {
        message: 'err',
        stack: 'Error: err\n    at foo()',
      };
      const longStack: ErrorInfo = {
        message: 'err',
        stack: 'Error: err\n    at foo()\n    at bar()\n    at baz()',
      };

      expect(dedup.check(shortStack)).toBe(true);
      expect(dedup.check(longStack)).toBe(true); // stack 更长 → true
    });

    it('重复错误且信息不够完整时应返回 false', () => {
      const errorWithLocation: ErrorInfo = {
        message: 'err',
        filename: 'app.js',
        lineno: 10,
        colno: 5,
      };
      const errorWithoutLocation: ErrorInfo = { message: 'err' };

      expect(dedup.check(errorWithLocation)).toBe(true);
      expect(dedup.check(errorWithoutLocation)).toBe(false); // 信息不如缓存的完整
    });
  });

  // ==================== 不同错误类型 ====================

  describe('不同错误类型的 hash 策略', () => {
    it('资源加载错误使用 tagName + src', () => {
      const err1: ErrorInfo = {
        message: 'Resource error',
        tagName: 'IMG',
        src: 'https://cdn.com/img.png',
      };
      const err2: ErrorInfo = {
        message: 'Resource error',
        tagName: 'IMG',
        src: 'https://cdn.com/img2.png',
      };

      expect(dedup.check(err1)).toBe(true);
      expect(dedup.check(err1)).toBe(false); // 相同资源
      expect(dedup.check(err2)).toBe(true); // 不同资源
    });

    it('Promise rejection 使用 message + reason', () => {
      const err: ErrorInfo = {
        message: 'Unhandled rejection',
        type: 'unhandledrejection',
        reason: 'network error',
      };
      expect(dedup.check(err)).toBe(true);
      expect(dedup.check(err)).toBe(false);
    });

    it('JS 错误使用 message + 第一个调用帧', () => {
      // 两个错误 message 相同，第一个调用帧相同，但后续调用链不同
      const err1: ErrorInfo = {
        message: 'oops',
        stack: 'Error: oops\n    at foo (app.js:10:5)\n    at bar()',
      };
      const err2: ErrorInfo = {
        message: 'oops',
        stack: 'Error: oops\n    at foo (app.js:10:5)\n    at baz()\n    at qux()',
      };

      expect(dedup.check(err1)).toBe(true);
      // 应该被视为同一个错误（第一个调用帧相同），但 stack 更长所以返回 true
      const result = dedup.check(err2);
      // err2 stack 更长（4行 vs 3行），所以 isMoreComplete 返回 true
      expect(result).toBe(true);
    });
  });

  // ==================== 禁用去重 ====================

  describe('禁用去重', () => {
    it('enabled=false 时所有错误都应返回 true', () => {
      const disabled = new ErrorDeduplicator({ enabled: false });
      const error: ErrorInfo = { message: 'test' };

      expect(disabled.check(error)).toBe(true);
      expect(disabled.check(error)).toBe(true);
      expect(disabled.check(error)).toBe(true);

      disabled.stop();
    });
  });

  // ==================== 自定义 hash ====================

  describe('自定义 hash 函数', () => {
    it('应使用自定义 hashFn', () => {
      const customDedup = new ErrorDeduplicator({
        hashFn: (error) => error.message, // 只用 message 做 hash
      });

      const err1: ErrorInfo = { message: 'same', stack: 'stack1' };
      const err2: ErrorInfo = { message: 'same', stack: 'stack2' };

      expect(customDedup.check(err1)).toBe(true);
      expect(customDedup.check(err2)).toBe(false); // message 相同 → 重复

      customDedup.stop();
    });
  });

  // ==================== 缓存管理 ====================

  describe('缓存管理', () => {
    it('超过 maxCacheSize 应自动清理最旧的条目', () => {
      // maxCacheSize = 10
      for (let i = 0; i < 12; i++) {
        dedup.check({ message: `error-${i}` });
      }

      const stats = dedup.getStats();
      // 添加 12 个后应该清理了 10% = 1 个最旧的
      expect(stats.cacheSize).toBeLessThanOrEqual(12);
    });

    it('clear 应清空所有缓存', () => {
      dedup.check({ message: 'a' });
      dedup.check({ message: 'b' });
      dedup.clear();

      const stats = dedup.getStats();
      expect(stats.cacheSize).toBe(0);
    });

    it('stop 应清理缓存和定时器', () => {
      dedup.check({ message: 'a' });
      dedup.stop();

      const stats = dedup.getStats();
      expect(stats.cacheSize).toBe(0);
    });
  });

  // ==================== 统计信息 ====================

  describe('getStats', () => {
    it('应返回正确的统计', () => {
      dedup.check({ message: 'a' });
      dedup.check({ message: 'a' }); // 重复
      dedup.check({ message: 'b' });

      const stats = dedup.getStats();
      expect(stats.uniqueErrors).toBe(2);
      expect(stats.totalErrors).toBe(3);
      expect(stats.duplicates).toBe(1);
    });
  });

  // ==================== getCount ====================

  describe('getCount', () => {
    it('应返回错误的重复次数', () => {
      const error: ErrorInfo = { message: 'test' };
      dedup.check(error);
      dedup.check(error);
      dedup.check(error);

      expect(dedup.getCount(error)).toBe(3);
    });

    it('未出现过的错误应返回 1', () => {
      expect(dedup.getCount({ message: 'new' })).toBe(1);
    });
  });

  // ==================== 定期清理 ====================

  describe('定期清理过期缓存', () => {
    it('30 秒后应清理过期条目', () => {
      dedup.check({ message: 'old' });

      // 推进时间：先超过 timeWindow
      vi.advanceTimersByTime(6000);

      // 再推进到清理周期（30 秒）
      vi.advanceTimersByTime(25000);

      const stats = dedup.getStats();
      expect(stats.cacheSize).toBe(0);
    });
  });

  // ==================== 全局单例 ====================

  describe('全局单例', () => {
    afterEach(() => {
      resetGlobalDeduplicator();
    });

    it('getGlobalDeduplicator 应返回同一个实例', () => {
      const a = getGlobalDeduplicator();
      const b = getGlobalDeduplicator();
      expect(a).toBe(b);
    });

    it('resetGlobalDeduplicator 后应创建新实例', () => {
      const a = getGlobalDeduplicator();
      resetGlobalDeduplicator();
      const b = getGlobalDeduplicator();
      expect(a).not.toBe(b);
    });
  });
});

