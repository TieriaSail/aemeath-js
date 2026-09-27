import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { AemeathLogger } from '../src/core/Logger';
import { ErrorCapturePlugin } from '../src/plugins/ErrorCapturePlugin';
import { SafeGuardPlugin } from '../src/plugins/SafeGuardPlugin';
import { getEarlyErrorCaptureScript } from '../src/build-plugins/early-error-script';
import { sanitizeLogEntry } from '../src/utils/payloadSanitize';
import { LogLevel, type LogEntry } from '../src/types';

const loggers: AemeathLogger[] = [];
function recording() {
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  const records: LogEntry[] = []; logger.on('log', entry => records.push(entry as LogEntry));
  return { logger, records };
}
afterEach(() => { loggers.splice(0).forEach(l => l.destroy()); vi.restoreAllMocks(); });

it('honors deleted/replaced resource fields even when the filter freezes its view', () => {
  const { logger, records } = recording();
  logger.use(new ErrorCapturePlugin({ errorFilter: error => {
    const view = error as Error & { src?: string; outerHTML?: string; tagName?: string };
    view.message = 'redacted'; delete view.src; delete view.outerHTML; view.tagName = 'safe';
    Object.freeze(view); return true;
  } }));
  const img = document.createElement('img'); img.src = 'https://app.test/SECRET.png'; document.body.append(img);
  try { img.dispatchEvent(new Event('error')); } finally { img.remove(); }
  expect(records).toHaveLength(1);
  expect(records[0].error).toMatchObject({ value: 'redacted', tagName: 'safe', evidence: { captureChannel: 'resource', stackOrigin: 'unavailable' } });
  expect(records[0].error?.stack).toBeUndefined();
  expect(JSON.stringify(records)).not.toContain('SECRET');
});

it('honors removed rejection reason fields and reads a filter message accessor once', () => {
  const { logger, records } = recording(); const read = vi.fn(() => 'redacted');
  logger.use(new ErrorCapturePlugin({ errorFilter: error => {
    delete (error as Error & { reason?: unknown }).reason;
    Object.defineProperty(error, 'message', { get: read }); return true;
  } }));
  const event = new Event('unhandledrejection'); Object.defineProperty(event, 'reason', { value: { token: 'SECRET' } });
  window.dispatchEvent(event);
  expect(records).toHaveLength(1); expect(read).toHaveBeenCalledTimes(1);
  expect(records[0].error?.value).toBe('redacted'); expect(JSON.stringify(records)).not.toContain('SECRET');
  expect(records[0].error?.evidence?.captureChannel).toBe('unhandledrejection');
});

it.each(['chrome', 'webkit'])('keeps distinct %s error locations but still merges repeated locations above rateLimit', style => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { logger, records } = recording();
  logger.use(new SafeGuardPlugin({ rateLimit: 1, maxErrors: 100, mergeWindow: 60000 }));
  logger.use(new ErrorCapturePlugin()); logger.info('warm rate window'); records.length = 0;
  for (const site of ['checkout', 'profile', 'profile']) {
    const error = new Error('failed');
    error.stack = style === 'chrome' ? `Error: failed\n at ${site} (https://app.test/${site}.js:10:2)` : `${site}@https://app.test/${site}.js:10:2`;
    (window.onerror as Function)('failed', `https://app.test/${site}.js`, 10, 2, error);
  }
  expect(records).toHaveLength(2);
  expect(records[0].error?.stack).toContain('checkout'); expect(records[1].error?.stack).toContain('profile');
});

