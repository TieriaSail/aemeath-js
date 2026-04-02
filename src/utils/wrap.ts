/**
 * Function wrapping utility for enhanced error capture.
 *
 * Wraps callbacks with try-catch to obtain full error details that would
 * otherwise be sanitized by the browser (e.g. "Script error." in WebView).
 *
 * Key features:
 * - Bidirectional references to prevent double-wrapping
 * - Recursive argument wrapping for nested callbacks
 * - Coordination with the global error handler to prevent duplicate reports
 */

// ==================== Types ====================

export interface WrappedFunction extends Function {
  __aemeath_wrapped__?: WrappedFunction;
  __aemeath_original__?: Function;
}

export type ErrorHandler = (error: unknown) => void;

// ==================== Dedup coordination ====================

let _ignoreOnError = 0;

/**
 * Check whether the global error handler should skip the current error.
 *
 * When wrap()'s try-catch captures an error it calls ignoreNextOnError()
 * before re-throwing. The global handler checks this flag and skips the
 * error to avoid a duplicate report.
 */
export function shouldIgnoreOnError(): boolean {
  return _ignoreOnError > 0;
}

/**
 * Signal that the next global error should be ignored.
 *
 * The flag auto-resets in the next macrotask (setTimeout), which is
 * guaranteed to run after the synchronous onerror handler.
 */
export function ignoreNextOnError(): void {
  _ignoreOnError++;
  setTimeout(() => {
    _ignoreOnError--;
  });
}

/**
 * Reset the ignore counter. Intended for tests only.
 * @internal
 */
export function _resetIgnoreOnError(): void {
  _ignoreOnError = 0;
}

// ==================== Core wrap ====================

/**
 * Wrap a value. If it is a function, instrument it with try-catch.
 * Non-function values are returned as-is.
 *
 * @param fn      - The value to wrap (only functions are actually wrapped)
 * @param onError - Called when the wrapped function throws
 * @returns The wrapped function, or the original value if not a function
 */
export function wrap<T>(fn: T, onError: ErrorHandler): T {
  if (typeof fn !== 'function') {
    return fn;
  }

  const original = fn as unknown as WrappedFunction;

  try {
    const existingWrapper = original.__aemeath_wrapped__;
    if (existingWrapper && typeof existingWrapper === 'function') {
      return existingWrapper as unknown as T;
    }

    if (original.__aemeath_original__) {
      return fn;
    }
  } catch {
    return fn;
  }

  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    try {
      const wrappedArgs = args.map((arg) => wrap(arg, onError));
      return original.apply(this, wrappedArgs);
    } catch (ex) {
      ignoreNextOnError();

      try {
        onError(ex);
      } catch {
        // onError itself must never break the application
      }

      throw ex;
    }
  } as unknown as WrappedFunction;

  // Copy enumerable properties from the original function
  try {
    for (const prop in original) {
      if (Object.prototype.hasOwnProperty.call(original, prop)) {
        (wrapped as unknown as Record<string, unknown>)[prop] = (
          original as unknown as Record<string, unknown>
        )[prop];
      }
    }
  } catch {
    // Some objects throw when enumerating properties
  }

  // Bidirectional reference
  try {
    wrapped.__aemeath_original__ = original;
    Object.defineProperty(original, '__aemeath_wrapped__', {
      value: wrapped,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch {
    // Non-extensible or frozen functions
  }

  // Preserve function name
  try {
    const descriptor = Object.getOwnPropertyDescriptor(wrapped, 'name');
    if (descriptor && descriptor.configurable) {
      Object.defineProperty(wrapped, 'name', {
        get() {
          return original.name;
        },
      });
    }
  } catch {
    // Some environments don't allow redefining `name`
  }

  return wrapped as unknown as T;
}

/**
 * Retrieve the original unwrapped function, if available.
 */
export function getOriginalFunction(fn: unknown): Function | undefined {
  if (typeof fn === 'function') {
    return (fn as WrappedFunction).__aemeath_original__;
  }
  return undefined;
}
