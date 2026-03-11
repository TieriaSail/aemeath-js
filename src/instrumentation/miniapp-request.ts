/**
 * MiniApp request instrumentation — singleton monkey-patch with multi-subscriber support.
 *
 * Design principles (addressing BUG-2, ARCH-3):
 * - Patches `api.request` at most once per API object.
 * - Transparently forwards success / fail / complete callbacks.
 * - Handles Alipay `status` vs WeChat `statusCode`, and `errorMessage` vs `errMsg`.
 * - Multi-subscriber: multiple handlers share a single patch.
 * - Safe restoration: only restores if no third-party patch was applied after ours.
 */

import type { NetworkEvent, NetworkHandler, InstrumentOptions, Unsubscribe } from './types';

// ---------------------------------------------------------------------------
// MiniApp request API shape (minimal)
// ---------------------------------------------------------------------------

export interface MiniAppRequestAPI {
  request?(options: Record<string, unknown>): unknown;
}

// ---------------------------------------------------------------------------
// Singleton state (per API object via WeakMap)
// ---------------------------------------------------------------------------

interface PatchState {
  subscribers: Array<{ handler: NetworkHandler; options: InstrumentOptions }>;
  originalRequest: (options: Record<string, unknown>) => unknown;
  patchedRequest: (options: Record<string, unknown>) => unknown;
}

const patchStates = new WeakMap<object, PatchState>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Notify only subscribers whose `shouldCapture` matches the event URL.
 */
function notifyFiltered(state: PatchState, url: string, event: NetworkEvent): void {
  for (const sub of state.subscribers) {
    try {
      if (sub.options.shouldCapture(url)) {
        sub.handler(event);
      }
    } catch {
      // subscriber errors must not break request flow
    }
  }
}

function shouldAnyCaptureUrl(state: PatchState, url: string): boolean {
  return state.subscribers.some((s) => s.options.shouldCapture(url));
}

function shouldAnyCaptureRequestBody(state: PatchState): boolean {
  return state.subscribers.some((s) => s.options.captureRequestBody);
}

function shouldAnyCaptureResponseBody(state: PatchState): boolean {
  return state.subscribers.some((s) => s.options.captureResponseBody);
}

// ---------------------------------------------------------------------------
// Patch logic
// ---------------------------------------------------------------------------

function installPatch(api: MiniAppRequestAPI, state: PatchState): void {
  const original = state.originalRequest;

  const patched = (reqOptions: Record<string, unknown>): unknown => {
    const url = String(reqOptions['url'] || '');
    const method = String(reqOptions['method'] || 'GET').toUpperCase();

    if (!shouldAnyCaptureUrl(state, url)) {
      return original.call(api, reqOptions);
    }

    const startTime = Date.now();

    let requestBody: unknown;
    if (shouldAnyCaptureRequestBody(state) && reqOptions['data'] != null) {
      requestBody = reqOptions['data'];
    }

    const wrappedOptions: Record<string, unknown> = {
      ...reqOptions,
      success: (res: Record<string, unknown>) => {
        const duration = Date.now() - startTime;
        let responseBody: unknown;
        let responseCode: number | string | undefined;
        let responseMessage: string | undefined;

        if (shouldAnyCaptureResponseBody(state) && res['data'] != null) {
          responseBody = res['data'];
          if (typeof responseBody === 'object' && responseBody) {
            const obj = responseBody as Record<string, unknown>;
            responseCode = obj['code'] as number | string | undefined;
            responseMessage = (obj['message'] || obj['msg']) as string | undefined;
          }
        }

        notifyFiltered(state, url, {
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
        notifyFiltered(state, url, {
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

    return original.call(api, wrappedOptions);
  };

  api.request = patched;
  state.patchedRequest = patched;
}

function uninstallPatch(api: MiniAppRequestAPI, state: PatchState): void {
  if (api.request === state.patchedRequest) {
    api.request = state.originalRequest;
  }
  patchStates.delete(api);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Subscribe to miniapp network request events.
 *
 * @param api - The miniapp global API object (e.g. wx, my, tt, swan) or a
 *   wrapped MiniAppAPI from `createMiniAppAdapter`.
 * @param handler - Callback receiving network events.
 * @param options - Capture configuration.
 * @returns Unsubscribe function.
 */
export function instrumentMiniAppRequest(
  api: MiniAppRequestAPI,
  handler: NetworkHandler,
  options: InstrumentOptions,
): Unsubscribe {
  if (!api || typeof api.request !== 'function') {
    return () => {};
  }

  const sub = { handler, options };

  let state = patchStates.get(api);
  if (!state) {
    state = {
      subscribers: [sub],
      originalRequest: api.request as (opts: Record<string, unknown>) => unknown,
      patchedRequest: null as unknown as (opts: Record<string, unknown>) => unknown,
    };
    patchStates.set(api, state);
    installPatch(api, state);
  } else {
    state.subscribers.push(sub);
  }

  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const s = patchStates.get(api);
    if (!s) return;
    s.subscribers = s.subscribers.filter((x) => x !== sub);
    if (s.subscribers.length === 0) {
      uninstallPatch(api, s);
    }
  };
}

/**
 * Reset all internal state for a given API object. Intended for testing only.
 * @internal
 */
export function _resetMiniAppRequestInstrumentation(api: MiniAppRequestAPI): void {
  const state = patchStates.get(api as object);
  if (state) {
    uninstallPatch(api, state);
  }
}
