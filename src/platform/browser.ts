/**
 * Browser platform adapter
 *
 * Implements PlatformAdapter using standard browser APIs:
 * localStorage, beforeunload, requestIdleCallback, window.onerror,
 * window.__EARLY_ERRORS__.
 *
 * Network interception (fetch/XHR) has been moved to the instrumentation layer.
 */

import type {
  PlatformAdapter,
  GlobalErrorInfo,
  UnhandledRejectionInfo,
  EarlyError,
} from './types';

export function createBrowserAdapter(): PlatformAdapter {
  let lastStorageError: unknown;
  return {
    type: 'browser',

    storage: {
      getItem(key: string): string | null {
        lastStorageError = undefined;
        try {
          return localStorage.getItem(key);
        } catch (error) {
          lastStorageError = error;
          return null;
        }
      },
      setItem(key: string, value: string): void {
        lastStorageError = undefined;
        try {
          localStorage.setItem(key, value);
        } catch (error) {
          lastStorageError = error;
          // storage full or blocked
        }
      },
      removeItem(key: string): void {
        lastStorageError = undefined;
        try {
          localStorage.removeItem(key);
        } catch (error) {
          lastStorageError = error;
          // blocked
        }
      },
      consumeLastError(): unknown {
        const error = lastStorageError;
        lastStorageError = undefined;
        return error;
      },
    },

    onBeforeExit(callback: () => void): () => void {
      window.addEventListener('beforeunload', callback);
      // iOS Safari / WKWebView 经常不触发 beforeunload；pagehide 才是更可靠的
      // 页面生命周期信号。重复触发是安全的，缓存写入采用覆盖语义。
      window.addEventListener('pagehide', callback);
      return () => {
        window.removeEventListener('beforeunload', callback);
        window.removeEventListener('pagehide', callback);
      };
    },

    requestIdle(callback: () => void, timeout?: number): void {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(callback, timeout != null ? { timeout } : undefined);
      } else {
        setTimeout(callback, 0);
      }
    },

    getCurrentPath(): string {
      try {
        return window.location.pathname;
      } catch {
        return '';
      }
    },

    errorCapture: {
      onGlobalError(
        handler: (info: GlobalErrorInfo) => void,
      ): () => void {
        const prev = window.onerror;
        const wrappedHandler: OnErrorEventHandler = (message, source, lineno, colno, error) => {
          handler({ message, source, lineno, colno, error });
          if (typeof prev === 'function') {
            return (prev as Function).call(window, message, source, lineno, colno, error);
          }
        };
        window.onerror = wrappedHandler;
        return () => {
          if (window.onerror === wrappedHandler) {
            window.onerror = prev;
          }
        };
      },

      onUnhandledRejection(
        handler: (info: UnhandledRejectionInfo) => void,
      ): () => void {
        const listener = (event: PromiseRejectionEvent) => {
          handler({ reason: event.reason });
        };
        window.addEventListener('unhandledrejection', listener);
        return () => window.removeEventListener('unhandledrejection', listener);
      },

      onResourceError(handler: (event: Event) => void): () => void {
        window.addEventListener('error', handler, true);
        return () => window.removeEventListener('error', handler, true);
      },
    },

    earlyCapture: {
      isInstalled(): boolean {
        return (
          typeof window !== 'undefined' &&
          typeof (window as { __flushEarlyErrors__?: unknown }).__flushEarlyErrors__ === 'function'
        );
      },

      hasEarlyErrors(): boolean {
        return (
          typeof window !== 'undefined' &&
          Array.isArray((window as any).__EARLY_ERRORS__) &&
          (window as any).__EARLY_ERRORS__.length > 0
        );
      },

      flush(callback: (errors: EarlyError[]) => void): void {
        if (typeof window === 'undefined') return;
        const flushFn = (window as any).__flushEarlyErrors__;
        if (typeof flushFn === 'function') {
          flushFn(callback);
        }
      },
    },
  };
}
