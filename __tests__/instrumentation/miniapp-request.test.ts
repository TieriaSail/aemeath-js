/**
 * MiniApp request instrumentation — independent unit tests.
 *
 * @vitest-environment node
 *
 * Covers:
 * - Basic interception: success / fail
 * - complete callback forwarding (ARCH-3)
 * - Alipay statusCode/status difference (BUG-2)
 * - Alipay errMsg/errorMessage difference (BUG-2)
 * - shouldCapture filtering
 * - Singleton / multi-subscriber / safe restoration (S-NEW-3, S-NEW-4)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  instrumentMiniAppRequest,
  _resetMiniAppRequestInstrumentation,
} from '../../src/instrumentation/miniapp-request';
import type { MiniAppRequestAPI } from '../../src/instrumentation/miniapp-request';
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

function createMockAPI(): MiniAppRequestAPI {
  return {
    request: vi.fn((opts: Record<string, unknown>) => {
      // By default, immediately call success callback
      if (typeof opts['success'] === 'function') {
        (opts['success'] as Function)({ statusCode: 200, data: { ok: true } });
      }
      if (typeof opts['complete'] === 'function') {
        (opts['complete'] as Function)({ statusCode: 200 });
      }
    }),
  };
}

function createFailingMockAPI(): MiniAppRequestAPI {
  return {
    request: vi.fn((opts: Record<string, unknown>) => {
      if (typeof opts['fail'] === 'function') {
        (opts['fail'] as Function)({ errMsg: 'request:fail timeout' });
      }
      if (typeof opts['complete'] === 'function') {
        (opts['complete'] as Function)({});
      }
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('instrumentMiniAppRequest', () => {
  let api: MiniAppRequestAPI;

  beforeEach(() => {
    api = createMockAPI();
  });

  // === Basic interception ===

  it('should capture a successful request', () => {
    const events: NetworkEvent[] = [];
    const unsub = instrumentMiniAppRequest(api, (e) => events.push(e), defaultOptions());

    api.request!({ url: '/api/data', method: 'GET' });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('request');
    expect(events[0]!.url).toBe('/api/data');
    expect(events[0]!.method).toBe('GET');
    expect(events[0]!.status).toBe(200);
    expect(events[0]!.error).toBeUndefined();

    unsub();
  });

  it('should capture a failed request', () => {
    api = createFailingMockAPI();
    const events: NetworkEvent[] = [];
    const unsub = instrumentMiniAppRequest(api, (e) => events.push(e), defaultOptions());

    api.request!({ url: '/api/fail', method: 'POST' });

    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe(0);
    expect(events[0]!.error).toContain('timeout');

    unsub();
  });

  it('should capture request body', () => {
    const events: NetworkEvent[] = [];
    const unsub = instrumentMiniAppRequest(api, (e) => events.push(e), defaultOptions());

    api.request!({ url: '/api', method: 'POST', data: { key: 'val' } });

    expect(events[0]!.requestBody).toEqual({ key: 'val' });
    unsub();
  });

  it('should not capture request body when captureRequestBody is false', () => {
    const events: NetworkEvent[] = [];
    const unsub = instrumentMiniAppRequest(
      api, (e) => events.push(e),
      defaultOptions({ captureRequestBody: false }),
    );

    api.request!({ url: '/api', method: 'POST', data: { key: 'val' } });

    expect(events[0]!.requestBody).toBeUndefined();
    unsub();
  });

  it('should capture response body and extract business info', () => {
    api = {
      request: vi.fn((opts: Record<string, unknown>) => {
        if (typeof opts['success'] === 'function') {
          (opts['success'] as Function)({
            statusCode: 200,
            data: { code: 1001, message: 'token expired' },
          });
        }
      }),
    };
    const events: NetworkEvent[] = [];
    const unsub = instrumentMiniAppRequest(api, (e) => events.push(e), defaultOptions());

    api.request!({ url: '/api/auth' });

    expect(events[0]!.responseCode).toBe(1001);
    expect(events[0]!.responseMessage).toBe('token expired');
    unsub();
  });

  it('should not capture response body when captureResponseBody is false', () => {
    const events: NetworkEvent[] = [];
    const unsub = instrumentMiniAppRequest(
      api, (e) => events.push(e),
      defaultOptions({ captureResponseBody: false }),
    );

    api.request!({ url: '/api' });

    expect(events[0]!.responseBody).toBeUndefined();
    unsub();
  });

  // === complete callback forwarding (ARCH-3) ===

  it('should forward the original success callback', () => {
    const userSuccess = vi.fn();
    const unsub = instrumentMiniAppRequest(api, () => {}, defaultOptions());

    api.request!({ url: '/api', success: userSuccess });

    expect(userSuccess).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('should forward the original fail callback', () => {
    api = createFailingMockAPI();
    const userFail = vi.fn();
    const unsub = instrumentMiniAppRequest(api, () => {}, defaultOptions());

    api.request!({ url: '/api', fail: userFail });

    expect(userFail).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('should forward the original complete callback', () => {
    const userComplete = vi.fn();
    const unsub = instrumentMiniAppRequest(api, () => {}, defaultOptions());

    api.request!({ url: '/api', complete: userComplete });

    expect(userComplete).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('should not throw when no original complete callback exists', () => {
    const unsub = instrumentMiniAppRequest(api, () => {}, defaultOptions());

    expect(() => {
      api.request!({ url: '/api' });
    }).not.toThrow();

    unsub();
  });

  // === Alipay status field difference (BUG-2) ===

  it('should read Alipay "status" when "statusCode" is absent', () => {
    api = {
      request: vi.fn((opts: Record<string, unknown>) => {
        if (typeof opts['success'] === 'function') {
          (opts['success'] as Function)({ status: 200, data: {} });
        }
      }),
    };
    const events: NetworkEvent[] = [];
    const unsub = instrumentMiniAppRequest(api, (e) => events.push(e), defaultOptions());

    api.request!({ url: '/api' });

    expect(events[0]!.status).toBe(200);
    unsub();
  });

  // === Alipay errorMessage field difference (BUG-2) ===

  it('should read Alipay "errorMessage" when "errMsg" is absent', () => {
    api = {
      request: vi.fn((opts: Record<string, unknown>) => {
        if (typeof opts['fail'] === 'function') {
          (opts['fail'] as Function)({ errorMessage: 'http status 500' });
        }
      }),
    };
    const events: NetworkEvent[] = [];
    const unsub = instrumentMiniAppRequest(api, (e) => events.push(e), defaultOptions());

    api.request!({ url: '/api' });

    expect(events[0]!.error).toBe('http status 500');
    unsub();
  });

  // === shouldCapture filtering ===

  it('should skip requests where shouldCapture returns false', () => {
    const originalRequest = api.request!;
    const events: NetworkEvent[] = [];
    const unsub = instrumentMiniAppRequest(
      api, (e) => events.push(e),
      defaultOptions({ shouldCapture: (url) => !url.includes('/logs') }),
    );

    api.request!({ url: '/logs', method: 'POST' });
    expect(events).toHaveLength(0);

    api.request!({ url: '/api/data' });
    expect(events).toHaveLength(1);

    unsub();
  });

  it('should default method to GET', () => {
    const events: NetworkEvent[] = [];
    const unsub = instrumentMiniAppRequest(api, (e) => events.push(e), defaultOptions());

    api.request!({ url: '/api' });

    expect(events[0]!.method).toBe('GET');
    unsub();
  });

  it('should uppercase method', () => {
    const events: NetworkEvent[] = [];
    const unsub = instrumentMiniAppRequest(api, (e) => events.push(e), defaultOptions());

    api.request!({ url: '/api', method: 'post' });

    expect(events[0]!.method).toBe('POST');
    unsub();
  });

  // === Singleton / multi-subscriber ===

  it('should patch api.request only once for multiple subscribers', () => {
    const unsub1 = instrumentMiniAppRequest(api, () => {}, defaultOptions());
    const patchedRef = api.request;

    const unsub2 = instrumentMiniAppRequest(api, () => {}, defaultOptions());
    expect(api.request).toBe(patchedRef);

    unsub1();
    unsub2();
  });

  it('should deliver events to all subscribers', () => {
    const events1: NetworkEvent[] = [];
    const events2: NetworkEvent[] = [];
    const unsub1 = instrumentMiniAppRequest(api, (e) => events1.push(e), defaultOptions());
    const unsub2 = instrumentMiniAppRequest(api, (e) => events2.push(e), defaultOptions());

    api.request!({ url: '/api' });

    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);

    unsub1();
    unsub2();
  });

  it('should not restore until the last subscriber unsubscribes', () => {
    const origReq = api.request;
    const unsub1 = instrumentMiniAppRequest(api, () => {}, defaultOptions());
    const unsub2 = instrumentMiniAppRequest(api, () => {}, defaultOptions());
    const patchedRef = api.request;

    unsub1();
    expect(api.request).toBe(patchedRef);

    unsub2();
    expect(api.request).toBe(origReq);
  });

  // === Safe restoration ===

  it('should not restore if a third party overwrote request', () => {
    const unsub = instrumentMiniAppRequest(api, () => {}, defaultOptions());

    const thirdParty = vi.fn();
    api.request = thirdParty;

    unsub();
    expect(api.request).toBe(thirdParty);
  });

  // === Idempotent unsubscribe ===

  it('should tolerate double-unsubscribe without errors', () => {
    const unsub = instrumentMiniAppRequest(api, () => {}, defaultOptions());
    unsub();
    unsub();
  });

  // === Subscriber error isolation ===

  it('should not break request if a subscriber handler throws', () => {
    const events: NetworkEvent[] = [];
    const unsub1 = instrumentMiniAppRequest(api, () => { throw new Error('boom'); }, defaultOptions());
    const unsub2 = instrumentMiniAppRequest(api, (e) => events.push(e), defaultOptions());

    api.request!({ url: '/api' });
    expect(events).toHaveLength(1);

    unsub1();
    unsub2();
  });

  // === No-op when request is unavailable ===

  it('should return noop unsubscribe when api.request does not exist', () => {
    const noReqApi: MiniAppRequestAPI = {};
    const unsub = instrumentMiniAppRequest(noReqApi, () => {}, defaultOptions());
    unsub(); // should not throw
  });

  it('should return noop when api is null/undefined', () => {
    const unsub = instrumentMiniAppRequest(
      null as unknown as MiniAppRequestAPI,
      () => {},
      defaultOptions(),
    );
    unsub();
  });
});
