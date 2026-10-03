import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { normalizeCapturedError } from '../src/utils/errorEvidence';
import { SourceMapParser } from '../src/parser/SourceMapParser.client';
import { getEarlyErrorCaptureScript } from '../src/build-plugins/early-error-script';
import { forwardEarlyError } from '../src/utils/forwardEarlyError';
import { AemeathLogger } from '../src/core/Logger';
import type { LogEntry } from '../src/types';

afterEach(() => vi.restoreAllMocks());

describe('second error evidence review', () => {
  it.each(['TypeError', '(class PaymentError extends Error {})'])('keeps foreign %s own extensions', constructor => {
    const error = runInNewContext(`Object.freeze(Object.assign(new ${constructor}('payment failed'), {
      status: 503, requestId: 'r-42', detail: { operation: 'pay' }
    }))`);
    const out = normalizeCapturedError(error, { channel: 'unhandledrejection' });
    expect(out).toMatchObject({ value: 'payment failed', status: 503, requestId: 'r-42', detail: { operation: 'pay' } });
    expect(out.stack).toBe(error.stack);
    expect(out.evidence?.normalization.issues).toEqual([]);
    expect(error).not.toHaveProperty('evidence');
  });

  it('does not enumerate a host object or invoke a constructor/toStringTag getter to detect Error', () => {
    const ownKeys = vi.fn(() => { throw Error('host enumeration'); });
    const getter = vi.fn(() => { throw Error('host getter'); });
    const prototype = Object.create(Object.prototype, { constructor: { get: getter } });
    const host = new Proxy(Object.create(prototype, {
      message: { value: 'host failure' },
      [Symbol.toStringTag]: { get: getter },
    }), { ownKeys });
    expect(normalizeCapturedError(host).value).toBe('host failure');
    expect(ownKeys).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([5000, 8100])('keeps a %s-byte reason intact through Logger and JSON normalization', size => {
    const reason = { detail: 'x'.repeat(size), status: 503, requestId: 'r-42' };
    const out = normalizeCapturedError(reason, { channel: 'unhandledrejection' });
    const records: LogEntry[] = [];
    const logger = new AemeathLogger({ enableConsole: false });
    logger.on('log', entry => records.push(entry as LogEntry));
    try { logger.error('Unhandled promise rejection', { error: out }); }
    finally { logger.destroy(); }
    const roundtrip = normalizeCapturedError(JSON.parse(JSON.stringify(records[0].error)));
    for (const error of [out, records[0].error!, roundtrip]) {
      expect(error.reason).toEqual(reason);
      expect(JSON.parse(error.value)).toEqual(reason);
      expect(error.evidence?.normalization.issues).toEqual([]);
    }
  });

  it.each(['generated', 'standalone'])('%s early script keeps reasons through runtime handoff', mode => {
    const callbacks: Record<string, Function> = {};
    const win: any = { addEventListener: (name: string, fn: Function) => { callbacks[name] = fn; } };
    const script = mode === 'generated'
      ? getEarlyErrorCaptureScript({ autoRefreshOnChunkError: false, checkCompatibility: false })
      : readFileSync('scripts/early-error.js', 'utf8');
    runInNewContext(script, { window: win, navigator: {}, screen: {}, location: {}, console });
    const reason = { detail: 'x'.repeat(5000), status: 503, requestId: 'r-42' };
    callbacks.unhandledrejection({ reason });
    const records: LogEntry[] = [];
    const logger = new AemeathLogger({ enableConsole: false });
    logger.on('log', entry => records.push(entry as LogEntry));
    try { forwardEarlyError(logger, win.__EARLY_ERRORS__[0]); }
    finally { logger.destroy(); }
    expect(records[0].error?.reason).toEqual(reason);
    expect(JSON.parse(records[0].error!.value)).toEqual(reason);
    expect(records[0].tags?.errorCategory).toBe('early');
  });

  it.each(['mapped', 'source-map-missing', 'parse-failed'])('keeps the supplied message when a headerless stack is %s', status => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: status !== 'source-map-missing', status: 404,
      json: async () => {
        if (status === 'parse-failed') throw Error('bad JSON');
        return { version: 3, sources: ['app.ts'], names: [], mappings: 'AAAA', sourcesContent: ['throw Error("boom")'] };
      },
    } as Response);
    const parser = new SourceMapParser({ sourceMapBaseUrl: 'https://cdn.test/maps/v1' });
    return parser.parseError({ type: 'TypeError', value: 'payment failed',
      stack: 'pay@https://cdn.test/static/js/app.js:1:1' }).then(result => {
      expect(result.status).toBe(status);
      expect(result.message).toBe('payment failed');
      expect(result.frames[0].minified?.line).toBe(1);
    });
  });
});
