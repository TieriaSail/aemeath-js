import { normalizeCapturedError } from '../utils/errorEvidence';
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
import { runCapture } from '../utils/captureGuard';

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

interface EventObserver { report?: (error: unknown) => void; }
interface EventListenerState {
  wrapped: EventListener;
  observers: Set<EventObserver>;
}
// A native registration must keep its identity across plugin instances. Scope
// states by target so unrelated targets sharing a callback do not share observers.
const eventListeners = new WeakMap<object, WeakMap<object, EventListenerState>>();
const eventOriginals = new WeakMap<object, EventListenerOrEventListenerObject>();
// Carry only the exact fallback through older SDK patches. Otherwise each
// layer repeats the wrapped/native pair after every soft reinstall.
let nativeRemoval: { target: object; listener: object; type: string; capture: boolean } | undefined;

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

  private readonly eventObserver: EventObserver = {};
  private readonly callbacks = new WeakMap<Function, Function>();
  private readonly callbackWrappers = new WeakSet<Function>();

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
    this.disabled = false;
    this.eventObserver.report = (error: unknown): void => {
      if (!this.logger || this.disabled) return;
      const err = normalizeCapturedError(error, { channel: 'wrapped' });
      this.logger.error('Caught error in wrapped callback', { error: err });
    };
    // Soft uninstall leaves our patches installed; reactivate them in place.
    if (this.restoreFns.length > 0) return;

    if (typeof window === 'undefined') {
      this.log('Skipped — not a browser environment');
      return;
    }

    const errorHandler = this.eventObserver.report;

    if (this.config.eventTarget) {
      try {
        this.patchEventTargets();
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
    this.eventObserver.report = undefined;
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
    for (const restore of [...this.restoreFns].reverse()) {
      try {
        restore();
      } catch {
        // best-effort restore
      }
    }
    this.restoreFns = [];
    this.disabled = true;
    this.eventObserver.report = undefined;
    this.logger = null;
    this.log('Force-restored all APIs');
  }

  // ==================== Patching ====================

  private patchEventTargets(): void {
    const globalObj = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : undefined);
    if (!globalObj) return;

    const self = this;

    for (const targetName of this.config.eventTargetObjects) {
      try {
        const target = (globalObj as Record<string, unknown>)[targetName] as
          | { prototype?: { addEventListener?: Function; removeEventListener?: Function } }
          | undefined;

        if (!target?.prototype?.addEventListener || !target?.prototype?.removeEventListener) {
          continue;
        }

        const proto = target.prototype;
        const addDescriptor = Object.getOwnPropertyDescriptor(proto, 'addEventListener');
        const removeDescriptor = Object.getOwnPropertyDescriptor(proto, 'removeEventListener');
        const originalAdd = proto.addEventListener as Function;
        const originalRemove = proto.removeEventListener as Function;

        const restore = (): void => {
          if (addDescriptor) Object.defineProperty(proto, 'addEventListener', addDescriptor);
          else delete proto.addEventListener;
          if (removeDescriptor) Object.defineProperty(proto, 'removeEventListener', removeDescriptor);
          else delete proto.removeEventListener;
        };
        try {
          proto.addEventListener = function (
            this: EventTarget,
            type: string,
            listener: EventListenerOrEventListenerObject | null,
            options?: boolean | AddEventListenerOptions,
          ): void {
            if (listener == null || (typeof listener !== 'function' && typeof listener !== 'object')) {
              return originalAdd.call(this, type, listener, options);
            }
            const originalListener = eventOriginals.get(listener) || listener;
            let listeners = eventListeners.get(this);
            let state = listeners?.get(originalListener);
            if (!state) {
              if (self.disabled) return originalAdd.call(this, type, listener, options);
              const observers = new Set<EventObserver>();
              const wrapped: EventListener = function(this: EventTarget, event: Event): void {
                try {
                  if (typeof originalListener === 'function') Reflect.apply(originalListener, this, [event]);
                  else originalListener.handleEvent(event);
                } catch (error) {
                  for (const observer of [...observers]) {
                    const report = observer.report;
                    if (report) runCapture('wrapped', () => report(error));
                    else observers.delete(observer);
                  }
                  throw error;
                }
              };
              state = { wrapped, observers };
              if (!listeners) { listeners = new WeakMap(); eventListeners.set(this, listeners); }
              listeners.set(originalListener, state);
              eventOriginals.set(wrapped, originalListener);
            }
            for (const observer of state.observers) {
              if (!observer.report) state.observers.delete(observer);
            }
            if (!self.disabled) state.observers.add(self.eventObserver);
            const wrappedListener = state.wrapped;

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

            if (nativeRemoval && nativeRemoval.target === this && nativeRemoval.listener === listener &&
                nativeRemoval.type === type && nativeRemoval.capture === options) {
              return originalRemove.call(this, type, listener, options);
            }
            if (typeof listener === 'function' || typeof listener === 'object') {
              const originalListener = eventOriginals.get(listener) || listener;
              const wrapped = eventListeners.get(this)?.get(originalListener)?.wrapped;
              if (wrapped && wrapped !== listener) {
                // The fallback removes registrations made before instrumentation.
                // Coerce user input once before forwarding both native removals.
                const eventType = `${type}`;
                const capture = options !== null && (typeof options === 'object' || typeof options === 'function')
                  ? Boolean(options.capture) : Boolean(options);
                originalRemove.call(this, eventType, wrapped, capture);
                const previousRemoval = nativeRemoval;
                nativeRemoval = { target: this, listener, type: eventType, capture };
                try { return originalRemove.call(this, eventType, listener, capture); }
                finally { nativeRemoval = previousRemoval; }
              }
            }

            return originalRemove.call(this, type, listener, options);
          };

          this.restoreFns.push(restore);
        } catch (error) {
          restore();
          throw error;
        }
      } catch (error) {
        this.warn('Failed to patch event target:', targetName, error);
      }
    }
  }

  /** Instrument only the callback; preserve native argument/receiver semantics. */
  private wrapCallback<T extends Function>(callback: T, errorHandler: (error: unknown) => void): T {
    if (this.callbackWrappers.has(callback)) return callback;
    const existing = this.callbacks.get(callback);
    if (existing) return existing as T;
    const wrapped = function(this: unknown, ...args: unknown[]): unknown {
      try { return Reflect.apply(callback, this, args); }
      catch (error) {
        runCapture('wrapped', () => errorHandler(error));
        throw error;
      }
    };
    this.callbacks.set(callback, wrapped);
    this.callbackWrappers.add(wrapped);
    return wrapped as unknown as T;
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
            self.wrapCallback(handler, errorHandler),
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
      if (self.disabled || typeof callback !== 'function') {
        return original.call(globalObj, callback);
      }
      return original.call(globalObj, self.wrapCallback(callback, errorHandler) as FrameRequestCallback);
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
          try {
            const original = (this as unknown as Record<string, unknown>)[prop];
            if (typeof original === 'function') {
              (this as unknown as Record<string, unknown>)[prop] = self.wrapCallback(original, errorHandler);
            }
          } catch {
            // Unreadable/read-only host properties must not prevent native send.
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
