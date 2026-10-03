import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { normalizeCapturedError, normalizeErrorEvidence } from '../src/utils/errorEvidence';
const SYNTHETIC_STACK = Symbol.for('aemeath.syntheticStack');
import { browserErrorCapture } from '../src/utils/browserErrorCapture';
import { getCaptureDiagnostics } from '../src/utils/captureGuard';
import { AemeathLogger } from '../src/core/Logger';
import { ErrorCapturePlugin } from '../src/plugins/ErrorCapturePlugin';
import { UploadPlugin } from '../src/plugins/UploadPlugin';
import { forwardEarlyError } from '../src/utils/forwardEarlyError';
import { getEarlyErrorCaptureScript } from '../src/build-plugins/early-error-script';
import type { EarlyError } from '../src/plugins/EarlyErrorCapturePlugin';
import type { LogEntry } from '../src/types';

const loggers: AemeathLogger[] = [];
afterEach(() => { loggers.splice(0).forEach(l => l.destroy()); vi.restoreAllMocks(); });
function logger() { const l = new AemeathLogger({ enableConsole: false }); loggers.push(l); return l; }

describe('error evidence contract', () => {
  it('preserves a frozen foreign Error, without mutating or replacing its name', () => {
    const error = runInNewContext('Object.freeze(new TypeError("foreign"))');
    const out = normalizeCapturedError(error, { channel: 'global' });
    expect(out).toMatchObject({ type: 'TypeError', value: 'foreign', stack: error.stack,
      evidence: { originalName: 'TypeError', stackOrigin: 'original' } });
    expect(error.type).toBeUndefined();
  });
  it('separates a known synthetic stack even when an Error was supplied', () => {
    const error = new Error('native failure');
    Object.defineProperty(error, SYNTHETIC_STACK, { value: true });
    const out = normalizeCapturedError(error);
    expect(out.stack).toBeUndefined();
    expect(out.evidence).toMatchObject({ stackOrigin: 'capture-site', captureStack: error.stack });
    expect(normalizeCapturedError(JSON.parse(JSON.stringify(out)))).toEqual(out);
  });
  it('classifies redacted script errors without manufacturing a stack', () => {
    const out = normalizeCapturedError(null, { channel: 'global', message: 'Script error.', source: '', line: 0, column: 0 });
    expect(out.stack).toBeUndefined();
    expect(out.evidence).toMatchObject({ stackOrigin: 'unavailable', missingStackReason: 'browser-redacted' });
  });
  it('keeps DOMException fields when stack is unavailable', () => {
    const error = new DOMException('denied', 'NotAllowedError');
    Object.defineProperty(error, 'stack', { value: undefined });
    const out = normalizeCapturedError(error);
    expect(out).toMatchObject({ type: 'NotAllowedError', value: 'denied', code: error.code });
    expect(out.stack).toBeUndefined();
  });
  it.each([null, undefined, false, 0, '', 42n, Symbol('x')])('handles primitive reason %s', reason => {
    const out = normalizeCapturedError(reason, { channel: 'unhandledrejection' });
    expect(out.stack).toBeUndefined();
    expect(out.value).toBe(String(reason));
    expect(() => JSON.stringify(out)).not.toThrow();
  });
  it('reads throwing fields once, never invokes toJSON/toString and survives proxies', () => {
    const message = vi.fn(() => { throw Error('getter'); });
    const toJSON = vi.fn(() => { throw Error('toJSON'); });
    const reason = { get message() { return message(); }, toJSON, toString: toJSON };
    const out = normalizeCapturedError(reason);
    expect(message).toHaveBeenCalledTimes(1);
    expect(toJSON).not.toHaveBeenCalled();
    expect(out.evidence?.normalization.issues).toContain('message:read-failed');
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    expect(() => JSON.stringify(normalizeCapturedError(revoked.proxy))).not.toThrow();
  });
  it('bounds nested causes, cycles, errors and multibyte strings with explicit markers', () => {
    const error: any = new Error('root');
    error.cause = error;
    error.errors = Array.from({ length: 20 }, () => ({ message: '界'.repeat(9000) }));
    const out = normalizeCapturedError(error);
    expect(out.cause).toBe('[circular]');
    expect(out.evidence?.normalization.issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(out).length).toBeLessThan(16000);
    expect(out.stack).toBe(error.stack);
  });
  it('keeps primary fields intact for the existing payload reject/split policy', () => {
    const error = new Error('x'.repeat(20000));
    expect(normalizeCapturedError(error).value).toBe(error.message);
  });
  it('preserves safe custom fields and is idempotent', () => {
    const error: any = new Error('business'); error.code = 17; error.detail = { owner: 'player' };
    const out = normalizeCapturedError(error);
    expect(out).toMatchObject({ code: 17, detail: { owner: 'player' } });
    expect(normalizeCapturedError(out)).toEqual(out);
  });
  it('retains input structured frames without claiming a capture stack', () => {
    const input = { type: 'Business', value: 'failed', stacktrace: { frames: [{ filename: 'a.js', lineno: 1 }] } };
    expect(normalizeCapturedError(input).stacktrace).toEqual(input.stacktrace);
  });
  it('keeps SDK-path business errors and routes immutable snapshots through Logger', () => {
    const l = logger(); const records: LogEntry[] = []; l.on('log', e => records.push(e as LogEntry));
    l.use(new ErrorCapturePlugin());
    const error = Object.freeze(new Error('[UploadPlugin] host message'));
    window.onerror?.(error.message, 'aemeath-js.js', 1, 2, error);
    expect(records).toHaveLength(1);
    expect(records[0].error?.evidence?.originalName).toBe('Error');
    expect(error).not.toHaveProperty('type');
  });
  it('does not lose repeated redacted errors in either capture or upload deduplication', async () => {
    const l = logger(); const delivered: LogEntry[] = [];
    l.use(new ErrorCapturePlugin());
    const upload = new UploadPlugin({ onUpload: async entry => { delivered.push(entry); return { success: true }; },
      cache: { enabled: false }, saveOnUnload: false, queue: { deduplicationDelay: 100 } });
    l.use(upload);
    window.onerror?.('Script error.', '', 0, 0, undefined);
    window.onerror?.('Script error.', '', 0, 0, undefined);
    await upload.flush();
    expect(delivered).toHaveLength(2);
    expect(delivered[0].error?.evidence?.occurrenceId).not.toBe(delivered[1].error?.evidence?.occurrenceId);
  });
});

