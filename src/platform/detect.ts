/**
 * Platform auto-detection and manual override.
 *
 * Detection order (important — some miniapp WebViews expose `window`):
 * 1. MiniApp vendors (wx, my, tt, swan)
 * 2. Browser (window + document)
 * 3. Noop fallback
 */

import type { PlatformAdapter, MiniAppVendor } from './types';
import { createBrowserAdapter } from './browser';
import { createMiniAppAdapter, type MiniAppAPI } from './miniapp';
import { createNoopAdapter } from './noop';

/**
 * Wrap Alipay's `my` object to normalize API differences.
 * Alipay uses object parameters for storage and different response field names.
 */
function wrapAlipayAPI(api: Record<string, any>): MiniAppAPI {
  return {
    getStorageSync(key: string): string {
      const res = api.getStorageSync({ key });
      return res?.data ?? '';
    },
    setStorageSync(key: string, data: string): void {
      api.setStorageSync({ key, data });
    },
    removeStorageSync(key: string): void {
      api.removeStorageSync({ key });
    },
    onAppHide: api.onAppHide?.bind(api),
    offAppHide: api.offAppHide?.bind(api),
    onError: api.onError?.bind(api),
    offError: api.offError?.bind(api),
    onUnhandledRejection: api.onUnhandledRejection?.bind(api),
    offUnhandledRejection: api.offUnhandledRejection?.bind(api),
    request: api.request?.bind(api),
  };
}

/**
 * Module-level singleton cache.
 *
 * Known limitation: in micro-frontend or SSR environments where multiple
 * bundles share the same module scope, this cache may cause cross-instance
 * conflicts. In such cases, pass an explicit `platform` option to
 * `initAemeath()` instead of relying on auto-detection, or call
 * `resetPlatform()` before each initialization.
 */
let currentPlatform: PlatformAdapter | null = null;

interface MiniAppCandidate {
  vendor: MiniAppVendor;
  check: () => boolean;
  getAPI: () => MiniAppAPI;
}

const miniappCandidates: MiniAppCandidate[] = [
  {
    vendor: 'wechat',
    check: () =>
      typeof wx !== 'undefined' &&
      typeof (wx as any).getSystemInfoSync === 'function',
    getAPI: () => wx as unknown as MiniAppAPI,
  },
  {
    vendor: 'alipay',
    check: () =>
      typeof my !== 'undefined' &&
      typeof (my as any).getSystemInfoSync === 'function',
    getAPI: () => wrapAlipayAPI(my!),
  },
  {
    vendor: 'tiktok',
    check: () =>
      typeof tt !== 'undefined' &&
      typeof (tt as any).getSystemInfoSync === 'function',
    getAPI: () => tt as unknown as MiniAppAPI,
  },
  {
    vendor: 'baidu',
    check: () =>
      typeof swan !== 'undefined' &&
      typeof (swan as any).getSystemInfoSync === 'function',
    getAPI: () => swan as unknown as MiniAppAPI,
  },
];

function detectMiniApp(): PlatformAdapter | null {
  for (const candidate of miniappCandidates) {
    try {
      if (candidate.check()) {
        return createMiniAppAdapter(candidate.vendor, candidate.getAPI());
      }
    } catch {
      // Detection failed for this vendor, try next
    }
  }
  return null;
}

/**
 * Auto-detect current platform and return the appropriate adapter.
 * Result is cached — subsequent calls return the same instance.
 *
 * @param fresh - If true, bypass the cache and re-detect.
 *   Useful in micro-frontend or testing scenarios.
 */
export function detectPlatform(fresh?: boolean): PlatformAdapter {
  if (!fresh && currentPlatform) return currentPlatform;

  // 1. Check miniapp first (some WebViews have window)
  const miniapp = detectMiniApp();
  if (miniapp) {
    currentPlatform = miniapp;
    return currentPlatform;
  }

  // 2. Check browser
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    currentPlatform = createBrowserAdapter();
    return currentPlatform;
  }

  // 3. Fallback to noop
  currentPlatform = createNoopAdapter();
  return currentPlatform;
}

/**
 * Manually set the platform adapter (for testing or custom environments).
 */
export function setPlatform(adapter: PlatformAdapter): void {
  currentPlatform = adapter;
}

/**
 * Reset platform detection (mainly for testing).
 */
export function resetPlatform(): void {
  currentPlatform = null;
}
