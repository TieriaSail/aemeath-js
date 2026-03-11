/**
 * Fetch instrumentation — singleton monkey-patch with multi-subscriber support.
 *
 * Design principles (addressing S-NEW-3, S-NEW-4, M-NEW-2, M-NEW-4):
 * - Patches `window.fetch` at most once regardless of how many subscribers.
 * - Each subscriber receives all captured events independently.
 * - When the last subscriber unsubscribes, the original fetch is restored
 *   only if no third-party code has overwritten our patch in the meantime.
 * - Request body type branching (string / FormData / Blob / etc.)
 * - Response body truncation via maxResponseBodySize.
 */

import type { NetworkEvent, NetworkHandler, InstrumentOptions, Unsubscribe } from './types';
import { safeParseJSON, extractBusinessInfo, captureRequestBody } from './helpers';

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

interface Subscriber {
  handler: NetworkHandler;
  options: InstrumentOptions;
}

let subscribers: Subscriber[] = [];
let originalFetch: typeof fetch | null = null;
let patchedFetch: typeof fetch | null = null;

/**
 * Notify only subscribers whose `shouldCapture` matches the event URL.
 * This ensures each subscriber only receives events it opted in to.
 */
function notifyFiltered(url: string, event: NetworkEvent): void {
  for (const sub of subscribers) {
    try {
      if (sub.options.shouldCapture(url)) {
        sub.handler(event);
      }
    } catch {
      // subscriber errors must not break fetch flow
    }
  }
}

function shouldAnyCaptureUrl(url: string): boolean {
  return subscribers.some((s) => s.options.shouldCapture(url));
}

function shouldAnyCaptureRequestBody(): boolean {
  return subscribers.some((s) => s.options.captureRequestBody);
}

function shouldAnyCaptureResponseBody(): boolean {
  return subscribers.some((s) => s.options.captureResponseBody);
}

function getMaxResponseBodySize(): number {
  let max = 0;
  for (const sub of subscribers) {
    if (sub.options.maxResponseBodySize > max) max = sub.options.maxResponseBodySize;
  }
  return max;
}

// ---------------------------------------------------------------------------
// Patch logic
// ---------------------------------------------------------------------------

function installPatch(): boolean {
  if (typeof window === 'undefined' || !window.fetch) return false;
  if (originalFetch != null) return true;

  originalFetch = window.fetch;
  const saved = originalFetch;

  const replacement: typeof fetch = async function aemeathFetchPatch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const startTime = Date.now();
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const method = (init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase();

    if (!shouldAnyCaptureUrl(url)) {
      return saved.call(window, input, init);
    }

    let requestBody: unknown;
    const body = init?.body ?? (isRequest ? input.body : null);
    if (shouldAnyCaptureRequestBody() && body) {
      requestBody = captureRequestBody(body);
    }

    try {
      const response = await saved.call(window, input, init);

      let responseBody: unknown;
      let responseCode: number | string | undefined;
      let responseMessage: string | undefined;

      if (shouldAnyCaptureResponseBody()) {
        try {
          const cloned = response.clone();
          const maxSize = getMaxResponseBodySize();
          let text = await cloned.text();
          if (text.length > maxSize) {
            text = text.slice(0, maxSize);
          }
          responseBody = safeParseJSON(text);
          const biz = extractBusinessInfo(responseBody);
          responseCode = biz.code;
          responseMessage = biz.message;
        } catch {
          responseBody = '[Unable to read response body]';
        }
      }

      const event: NetworkEvent = {
        type: 'fetch',
        url,
        method,
        status: response.status,
        statusText: response.statusText,
        duration: Date.now() - startTime,
        timestamp: startTime,
        requestBody,
        responseBody,
        responseCode,
        responseMessage,
      };

      notifyFiltered(url, event);
      return response;
    } catch (error) {
      const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
      let errorMessage = error instanceof Error ? error.message : String(error);
      if (!isOnline && !errorMessage.includes('offline')) {
        errorMessage = `${errorMessage} (device appears to be offline)`;
      }

      const event: NetworkEvent = {
        type: 'fetch',
        url,
        method,
        status: 0,
        statusText: 'Network Error',
        duration: Date.now() - startTime,
        timestamp: startTime,
        requestBody,
        error: errorMessage,
      };

      notifyFiltered(url, event);
      throw error;
    }
  };

  window.fetch = replacement;
  patchedFetch = replacement;
  return true;
}

function uninstallPatch(): void {
  if (originalFetch == null) return;
  if (typeof window !== 'undefined' && window.fetch === patchedFetch) {
    window.fetch = originalFetch;
  }
  originalFetch = null;
  patchedFetch = null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Subscribe to fetch network events. The first subscriber triggers the
 * monkey-patch; unsubscribing the last one safely restores the original.
 */
export function instrumentFetch(handler: NetworkHandler, options: InstrumentOptions): Unsubscribe {
  const sub: Subscriber = { handler, options };
  const needsPatch = subscribers.length === 0;
  subscribers.push(sub);

  if (needsPatch && !installPatch()) {
    subscribers = subscribers.filter((s) => s !== sub);
    return () => {};
  }

  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    subscribers = subscribers.filter((s) => s !== sub);
    if (subscribers.length === 0) {
      uninstallPatch();
    }
  };
}

/**
 * Reset all internal state. Intended for testing only.
 * @internal
 */
export function _resetFetchInstrumentation(): void {
  uninstallPatch();
  subscribers = [];
}
