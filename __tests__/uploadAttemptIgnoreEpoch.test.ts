import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin } from '../src/plugins/UploadPlugin';
import { LogLevel, type LogEntry } from '../src/types';
import { _resetIgnoreNetworkCapture, shouldIgnoreNetworkCapture } from '../src/utils/ignoreNetworkCapture';

const loggers: AemeathLogger[] = [];
beforeEach(() => {
  vi.useFakeTimers(); _resetIgnoreNetworkCapture();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  loggers.splice(0).forEach(logger => logger.destroy());
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); _resetIgnoreNetworkCapture();
});
function entry(logId: string): LogEntry {
  return { logId, message: logId, level: LogLevel.ERROR, timestamp: Date.now() };
}
function setup(onUpload: ConstructorParameters<typeof UploadPlugin>[0]['onUpload']) {
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  const upload = new UploadPlugin({ onUpload, cache: { enabled: false }, saveOnUnload: false,
    queue: { deduplicationDelay: 100, uploadInterval: 100000, maxRetries: 0, offlinePolicy: 'legacy' } });
  logger.use(upload);
  return { logger, upload };
}

describe('upload attempt notification and network-ignore ownership', () => {
  for (const remount of [false, true]) {
    it.each(['success', 'throw', 'timeout'])(`attempt listener teardown cannot reacquire an ignore window (remount=${remount}, %s)`, async outcome => {
      const observed: boolean[] = [];
      const onUpload = vi.fn(() => {
        observed.push(shouldIgnoreNetworkCapture());
        if (outcome === 'throw') throw Error('callback failure');
        if (outcome === 'timeout') return new Promise<{ success: boolean }>(() => {});
        return Promise.resolve({ success: true });
      });
      const { logger, upload } = setup(onUpload);
      logger.on('upload:attempt', () => {
        logger.uninstall('upload');
        // Keep stale failures eligible for later retry without starting a new batch.
        if (remount) { upload.setOnUpload(null); logger.use(upload); }
      });
      upload.requeue(entry('old'));
      const done = upload.flush();
      await vi.advanceTimersByTimeAsync(60010); await done;
      expect(onUpload).toHaveBeenCalledTimes(1);
      expect(observed).toEqual([false]);
      expect(shouldIgnoreNetworkCapture()).toBe(false);
      expect(upload.getQueueStatus().inFlight).toBe(0);
    });
  }

  it.each(['old-first', 'new-first'])('old settlement preserves a new request window (%s)', async order => {
    const releases: Record<string, () => void> = {};
    const onUpload = vi.fn((log: LogEntry) => new Promise<{ success: boolean }>(resolve => {
      releases[log.logId] = () => resolve({ success: true });
    }));
    const { logger, upload } = setup(onUpload);
    let remounted = false;
    logger.on('upload:attempt', () => {
      if (remounted) return;
      remounted = true;
      logger.uninstall('upload'); logger.use(upload);
    });
    upload.requeue(entry('old')); const oldDone = upload.flush();
    await vi.advanceTimersByTimeAsync(0);
    const ignoredAfterOld = shouldIgnoreNetworkCapture();
    upload.requeue(entry('new')); const newDone = upload.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(onUpload.mock.calls.map(([log]) => log.logId)).toEqual(['old', 'new']);
    expect(shouldIgnoreNetworkCapture()).toBe(true);
    const first = order === 'old-first' ? 'old' : 'new';
    releases[first]!(); await vi.advanceTimersByTimeAsync(0);
    const ignoredAfterFirst = shouldIgnoreNetworkCapture();
    releases[first === 'old' ? 'new' : 'old']!();
    await vi.advanceTimersByTimeAsync(500); await Promise.all([oldDone, newDone]);
    expect(ignoredAfterOld).toBe(false);
    expect(ignoredAfterFirst).toBe(first === 'old');
    expect(shouldIgnoreNetworkCapture()).toBe(false);
    expect(upload.getQueueStatus().inFlight).toBe(0);
  });

  it.each([false, true])('same-installation attempt retains normal suppression (pause=%s)', async pause => {
    let release!: () => void;
    const observed: boolean[] = [];
    const { logger, upload } = setup(() => {
      observed.push(shouldIgnoreNetworkCapture());
      return new Promise<{ success: boolean }>(resolve => { release = () => resolve({ success: true }); });
    });
    if (pause) logger.on('upload:attempt', () => upload.setOnUpload(null));
    upload.requeue(entry('current')); const done = upload.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(observed).toEqual([true]); expect(shouldIgnoreNetworkCapture()).toBe(true);
    release(); await vi.advanceTimersByTimeAsync(500); await done;
    expect(shouldIgnoreNetworkCapture()).toBe(false);
  });
});
