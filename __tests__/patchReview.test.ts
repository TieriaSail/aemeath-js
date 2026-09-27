import { afterEach, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { SourceMapGenerator } from 'source-map-js';
import { AemeathLogger } from '../src/core/Logger';
import { ErrorCapturePlugin } from '../src/plugins/ErrorCapturePlugin';
import { SourceMapParser } from '../src/parser/SourceMapParser.client';
import { sanitizeLogEntry } from '../src/utils/payloadSanitize';
import { LogLevel, type LogEntry } from '../src/types';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('keeps the filter view as receiver when snapshotting accepted accessors', () => {
  const logger = new AemeathLogger({ enableConsole: false }); const records: LogEntry[] = [];
  logger.on('log', entry => records.push(entry as LogEntry)); const receivers: unknown[] = [];
  logger.use(new ErrorCapturePlugin({ errorFilter: view => {
    Object.defineProperty(view, 'message', { get() { receivers.push(this); return this === view ? 'redacted' : 'SECRET'; }, configurable: true });
    Object.defineProperty(view, 'extra', { get() { receivers.push(this); return this === view ? 'safe' : 'SECRET'; }, configurable: true });
    Object.freeze(view); return true;
  } }));
  try { (window.onerror as Function)('original', 'app.js', 1, 2, null);
    expect(records).toHaveLength(1); expect(records[0].error).toMatchObject({ value: 'redacted', extra: 'safe' });
    expect(JSON.stringify(records)).not.toContain('SECRET'); expect(receivers).toHaveLength(2); expect(receivers[0]).toBe(receivers[1]);
  } finally { logger.destroy(); }
});

function serialized(value: unknown) {
  const entry: LogEntry = { logId: 'L', level: LogLevel.ERROR, message: 'm', timestamp: 1, context: { value } };
  return { native: () => JSON.stringify(entry), sanitized: () => sanitizeLogEntry(entry) };
}
it.each(['new Number(7)', 'new String("kept")', 'new Boolean(false)'])('preserves a foreign-realm serializer result %s', expression => {
  const returned: unknown = runInNewContext(expression); const sample = serialized({ toJSON() { return returned; } });
  const result = sample.sanitized(); expect(result.status).toBe('ok'); expect(JSON.stringify(result.entries[0])).toBe(sample.native());
});
it.each(['number', 'string'])('preserves %s wrapper custom primitive conversion', kind => {
  const value = kind === 'number' ? new Number(7) : new String('kept');
  Object.defineProperty(value, Symbol.toPrimitive, { value: () => kind === 'number' ? 42 : 'converted' });
  const sample = serialized({ toJSON() { return value; } });
  expect(JSON.stringify(sample.sanitized().entries[0])).toBe(sample.native());
});
it('does not turn a returned BigInt wrapper into an empty object', () => {
  const sample = serialized({ toJSON() { return Object(BigInt(7)); } });
  expect(sample.native).toThrow();
  const result = sample.sanitized(); expect(result.strips.some(s => s.kind === 'unserializable')).toBe(true);
  expect(JSON.stringify(result.entries)).not.toContain('\"value\":{}');
});
it('sanitizes a boxed Data URL and catches failed wrapper conversion', () => {
  const result = serialized({ toJSON() { return new String('data:image/png;base64,' + 'A'.repeat(800)); } }).sanitized();
  expect(result.strips.some(s => s.kind === 'data-url')).toBe(true);
  expect(JSON.stringify(result.entries)).not.toContain('data:image');
  const value = new Number(1); Object.defineProperty(value, Symbol.toPrimitive, { value() { throw new Error('bad'); } });
  expect(serialized({ toJSON() { return value; } }).sanitized().strips.some(s => s.kind === 'unserializable')).toBe(true);
});
it('does not confuse toStringTag spoofing with primitive wrappers', () => {
  const value = { label: 'keep', [Symbol.toStringTag]: 'Number' };
  const sample = serialized({ toJSON() { return value; } });
  expect(JSON.stringify(sample.sanitized().entries[0])).toBe(sample.native());
});

for (const style of ['chrome', 'webkit']) for (const method of ['parse', 'parseError'] as const) {
  it.each([1, 10, 11])(`${method} respects one-based ${style} stack column %s at a mapping boundary`, async column => {
    const map = new SourceMapGenerator({ file: 'bundle.js' });
    map.addMapping({ generated: { line: 1, column: 0 }, original: { line: 10, column: 4 }, source: 'checkout.ts' });
    map.addMapping({ generated: { line: 1, column: 10 }, original: { line: 20, column: 8 }, source: 'profile.ts' });
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => JSON.parse(map.toString()) }); vi.stubGlobal('fetch', fetch);
    const parser = new SourceMapParser({ sourceMapBaseUrl: 'https://app.test/maps' });
    const frame = style === 'chrome' ? `at pay (https://app.test/static/js/bundle.js:1:${column})` : `pay@https://app.test/static/js/bundle.js:1:${column}`;
    const result = method === 'parse' ? await parser.parse(frame) : await parser.parseError({ type: 'Error', value: 'failed', stack: frame });
    expect(result.frames[0].minified?.column).toBe(column);
    expect(result.frames[0].original).toMatchObject(column <= 10 ? { fileName: 'checkout.ts', line: 10, column: 4 } : { fileName: 'profile.ts', line: 20, column: 8 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
}


it.each(['error', 'tags', 'context'] as const)('does not restore an omitted top-level %s serializer', field => {
  const serialize = vi.fn().mockReturnValueOnce(undefined).mockReturnValue('SECRET');
  const entry = { logId: 'L', level: LogLevel.ERROR, message: 'm', timestamp: 1, [field]: { toJSON: serialize } } as unknown as LogEntry;
  const result = sanitizeLogEntry(entry);
  expect(result.status).toBe('ok'); expect(result.entries[0][field]).toBeUndefined();
  expect(JSON.stringify(result.entries)).not.toContain('SECRET'); expect(serialize).toHaveBeenCalledTimes(1);
});


it.each(['global', 'rejection', 'console'])('snapshots accepted original %s errors only once', channel => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const logger = new AemeathLogger({ enableConsole: false }); const records: LogEntry[] = [];
  const filter = vi.fn(() => true); const raw = new Error('original');
  const stack = vi.fn().mockReturnValueOnce('Error: original\n at pay (https://app.test/app.js:1:2)').mockImplementation(() => { throw Error('second read'); });
  Object.defineProperty(raw, 'stack', { get: stack, configurable: true });
  logger.on('log', entry => records.push(entry as LogEntry));
  logger.use(new ErrorCapturePlugin({ captureConsoleError: true, errorFilter: filter }));
  try {
    if (channel === 'global') (window.onerror as Function)('original', 'app.js', 1, 2, raw);
    else if (channel === 'console') console.error(raw);
    else { const event = new Event('unhandledrejection'); Object.defineProperty(event, 'reason', { value: raw }); window.dispatchEvent(event); }
    expect(filter).toHaveBeenCalledExactlyOnceWith(raw); expect(stack).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(1); expect(records[0].error?.stack).toContain('at pay');
  } finally { logger.destroy(); }
});
it('does not call user filters for explicitly marked internal Errors', () => {
  const logger = new AemeathLogger({ enableConsole: false }); const filter = vi.fn(() => true);
  logger.use(new ErrorCapturePlugin({ errorFilter: filter }));
  try { (window.onerror as Function)('internal', '', 0, 0, Object.assign(new Error('internal'), { _isAemeathInternalError: true }));
    expect(filter).not.toHaveBeenCalled();
  } finally { logger.destroy(); }
});
