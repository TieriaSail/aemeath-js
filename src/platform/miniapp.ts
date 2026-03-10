/**
 * MiniApp platform adapter factory
 *
 * Supports WeChat, Alipay, Douyin (TikTok), Baidu, and custom miniapp vendors.
 * Each vendor's global API object is injected at creation time.
 */

import type {
  PlatformAdapter,
  MiniAppVendor,
  GlobalErrorInfo,
  UnhandledRejectionInfo,
  NetworkRequestLog,
  NetworkInterceptOptions,
  EarlyError,
} from './types';

/**
 * Unified MiniApp API interface.
 * Each vendor (wx, my, tt, swan) implements a superset of this.
 */
export interface MiniAppAPI {
  // Storage
  getStorageSync(key: string): string;
  setStorageSync(key: string, data: string): void;
  removeStorageSync(key: string): void;

  // Lifecycle
  onAppHide?(callback: () => void): void;
  offAppHide?(callback: () => void): void;

  // Error handling
  onError?(callback: (message: string) => void): void;
  offError?(callback: (message: string) => void): void;
  onUnhandledRejection?(
    callback: (res: { reason: string; promise: Promise<unknown> }) => void,
  ): void;
  offUnhandledRejection?(
    callback: (res: { reason: string; promise: Promise<unknown> }) => void,
  ): void;

  // Network
  request?(options: Record<string, unknown>): unknown;
}

/**
 * Create a miniapp platform adapter for a specific vendor.
 *
 * @param vendor - The miniapp vendor identifier
 * @param api - The vendor's global API object (e.g. wx, my, tt, swan)
 */
export function createMiniAppAdapter(
  vendor: MiniAppVendor,
  api: MiniAppAPI,
): PlatformAdapter {
  return {
    type: 'miniapp',
    vendor,

    storage: {
      getItem(key: string): string | null {
        try {
          const val = api.getStorageSync(key);
          return val != null && val !== '' ? String(val) : null;
        } catch {
          return null;
        }
      },
      setItem(key: string, value: string): void {
        try {
          api.setStorageSync(key, value);
        } catch {
          // storage full or unavailable
        }
      },
      removeItem(key: string): void {
        try {
          api.removeStorageSync(key);
        } catch {
          // unavailable
        }
      },
    },

    onBeforeExit(callback: () => void): () => void {
      if (api.onAppHide) {
        api.onAppHide(callback);
        return () => {
          api.offAppHide?.(callback);
        };
      }
      return () => {};
    },

    requestIdle(callback: () => void, timeout?: number): void {
      setTimeout(callback, timeout != null ? Math.min(timeout, 16) : 0);
    },

    getCurrentPath(): string {
      try {
        const pages =
          typeof getCurrentPages === 'function' ? getCurrentPages() : [];
        if (pages.length > 0) {
          const current = pages[pages.length - 1];
          return (current as any).route || (current as any).__route__ || '';
        }
      } catch {
        // getCurrentPages not available
      }
      return '';
    },

    errorCapture: {
      onGlobalError(
        handler: (info: GlobalErrorInfo) => void,
      ): () => void {
        if (!api.onError) return () => {};
        const cb = (message: string) => {
          const err = new Error(message);
          (err as any)._syntheticStack = true;
          handler({
            message,
            error: err,
          });
        };
        api.onError(cb);
        return () => {
          api.offError?.(cb);
        };
      },

      onUnhandledRejection(
        handler: (info: UnhandledRejectionInfo) => void,
      ): () => void {
        if (!api.onUnhandledRejection) return () => {};
        const cb = (res: { reason: string; promise: Promise<unknown> }) => {
          handler({ reason: res.reason });
        };
        api.onUnhandledRejection(cb);
        return () => {
          api.offUnhandledRejection?.(cb);
        };
      },

      // No resource error concept in miniapps
    },

    network: {
      intercept(
        handler: (log: NetworkRequestLog) => void,
        options: NetworkInterceptOptions,
      ): () => void {
        if (!api.request) return () => {};

        const originalRequest = api.request.bind(api);
        api.request = (reqOptions: Record<string, unknown>) => {
          const url = String(reqOptions['url'] || '');
          const method = String(reqOptions['method'] || 'GET').toUpperCase();

          if (!options.shouldCapture(url)) {
            return originalRequest(reqOptions);
          }

          const startTime = Date.now();

          let requestBody: unknown;
          if (options.captureRequestBody && reqOptions['data'] != null) {
            requestBody = reqOptions['data'];
          }

          const wrappedOptions = {
            ...reqOptions,
            success: (res: Record<string, unknown>) => {
              const duration = Date.now() - startTime;
              let responseBody: unknown;
              let responseCode: number | string | undefined;
              let responseMessage: string | undefined;

              if (options.captureResponseBody && res['data'] != null) {
                responseBody = res['data'];
                if (typeof responseBody === 'object' && responseBody) {
                  const obj = responseBody as Record<string, unknown>;
                  responseCode = obj['code'] as number | string | undefined;
                  responseMessage = (obj['message'] || obj['msg']) as
                    | string
                    | undefined;
                }
              }

              handler({
                type: 'request',
                url,
                method,
                status: (res['statusCode'] ?? res['status']) as number | undefined,
                statusText: '',
                duration,
                timestamp: startTime,
                requestBody,
                responseBody,
                responseCode,
                responseMessage,
              });

              if (typeof reqOptions['success'] === 'function') {
                (reqOptions['success'] as Function)(res);
              }
            },
            fail: (err: Record<string, unknown>) => {
              const duration = Date.now() - startTime;
              handler({
                type: 'request',
                url,
                method,
                status: 0,
                statusText: 'Request Failed',
                duration,
                timestamp: startTime,
                requestBody,
                error: String(err['errMsg'] || err['errorMessage'] || 'Request failed'),
              });

              if (typeof reqOptions['fail'] === 'function') {
                (reqOptions['fail'] as Function)(err);
              }
            },
            complete: (res: Record<string, unknown>) => {
              if (typeof reqOptions['complete'] === 'function') {
                (reqOptions['complete'] as Function)(res);
              }
            },
          };

          return originalRequest(wrappedOptions);
        };

        return () => {
          if (originalRequest) {
            api.request = originalRequest;
          }
        };
      },
    },

    earlyCapture: {
      hasEarlyErrors(): boolean {
        // Miniapp early errors are captured via App.onError before SDK init
        // The adapter stores them internally during the start() phase
        return false;
      },
      flush(_callback: (errors: EarlyError[]) => void): void {
        // No browser-style __EARLY_ERRORS__ in miniapps
        // Early errors in miniapps are captured through errorCapture.onGlobalError
      },
    },
  };
}
