/**
 * Noop platform adapter — fallback for unknown environments.
 *
 * All methods are safe no-ops. The SDK won't crash in unsupported platforms,
 * but monitoring features won't work.
 */

import type { PlatformAdapter, EarlyError } from './types';

export function createNoopAdapter(): PlatformAdapter {
  return {
    type: 'unknown',

    storage: {
      getItem(): string | null {
        return null;
      },
      setItem(): void {},
      removeItem(): void {},
    },

    onBeforeExit(): () => void {
      return () => {};
    },

    requestIdle(callback: () => void): void {
      setTimeout(callback, 0);
    },

    getCurrentPath(): string {
      return '';
    },

    errorCapture: {
      onGlobalError(): () => void {
        return () => {};
      },
      onUnhandledRejection(): () => void {
        return () => {};
      },
    },

    earlyCapture: {
      isInstalled(): boolean {
        return false;
      },
      hasEarlyErrors(): boolean {
        return false;
      },
      flush(_callback: (errors: EarlyError[]) => void): void {},
    },
  };
}
