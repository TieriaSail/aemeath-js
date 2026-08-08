/**
 * Fetch instrumentation — singleton monkey-patch with multi-subscriber support.
 *
 * Design principles (addressing S-NEW-3, S-NEW-4, M-NEW-2, M-NEW-4):
 * - Patches `window.fetch` at most once regardless of how many subscribers.
 * - Each subscriber receives all captured events independently.
 * - When the last subscriber unsubscribes, the original fetch is restored
 *   only if no third-party code has overwritten our patch in the meantime.
 * - Request body type branching (string / FormData / Blob / etc.)
 * - Non-blocking, content-type-aware response body capture.
 * - Bounded response body retention via maxResponseBodySize.
 * - Capture deadlines and teardown cancellation for stalled streams.
 */

import type {
  NetworkEvent,
  NetworkHandler,
  InstrumentOptions,
  ResponseBodyCaptureContext,
  Unsubscribe,
  NetworkErrorType,
  NetworkErrorDetail,
} from './types';
import { safeParseJSON, extractBusinessInfo, captureRequestBody } from './helpers';
import { shouldIgnoreNetworkCapture } from '../utils/ignoreNetworkCapture';

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

interface Subscriber {
  handler: NetworkHandler;
  options: InstrumentOptions;
}

interface ResponseBodyReadResult {
  bytes: Uint8Array;
  truncated: boolean;
}

interface ResponseBodyReadTask {
  promise: Promise<ResponseBodyReadResult>;
  cancel: () => void;
}

interface ActiveCapture {
  targets: Set<Subscriber>;
  task: ResponseBodyReadTask;
}

const DEFAULT_MAX_RESPONSE_BODY_SIZE = 10240;
const DEFAULT_RESPONSE_BODY_CAPTURE_TIMEOUT = 2000;

let subscribers: Subscriber[] = [];
let originalFetch: typeof fetch | null = null;
let patchedFetch: typeof fetch | null = null;
const activeCaptures = new Set<ActiveCapture>();

/**
 * Notify only subscribers whose `shouldCapture` matches the event URL.
 * This ensures each subscriber only receives events it opted in to.
 */
function getMatchingSubscribers(url: string): Subscriber[] {
  const matching: Subscriber[] = [];
  for (const sub of subscribers) {
    try {
      if (sub.options.shouldCapture(url)) {
        matching.push(sub);
      }
    } catch {
      // filter errors must not break fetch flow
    }
  }
  return matching;
}

function notifySubscribers(targets: Subscriber[], event: NetworkEvent): void {
  for (const sub of targets) {
    if (!subscribers.includes(sub)) continue;
    try {
      sub.handler(event);
    } catch {
      // subscriber errors must not break fetch flow
    }
  }
}

function defaultShouldCaptureResponseBody(context: ResponseBodyCaptureContext): boolean {
  const disposition = context.headers.get('content-disposition') ?? '';
  if (/\battachment\b/i.test(disposition)) return false;

  const rawContentType = context.headers.get('content-type');
  if (!rawContentType) return false;

  const contentType = rawContentType.split(';', 1)[0]!.trim().toLowerCase();
  if (contentType === 'text/event-stream') return false;
  if (contentType.startsWith('text/')) return true;

  if (
    contentType === 'application/json' ||
    (contentType.startsWith('application/') && contentType.endsWith('+json'))
  ) {
    return true;
  }
  if (
    contentType === 'application/xml' ||
    (contentType.startsWith('application/') && contentType.endsWith('+xml'))
  ) {
    return true;
  }

  return (
    contentType === 'application/x-www-form-urlencoded' ||
    contentType === 'application/javascript' ||
    contentType === 'application/ecmascript' ||
    contentType === 'application/x-javascript'
  );
}

function shouldCaptureResponseBody(
  sub: Subscriber,
  context: ResponseBodyCaptureContext,
): boolean {
  if (!sub.options.captureResponseBody) return false;
  const filter = sub.options.shouldCaptureResponseBody ?? defaultShouldCaptureResponseBody;
  try {
    return filter(context);
  } catch {
    return false;
  }
}

function getMaxResponseBodySize(targets: Subscriber[]): number {
  let max = 0;
  for (const sub of targets) {
    max = Math.max(max, normalizeByteLimit(sub.options.maxResponseBodySize));
  }
  return max;
}

function getResponseBodyCaptureTimeout(targets: Subscriber[]): number {
  let timeout = Number.POSITIVE_INFINITY;
  for (const sub of targets) {
    timeout = Math.min(
      timeout,
      normalizeCaptureTimeout(sub.options.responseBodyCaptureTimeout),
    );
  }
  return Number.isFinite(timeout) ? timeout : DEFAULT_RESPONSE_BODY_CAPTURE_TIMEOUT;
}

