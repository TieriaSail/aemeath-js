import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { AemeathLogger } from '../src/core/Logger';
import { ErrorCapturePlugin } from '../src/plugins/ErrorCapturePlugin';
import { PayloadSanitizePlugin } from '../src/plugins/PayloadSanitizePlugin';
import { UploadPlugin } from '../src/plugins/UploadPlugin';
import { normalizeCapturedError } from '../src/utils/errorEvidence';
import { forwardEarlyError } from '../src/utils/forwardEarlyError';
import { SYNTHETIC_STACK } from '../src/platform/constants';
import type { EarlyError } from '../src/platform/types';
import type { LogEntry } from '../src/types';

const loggers: AemeathLogger[] = [];
function logger() {
  const l = new AemeathLogger({ enableConsole: false });
  loggers.push(l);
  return l;
}
afterEach(() => { loggers.splice(0).forEach(l => l.destroy()); vi.restoreAllMocks(); });

describe('error evidence review regressions', () => {
  it.each([false, true])('delivers every evidence fragment, including after retry=%s', async retry => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const l = logger();
    const delivered: LogEntry[] = [];
    const dropped = vi.fn();
    const attempted = new Set<string>();
    l.on('upload:drop', dropped);
    l.use(new PayloadSanitizePlugin({ maxBytes: 6000 }));
    const upload = new UploadPlugin({
      onUpload: async entry => {
        if (retry && !entry.error && !attempted.has(entry.logId)) {
          attempted.add(entry.logId);
          return { success: false, shouldRetry: true, retryReason: 'server' };
        }
        delivered.push(JSON.parse(JSON.stringify(entry)));
        return { success: true };
      },
      cache: { enabled: false }, saveOnUnload: false,
      queue: { deduplicationDelay: 100 },
    });
    l.use(upload);
    for (let i = 0; i < 2; i++) {
      l.error('same failure', {
        error: new Error('same error'),
        context: { response: 'x'.repeat(4000), request: 'y'.repeat(4000) },
      });
    }
    await upload.flush();
    if (retry) {
      expect(delivered).toHaveLength(2);
      expect(attempted.size).toBe(2);
      await upload.flush();
    }
    expect(delivered).toHaveLength(4);
    const ids = new Set(delivered.map(e => e.tags?.splitId));
    expect(ids.size).toBe(2);
    for (const id of ids) {
      const parts = delivered.filter(e => e.tags?.splitId === id);
      expect(parts.map(e => e.tags?.splitIndex).sort()).toEqual([1, 2]);
      expect(parts.every(e => e.tags?.splitTotal === 2)).toBe(true);
      expect(Object.assign({}, ...parts.map(e => e.context))).toMatchObject({
        response: 'x'.repeat(4000), request: 'y'.repeat(4000),
      });
    }
    expect(dropped).not.toHaveBeenCalled();
  });

  it('keeps early metadata through handoff and repeated normalization after diagnostic budget exhaustion', () => {
    const input = Object.assign(new Error('early failure'), { detail: 'x'.repeat(8192) });
    for (let i = 0; i < 50; i++) Object.assign(input, { ['extra' + i]: i });
    const early: EarlyError = {
      type: 'error', message: input.message, stack: input.stack || '',
      error: normalizeCapturedError(input, { phase: 'early', channel: 'global' }),
      filename: 'app.js', source: 'app.js', lineno: 42, colno: 7, timestamp: 123,
      device: { ua: 'test', lang: 'en', screen: '800x600', url: 'https://app.test/', time: 123 },
    };
    const records: LogEntry[] = []; const l = logger(); l.on('log', e => records.push(e));
    forwardEarlyError(l, early);
    expect(records[0].tags?.errorCategory).toBe('early');
    const expected = { earlyError: true, filename: 'app.js', source: 'app.js', lineno: 42, colno: 7,
      captureTimestamp: 123, device: early.device };
    expect(records[0].error).toMatchObject(expected);
    expect(normalizeCapturedError(records[0].error)).toMatchObject(expected);
  });

  it('keeps browser location independent of the synthetic capture stack budget', () => {
    const input = Object.assign(new Error('native failure'), { stack: 'x'.repeat(10000), [SYNTHETIC_STACK]: true });
    const first = normalizeCapturedError(input, { source: 'app.js', line: 42, column: 7 });
    expect(normalizeCapturedError(first).evidence?.browserLocation).toEqual({ source: 'app.js', line: 42, column: 7 });
  });

  it('preserves console arguments and the compatible source tag', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const records: LogEntry[] = []; const l = logger(); l.on('log', e => records.push(e));
    l.use(new ErrorCapturePlugin({ captureConsoleError: true }));
    const metadata = { requestId: 'r-42', operation: 'submit' };
    const suffix = Array.from({ length: 12 }, (_, i) => 'argument-' + i);
    console.error('save failed', metadata, new Error('denied'), ...suffix);
    expect(records).toHaveLength(1);
    expect(records[0].tags?.source).toBe('console');
    const args = records[0].context?.consoleArgs as unknown[];
    expect(args).toHaveLength(15);
    expect(args.slice(0, 2)).toEqual(['save failed', metadata]);
    expect(args.slice(3)).toEqual(suffix);
    expect(records[0].error?.evidence?.captureChannel).toBe('console');
  });

  it('retains nested plain reasons from a foreign realm without invoking conversion hooks', () => {
    const reason = runInNewContext('({status:503, detail:{message:"payment failed", requestId:"r-1"}, toJSON(){throw Error("must not run")}})');
    const out = normalizeCapturedError(reason, { channel: 'unhandledrejection' });
    const expected = { status: 503, detail: { message: 'payment failed', requestId: 'r-1' } };
    expect(out.reason).toEqual(expected);
    expect(JSON.parse(out.value)).toEqual(expected);
    expect(out.evidence?.normalization.issues).toEqual([]);
  });

  it('preserves all structured original frames even when diagnostic budgets are exhausted', () => {
    const frames = Array.from({ length: 200 }, (_, i) => ({ filename: 'app.js', lineno: i + 1, colno: 1,
      function: 'handler' + i, source: 'x'.repeat(200) }));
    const input = { type: 'TypeError', value: 'boom', detail: 'x'.repeat(8192), stacktrace: { frames } };
    const l = logger(); const records: LogEntry[] = []; l.on('log', e => records.push(e));
    l.error('structured error', { error: input });
    const out = normalizeCapturedError(records[0].error);
    expect(out.stacktrace).toEqual({ frames });
    expect(out.stacktrace).not.toBe(input.stacktrace);
    expect(out.evidence?.normalization.issues.some(issue => issue.startsWith('stacktrace'))).toBe(false);
  });
});
