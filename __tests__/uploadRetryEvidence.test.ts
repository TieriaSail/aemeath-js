import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin, type UploadResult } from '../src/plugins/UploadPlugin';

const loggers: AemeathLogger[] = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { loggers.splice(0).forEach(l => l.destroy()); vi.restoreAllMocks(); vi.useRealTimers(); });
async function flush(upload: UploadPlugin) { const done = upload.flush(); await vi.advanceTimersByTimeAsync(300); await done; }
function setup(first: () => unknown) {
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  let calls = 0; const drops: string[] = []; const reasons: unknown[] = [];
  const upload = new UploadPlugin({ onUpload: async () => (++calls === 1 ? first() : { success: true }) as UploadResult,
    onDrop: (_log, info) => drops.push(info.reason), cache: { enabled: false }, saveOnUnload: false,
    queue: { maxRetries: 1, deduplicationDelay: 100, suspectedOfflineThreshold: 1, retryBackoff: { baseMs: 5000 } } });
  logger.use(upload); logger.on('upload:retry-scheduled', event => reasons.push((event as { reason: unknown }).reason));
  logger.error('retry evidence'); return { upload, drops, reasons, calls: () => calls };
}
const throws = () => { throw Error('must not read ignored field'); };

describe('stable upload retry evidence', () => {
  it('reads one response for status and Retry-After, including explicit flush', async () => {
    let reads = 0;
    const run = setup(() => { throw { message: 'busy', get response() {
      return ++reads === 1 ? { status: 503, headers: { 'retry-after': '5' } } : undefined;
    } }; });
    await flush(run.upload); expect(reads).toBe(1); expect(run.reasons).toEqual(['server']);
    await flush(run.upload); expect(run.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(5000); await flush(run.upload); expect(run.calls()).toBe(2);
  });

  it.each(['name', 'message'] as const)('does not re-read %s and mistake callback errors for a broken network', async key => {
    let reads = 0;
    const error = key === 'name'
      ? { message: 'cancelled', get name() { return ++reads === 1 ? 'AbortError' : 'TimeoutError'; } }
      : { name: 'TypeError', get message() { return ++reads === 1 ? 'Cannot read properties of undefined' : 'Failed to fetch'; } };
    const run = setup(() => { throw error; }); await flush(run.upload);
    expect(reads).toBe(1); expect(run.upload.getQueueStatus().paused).toBe(false);
    expect(run.reasons).toEqual([key === 'name' ? 'cancelled' : 'callback-error']);
    await flush(run.upload); expect(run.calls()).toBe(2);
  });

  it.each(['retryAfterMs', 'retryAfter', 'retryReason'] as const)('preserves explicit no-retry when ignored %s throws', async key => {
    const value = Object.defineProperty({ success: false, shouldRetry: false }, key, { get: throws });
    const run = setup(() => value); await flush(run.upload);
    expect(run.drops).toEqual(['no-retry']); expect(run.calls()).toBe(1);
  });

  it.each(['retryAfterMs', 'retryAfter', 'shouldRetry'] as const)('preserves permanent payload failure when ignored %s throws', async key => {
    const value = Object.defineProperty({ success: false, retryReason: 'payload' }, key, { get: throws });
    const run = setup(() => value); await flush(run.upload);
    expect(run.drops).toEqual(['no-retry']); expect(run.calls()).toBe(1);
  });

  it('does not read a lower-priority Retry-After when retryAfterMs is valid', async () => {
    const fallback = vi.fn(throws);
    const run = setup(() => ({ success: false, shouldRetry: true, retryReason: 'rate-limit', retryAfterMs: 5000, get retryAfter() { return fallback(); } }));
    await flush(run.upload); expect(fallback).not.toHaveBeenCalled();
    expect(run.reasons).toEqual(['rate-limit']); await flush(run.upload); expect(run.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(5000); await flush(run.upload); expect(run.calls()).toBe(2);
  });

  it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('keeps the header fallback for invalid retryAfterMs=%s', async retryAfterMs => {
    const run = setup(() => ({ success: false, shouldRetry: true, retryAfterMs, retryAfter: '5' }));
    await flush(run.upload); await flush(run.upload); expect(run.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(5000); await flush(run.upload); expect(run.calls()).toBe(2);
  });

  it('does not inspect deadlines when failure has no retry intent', async () => {
    const run = setup(() => ({ success: false, get retryAfterMs() { return throws(); } }));
    await flush(run.upload); expect(run.drops).toEqual(['no-retry']);
  });
  it('retains a valid header when the higher-priority milliseconds getter is unreadable', async () => {
    const run = setup(() => ({ success: false, shouldRetry: true, retryReason: 'rate-limit',
      get retryAfterMs() { return throws(); }, retryAfter: '5' }));
    await flush(run.upload); expect(run.reasons).toEqual(['rate-limit']);
    await flush(run.upload); expect(run.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(5000); await flush(run.upload); expect(run.calls()).toBe(2);
  });

});