describe('browser failure boundaries', () => {
  it.each([true, false, undefined])('preserves original handler return %s after SDK failure', result => {
    const previous = window.onerror;
    const host = vi.fn(function (this: unknown) { expect(this).toBe(window); return result; });
    window.onerror = host;
    const before = getCaptureDiagnostics().failures;
    const off = browserErrorCapture.onGlobalError(() => { throw Error('SDK'); });
    try {
      expect(window.onerror?.('host', 'host.js', 1, 2, undefined)).toBe(result);
      expect(host).toHaveBeenCalledWith('host', 'host.js', 1, 2, undefined);
      expect(getCaptureDiagnostics().failures).toBe(before + 1);
    } finally { off(); window.onerror = previous; }
  });
  it('does not swallow errors from the host handler', () => {
    const previous = window.onerror; const thrown = Error('host');
    window.onerror = () => { throw thrown; };
    const off = browserErrorCapture.onGlobalError(() => {});
    try { expect(() => window.onerror?.('', '', 0, 0, undefined)).toThrow(thrown); }
    finally { off(); window.onerror = previous; }
  });
  it('handles out-of-order uninstall without reviving inactive capture handlers', () => {
    const previous = window.onerror; const a = vi.fn(); const b = vi.fn();
    const capture = browserErrorCapture;
    const offA = capture.onGlobalError(a);
    const offB = capture.onGlobalError(b);
    offA(); window.onerror?.('', '', 0, 0, undefined);
    expect(a).not.toHaveBeenCalled(); expect(b).toHaveBeenCalledTimes(1);
    offB(); expect(window.onerror).toBe(previous);
  });
});

