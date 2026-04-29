/**
 * Browser API Errors Plugin
 *
 * Monkey-patches browser APIs to wrap callbacks with try-catch, capturing
 * full error details that would otherwise be sanitized to "Script error."
 * in cross-origin / WebView environments.
 *
 * Patched APIs:
 * - EventTarget.prototype.addEventListener / removeEventListener
 * - setTimeout / setInterval
 * - requestAnimationFrame
 * - XMLHttpRequest.prototype.send (wraps onload / onerror / onprogress / onreadystatechange)
 */

import type { AemeathPlugin, AemeathInterface } from '../types';
import { PluginPriority } from '../types';
import { wrap, type WrappedFunction } from '../utils/wrap';

// ==================== Configuration ====================

export interface BrowserApiErrorsPluginOptions {
  /** Patch EventTarget.addEventListener @default true */
  eventTarget?: boolean;

  /** Patch setTimeout / setInterval @default true */
  timer?: boolean;

  /** Patch requestAnimationFrame @default true */
  requestAnimationFrame?: boolean;

  /** Patch XMLHttpRequest.send callbacks @default true */
  xhr?: boolean;

  /**
   * Custom list of objects whose addEventListener / removeEventListener
   * should be patched. Defaults to a comprehensive built-in list.
   */
  eventTargetObjects?: string[];

  /** Debug mode @default false */
  debug?: boolean;
}

// ==================== Default event target list ====================

const DEFAULT_EVENT_TARGETS = [
  'EventTarget',
  'Window',
  'Node',
  'ApplicationCache',
  'AudioTrackList',
  'BaseAudioContext',
  'ChannelMergerNode',
  'CryptoOperation',
  'EventSource',
  'FileReader',
  'HTMLUnknownElement',
  'IDBDatabase',
  'IDBRequest',
  'IDBTransaction',
  'KeyOperation',
  'MediaController',
  'MessagePort',
  'ModalWindow',
  'Notification',
  'SVGElementInstance',
  'Screen',
  'SharedWorker',
  'TextTrack',
  'TextTrackCue',
  'TextTrackList',
  'WebSocket',
  'Worker',
  'XMLHttpRequest',
  'XMLHttpRequestEventTarget',
  'XMLHttpRequestUpload',
];

// XHR callback properties to wrap
const XHR_CALLBACK_PROPS: (keyof XMLHttpRequest)[] = [
  'onload',
  'onerror',
  'onprogress',
  'onloadend',
  'onreadystatechange',
  'ontimeout',
  'onabort',
];

// ==================== Plugin ====================

export class BrowserApiErrorsPlugin implements AemeathPlugin {
  readonly name = 'browser-api-errors';
  readonly version = '1.3.0';
  readonly priority: number = PluginPriority.EARLIEST;
  readonly description = 'Browser API callback wrapping for enhanced error capture';

  private readonly config: Required<Omit<BrowserApiErrorsPluginOptions, 'eventTargetObjects'>> & {
    eventTargetObjects: string[];
  };
  private readonly debugEnabled: boolean;
  private logger: AemeathInterface | null = null;

  /**
   * When true, all patches become transparent pass-throughs.
   * This avoids breaking other libraries' monkey-patch chains
   * that may have been installed after ours.
   */
  private disabled = false;

  // Restore functions for forceRestore (hard uninstall)
  private restoreFns: Array<() => void> = [];

  constructor(options: BrowserApiErrorsPluginOptions = {}) {
    this.debugEnabled = options.debug ?? false;
    this.config = {
      eventTarget: options.eventTarget ?? true,
      timer: options.timer ?? true,
      requestAnimationFrame: options.requestAnimationFrame ?? true,
      xhr: options.xhr ?? true,
      eventTargetObjects: options.eventTargetObjects ?? DEFAULT_EVENT_TARGETS,
      debug: options.debug ?? false,
    };
  }

  private log(...args: unknown[]): void {
    if (this.debugEnabled) {
      console.log('[BrowserApiErrors]', ...args);
    }
  }

  private warn(...args: unknown[]): void {
    if (this.debugEnabled) {
      console.warn('[BrowserApiErrors]', ...args);
    }
  }

  install(logger: AemeathInterface): void {
    this.logger = logger;

    if (typeof window === 'undefined') {
      this.log('Skipped — not a browser environment');
      return;
    }

    const self = this;
    const errorHandler = (error: unknown): void => {
      if (!self.logger || self.disabled) return;
      const err = error instanceof Error
        ? error
        : new Error(String(error));
      self.logger.error('Caught error in wrapped callback', { error: err });
    };

    if (this.config.eventTarget) {
      try {
        this.patchEventTargets(errorHandler);
      } catch (e) {
        this.warn('Failed to patch event targets:', e);
      }
    }

    if (this.config.timer) {
      try {
        this.patchTimers(errorHandler);
      } catch (e) {
        this.warn('Failed to patch timers:', e);
      }
    }

    if (this.config.requestAnimationFrame) {
      try {
        this.patchRequestAnimationFrame(errorHandler);
      } catch (e) {
        this.warn('Failed to patch requestAnimationFrame:', e);
      }
    }

    if (this.config.xhr) {
      try {
        this.patchXHR(errorHandler);
      } catch (e) {
        this.warn('Failed to patch XMLHttpRequest:', e);
      }
    }

    this.log('Installed —', this.restoreFns.length, 'patches applied');
  }

