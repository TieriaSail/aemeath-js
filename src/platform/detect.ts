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
    getAPI: () => my as unknown as MiniAppAPI,
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
 */
export function detectPlatform(): PlatformAdapter {
  if (currentPlatform) return currentPlatform;

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