describe('early evidence parity', () => {
  it.each(['generated', 'standalone'])('%s script preserves evidence through handoff', mode => {
    const callbacks: Record<string, Function> = {};
    const win: any = { addEventListener: (name: string, fn: Function) => { callbacks[name] = fn; } };
    const script = mode === 'generated' ? getEarlyErrorCaptureScript({ autoRefreshOnChunkError: false, checkCompatibility: false }) : readFileSync('scripts/early-error.js', 'utf8');
    runInNewContext(script, { window: win, navigator: {}, screen: {}, location: {}, console });
    callbacks.error({ target: win, message: 'Script error.', filename: '', lineno: 0, colno: 0, error: null });
    const early = win.__EARLY_ERRORS__[0] as EarlyError;
    const out: LogEntry[] = []; const l = logger(); l.on('log', e => out.push(e as LogEntry));
    forwardEarlyError(l, early);
    expect(out[0].error?.stack).toBeUndefined();
    expect(out[0].error?.evidence).toMatchObject({ capturePhase: 'early', captureChannel: 'global', missingStackReason: 'browser-redacted' });
    expect(out[0].error?.evidence?.occurrenceId).toBe(early.error?.evidence?.occurrenceId);
    const foreign = runInNewContext('new TypeError("early promise")');
    callbacks.unhandledrejection({ reason: foreign });
    expect(win.__EARLY_ERRORS__[1].error).toMatchObject({ value: 'early promise', evidence: { originalName: 'TypeError', stackOrigin: 'original' } });
  });
  it('uses the same normalization contract in the standalone generated function', () => {
    const a = normalizeErrorEvidence(undefined, { message: 'Script error.', channel: 'global', phase: 'early' });
    expect(a.evidence?.stackOrigin).toBe('unavailable');
  });
});

describe('evidence-aware SourceMap parsing', () => {
  it('never resolves a known capture stack even from an old-shaped payload', async () => {
    const { SourceMapParser } = await import('../src/parser/SourceMapParser.client');
    const parser = new SourceMapParser({ sourceMapBaseUrl: 'https://cdn.test/maps/v1' });
    const error = normalizeCapturedError(undefined, { message: 'Script error.', channel: 'global' });
    error.stack = 'Error\n at collect (https://cdn.test/sdk.js:1:1)';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect((await parser.parseError(error)).status).toBe('unavailable');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it.each(['missing', 'invalid', 'mapped'])('reports %s source map state', async mode => {
    const { SourceMapParser } = await import('../src/parser/SourceMapParser.client');
    const parser = new SourceMapParser({ sourceMapBaseUrl: 'https://cdn.test/maps/v1' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: mode !== 'missing', status: mode === 'missing' ? 404 : 200,
      json: async () => {
        if (mode === 'invalid') throw Error('bad json');
        return { version: 3, sources: ['app.ts'], names: [], mappings: 'AAAA', sourcesContent: ['throw new Error()'] };
      },
    } as Response);
    const out = await parser.parseError({ type: 'Error', value: 'failure', stack: 'Error: failure\n    at app (https://cdn.test/static/js/app.js:1:1)' });
    expect(out.status).toBe(mode === 'mapped' ? 'mapped' : mode === 'missing' ? 'source-map-missing' : 'parse-failed');
  });
});

describe('synthetic replay evidence', () => {
  it('preserves adapter synthetic provenance through Logger, JSON and requeue', async () => {
    const l = logger();
    const records: LogEntry[] = []; l.on('log', e => records.push(e as LogEntry));
    const input = new Error('synthetic');
    l.error('synthetic', { error: normalizeCapturedError(input, { synthetic: true }) });
    const stored: LogEntry = JSON.parse(JSON.stringify(records[0]));
    expect(stored.error?.stack).toBeUndefined();
    expect(stored.error?.evidence).toMatchObject({ stackOrigin: 'capture-site' });
    expect(stored.error?.evidence?.originalName).toBeUndefined();
    const receiver = logger(); const sent: LogEntry[] = [];
    const upload = new UploadPlugin({ onUpload: async log => { sent.push(log); return { success: true }; }, cache: { enabled: false }, saveOnUnload: false });
    receiver.use(upload); upload.requeue(stored, { source: 'offline-replay' }); await upload.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].logId).toBe(stored.logId);
    expect(sent[0].error).toEqual(stored.error);
  });
  it('retains Firefox/Safari frames for original stacks', async () => {
    const { SourceMapParser } = await import('../src/parser/SourceMapParser.client');
    const parser = new SourceMapParser({ sourceMapBaseUrl: 'https://cdn.test/maps/v1' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 404 } as Response);
    const out = await parser.parseError({ type: 'Error', value: 'x', stack: 'fn@https://cdn.test/static/js/app.js:2:3' });
    expect(out.status).toBe('source-map-missing');
    expect(out.frames[0].minified).toMatchObject({ line: 2, column: 3 });
  });
});
