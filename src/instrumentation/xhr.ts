/**
 * XHR instrumentation — singleton monkey-patch with multi-subscriber support.
 *
 * Design principles (addressing M-NEW-1, M-NEW-3, M-NEW-4, M-NEW-6):
 * - Patches XMLHttpRequest.prototype.open and .send at most once.
 * - Uses `arguments` forwarding in open() to preserve 2-arg and 5-arg semantics.
 * - Checks responseType before reading responseText to avoid InvalidStateError.
 * - Truncates response text via maxResponseBodySize.
 * - Cleans up event listeners on error/timeout/loadend to avoid leaks.
 */

import type { NetworkEvent, NetworkHandler, InstrumentOptions, Unsubscribe } from './types';
import { safeParseJSON, extractBusinessInfo, captureRequestBody } from './helpers';

// ---------------------------------------------------------------------------
// Internal per-request metadata stored on each XHR instance
// ---------------------------------------------------------------------------

const XHR_INFO_KEY = Symbol('aemeath.xhrInfo');

interface XHRInfo {
  method: string;
  url: string;
  startTime: number;
  requestBody: unknown;
}

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

interface Subscriber {
  handler: NetworkHandler;
  options: InstrumentOptions;
}

let subscribers: Subscriber[] = [];
let originalOpen: typeof XMLHttpRequest.prototype.open | null = null;
let originalSend: typeof XMLHttpRequest.prototype.send | null = null;
let patchedOpen: typeof XMLHttpRequest.prototype.open | null = null;
let patchedSend: typeof XMLHttpRequest.prototype.send | null = null;

/**
 * Notify only subscribers whose `shouldCapture` matches the event URL.
 */
function notifyFiltered(url: string, event: NetworkEvent): void {
  for (const sub of subscribers) {
    try {
      if (sub.options.shouldCapture(url)) {
        sub.handler(event);
      }
    } catch {
      // subscriber errors must not break XHR flow
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
  if (typeof window === 'undefined' || typeof XMLHttpRequest === 'undefined') return false;
  if (originalOpen != null) return true;

  originalOpen = XMLHttpRequest.prototype.open;
  originalSend = XMLHttpRequest.prototype.send;
  const savedOpen = originalOpen;
  const savedSend = originalSend;

  XMLHttpRequest.prototype.open = function aemeathXHROpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
  ): void {
    (this as any)[XHR_INFO_KEY] = {
      method: method.toUpperCase(),
      url: typeof url === 'string' ? url : url.href,
      startTime: 0,
      requestBody: undefined,
    } satisfies XHRInfo;
    // eslint-disable-next-line prefer-rest-params
    return savedOpen.apply(this, arguments as any);
  };

  XMLHttpRequest.prototype.send = function aemeathXHRSend(
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const info: XHRInfo | undefined = (this as any)[XHR_INFO_KEY];

    if (!info || !shouldAnyCaptureUrl(info.url)) {
      return savedSend.call(this, body);
    }

    info.startTime = Date.now();

    if (shouldAnyCaptureRequestBody() && body != null) {
      info.requestBody = captureRequestBody(body);
    }

    let isRecorded = false;

    const cleanup = () => {
      this.removeEventListener('readystatechange', handleReadyStateChange);
      this.removeEventListener('loadend', handleLoadEnd);
      this.removeEventListener('error', handleError);
      this.removeEventListener('timeout', handleTimeout);
    };

    const captureSuccess = () => {
      let responseBody: unknown;
      let responseCode: number | string | undefined;
      let responseMessage: string | undefined;

      if (shouldAnyCaptureResponseBody()) {
        try {
          if (this.responseType === '' || this.responseType === 'text') {
            const maxSize = getMaxResponseBodySize();
            let text = this.responseText;
            if (text.length > maxSize) {
              text = text.slice(0, maxSize);
            }
            responseBody = safeParseJSON(text);
            const biz = extractBusinessInfo(responseBody);
            responseCode = biz.code;
            responseMessage = biz.message;
          } else {
            responseBody = `[${this.responseType} response]`;
          }
        } catch {
          responseBody = '[Unable to read response body]';
        }
      }

      notifyFiltered(info.url, {
        type: 'xhr',
        url: info.url,
        method: info.method,
        status: this.status,
        statusText: this.statusText,
        duration: Date.now() - info.startTime,
        timestamp: info.startTime,
        requestBody: info.requestBody,
        responseBody,
        responseCode,
        responseMessage,
      });
    };

    // Capture early on readyState=4 with a valid HTTP status.
    // This defends against iOS WKWebView firing a spurious `error` event
    // after the response has already been delivered via onreadystatechange.
    const handleReadyStateChange = () => {
      if (this.readyState !== 4) return;
      if (isRecorded) return;
      if (this.status === 0) return;

      isRecorded = true;
      captureSuccess();
      cleanup();
    };

    const handleLoadEnd = () => {
      if (isRecorded) { cleanup(); return; }
      isRecorded = true;
      captureSuccess();
      cleanup();
    };

    const handleError = () => {
      if (isRecorded) return;
      isRecorded = true;
      const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
      let errorMessage = 'Network Error';
      if (!isOnline) {
        errorMessage = 'Network Error: Device appears to be offline';
      } else if (this.status === 0) {
        errorMessage = `Network Error: No response received (readyState=${this.readyState})`;
      }

      notifyFiltered(info.url, {
        type: 'xhr',
        url: info.url,
        method: info.method,
        status: this.status,
        statusText: this.statusText || 'Network Error',
        duration: Date.now() - info.startTime,
        timestamp: info.startTime,
        requestBody: info.requestBody,
        error: errorMessage,
      });
      cleanup();
    };

    const handleTimeout = () => {
      if (isRecorded) return;
      isRecorded = true;
      const duration = Date.now() - info.startTime;
      notifyFiltered(info.url, {
        type: 'xhr',
        url: info.url,
        method: info.method,
        status: 0,
        statusText: 'Request Timeout',
        duration,
        timestamp: info.startTime,
        requestBody: info.requestBody,
        error: `Request Timeout: No response within ${duration}ms`,
      });
      cleanup();
    };

    this.addEventListener('readystatechange', handleReadyStateChange);
    this.addEventListener('loadend', handleLoadEnd);
    this.addEventListener('error', handleError);
    this.addEventListener('timeout', handleTimeout);

    return savedSend.call(this, body);
  };

  patchedOpen = XMLHttpRequest.prototype.open;
  patchedSend = XMLHttpRequest.prototype.send;
  return true;
}

function uninstallPatch(): void {
  if (typeof window === 'undefined' || typeof XMLHttpRequest === 'undefined') return;
  if (originalOpen != null && XMLHttpRequest.prototype.open === patchedOpen) {
    XMLHttpRequest.prototype.open = originalOpen;
  }
  if (originalSend != null && XMLHttpRequest.prototype.send === patchedSend) {
    XMLHttpRequest.prototype.send = originalSend;
  }
  originalOpen = null;
  originalSend = null;
  patchedOpen = null;
  patchedSend = null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Subscribe to XHR network events. The first subscriber triggers the
 * monkey-patch; unsubscribing the last one safely restores the originals.
 */
export function instrumentXHR(handler: NetworkHandler, options: InstrumentOptions): Unsubscribe {
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
export function _resetXHRInstrumentation(): void {
  uninstallPatch();
  subscribers = [];
}
