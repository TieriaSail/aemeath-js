import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getEarlyErrorCaptureScript, type EarlyErrorScriptOptions } from '../src/build-plugins/early-error-script';
import { runInNewContext } from 'node:vm';
import { resetAemeath } from '../src/singleton';

const win = window as unknown as Record<string, any>;
const registrations: [string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined][] = [];
const removeListener = window.removeEventListener.bind(window);
const requests: { url: string; headers: Record<string, string>; body?: string }[] = [];
class MockXHR {
  record = { url: '', headers: {} as Record<string, string>, body: undefined as string | undefined };
  open(_method: string, url: string) { this.record.url = url; }
  setRequestHeader(key: string, value: string) {
    const lower = key.toLowerCase();
    this.record.headers[lower] = this.record.headers[lower] ? this.record.headers[lower] + ', ' + value : value;
  }
  send(body: string) { this.record.body = body; requests.push(this.record); }
}
function inject(options: EarlyErrorScriptOptions = {}) {
  const originalAdd = window.addEventListener;
  window.addEventListener = function(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
    registrations.push([type, listener, options]);
    return originalAdd.call(window, type, listener, options);
  };
  try { new Function(getEarlyErrorCaptureScript({ checkCompatibility: false, autoRefreshOnChunkError: false,
    fallbackEndpoint: '/fallback', fallbackTimeout: 100, fallbackTransport: 'xhr', ...options }))();
  } finally { window.addEventListener = originalAdd; }
}
function capture(message = 'business error') {
  const event = new Event('unhandledrejection');
  Object.defineProperty(event, 'reason', { value: new Error(message) });
  window.dispatchEvent(event);
}
beforeEach(() => {
  resetAemeath(); vi.useFakeTimers(); requests.length = 0;
  vi.stubGlobal('XMLHttpRequest', MockXHR);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { resetAemeath();
  for (const [type, listener, options] of registrations) removeListener(type, listener, options);
  registrations.length = 0; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('stops old listeners and fallback timers before reset and reinjection', async () => {
  inject({ fallbackEndpoint: '/old', fallbackTimeout: 10 });
  capture('old'); resetAemeath();
  inject({ fallbackEndpoint: '/new', fallbackTimeout: 100 }); capture('new');
  expect(win.__EARLY_ERRORS__).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(20); expect(requests).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(100);
  expect(requests.map(request => request.url)).toEqual(['/new']);
  expect(JSON.parse(requests[0].body!).errors.map((error: { message: string }) => error.message)).toEqual(['new']);
});
it('releases capture listeners after handoff', () => {
  const add = vi.spyOn(window, 'addEventListener'); const remove = vi.spyOn(window, 'removeEventListener');
  inject(); capture();
  const callback = vi.fn(); win.__flushEarlyErrors__(callback);
  expect(callback).toHaveBeenCalledTimes(1);
  for (const event of ['error', 'unhandledrejection']) {
    const registration = add.mock.calls.find(args => args[0] === event)!;
    if (registration[2] === undefined) expect(remove).toHaveBeenCalledWith(event, registration[1]);
    else expect(remove).toHaveBeenCalledWith(event, registration[1], registration[2]);
  }
});
it('lets a new injection retry after partial script initialization fails', () => {
  const originalAdd = window.addEventListener;
  const broken = vi.spyOn(window, 'addEventListener').mockImplementation(function(type, listener, options) {
    if (type === 'unhandledrejection') throw new Error('installation failed');
    return originalAdd.call(window, type, listener, options);
  });
  inject(); broken.mockRestore();
  inject(); capture('after recovery');
  expect(win.__EARLY_ERRORS__).toHaveLength(1);
  expect(typeof win.__flushEarlyErrors__).toBe('function');
});
it('does not send fallback after reset without reinjection', async () => {
  inject(); capture(); resetAemeath();
  await expect(vi.advanceTimersByTimeAsync(200)).resolves.not.toThrow();
  expect(requests).toHaveLength(0);
});
it.each(['content-type', 'CONTENT-TYPE'])('overrides the default %s header without appending it', async header => {
  inject({ fallbackHeaders: { [header]: 'application/custom+json', 'X-Token': 'test' } }); capture();
  await vi.advanceTimersByTimeAsync(100);
  expect(requests).toHaveLength(1);
  expect(requests[0].headers['content-type']).toBe('application/custom+json');
  expect(requests[0].headers['x-token']).toBe('test');
});
it('allows a header named hasOwnProperty without breaking the send', async () => {
  inject({ fallbackHeaders: { hasOwnProperty: 'test' } }); capture();
  await vi.advanceTimersByTimeAsync(100);
  expect(requests).toHaveLength(1); expect(requests[0].headers.hasownproperty).toBe('test');
});
it('keeps sending valid batches after a cyclic payload fails serialization', async () => {
  inject({ formatPayload: function() {
    var invalid: Record<string, unknown> = {}; invalid.self = invalid;
    return [invalid, { kept: true }];
  } }); capture();
  await vi.advanceTimersByTimeAsync(100);
  expect(requests.map(request => JSON.parse(request.body!))).toEqual([{ kept: true }]);
});
it('does not send an empty request when a custom payload serializes to undefined', async () => {
  inject({ formatPayload: function() { return [function() {}, { kept: true }]; } }); capture();
  await vi.advanceTimersByTimeAsync(100);
  expect(requests.map(request => request.body)).toEqual(['{"kept":true}']);
});
it('still sends if the diagnostic console.warn throws', async () => {
  vi.mocked(console.warn).mockImplementation(() => { throw new Error('broken console'); });
  inject(); capture(); await vi.advanceTimersByTimeAsync(100);
  expect(requests).toHaveLength(1);
});
it('falls back to the default payload if both the formatter and console.error throw', async () => {
  vi.mocked(console.error).mockImplementation(() => { throw new Error('broken console'); });
  inject({ formatPayload: function() { throw new Error('formatter'); } }); capture();
  await vi.advanceTimersByTimeAsync(100);
  expect(requests).toHaveLength(1);
  expect(JSON.parse(requests[0].body!).type).toBe('early-error-fallback');
});
it('does not let diagnostics replace a handoff callback failure', () => {
  vi.mocked(console.error).mockImplementation(() => { throw new Error('broken console'); });
  inject(); capture();
  expect(() => win.__flushEarlyErrors__(() => { throw new Error('consumer failed'); })).not.toThrow();
  expect(win.__EARLY_ERRORS__).toHaveLength(0);
});

it('retains the JSON content type when custom headers do not override it', async () => {
  inject({ fallbackHeaders: { 'X-App': 'example' } }); capture();
  await vi.advanceTimersByTimeAsync(100);
  expect(requests[0].headers['content-type']).toBe('application/json');
});
it('does not let a stale flush reference drain a replacement buffer', () => {
  inject(); const stale = win.__flushEarlyErrors__; resetAemeath();
  inject(); capture('replacement'); const consumer = vi.fn();
  stale(consumer);
  expect(consumer).not.toHaveBeenCalled(); expect(win.__EARLY_ERRORS__).toHaveLength(1);
});

it.each(['reload', 'handoff', 'dispose'] as const)('preserves chunk fallback while managing the pending reload: %s', mode => {
  const handlers = new Map<string, Function>(); const timers = new Map<number, Function>(); let timerId = 0;
  const reload = vi.fn();
  const context: Record<string, any> = {
    navigator: { userAgent: 'vm', language: 'en' }, screen: { width: 100, height: 100 },
    location: { href: 'https://app.test/', reload }, console: { warn() {}, error() {} },
    sessionStorage: { getItem() { return null; }, setItem() {} }, XMLHttpRequest: MockXHR,
    setTimeout(callback: Function) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
    addEventListener(type: string, callback: Function) { handlers.set(type, callback); },
    removeEventListener(type: string, callback: Function) { if (handlers.get(type) === callback) handlers.delete(type); },
  };
  context.window = context;
  runInNewContext(getEarlyErrorCaptureScript({ checkCompatibility: false, fallbackEndpoint: '/chunk-fallback',
    fallbackTimeout: 5000, fallbackTransport: 'xhr' }), context);
  handlers.get('error')!({ target: { tagName: 'SCRIPT', src: '/chunk.js' } });
  expect(requests).toHaveLength(1); expect(timers.size).toBe(1);
  if (mode === 'handoff') context.__flushEarlyErrors__(() => {});
  if (mode === 'dispose') context.__stopEarlyErrorCapture__();
  if (mode !== 'reload') expect(timers.size).toBe(0);
  for (const callback of timers.values()) callback();
  expect(reload).toHaveBeenCalledTimes(mode === 'reload' ? 1 : 0);
});
