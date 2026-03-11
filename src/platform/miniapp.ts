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
  EarlyError,
} from './types';

import { SYNTHETIC_STACK } from './constants';
export { SYNTHETIC_STACK };

const wrappedApis = new WeakSet<object>();

function isAlreadyWrapped(api: unknown): boolean {
  return typeof api === 'object' && api !== null && wrappedApis.has(api);
}

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
    callback: (res: { reason: unknown; promise: Promise<unknown> }) => void,
  ): void;
  offUnhandledRejection?(
    callback: (res: { reason: unknown; promise: Promise<unknown> }) => void,
  ): void;

  // Network
  request?(options: Record<string, unknown>): unknown;
}

/**
 * Wrap Alipay's raw `my` object to normalize API differences.
 * Alipay uses object parameters for storage and different response field names.
 */
function wrapAlipayAPI(api: Record<string, any>): MiniAppAPI {
  const safeBind = (fn: unknown): ((...args: any[]) => any) | undefined =>
    typeof fn === 'function' ? (fn as Function).bind(api) : undefined;

  const result: MiniAppAPI = {
    getStorageSync(key: string): string {
      const res = api.getStorageSync({ key });
      const data = res?.data;
      if (data == null || data === '') return '';
      if (typeof data === 'object') {
        try { return JSON.stringify(data); } catch { return ''; }
      }
      return String(data);
    },
    setStorageSync(key: string, data: string): void {
      api.setStorageSync({ key, data });
    },
    removeStorageSync(key: string): void {
      api.removeStorageSync({ key });
    },
    onAppHide: safeBind(api.onAppHide) as MiniAppAPI['onAppHide'],
    offAppHide: safeBind(api.offAppHide) as MiniAppAPI['offAppHide'],
    onError: safeBind(api.onError) as MiniAppAPI['onError'],
    offError: safeBind(api.offError) as MiniAppAPI['offError'],
    onUnhandledRejection: safeBind(api.onUnhandledRejection) as MiniAppAPI['onUnhandledRejection'],
    offUnhandledRejection: safeBind(api.offUnhandledRejection) as MiniAppAPI['offUnhandledRejection'],
    request: safeBind(api.request) as MiniAppAPI['request'],
  };

  wrappedApis.add(result);
  return result;
}

/**
 * Create a miniapp platform adapter for a specific vendor.
 *
 * When `vendor` is `'alipay'`, the raw API object is automatically wrapped
 * via `wrapAlipayAPI` to normalize storage signatures and response fields.
 * Users can safely pass the raw `my` global — no manual wrapping needed.
 *
 * @param vendor - The miniapp vendor identifier
 * @param api - The vendor's global API object (e.g. wx, my, tt, swan).
 *   For Alipay, the raw `my` object is accepted and auto-wrapped.
 */
export function createMiniAppAdapter(
  vendor: MiniAppVendor,
  rawApi: MiniAppAPI | Record<string, any>,
): PlatformAdapter {
  const api: MiniAppAPI =
    vendor === 'alipay' && !isAlreadyWrapped(rawApi)
      ? wrapAlipayAPI(rawApi as Record<string, any>)
      : (rawApi as MiniAppAPI);

  if (typeof api.getStorageSync !== 'function') {
    throw new TypeError(
      `[MiniApp] Invalid API object for vendor "${vendor}": getStorageSync must be a function`,
    );
  }

  return {
    type: 'miniapp',
    vendor,
    nativeAPI: api,

    storage: {
      getItem(key: string): string | null {
        try {
          const val = api.getStorageSync(key);
          // Empty string is treated as "no data" for consistency across vendors
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

    requestIdle(callback: () => void, _timeout?: number): void {
      setTimeout(callback, 0);
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
          (err as any)[SYNTHETIC_STACK] = true;
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
        const cb = (res: { reason: unknown; promise: Promise<unknown> }) => {
          handler({ reason: res.reason });
        };
        api.onUnhandledRejection(cb);
        return () => {
          api.offUnhandledRejection?.(cb);
        };
      },

      // No resource error concept in miniapps
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
