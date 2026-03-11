/**
 * Platform auto-detection and manual override.
 *
 * Detection order (important — some miniapp WebViews expose `window`):
 * 1. MiniApp vendors (wx, my, tt, swan)
 * 2. Browser (window + document)
 * 3. Noop fallback
 *
 * Since `platform` is now a required property on `AemeathLogger` (injected
 * at construction time), `detectPlatform()` is typically called once per
 * Logger instance. There is no module-level cache — this avoids micro-frontend
 * and SSR cross-instance conflicts by design.
 */

import type { PlatformAdapter, MiniAppVendor } from './types';
import { createBrowserAdapter } from './browser';
import { createMiniAppAdapter } from './miniapp';
import { createNoopAdapter } from './noop';

/**
 * Manual override slot. When set, `detectPlatform()` returns this adapter.
 * @internal — primarily for testing and custom environments.
 */
let overridePlatform: PlatformAdapter | null = null;

interface MiniAppCandidate {
  vendor: MiniAppVendor;
  check: () => boolean;
  getRawAPI: () => Record<string, any>;
}

const miniappCandidates: MiniAppCandidate[] = [
  {
    vendor: 'wechat',
    check: () =>
      typeof wx !== 'undefined' &&
      wx != null &&
      typeof (wx as any).getSystemInfoSync === 'function',
    getRawAPI: () => wx as unknown as Record<string, any>,
  },
  {
    vendor: 'alipay',
    check: () =>
      typeof my !== 'undefined' &&
      my != null &&
      typeof (my as any).getSystemInfoSync === 'function',
    getRawAPI: () => my as unknown as Record<string, any>,
  },
  {
    vendor: 'tiktok',
    check: () =>
      typeof tt !== 'undefined' &&
      tt != null &&
      typeof (tt as any).getSystemInfoSync === 'function',
    getRawAPI: () => tt as unknown as Record<string, any>,
  },
  {
    vendor: 'baidu',
    check: () =>
      typeof swan !== 'undefined' &&
      swan != null &&
      typeof (swan as any).getSystemInfoSync === 'function',
    getRawAPI: () => swan as unknown as Record<string, any>,
  },
];

function detectMiniApp(): PlatformAdapter | null {
  for (const candidate of miniappCandidates) {
    try {
      if (candidate.check()) {
        return createMiniAppAdapter(candidate.vendor, candidate.getRawAPI());
      }
    } catch {
      // Detection failed for this vendor, try next
    }
  }
  return null;
}

/**
 * Auto-detect current platform and return a new adapter instance.
 *
 * If a manual override has been set via `setPlatform()`, that adapter
 * is returned instead.
 */
export function detectPlatform(): PlatformAdapter {
  if (overridePlatform) return overridePlatform;

  const miniapp = detectMiniApp();
  if (miniapp) return miniapp;

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    return createBrowserAdapter();
  }

  return createNoopAdapter();
}

/**
 * Manually set the platform adapter (for testing or custom environments).
 * @internal
 */
export function setPlatform(adapter: PlatformAdapter): void {
  overridePlatform = adapter;
}

/**
 * Reset platform override (mainly for testing).
 * @internal
 */
export function resetPlatform(): void {
  overridePlatform = null;
}
