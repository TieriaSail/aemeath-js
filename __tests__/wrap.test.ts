/**
 * wrap() utility tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  wrap,
  getOriginalFunction,
  shouldIgnoreOnError,
  ignoreNextOnError,
  _resetIgnoreOnError,
  type WrappedFunction,
} from '../src/utils/wrap';

describe('wrap()', () => {
  const noop = () => {};

  beforeEach(() => {
    _resetIgnoreOnError();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ==================== Non-function passthrough ====================

  describe('non-function passthrough', () => {
    it('should return non-function values as-is', () => {
      expect(wrap(42, noop)).toBe(42);
      expect(wrap('hello', noop)).toBe('hello');
      expect(wrap(null, noop)).toBe(null);
      expect(wrap(undefined, noop)).toBe(undefined);
      const obj = { a: 1 };
      expect(wrap(obj, noop)).toBe(obj);
    });
  });

  // ==================== Basic wrapping ====================

  describe('basic wrapping', () => {
    it('should return a function when wrapping a function', () => {
      const fn = () => 123;
      const wrapped = wrap(fn, noop);
      expect(typeof wrapped).toBe('function');
      expect(wrapped).not.toBe(fn);
    });

    it('wrapped function should execute correctly and return value', () => {
      const fn = (a: number, b: number) => a + b;
      const wrapped = wrap(fn, noop);
      expect(wrapped(2, 3)).toBe(5);
    });

    it('should preserve `this` context', () => {
      const obj = {
        value: 42,
        getValue() {
          return this.value;
        },
      };
      obj.getValue = wrap(obj.getValue, noop);
      expect(obj.getValue()).toBe(42);
    });
  });

  // ==================== Error handling ====================

  describe('error handling', () => {
    it('should call onError when the wrapped function throws', () => {
      const onError = vi.fn();
      const fn = () => {
        throw new Error('test error');
      };
      const wrapped = wrap(fn, onError);

      expect(() => wrapped()).toThrow('test error');
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.any(Error));
      expect((onError.mock.calls[0][0] as Error).message).toBe('test error');
    });

    it('should re-throw the original error after calling onError', () => {
      const originalError = new Error('original');
      const fn = () => {
        throw originalError;
      };
      const wrapped = wrap(fn, noop);

      try {
        wrapped();
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBe(originalError);
      }
    });

    it('should not break if onError itself throws', () => {
      const fn = () => {
        throw new Error('app error');
      };
      const brokenHandler = () => {
        throw new Error('handler error');
      };
      const wrapped = wrap(fn, brokenHandler);

      expect(() => wrapped()).toThrow('app error');
    });
  });

  // ==================== ignoreNextOnError coordination ====================

  describe('ignoreNextOnError coordination', () => {
    it('shouldIgnoreOnError() should be false by default', () => {
      expect(shouldIgnoreOnError()).toBe(false);
    });

    it('ignoreNextOnError() should set flag to true', () => {
      ignoreNextOnError();
      expect(shouldIgnoreOnError()).toBe(true);
    });

    it('flag should auto-reset after macrotask', () => {
      ignoreNextOnError();
      expect(shouldIgnoreOnError()).toBe(true);
      vi.runAllTimers();
      expect(shouldIgnoreOnError()).toBe(false);
    });

    it('wrap catch should call ignoreNextOnError before re-throw', () => {
      const fn = () => {
        throw new Error('test');
      };
      const wrapped = wrap(fn, noop);

      try {
        wrapped();
      } catch {
        // expected
      }

      expect(shouldIgnoreOnError()).toBe(true);
      vi.runAllTimers();
      expect(shouldIgnoreOnError()).toBe(false);
    });

    it('multiple ignoreNextOnError calls should stack correctly', () => {
      ignoreNextOnError();
      ignoreNextOnError();
      expect(shouldIgnoreOnError()).toBe(true);

      vi.advanceTimersByTime(0);
      // Both setTimeout callbacks should have fired
      vi.runAllTimers();
      expect(shouldIgnoreOnError()).toBe(false);
    });
  });

  // ==================== Bidirectional references ====================

  describe('bidirectional references', () => {
    it('should set __aemeath_wrapped__ on the original', () => {
      const fn = () => {};
      const wrapped = wrap(fn, noop);
      expect((fn as WrappedFunction).__aemeath_wrapped__).toBe(wrapped);
    });

    it('should set __aemeath_original__ on the wrapper', () => {
      const fn = () => {};
      const wrapped = wrap(fn, noop);
      expect((wrapped as WrappedFunction).__aemeath_original__).toBe(fn);
    });

    it('getOriginalFunction should return the original', () => {
      const fn = () => {};
      const wrapped = wrap(fn, noop);
      expect(getOriginalFunction(wrapped)).toBe(fn);
    });

    it('getOriginalFunction should return undefined for non-wrapped', () => {
      expect(getOriginalFunction(() => {})).toBeUndefined();
      expect(getOriginalFunction(42)).toBeUndefined();
    });
  });

  // ==================== Idempotency ====================

  describe('idempotency', () => {
    it('should not double-wrap — returns existing wrapper', () => {
      const fn = () => {};
      const wrapped1 = wrap(fn, noop);
      const wrapped2 = wrap(fn, noop);
      expect(wrapped1).toBe(wrapped2);
    });

    it('should not wrap a function that is already a wrapper', () => {
      const fn = () => {};
      const wrapped = wrap(fn, noop);
      const doubleWrapped = wrap(wrapped, noop);
      expect(doubleWrapped).toBe(wrapped);
    });
  });

  // ==================== Recursive argument wrapping ====================

  describe('recursive argument wrapping', () => {
    it('should wrap function arguments recursively', () => {
      const onError = vi.fn();
      const innerFn = () => {
        throw new Error('inner error');
      };

      const outerFn = (callback: Function) => {
        callback();
      };

      const wrappedOuter = wrap(outerFn, onError);

      expect(() => wrappedOuter(innerFn)).toThrow('inner error');
      // onError should be called for the inner error
      expect(onError).toHaveBeenCalled();
    });

    it('should not modify non-function arguments', () => {
      const fn = (a: number, b: string, c: object) => [a, b, c];
      const wrapped = wrap(fn, noop);
      const obj = { key: 'value' };
      const result = wrapped(1, 'hello', obj);
      expect(result).toEqual([1, 'hello', obj]);
    });
  });

  // ==================== Property copying ====================

  describe('property copying', () => {
    it('should copy custom properties from the original function', () => {
      const fn = () => {};
      (fn as any).customProp = 'hello';
      (fn as any).customNum = 42;
      const wrapped = wrap(fn, noop);
      expect((wrapped as any).customProp).toBe('hello');
      expect((wrapped as any).customNum).toBe(42);
    });
  });

  // ==================== Function name preservation ====================

  describe('function name preservation', () => {
    it('should preserve the original function name', () => {
      function myNamedFunction() {}
      const wrapped = wrap(myNamedFunction, noop);
      expect(wrapped.name).toBe('myNamedFunction');
    });
  });
});