  uninstall(): void {
    this.disabled = true;
    this.logger = null;
    this.log('Disabled (soft uninstall — patches remain as pass-throughs to preserve other libraries\' patch chains)');
  }

  /**
   * Hard-restore all patched APIs to their pre-patch state.
   *
   * Only call this when you are certain no other library has patched
   * the same APIs after this plugin. Otherwise use `uninstall()` which
   * keeps patches in place as transparent pass-throughs.
   */
  forceRestore(): void {
    for (const restore of this.restoreFns) {
      try {
        restore();
      } catch {
        // best-effort restore
      }
    }
    this.restoreFns = [];
    this.disabled = true;
    this.logger = null;
    this.log('Force-restored all APIs');
  }

  // ==================== Patching ====================

  private patchEventTargets(errorHandler: (error: unknown) => void): void {
    const globalObj = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : undefined);
    if (!globalObj) return;

    const self = this;

    for (const targetName of this.config.eventTargetObjects) {
      const target = (globalObj as Record<string, unknown>)[targetName] as
        | { prototype?: { addEventListener?: Function; removeEventListener?: Function } }
        | undefined;

      if (!target?.prototype?.addEventListener || !target?.prototype?.removeEventListener) {
        continue;
      }

      const proto = target.prototype;
      const originalAdd = proto.addEventListener as Function;
      const originalRemove = proto.removeEventListener as Function;

      proto.addEventListener = function (
        this: EventTarget,
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ): void {
        if (listener == null || self.disabled) {
          return originalAdd.call(this, type, listener, options);
        }

        let wrappedListener: EventListenerOrEventListenerObject;

        if (typeof listener === 'function') {
          wrappedListener = wrap(listener, errorHandler);
        } else if (typeof listener === 'object' && typeof listener.handleEvent === 'function') {
          const originalHandleEvent = listener.handleEvent;
          const wrappedHandleEvent = wrap(originalHandleEvent, errorHandler);
          wrappedListener = {
            ...listener,
            handleEvent: wrappedHandleEvent as EventListener,
          };
        } else {
          wrappedListener = listener;
        }

        return originalAdd.call(this, type, wrappedListener, options);
      };

      proto.removeEventListener = function (
        this: EventTarget,
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
      ): void {
        if (listener == null) {
          return originalRemove.call(this, type, listener, options);
        }

        if (typeof listener === 'function') {
          const wrapped = (listener as WrappedFunction).__aemeath_wrapped__;
          if (wrapped) {
            originalRemove.call(this, type, wrapped as EventListener, options);
          }
        }

        return originalRemove.call(this, type, listener, options);
      };

      this.restoreFns.push(() => {
        proto.addEventListener = originalAdd as typeof proto.addEventListener;
        proto.removeEventListener = originalRemove as typeof proto.removeEventListener;
      });
    }
  }

  private patchTimers(errorHandler: (error: unknown) => void): void {
    const globalObj = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : undefined);
    if (!globalObj) return;

    const self = this;

    const patchTimer = (name: 'setTimeout' | 'setInterval'): void => {
      const original = (globalObj as Record<string, unknown>)[name] as Function;
      if (typeof original !== 'function') return;

      (globalObj as Record<string, unknown>)[name] = function (
        this: unknown,
        handler: TimerHandler,
        timeout?: number,
        ...args: unknown[]
      ): number {
        if (typeof handler === 'function' && !self.disabled) {
          return (original as Function).call(
            this,
            wrap(handler, errorHandler),
            timeout,
            ...args,
          );
        }
        return (original as Function).call(this, handler, timeout, ...args);
      };

      this.restoreFns.push(() => {
        (globalObj as Record<string, unknown>)[name] = original;
      });
    };

    patchTimer('setTimeout');
    patchTimer('setInterval');
  }

  private patchRequestAnimationFrame(errorHandler: (error: unknown) => void): void {
    const globalObj = typeof window !== 'undefined' ? window : undefined;
    if (!globalObj || typeof globalObj.requestAnimationFrame !== 'function') return;

    const self = this;
    const original = globalObj.requestAnimationFrame;

    globalObj.requestAnimationFrame = function (callback: FrameRequestCallback): number {
      if (self.disabled) {
        return original.call(globalObj, callback);
      }
      return original.call(globalObj, wrap(callback, errorHandler) as FrameRequestCallback);
    };

    this.restoreFns.push(() => {
      globalObj.requestAnimationFrame = original;
    });
  }

  private patchXHR(errorHandler: (error: unknown) => void): void {
    if (typeof XMLHttpRequest === 'undefined') return;

    const self = this;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.send = function (
      this: XMLHttpRequest,
      ...args: Parameters<XMLHttpRequest['send']>
    ): void {
      if (!self.disabled) {
        for (const prop of XHR_CALLBACK_PROPS) {
          if (typeof (this as unknown as Record<string, unknown>)[prop] === 'function') {
            try {
              const original = (this as unknown as Record<string, unknown>)[prop] as Function;
              (this as unknown as Record<string, unknown>)[prop] = wrap(original, errorHandler);
            } catch {
              // Some XHR properties may be read-only in certain environments
            }
          }
        }
      }
      return originalSend.apply(this, args);
    };

    this.restoreFns.push(() => {
      XMLHttpRequest.prototype.send = originalSend;
    });
  }
}
