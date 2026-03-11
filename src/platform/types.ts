/**
 * Platform abstraction layer — type definitions
 *
 * All platform-specific behavior is behind the PlatformAdapter interface.
 * Plugins only depend on this interface, never on browser/miniapp APIs directly.
 */

export type PlatformType = 'browser' | 'miniapp' | 'unknown';

export type MiniAppVendor =
  | 'wechat'
  | 'alipay'
  | 'tiktok'
  | 'baidu'
  | 'unknown';

export interface EarlyError {
  type: 'error' | 'resource' | 'unhandledrejection' | 'compatibility';
  message: string;
  stack: string | null;
  filename?: string;
  lineno?: number;
  colno?: number;
  source?: string;
  timestamp: number;
  device: {
    ua: string;
    lang: string;
    screen: string;
    url: string;
    time: number;
  };
}

/**
 * Handler called when a global error is captured.
 * Return value follows the same semantics as window.onerror.
 */
export interface GlobalErrorInfo {
  message: string | Event;
  source?: string;
  lineno?: number;
  colno?: number;
  error?: Error;
}

/**
 * Handler called when an unhandled promise rejection is captured.
 */
export interface UnhandledRejectionInfo {
  reason: unknown;
}

/**
 * Unified platform adapter interface.
 *
 * Each platform (browser, miniapp, noop) implements this interface.
 * Plugins consume it without knowing which platform they're running on.
 *
 * Network interception is NOT part of this interface — it lives in the
 * independent `src/instrumentation/` layer, which owns all monkey-patch logic.
 */
export interface PlatformAdapter {
  readonly type: PlatformType;
  readonly vendor?: MiniAppVendor;

  /** Key-value storage (UploadPlugin, SafeGuardPlugin) */
  storage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };

  /** Lifecycle hook — called before the app exits (UploadPlugin, SafeGuardPlugin) */
  onBeforeExit(callback: () => void): () => void;

  /** Idle scheduling (SafeGuardPlugin) */
  requestIdle(callback: () => void, timeout?: number): void;

  /** Current route path (RouteMatcher) */
  getCurrentPath(): string;

  /** Error capture (ErrorCapturePlugin) */
  errorCapture: {
    onGlobalError(
      handler: (info: GlobalErrorInfo) => void,
    ): () => void;
    onUnhandledRejection(
      handler: (info: UnhandledRejectionInfo) => void,
    ): () => void;
    onResourceError?(handler: (event: Event) => void): () => void;
  };

  /** Early error capture (EarlyErrorCapturePlugin) */
  earlyCapture: {
    hasEarlyErrors(): boolean;
    flush(callback: (errors: EarlyError[]) => void): void;
  };

  /**
   * The underlying native API object for the platform, if applicable.
   * For miniapps this is the (possibly wrapped) API object used internally by
   * the adapter. Exposed so that the instrumentation layer patches the exact
   * same object the adapter uses, avoiding Alipay wrapper divergence.
   */
  readonly nativeAPI?: { request?: (options: Record<string, unknown>) => unknown };
}
