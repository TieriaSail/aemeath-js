/**
 * Browser platform adapter
 *
 * Implements PlatformAdapter using standard browser APIs:
 * localStorage, beforeunload, requestIdleCallback, window.onerror,
 * fetch/XHR interception, window.__EARLY_ERRORS__.
 */

import type {
  PlatformAdapter,
  GlobalErrorInfo,
  UnhandledRejectionInfo,
  NetworkRequestLog,
  NetworkInterceptOptions,
  EarlyError,
} from './types';

function safeParseJSON(data: unknown): unknown {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }
  return data;
}

function extractBusinessInfo(data: unknown): {
  code?: number | string;
  message?: string;
} {
  if (!data || typeof data !== 'object') return {};
  const obj = data as Record<string, unknown>;
  return {
    code: obj['code'] as number | string | undefined,
    message: (obj['message'] || obj['msg'] || obj['error']) as
      | string
      | undefined,
  };
}

export function createBrowserAdapter(): PlatformAdapter {
  return {
    type: 'browser',

    storage: {
      getItem(key: string): string | null {
        try {
          return localStorage.getItem(key);
        } catch {
          return null;
        }
      },
      setItem(key: string, value: string): void {
        try {
          localStorage.setItem(key, value);
        } catch {
          // storage full or blocked
        }
      },
      removeItem(key: string): void {
        try {
          localStorage.removeItem(key);
        } catch {
          // blocked
        }
      },
    },

    onBeforeExit(callback: () => void): () => void {
      window.addEventListener('beforeunload', callback);
      return () => window.removeEventListener('beforeunload', callback);
    },

    requestIdle(callback: () => void, timeout?: number): void {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(callback, timeout != null ? { timeout } : undefined);
      } else {
        setTimeout(callback, 0);
      }
    },

    getCurrentPath(): string {
      return window.location.pathname;
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

    network: {
      intercept(
        handler: (log: NetworkRequestLog) => void,
        options: NetworkInterceptOptions,
      ): () => void {
        let originalFetch: typeof fetch | null = null;
        let originalXHROpen: typeof XMLHttpRequest.prototype.open | null = null;
        let originalXHRSend: typeof XMLHttpRequest.prototype.send | null = null;

        // --- fetch interception ---
        if (typeof window !== 'undefined' && window.fetch) {
          originalFetch = window.fetch;
          const savedFetch = originalFetch;

          window.fetch = async function (
            input: RequestInfo | URL,
            init?: RequestInit,
          ): Promise<Response> {
            const startTime = Date.now();
            const url =
              typeof input === 'string'
                ? input
                : input instanceof URL
                  ? input.href
                  : input.url;
            const method = init?.method?.toUpperCase() || 'GET';

            if (!options.shouldCapture(url)) {
              return savedFetch.call(window, input, init);
            }

            let requestBody: unknown;
            if (options.captureRequestBody && init?.body) {
              try {
                requestBody = safeParseJSON(init.body);
              } catch {
                requestBody = '[Unable to parse request body]';
              }
            }

            try {
              const response = await savedFetch.call(window, input, init);

              let responseBody: unknown;
              let responseCode: number | string | undefined;
              let responseMessage: string | undefined;

              if (options.captureResponseBody) {
                try {
                  const cloned = response.clone();
                  const text = await cloned.text();
                  responseBody = safeParseJSON(text);
                  const biz = extractBusinessInfo(responseBody);
                  responseCode = biz.code;
                  responseMessage = biz.message;
                } catch {
                  responseBody = '[Unable to read response body]';
                }
              }

              handler({
                type: 'fetch',
                url,
                method,
                status: response.status,
                statusText: response.statusText,
                duration: Date.now() - startTime,
                timestamp: startTime,
                requestBody,
                responseBody,
                responseCode,
                responseMessage,
              });

              return response;
            } catch (error) {
              const isOnline =
                typeof navigator !== 'undefined' ? navigator.onLine : true;
              let errorMessage =
                error instanceof Error ? error.message : String(error);
              if (!isOnline && !errorMessage.includes('offline')) {
                errorMessage = `${errorMessage} (device appears to be offline)`;
              }

              handler({
                type: 'fetch',
                url,
                method,
                status: 0,
                statusText: 'Network Error',
                duration: Date.now() - startTime,
                timestamp: startTime,
                requestBody,
                error: errorMessage,
              });

              throw error;
            }
          };
        }

        // --- XHR interception ---
        if (typeof window !== 'undefined' && window.XMLHttpRequest) {
          originalXHROpen = XMLHttpRequest.prototype.open;
          originalXHRSend = XMLHttpRequest.prototype.send;
          const savedOpen = originalXHROpen;
          const savedSend = originalXHRSend;

          XMLHttpRequest.prototype.open = function (
            method: string,
            url: string | URL,
            async: boolean = true,
            username?: string | null,
            password?: string | null,
          ): void {
            (this as any)._networkInfo = {
              method: method.toUpperCase(),
              url: typeof url === 'string' ? url : url.href,
              startTime: 0,
              requestBody: undefined,
            };
            return savedOpen.call(this, method, url, async, username, password);
          };

          XMLHttpRequest.prototype.send = function (
            body?: Document | XMLHttpRequestBodyInit | null,
          ): void {
            const info = (this as any)._networkInfo;

            if (!info || !options.shouldCapture(info.url)) {
              return savedSend.call(this, body);
            }

            info.startTime = Date.now();

            if (options.captureRequestBody && body) {
              try {
                info.requestBody = safeParseJSON(body);
              } catch {
                info.requestBody = '[Unable to parse request body]';
              }
            }

            let isRecorded = false;

            const cleanup = () => {
              this.removeEventListener('loadend', handleLoadEnd);
              this.removeEventListener('error', handleError);
              this.removeEventListener('timeout', handleTimeout);
            };

            const handleLoadEnd = () => {
              if (isRecorded) { cleanup(); return; }
              isRecorded = true;

              let responseBody: unknown;
              let responseCode: number | string | undefined;
              let responseMessage: string | undefined;

              if (options.captureResponseBody) {
                try {
                  responseBody = safeParseJSON(this.responseText);
                  const biz = extractBusinessInfo(responseBody);
                  responseCode = biz.code;
                  responseMessage = biz.message;
                } catch {
                  responseBody = '[Unable to read response body]';
                }
              }

              handler({
                type: 'xhr',
                url: info.url,
                method: info.method,
                status: this.status,
                statusText: this.statusText,
                duration: Date.now() - info.startTime,
                timestamp: info.startTime,
                requestBody: info.requestBody,
                responseBody,
                responseCode,
                responseMessage,
              });
              cleanup();
            };

            const handleError = () => {
              if (isRecorded) return;
              isRecorded = true;
              const isOnline =
                typeof navigator !== 'undefined' ? navigator.onLine : true;
              let errorMessage = 'Network Error';
              if (!isOnline) {
                errorMessage = 'Network Error: Device appears to be offline';
              } else if (this.status === 0) {
                errorMessage = `Network Error: No response received (readyState=${this.readyState})`;
              }

              handler({
                type: 'xhr',
                url: info.url,
                method: info.method,
                status: this.status,
                statusText: this.statusText || 'Network Error',
                duration: Date.now() - info.startTime,
                timestamp: info.startTime,
                requestBody: info.requestBody,
                error: errorMessage,
              });
            };

            const handleTimeout = () => {
              if (isRecorded) return;
              isRecorded = true;
              const duration = Date.now() - info.startTime;
              handler({
                type: 'xhr',
                url: info.url,
                method: info.method,
                status: 0,
                statusText: 'Request Timeout',
                duration,
                timestamp: info.startTime,
                requestBody: info.requestBody,
                error: `Request Timeout: No response within ${duration}ms`,
              });
            };

            this.addEventListener('loadend', handleLoadEnd);
            this.addEventListener('error', handleError);
            this.addEventListener('timeout', handleTimeout);

            return savedSend.call(this, body);
          };
        }

        // Return cleanup function
        return () => {
          if (originalFetch) {
            window.fetch = originalFetch;
          }
          if (originalXHROpen) {
            XMLHttpRequest.prototype.open = originalXHROpen;
          }
          if (originalXHRSend) {
            XMLHttpRequest.prototype.send = originalXHRSend;
          }
        };
      },
    },

    earlyCapture: {
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