function normalizeByteLimit(value: number): number {
  return Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : DEFAULT_MAX_RESPONSE_BODY_SIZE;
}

function normalizeCaptureTimeout(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : DEFAULT_RESPONSE_BODY_CAPTURE_TIMEOUT;
}

function parseContentLength(headers: Headers): number | undefined {
  const value = headers.get('content-length');
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => {
      // Cancellation is best-effort and must never affect the business branch.
    });
  } catch {
    // Non-standard stream implementations may throw synchronously.
  }
}

function joinChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function readResponseBodyAtMost(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
): ResponseBodyReadTask {
  if (!response.body) {
    return {
      promise: Promise.resolve({ bytes: new Uint8Array(), truncated: false }),
      cancel: () => {},
    };
  }

  const reader = response.body.getReader();
  const declaredLength = parseContentLength(response.headers);
  const byteLimit = normalizeByteLimit(maxBytes);
  let settled = false;
  let cancellationReason: 'timeout' | 'cancelled' | undefined;
  let resolveCancellation!: (reason: 'timeout' | 'cancelled') => void;
  const cancellation = new Promise<'timeout' | 'cancelled'>((resolve) => {
    resolveCancellation = resolve;
  });

  const cancel = (reason: 'timeout' | 'cancelled' = 'cancelled'): void => {
    if (settled || cancellationReason) return;
    cancellationReason = reason;
    resolveCancellation(reason);
    cancelReader(reader);
  };

  const timeoutId = setTimeout(
    () => cancel('timeout'),
    normalizeCaptureTimeout(timeoutMs),
  );

  const promise = (async (): Promise<ResponseBodyReadResult> => {
    const chunks: Uint8Array[] = [];
    let bytesRead = 0;

    if (byteLimit <= 0) {
      cancelReader(reader);
      return {
        bytes: new Uint8Array(),
        truncated: declaredLength !== 0,
      };
    }

    while (true) {
      const readOutcome = reader.read().then(
        (result) => ({ kind: 'read' as const, result }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      );
      const outcome = await Promise.race([
        readOutcome,
        cancellation.then((reason) => ({ kind: 'cancel' as const, reason })),
      ]);

      if (outcome.kind === 'cancel') {
        return { bytes: joinChunks(chunks, bytesRead), truncated: true };
      }
      if (outcome.kind === 'error') throw outcome.error;

      const { done, value } = outcome.result;
      if (done) {
        return { bytes: joinChunks(chunks, bytesRead), truncated: false };
      }
      if (!value || value.byteLength === 0) continue;

      const remaining = byteLimit - bytesRead;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      // Copy only retained bytes so an oversized source chunk is not kept alive
      // by a small subarray view after this iteration.
      chunks.push(chunk.slice());
      bytesRead += chunk.byteLength;

      if (value.byteLength > remaining || bytesRead >= byteLimit) {
        cancelReader(reader);
        return {
          bytes: joinChunks(chunks, bytesRead),
          truncated:
            value.byteLength > remaining ||
            declaredLength === undefined ||
            declaredLength > bytesRead,
        };
      }
    }
  })().finally(() => {
    settled = true;
    clearTimeout(timeoutId);
  });

  return { promise, cancel: () => cancel('cancelled') };
}

function cancelCapturesForSubscriber(subscriber: Subscriber): void {
  for (const capture of activeCaptures) {
    capture.targets.delete(subscriber);
    if (capture.targets.size === 0) capture.task.cancel();
  }
}

function cancelAllActiveCaptures(): void {
  for (const capture of activeCaptures) capture.task.cancel();
  activeCaptures.clear();
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
    // 上报回调窗口内发起的请求：原样放行，绝不记入 NetworkPlugin。
    // 必须在「发起时」判断——若等响应回来再跳过，窗口可能已关上，而且
    // 中间态仍会占用 activeCaptures。
    if (shouldIgnoreNetworkCapture()) {
      return saved.call(window, input, init);
    }

    const startTime = Date.now();
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const method = (init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase();

    const initialSubscribers = getMatchingSubscribers(url);
    if (initialSubscribers.length === 0) {
      return saved.call(window, input, init);
    }

    let requestBody: unknown;
    const body = init?.body ?? (isRequest ? input.body : null);
    if (initialSubscribers.some((sub) => sub.options.captureRequestBody) && body) {
      requestBody = captureRequestBody(body);
    }

    try {
      const response = await saved.call(window, input, init);
      const duration = Date.now() - startTime;
      const event: NetworkEvent = {
        type: 'fetch',
        url,
        method,
        status: response.status,
        statusText: response.statusText,
        duration,
        timestamp: startTime,
        requestBody,
      };

      // A request belongs to the subscribers that matched when it started.
      // This prevents late subscribers and route changes from reclassifying it.
      const matchingSubscribers = initialSubscribers.filter((sub) =>
        subscribers.includes(sub),
      );
      const captureContext: ResponseBodyCaptureContext = {
        url,
        method,
        status: response.status,
        headers: response.headers,
      };
      const bodySubscribers = matchingSubscribers.filter((sub) =>
        shouldCaptureResponseBody(sub, captureContext),
      );
      const metadataSubscribers = matchingSubscribers.filter(
        (sub) => !bodySubscribers.includes(sub),
      );

      // Subscribers that do not want this body receive metadata immediately.
      notifySubscribers(metadataSubscribers, event);

      if (bodySubscribers.length > 0) {
        const maxSize = getMaxResponseBodySize(bodySubscribers);
        const timeout = getResponseBodyCaptureTimeout(bodySubscribers);
        try {
          const cloned = response.clone();
          const task = readResponseBodyAtMost(cloned, maxSize, timeout);
          const capture: ActiveCapture = {
            targets: new Set(bodySubscribers),
            task,
          };
          activeCaptures.add(capture);

          void task.promise
            .then((result) => {
              for (const sub of Array.from(capture.targets)) {
                const subscriberLimit = normalizeByteLimit(
                  sub.options.maxResponseBodySize,
                );
                const bytes = result.bytes.subarray(0, subscriberLimit);
                const responseBody = safeParseJSON(new TextDecoder().decode(bytes));
                const biz = extractBusinessInfo(responseBody);
                notifySubscribers([sub], {
                  ...event,
                  responseBody,
                  responseBodyTruncated:
                    result.truncated || result.bytes.byteLength > subscriberLimit
                      ? true
                      : undefined,
                  responseCode: biz.code,
                  responseMessage: biz.message,
                });
              }
            })
            .catch(() => {
              notifySubscribers(Array.from(capture.targets), {
                ...event,
                responseBody: '[Unable to read response body]',
              });
            })
            .finally(() => {
              activeCaptures.delete(capture);
            });
        } catch {
          notifySubscribers(bodySubscribers, {
            ...event,
            responseBody: '[Unable to read response body]',
          });
        }
      }

      // Body capture continues independently; business code receives the
      // original Response as soon as the response headers are available.
      return response;
    } catch (error) {
      const navigatorOnLine = typeof navigator !== 'undefined' ? navigator.onLine : true;
      // Read `name` / `message` as plain properties instead of relying on
      // `instanceof Error`: cross-realm errors (iframe / worker / jsdom)
      // fail instanceof checks while still carrying the standard fields.
      const errObj = error as { name?: unknown; message?: unknown } | null;
      const rawMessage =
        errObj != null && typeof errObj.message === 'string' ? errObj.message : String(error);
      // Per WHATWG fetch spec, abort/timeout reject with a DOMException whose
      // `name` is standardized ('AbortError' / 'TimeoutError'). `name` is
      // locale-independent and reliable across browsers, unlike `message`.
      const errName = errObj != null && typeof errObj.name === 'string' ? errObj.name : '';

      let errorType: NetworkErrorType;
      let errorMessage: string;
      if (errName === 'AbortError') {
        errorType = 'network.aborted';
        errorMessage = 'Network Error: Request aborted';
      } else if (errName === 'TimeoutError') {
        errorType = 'network.timeout';
        errorMessage = 'Network Error: Request timed out (AbortSignal.timeout)';
      } else if (!navigatorOnLine) {
        errorType = 'network.offline';
        errorMessage = 'Network Error: Device appears to be offline';
      } else {
        // fetch TypeError does not expose the underlying cause
        // (CORS / DNS / connection refused / SSL are indistinguishable).
        errorType = 'network.unknown';
        errorMessage = `Network Error: ${rawMessage}`;
      }

      const errorDetail: NetworkErrorDetail = {
        navigatorOnLine,
        statusCode: 0,
        raw: rawMessage,
      };

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
        errorType,
        errorDetail,
      };

      notifySubscribers(initialSubscribers, event);
      throw error;
    }
  };

  window.fetch = replacement;
  patchedFetch = replacement;
  return true;
}

function uninstallPatch(): void {
  cancelAllActiveCaptures();
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
    cancelCapturesForSubscriber(sub);
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
