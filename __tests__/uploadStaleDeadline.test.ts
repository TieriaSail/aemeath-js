import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin, type UploadResult } from '../src/plugins/UploadPlugin';
import { OfflinePersistencePlugin } from '../src/plugins/OfflinePersistencePlugin';
import { LogLevel, type LogEntry } from '../src/types';
const loggers: AemeathLogger[] = [];
let sequence = 0;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { loggers.splice(0).forEach(logger => logger.destroy()); vi.useRealTimers(); });
async function flush(upload: UploadPlugin) { const done = upload.flush(); await vi.advanceTimersByTimeAsync(300); await done; }
function setup(cache: boolean) {
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  let resolve!: (result: UploadResult) => void, reject!: (reason: unknown) => void;
  let calls = 0;
  const onUpload = vi.fn((_entry: LogEntry) => ++calls === 1
    ? new Promise<UploadResult>((ok, bad) => { resolve = ok; reject = bad; }) : Promise.resolve({ success: true }));
  const key = `stale-deadline-${++sequence}`;
  const options = { onUpload, cache: { enabled: cache, key }, saveOnUnload: false,
    queue: { deduplicationDelay: 10, retryBackoff: { baseMs: 0 } } };
  const upload = new UploadPlugin(options); logger.use(upload);
  const events: Record<string, unknown>[] = [];
  logger.on('upload:retry-scheduled', value => events.push(value as Record<string, unknown>));
  return { logger, upload, onUpload, options, key, events, resolve: (result: UploadResult) => resolve(result), reject: (reason: unknown) => reject(reason) };
}
async function remount(run: ReturnType<typeof setup>) {
  await vi.advanceTimersByTimeAsync(100); expect(run.onUpload).toHaveBeenCalledTimes(1);
  run.logger.uninstall('upload'); run.logger.use(run.upload);
  await vi.advanceTimersByTimeAsync(100); expect(run.onUpload).toHaveBeenCalledTimes(1);
}

describe.each([false, true])('stale attempt deadlines with cache=%s', cache => {
  it.each(['result', 'http-error'] as const)('preserves a late %s deadline through flush and another remount', async kind => {
    const run = setup(cache); run.logger.error('late server backoff'); await remount(run);
    const expected = Date.now() + 10_000;
    if (kind === 'result') run.resolve({ success: false, shouldRetry: true, retryReason: 'rate-limit', retryAfterMs: 10_000 });
    else run.reject({ message: 'busy', response: { status: 503, headers: { 'retry-after': '10' } } });
    await vi.advanceTimersByTimeAsync(50); await flush(run.upload);
    expect(run.onUpload).toHaveBeenCalledTimes(1);
    expect(run.events).toHaveLength(1); expect(run.events[0]!.serverNotBefore).toBe(expected);
    run.logger.uninstall('upload'); run.logger.use(run.upload); await flush(run.upload);
    expect(run.onUpload).toHaveBeenCalledTimes(1);
    if (cache) expect(JSON.parse(localStorage.getItem(run.key)!)[0].serverNotBefore).toBe(expected);
    await vi.advanceTimersByTimeAsync(10_000); await flush(run.upload); expect(run.onUpload).toHaveBeenCalledTimes(2);
  });

  it('defers the unsent sibling of a split log too', async () => {
    const run = setup(cache);
    const logs: LogEntry[] = [1, 2].map(index => ({ logId: `${run.key}-${index}`, level: LogLevel.ERROR,
      message: 'split late failure', timestamp: Date.now(), tags: { splitId: run.key, splitIndex: index, splitTotal: 2 } }));
    run.upload.requeue(logs); await remount(run);
    run.resolve({ success: false, shouldRetry: true, retryAfter: '10' });
    await vi.advanceTimersByTimeAsync(50); await flush(run.upload); expect(run.onUpload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000); await flush(run.upload);
    expect(run.onUpload).toHaveBeenCalledTimes(3);
    expect(new Set(run.onUpload.mock.calls.slice(1).map(call => call[0].logId))).toEqual(new Set(logs.map(log => log.logId)));
  });
});

it('retains the deadline through offline persistence when Upload cache is disabled', async () => {
  const run = setup(false); const key = `offline-${run.key}`;
  const offline = new OfflinePersistencePlugin({ storage: 'localstorage', key }); run.logger.use(offline); await offline.whenReady();
  run.logger.error('persist the late deadline'); await remount(run);
  run.resolve({ success: false, shouldRetry: true, retryAfterMs: 10_000 });
  await vi.advanceTimersByTimeAsync(500); await offline.whenReady();
  expect(run.onUpload).toHaveBeenCalledTimes(1); expect(offline.getStatus().pending).toBe(1);
  run.logger.destroy();
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  const upload = new UploadPlugin(run.options); const restored = new OfflinePersistencePlugin({ storage: 'localstorage', key });
  logger.use(upload); logger.use(restored); await restored.whenReady();
  await vi.advanceTimersByTimeAsync(500); await flush(upload); expect(run.onUpload).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10_000); await restored.whenReady(); await flush(upload);
  expect(run.onUpload).toHaveBeenCalledTimes(2);
});

it('preserves fast stale-failure handoff when the server supplies no deadline', async () => {
  const run = setup(false); run.logger.error('no server deadline'); await remount(run);
  run.resolve({ success: false, shouldRetry: true }); await vi.advanceTimersByTimeAsync(500); await flush(run.upload);
  expect(run.onUpload).toHaveBeenCalledTimes(2);
});
