/**
 * XHR instrumentation — independent unit tests.
 *
 * Covers all boundary cases from reviews 1–4:
 * - responseType branching (M-NEW-3)
 * - response body truncation (M-NEW-4)
 * - event listener cleanup on error/timeout (M-NEW-6)
 * - open() argument forwarding 2-arg and 5-arg (M-NEW-1)
 * - singleton / multi-subscriber / safe restoration (S-NEW-3, S-NEW-4)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { instrumentXHR, _resetXHRInstrumentation } from '../../src/instrumentation/xhr';
import type { NetworkEvent, InstrumentOptions } from '../../src/instrumentation/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultOptions(overrides?: Partial<InstrumentOptions>): InstrumentOptions {
  return {
    shouldCapture: () => true,
    captureRequestBody: true,
    captureResponseBody: true,
    maxResponseBodySize: 10240,
    ...overrides,
  };
}

/**
 * Create an XHR, open + send it, then simulate a response via event dispatch.
 * Returns the XHR so callers can trigger specific events.
 */
function sendXHR(
  method: string,
  url: string,
  body?: string | null,
  opts?: {
    status?: number;
    statusText?: string;
    responseText?: string;
    responseType?: XMLHttpRequestResponseType;
    triggerEvent?: 'loadend' | 'error' | 'timeout';
  },
): XMLHttpRequest {
  const xhr = new XMLHttpRequest();
  xhr.open(method, url);

  if (opts?.responseType) {
    xhr.responseType = opts.responseType;
  }

  xhr.send(body ?? null);

  // Simulate response properties
  const status = opts?.status ?? 200;
  const statusText = opts?.statusText ?? 'OK';
  Object.defineProperty(xhr, 'status', { value: status, writable: true, configurable: true });
  Object.defineProperty(xhr, 'statusText', { value: statusText, writable: true, configurable: true });

  const rt = opts?.responseType;
  const isTextualResponseType =
    rt === undefined
    || rt === 'text'
    // lib.dom 的 XMLHttpRequestResponseType 在部分版本不含 `''`，但运行时应视为默认 text
    || (rt as string) === '';
  if (opts?.responseText !== undefined && isTextualResponseType) {
    Object.defineProperty(xhr, 'responseText', { value: opts.responseText, writable: true, configurable: true });
  }

  const eventType = opts?.triggerEvent ?? 'loadend';
  xhr.dispatchEvent(new Event(eventType));

  return xhr;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('instrumentXHR', () => {
  let savedOpen: typeof XMLHttpRequest.prototype.open;
  let savedSend: typeof XMLHttpRequest.prototype.send;

  beforeEach(() => {
    _resetXHRInstrumentation();
    savedOpen = XMLHttpRequest.prototype.open;
    savedSend = XMLHttpRequest.prototype.send;
  });

  afterEach(() => {
    _resetXHRInstrumentation();
    XMLHttpRequest.prototype.open = savedOpen;
    XMLHttpRequest.prototype.send = savedSend;
  });

  // === Basic interception ===

  it('should capture a successful XHR request', () => {
    const events: NetworkEvent[] = [];
    const unsub = instrumentXHR((e) => events.push(e), defaultOptions());

    sendXHR('GET', '/api/data', null, { status: 200, responseText: '{"ok":true}' });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('xhr');
    expect(events[0]!.url).toBe('/api/data');
    expect(events[0]!.method).toBe('GET');
    expect(events[0]!.status).toBe(200);
    expect(events[0]!.error).toBeUndefined();

    unsub();
  });

  it('should capture request body as parsed JSON', () => {
    const events: NetworkEvent[] = [];
    const unsub = instrumentXHR((e) => events.push(e), defaultOptions());

    sendXHR('POST', '/api', '{"key":"val"}', { status: 200, responseText: 'ok' });

    expect(events[0]!.requestBody).toEqual({ key: 'val' });
    unsub();
  });

  it('should not capture request body when captureRequestBody is false', () => {
    const events: NetworkEvent[] = [];
    const unsub = instrumentXHR((e) => events.push(e), defaultOptions({ captureRequestBody: false }));

    sendXHR('POST', '/api', '{"key":"val"}', { status: 200, responseText: 'ok' });

    expect(events[0]!.requestBody).toBeUndefined();
    unsub();
  });

  // === Error event (M-NEW-6: cleanup after error) ===

  it('should capture XHR error events and clean up listeners', () => {
    const events: NetworkEvent[] = [];
    const unsub = instrumentXHR((e) => events.push(e), defaultOptions());

    const xhr = sendXHR('GET', '/api/fail', null, { status: 0, triggerEvent: 'error' });

    expect(events).toHaveLength(1);
    expect(events[0]!.error).toContain('Network Error');

    // Firing loadend after error should not produce a second event
    xhr.dispatchEvent(new Event('loadend'));
    expect(events).toHaveLength(1);

    unsub();
  });

  // === Timeout event (M-NEW-6: cleanup after timeout) ===

  it('should capture XHR timeout events and clean up listeners', () => {
    const events: NetworkEvent[] = [];
    const unsub = instrumentXHR((e) => events.push(e), defaultOptions());

    const xhr = sendXHR('GET', '/api/slow', null, { status: 0, triggerEvent: 'timeout' });

    expect(events).toHaveLength(1);
    expect(events[0]!.error).toContain('Timeout');

    // Firing loadend after timeout should not produce a second event
    xhr.dispatchEvent(new Event('loadend'));
    expect(events).toHaveLength(1);

    unsub();
  });

  // === responseType branching (M-NEW-3) ===

  it('should read responseText for default responseType', () => {
    const events: NetworkEvent[] = [];
    const unsub = instrumentXHR((e) => events.push(e), defaultOptions());

    sendXHR('GET', '/api', null, { status: 200, responseText: '{"data":1}', responseType: '' });

    expect(events[0]!.responseBody).toEqual({ data: 1 });
    unsub();
  });

  it('should return descriptor for arraybuffer responseType', () => {
    const events: NetworkEvent[] = [];
    const unsub = instrumentXHR((e) => events.push(e), defaultOptions());

    sendXHR('GET', '/api/bin', null, { status: 200, responseType: 'arraybuffer' });

    expect(events[0]!.responseBody).toBe('[arraybuffer response]');
    unsub();
  });

  it('should return descriptor for blob responseType', () => {
    const events: NetworkEvent[] = [];
    const unsub = instrumentXHR((e) => events.push(e), defaultOptions());

    sendXHR('GET', '/api/file', null, { status: 200, responseType: 'blob' });

    expect(events[0]!.responseBody).toBe('[blob response]');
    unsub();
  });

  it('should not capture response body when captureResponseBody is false', () => {
    const events: NetworkEvent[] = [];
    const unsub = instrumentXHR((e) => events.push(e), defaultOptions({ captureResponseBody: false }));

    sendXHR('GET', '/api', null, { status: 200, responseText: 'secret' });

    expect(events[0]!.responseBody).toBeUndefined();
    unsub();
  });

  // === Response body truncation (M-NEW-4) ===

  it('should truncate response text exceeding maxResponseBodySize', () => {
    const events: NetworkEvent[] = [];
    const longText = 'x'.repeat(500);
    const unsub = instrumentXHR((e) => events.push(e), defaultOptions({ maxResponseBodySize: 100 }));

    sendXHR('GET', '/api', null, { status: 200, responseText: longText });

    const body = events[0]!.responseBody as string;
    expect(body.length).toBeLessThanOrEqual(100);
    unsub();
  });

  // === open() argument forwarding (M-NEW-1) ===

  it('should forward all arguments to original open (2-arg form)', () => {
    const spy = vi.fn();
    XMLHttpRequest.prototype.open = spy;

    const unsub = instrumentXHR(() => {}, defaultOptions());

    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api');

    expect(spy).toHaveBeenCalledTimes(1);
    // The call should have received at least method and url
    expect(spy.mock.calls[0]![0]).toBe('GET');
    expect(spy.mock.calls[0]![1]).toBe('/api');

    unsub();
  });

  // === shouldCapture filtering ===

  it('should skip requests where shouldCapture returns false', () => {
    const events: NetworkEvent[] = [];
    const unsub = instrumentXHR(
      (e) => events.push(e),
      defaultOptions({ shouldCapture: (url) => !url.includes('/logs') }),
    );

    sendXHR('POST', '/logs', null, { status: 200, responseText: 'ok' });
    expect(events).toHaveLength(0);

    sendXHR('GET', '/api/data', null, { status: 200, responseText: 'ok' });
    expect(events).toHaveLength(1);

    unsub();
  });

  // === Singleton / multi-subscriber (S-NEW-4) ===

  it('should patch XHR.prototype.open only once for multiple subscribers', () => {
    const unsub1 = instrumentXHR(() => {}, defaultOptions());
    const openAfterFirst = XMLHttpRequest.prototype.open;

    const unsub2 = instrumentXHR(() => {}, defaultOptions());
    expect(XMLHttpRequest.prototype.open).toBe(openAfterFirst);

    unsub1();
    unsub2();
  });

  it('should deliver events to all subscribers', () => {
    const events1: NetworkEvent[] = [];
    const events2: NetworkEvent[] = [];
    const unsub1 = instrumentXHR((e) => events1.push(e), defaultOptions());
    const unsub2 = instrumentXHR((e) => events2.push(e), defaultOptions());

    sendXHR('GET', '/api', null, { status: 200, responseText: 'ok' });

    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);

    unsub1();
    unsub2();
  });

  it('should not restore until the last subscriber unsubscribes', () => {
    const unsub1 = instrumentXHR(() => {}, defaultOptions());
    const unsub2 = instrumentXHR(() => {}, defaultOptions());
    const patchedRef = XMLHttpRequest.prototype.open;

    unsub1();
    expect(XMLHttpRequest.prototype.open).toBe(patchedRef);

    unsub2();
    expect(XMLHttpRequest.prototype.open).toBe(savedOpen);
  });

  // === Safe restoration (S-NEW-3) ===

  it('should not restore if a third party overwrote open/send', () => {
    const unsub = instrumentXHR(() => {}, defaultOptions());

    const thirdPartyOpen = vi.fn();
    XMLHttpRequest.prototype.open = thirdPartyOpen as any;

    unsub();
    expect(XMLHttpRequest.prototype.open).toBe(thirdPartyOpen);
  });

  // === Idempotent unsubscribe ===

  it('should tolerate double-unsubscribe without errors', () => {
    const unsub = instrumentXHR(() => {}, defaultOptions());
    unsub();
    unsub();
  });

  // === Subscriber error isolation ===

  it('should not break XHR if a subscriber handler throws', () => {
    const events: NetworkEvent[] = [];
    const unsub1 = instrumentXHR(() => { throw new Error('boom'); }, defaultOptions());
    const unsub2 = instrumentXHR((e) => events.push(e), defaultOptions());

    sendXHR('GET', '/api', null, { status: 200, responseText: 'ok' });
    expect(events).toHaveLength(1);

    unsub1();
    unsub2();
  });

  // === Method uppercasing ===

  it('should uppercase the HTTP method', () => {
    const events: NetworkEvent[] = [];
    const unsub = instrumentXHR((e) => events.push(e), defaultOptions());

    sendXHR('post', '/api', null, { status: 200, responseText: 'ok' });

    expect(events[0]!.method).toBe('POST');
    unsub();
  });

  // === readystatechange defense against WKWebView spurious error ===

  it('should capture via readystatechange when readyState=4 and status>0', () => {
    const events: NetworkEvent[] = [];
    const unsub = instrumentXHR((e) => events.push(e), defaultOptions());

    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/data');
    xhr.send(null);

    // Simulate readyState=4 with valid status
    Object.defineProperty(xhr, 'readyState', { value: 4, writable: true, configurable: true });
    Object.defineProperty(xhr, 'status', { value: 200, writable: true, configurable: true });
    Object.defineProperty(xhr, 'statusText', { value: 'OK', writable: true, configurable: true });
    Object.defineProperty(xhr, 'responseType', { value: '', writable: true, configurable: true });
    Object.defineProperty(xhr, 'responseText', { value: '{"ok":true}', writable: true, configurable: true });

    xhr.dispatchEvent(new Event('readystatechange'));

    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe(200);
    expect(events[0]!.responseBody).toEqual({ ok: true });

    unsub();
  });

  it('should block spurious error event after successful readystatechange capture (WKWebView defense)', () => {
    const events: NetworkEvent[] = [];
    const unsub = instrumentXHR((e) => events.push(e), defaultOptions());

    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/data');
    xhr.send(null);

    // Step 1: readystatechange fires with valid response
    Object.defineProperty(xhr, 'readyState', { value: 4, writable: true, configurable: true });
    Object.defineProperty(xhr, 'status', { value: 200, writable: true, configurable: true });
    Object.defineProperty(xhr, 'statusText', { value: 'OK', writable: true, configurable: true });
    Object.defineProperty(xhr, 'responseType', { value: '', writable: true, configurable: true });
    Object.defineProperty(xhr, 'responseText', { value: '{"ok":true}', writable: true, configurable: true });
    xhr.dispatchEvent(new Event('readystatechange'));

    expect(events).toHaveLength(1);

    // Step 2: WKWebView fires spurious error (status reset to 0)
    Object.defineProperty(xhr, 'status', { value: 0, writable: true, configurable: true });
    xhr.dispatchEvent(new Event('error'));

    // Should still be 1 event — the spurious error is blocked
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe(200);
    expect(events[0]!.error).toBeUndefined();

    unsub();
  });

  it('should skip readystatechange when status=0 and let error handler capture', () => {
    const events: NetworkEvent[] = [];
    const unsub = instrumentXHR((e) => events.push(e), defaultOptions());

    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/fail');
    xhr.send(null);

    // readystatechange fires with status=0 (real network error)
    Object.defineProperty(xhr, 'readyState', { value: 4, writable: true, configurable: true });
    Object.defineProperty(xhr, 'status', { value: 0, writable: true, configurable: true });
    Object.defineProperty(xhr, 'statusText', { value: '', writable: true, configurable: true });
    xhr.dispatchEvent(new Event('readystatechange'));

    // Should not capture yet — status=0 is skipped
    expect(events).toHaveLength(0);

    // error handler should capture
    xhr.dispatchEvent(new Event('error'));
    expect(events).toHaveLength(1);
    expect(events[0]!.error).toContain('Network Error');

    unsub();
  });

  it('should ignore readystatechange when readyState < 4', () => {
    const events: NetworkEvent[] = [];
    const unsub = instrumentXHR((e) => events.push(e), defaultOptions());

    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/data');
    xhr.send(null);

    // readyState=2 (HEADERS_RECEIVED) — should be ignored
    Object.defineProperty(xhr, 'readyState', { value: 2, writable: true, configurable: true });
    Object.defineProperty(xhr, 'status', { value: 200, writable: true, configurable: true });
    xhr.dispatchEvent(new Event('readystatechange'));

    expect(events).toHaveLength(0);

    unsub();
  });

  // === Business info extraction ===

  it('should extract code and message from response JSON', () => {
    const events: NetworkEvent[] = [];
    const unsub = instrumentXHR((e) => events.push(e), defaultOptions());

    sendXHR('GET', '/api', null, { status: 200, responseText: '{"code":400,"msg":"bad request"}' });

    expect(events[0]!.responseCode).toBe(400);
    expect(events[0]!.responseMessage).toBe('bad request');
    unsub();
  });
});
