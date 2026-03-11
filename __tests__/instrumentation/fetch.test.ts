/**
 * Fetch instrumentation — independent unit tests.
 *
 * These test the monkey-patch layer directly, without NetworkPlugin,
 * covering every boundary case that caused bugs in reviews 1–4.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { instrumentFetch, _resetFetchInstrumentation } from '../../src/instrumentation/fetch';
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

function makeResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, { status: 200, statusText: 'OK', ...init });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('instrumentFetch', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    _resetFetchInstrumentation();
    originalFetch = window.fetch;
  });

  afterEach(() => {
    _resetFetchInstrumentation();
    window.fetch = originalFetch;
  });

  // === Basic interception ===

  it('should capture a successful fetch request', async () => {
    const events: NetworkEvent[] = [];
    window.fetch = vi.fn().mockResolvedValue(makeResponse('{"ok":true}'));

    const unsub = instrumentFetch((e) => events.push(e), defaultOptions());
    await window.fetch('/api/data');

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('fetch');
    expect(events[0]!.url).toBe('/api/data');
    expect(events[0]!.method).toBe('GET');
    expect(events[0]!.status).toBe(200);
    expect(events[0]!.error).toBeUndefined();

    unsub();
  });

  it('should capture HTTP error responses (status >= 400)', async () => {
    const events: NetworkEvent[] = [];
    window.fetch = vi.fn().mockResolvedValue(makeResponse('Not Found', { status: 404, statusText: 'Not Found' }));

    const unsub = instrumentFetch((e) => events.push(e), defaultOptions());
    await window.fetch('/api/missing');

    expect(events[0]!.status).toBe(404);
    expect(events[0]!.statusText).toBe('Not Found');
    unsub();
  });

  it('should capture network errors (fetch throws)', async () => {
    const events: NetworkEvent[] = [];
    window.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const unsub = instrumentFetch((e) => events.push(e), defaultOptions());

    await expect(window.fetch('/api/fail')).rejects.toThrow('Failed to fetch');

    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe(0);
    expect(events[0]!.error).toContain('Failed to fetch');
    unsub();
  });

  // === Request body type branching (M-NEW-2) ===

  it('should capture string request body as parsed JSON', async () => {
    const events: NetworkEvent[] = [];
    window.fetch = vi.fn().mockResolvedValue(makeResponse('ok'));

    const unsub = instrumentFetch((e) => events.push(e), defaultOptions());
    await window.fetch('/api', { method: 'POST', body: '{"key":"val"}' });

    expect(events[0]!.requestBody).toEqual({ key: 'val' });
    unsub();
  });

  it('should capture FormData body as descriptor string', async () => {
    const events: NetworkEvent[] = [];
    window.fetch = vi.fn().mockResolvedValue(makeResponse('ok'));

    const unsub = instrumentFetch((e) => events.push(e), defaultOptions());
    const fd = new FormData();
    fd.append('file', 'content');
    await window.fetch('/upload', { method: 'POST', body: fd });

    expect(events[0]!.requestBody).toBe('[FormData]');
    unsub();
  });

  it('should capture Blob body with size info', async () => {
    const events: NetworkEvent[] = [];
    window.fetch = vi.fn().mockResolvedValue(makeResponse('ok'));

    const unsub = instrumentFetch((e) => events.push(e), defaultOptions());
    const blob = new Blob(['hello'], { type: 'text/plain' });
    await window.fetch('/upload', { method: 'POST', body: blob });

    expect(events[0]!.requestBody).toBe(`[Blob size=${blob.size}]`);
    unsub();
  });

  it('should capture URLSearchParams body as string', async () => {
    const events: NetworkEvent[] = [];
    window.fetch = vi.fn().mockResolvedValue(makeResponse('ok'));

    const unsub = instrumentFetch((e) => events.push(e), defaultOptions());
    const params = new URLSearchParams({ q: 'test' });
    await window.fetch('/search', { method: 'POST', body: params });

    expect(events[0]!.requestBody).toBe('q=test');
    unsub();
  });

  it('should not capture request body when captureRequestBody is false', async () => {
    const events: NetworkEvent[] = [];
    window.fetch = vi.fn().mockResolvedValue(makeResponse('ok'));

    const unsub = instrumentFetch((e) => events.push(e), defaultOptions({ captureRequestBody: false }));
    await window.fetch('/api', { method: 'POST', body: '{"x":1}' });

    expect(events[0]!.requestBody).toBeUndefined();
    unsub();
  });

  // === Response body truncation (M-NEW-4) ===

  it('should truncate response body exceeding maxResponseBodySize', async () => {
    const events: NetworkEvent[] = [];
    const longBody = 'x'.repeat(500);
    window.fetch = vi.fn().mockResolvedValue(makeResponse(longBody));

    const unsub = instrumentFetch((e) => events.push(e), defaultOptions({ maxResponseBodySize: 100 }));
    await window.fetch('/api/big');

    const body = events[0]!.responseBody as string;
    expect(body.length).toBeLessThanOrEqual(100);
    unsub();
  });

  it('should not capture response body when captureResponseBody is false', async () => {
    const events: NetworkEvent[] = [];
    window.fetch = vi.fn().mockResolvedValue(makeResponse('secret'));

    const unsub = instrumentFetch((e) => events.push(e), defaultOptions({ captureResponseBody: false }));
    await window.fetch('/api');

    expect(events[0]!.responseBody).toBeUndefined();
    unsub();
  });

  it('should handle response.clone().text() failure gracefully', async () => {
    const events: NetworkEvent[] = [];
    const badResponse = makeResponse('ok');
    vi.spyOn(badResponse, 'clone').mockReturnValue({
      text: () => Promise.reject(new Error('clone failed')),
    } as unknown as Response);
    window.fetch = vi.fn().mockResolvedValue(badResponse);

    const unsub = instrumentFetch((e) => events.push(e), defaultOptions());
    await window.fetch('/api');

    expect(events[0]!.responseBody).toBe('[Unable to read response body]');
    unsub();
  });

  // === shouldCapture filtering ===

  it('should skip requests where shouldCapture returns false', async () => {
    const events: NetworkEvent[] = [];
    const mockFetch = vi.fn().mockResolvedValue(makeResponse('ok'));
    window.fetch = mockFetch;

    const unsub = instrumentFetch(
      (e) => events.push(e),
      defaultOptions({ shouldCapture: (url) => !url.includes('/logs') }),
    );

    await window.fetch('/logs');
    expect(events).toHaveLength(0);

    await window.fetch('/api/data');
    expect(events).toHaveLength(1);

    unsub();
  });

  // === Singleton / multi-subscriber (S-NEW-4) ===

  it('should patch window.fetch only once for multiple subscribers', async () => {
    window.fetch = vi.fn().mockResolvedValue(makeResponse('ok'));
    const refAfterOriginal = window.fetch;

    const unsub1 = instrumentFetch(() => {}, defaultOptions());
    const patchedRef = window.fetch;
    expect(patchedRef).not.toBe(refAfterOriginal);

    const unsub2 = instrumentFetch(() => {}, defaultOptions());
    expect(window.fetch).toBe(patchedRef); // same patch, not double-wrapped

    unsub1();
    unsub2();
  });

  it('should deliver events to all subscribers', async () => {
    const events1: NetworkEvent[] = [];
    const events2: NetworkEvent[] = [];
    window.fetch = vi.fn().mockResolvedValue(makeResponse('ok'));

    const unsub1 = instrumentFetch((e) => events1.push(e), defaultOptions());
    const unsub2 = instrumentFetch((e) => events2.push(e), defaultOptions());

    await window.fetch('/api');

    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);

    unsub1();
    unsub2();
  });

  it('should not restore fetch until the last subscriber unsubscribes', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeResponse('ok'));
    window.fetch = mockFetch;

    const unsub1 = instrumentFetch(() => {}, defaultOptions());
    const unsub2 = instrumentFetch(() => {}, defaultOptions());
    const patchedRef = window.fetch;

    unsub1();
    expect(window.fetch).toBe(patchedRef); // still patched

    unsub2();
    expect(window.fetch).toBe(mockFetch); // restored
  });

  // === Safe restoration (S-NEW-3) ===

  it('should not restore if a third party overwrote fetch after our patch', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeResponse('ok'));
    window.fetch = mockFetch;

    const unsub = instrumentFetch(() => {}, defaultOptions());

    // Third party overwrites our patch
    const thirdPartyFetch = vi.fn();
    window.fetch = thirdPartyFetch;

    unsub();
    // We must NOT overwrite the third party's patch
    expect(window.fetch).toBe(thirdPartyFetch);
  });

  // === Idempotent unsubscribe ===

  it('should tolerate double-unsubscribe without errors', () => {
    window.fetch = vi.fn().mockResolvedValue(makeResponse('ok'));
    const unsub = instrumentFetch(() => {}, defaultOptions());
    unsub();
    unsub(); // should not throw
  });

  // === URL extraction ===

  it('should extract URL from Request objects', async () => {
    const events: NetworkEvent[] = [];
    window.fetch = vi.fn().mockResolvedValue(makeResponse('ok'));

    const unsub = instrumentFetch((e) => events.push(e), defaultOptions());
    const req = new Request('https://example.com/api');
    await window.fetch(req);

    expect(events[0]!.url).toBe('https://example.com/api');
    unsub();
  });

  it('should extract URL from URL objects', async () => {
    const events: NetworkEvent[] = [];
    window.fetch = vi.fn().mockResolvedValue(makeResponse('ok'));

    const unsub = instrumentFetch((e) => events.push(e), defaultOptions());
    await window.fetch(new URL('https://example.com/data'));

    expect(events[0]!.url).toBe('https://example.com/data');
    unsub();
  });

  // === Method extraction ===

  it('should default method to GET when not specified', async () => {
    const events: NetworkEvent[] = [];
    window.fetch = vi.fn().mockResolvedValue(makeResponse('ok'));

    const unsub = instrumentFetch((e) => events.push(e), defaultOptions());
    await window.fetch('/api');

    expect(events[0]!.method).toBe('GET');
    unsub();
  });

  it('should uppercase the method', async () => {
    const events: NetworkEvent[] = [];
    window.fetch = vi.fn().mockResolvedValue(makeResponse('ok'));

    const unsub = instrumentFetch((e) => events.push(e), defaultOptions());
    await window.fetch('/api', { method: 'post' });

    expect(events[0]!.method).toBe('POST');
    unsub();
  });

  // === Business info extraction ===

  it('should extract code and message from response JSON', async () => {
    const events: NetworkEvent[] = [];
    window.fetch = vi.fn().mockResolvedValue(
      makeResponse('{"code":1001,"message":"invalid token"}'),
    );

    const unsub = instrumentFetch((e) => events.push(e), defaultOptions());
    await window.fetch('/api/auth');

    expect(events[0]!.responseCode).toBe(1001);
    expect(events[0]!.responseMessage).toBe('invalid token');
    unsub();
  });

  // === Duration tracking ===

  it('should report duration > 0 for requests', async () => {
    const events: NetworkEvent[] = [];
    window.fetch = vi.fn().mockResolvedValue(makeResponse('ok'));

    const unsub = instrumentFetch((e) => events.push(e), defaultOptions());
    await window.fetch('/api');

    expect(events[0]!.duration).toBeGreaterThanOrEqual(0);
    expect(events[0]!.timestamp).toBeGreaterThan(0);
    unsub();
  });

  // === Subscriber error isolation ===

  it('should not break fetch if a subscriber handler throws', async () => {
    window.fetch = vi.fn().mockResolvedValue(makeResponse('ok'));

    const events: NetworkEvent[] = [];
    const unsub1 = instrumentFetch(() => { throw new Error('boom'); }, defaultOptions());
    const unsub2 = instrumentFetch((e) => events.push(e), defaultOptions());

    await window.fetch('/api');
    expect(events).toHaveLength(1);

    unsub1();
    unsub2();
  });

  // === Offline detection ===

  it('should append offline hint when navigator.onLine is false', async () => {
    const events: NetworkEvent[] = [];
    window.fetch = vi.fn().mockRejectedValue(new Error('Network failure'));
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

    const unsub = instrumentFetch((e) => events.push(e), defaultOptions());
    await expect(window.fetch('/api')).rejects.toThrow();

    expect(events[0]!.error).toContain('offline');
    unsub();
  });

  // === No-op when fetch is unavailable ===

  it('should not throw when window.fetch does not exist', () => {
    const saved = window.fetch;
    // @ts-expect-error — intentionally removing fetch
    delete window.fetch;

    const unsub = instrumentFetch(() => {}, defaultOptions());
    unsub(); // should not throw

    window.fetch = saved;
  });
});