const entry = (value: unknown): LogEntry => ({ logId: 'L', level: LogLevel.ERROR, message: 'm', timestamp: 1, context: { value } });
function cleaned(value: unknown) {
  const result = sanitizeLogEntry(entry(value)); expect(result.status).toBe('ok');
  return result.entries[0].context?.value;
}
it('sanitizes returned objects without invoking their serializer and still serializes child properties', () => {
  const outer = vi.fn(); const inner = vi.fn(); const child = vi.fn();
  const input = { toJSON(key: string) { outer(key); return {
    label: 'kept', toJSON() { inner(); return 'WRONG'; },
    nested: { toJSON(key: string) { child(key); return 'child'; } },
    image: 'data:image/png;base64,' + 'A'.repeat(800),
  }; } };
  const result = cleaned(input) as Record<string, unknown>;
  expect(result.label).toBe('kept'); expect(result.nested).toBe('child');
  expect(JSON.stringify(result)).not.toContain('data:image'); expect(JSON.stringify(result)).not.toContain('WRONG');
  expect(outer).toHaveBeenCalledExactlyOnceWith('value'); expect(inner).not.toHaveBeenCalled(); expect(child).toHaveBeenCalledExactlyOnceWith('nested');
});
it.each(['own', 'inherited', 'date', 'array', 'non-callable'])('matches native JSON for a serializer returning %s toJSON', kind => {
  const returned = kind === 'own' ? { label: 'keep', toJSON() { return 'WRONG'; } }
    : kind === 'inherited' ? Object.assign(Object.create({ toJSON() { return 'WRONG'; } }), { label: 'keep' })
    : kind === 'date' ? new Date('2026-01-01T00:00:00Z')
    : kind === 'array' ? Object.assign([1, 2], { toJSON() { return 'WRONG'; } })
    : { toJSON: 'ordinary property', label: 'keep' };
  const value = { toJSON() { return returned; } };
  const expected = JSON.parse(JSON.stringify({ value })).value;
  expect(JSON.parse(JSON.stringify({ value: cleaned(value) })).value).toEqual(expected);
});
it('reads self-returning serializer getter/method once and removes raw data', () => {
  const call = vi.fn(() => value); const read = vi.fn(() => call);
  const value = { image: 'data:image/png;base64,' + 'A'.repeat(800), get toJSON() { return read(); } };
  const result = cleaned(value);
  expect(JSON.stringify(result)).not.toContain('data:image'); expect(read).toHaveBeenCalledTimes(1); expect(call).toHaveBeenCalledTimes(1);
});
it('handles mutually returning serializers without calling the second function', () => {
  const second = vi.fn(() => a); const b = { label: 'keep', toJSON: second }; const a = { toJSON() { return b; } };
  expect(cleaned(a)).toEqual({ label: 'keep' }); expect(second).not.toHaveBeenCalled();
});
it('preserves property key arguments, normal dates and sanitizes overridden Date serializers', () => {
  const keys: string[] = []; const value = { toJSON(key: string) { keys.push(key); return key; } };
  expect(cleaned({ 'with.dot': value, array: [value] })).toEqual({ 'with.dot': 'with.dot', array: ['0'] });
  expect(keys).toEqual(['with.dot', '0']);
  const date = new Date('2026-01-01T00:00:00Z'); expect(JSON.stringify(cleaned(date))).toBe(JSON.stringify(date));
  date.toJSON = () => 'data:image/png;base64,' + 'A'.repeat(800);
  expect(JSON.stringify(cleaned(date))).not.toContain('data:image');
});

for (const kind of ['embedded', 'standalone']) describe(`${kind} early script compatibility`, () => {
  it.each(['IMG', 'VIDEO', 'AUDIO', 'SOURCE', 'LINK'])('retains %s resource kind, URL and legacy aliases', tagName => {
    const handlers: Record<string, ((event: unknown) => void)[]> = {};
    const win: any = { addEventListener(name: string, fn: (event: unknown) => void) { (handlers[name] ||= []).push(fn); } };
    const script = kind === 'standalone' ? readFileSync('scripts/early-error.js', 'utf8') : getEarlyErrorCaptureScript({ autoRefreshOnChunkError: false, checkCompatibility: false });
    runInNewContext(script, { window: win, navigator: {}, screen: {}, location: {}, console });
    const url = 'https://app.test/missing'; const target = { tagName, ...(tagName === 'LINK' ? { href: url } : { src: url }) };
    handlers.error.forEach(fn => fn({ target }));
    let batch: any[] = []; win.__flushEarlyErrors__((errors: any[]) => { batch = errors; });
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({ type: 'resource', tagName, src: url, source: url, filename: url,
      error: { evidence: { captureChannel: 'resource', capturePhase: 'early', browserLocation: { source: url } } } });
  });
});
