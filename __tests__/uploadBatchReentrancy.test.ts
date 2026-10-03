import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin } from '../src/plugins/UploadPlugin';
import { LogLevel, type LogEntry } from '../src/types';
import { _resetIgnoreNetworkCapture, shouldIgnoreNetworkCapture } from '../src/utils/ignoreNetworkCapture';

const loggers: AemeathLogger[] = [];
const key = 'batch-reentrancy';
const ids = ['batch-first', 'batch-second', 'batch-third'];
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); _resetIgnoreNetworkCapture(); });
afterEach(() => {
  loggers.splice(0).forEach(logger => logger.destroy());
  localStorage.clear(); vi.useRealTimers(); _resetIgnoreNetworkCapture();
});
async function flush(upload: UploadPlugin) {
  const done = upload.flush(); await vi.advanceTimersByTimeAsync(500); await done;
}
function entries(): LogEntry[] {
  return ids.map(logId => ({ logId, message: logId, level: LogLevel.ERROR, timestamp: Date.now() }));
}
function setup(cache: boolean, action: (logger: AemeathLogger, upload: UploadPlugin) => void, trigger = 'callback') {
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  let first = true;
  const act = () => { if (first) { first = false; action(logger, upload); } };
  const onUpload = vi.fn(async (_log: LogEntry) => {
    if (trigger === 'callback') act();
    return { success: true };
  });
  const upload = new UploadPlugin({ onUpload, cache: { enabled: cache, key }, saveOnUnload: false,
    queue: { concurrency: 3, deduplicationDelay: 100, uploadInterval: 100000 } });
  if (trigger === 'event') logger.on('upload:attempt', act);
  logger.use(upload); upload.requeue(entries());
  return { logger, upload, onUpload };
}

describe('upload batch synchronous reentrancy', () => {
  it('waits for started requests if selecting a later record throws', async () => {
    const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    const onUpload = vi.fn(async (_log: LogEntry) => {
      if (first) {
        first = false;
        const pending = upload.peekQueuedForPersist()[0]!.log;
        let broken = true;
        Object.defineProperty(pending, 'tags', { configurable: true, get() {
          if (broken) { broken = false; throw Error('late selection failure'); }
          return undefined;
        } });
        await gate;
      }
      return { success: true };
    });
    const upload = new UploadPlugin({ onUpload, cache: { enabled: false }, saveOnUnload: false,
      queue: { concurrency: 3, deduplicationDelay: 100, uploadInterval: 100000 } });
    logger.use(upload); upload.requeue(entries());
    let completed = false;
    const done = upload.flush().then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(onUpload).toHaveBeenCalledTimes(1);
    expect(completed).toBe(false);
    expect(upload.getQueueStatus()).toMatchObject({ length: 2, inFlight: 1 });
    release(); await vi.advanceTimersByTimeAsync(500); await done; await flush(upload);
    expect(onUpload.mock.calls.map(([log]) => log.logId)).toEqual(ids);
    expect(upload.getQueueStatus()).toMatchObject({ length: 0, inFlight: 0 });
    expect(shouldIgnoreNetworkCapture()).toBe(false);
  });

  for (const trigger of ['callback', 'event']) {
    it.each([false, true])(`${trigger} pause retains unstarted records (cache=%s)`, async cache => {
      let snapshot: string[] = [];
      const run = setup(cache, (logger, upload) => {
        logger.on('upload:paused', value => {
          snapshot = (value as { logs: Array<{ log: LogEntry }> }).logs.map(item => item.log.logId);
        });
        upload.setOnUpload(null);
      }, trigger);
      await flush(run.upload);
      expect(run.onUpload.mock.calls.map(([log]) => log.logId)).toEqual(ids.slice(0, 1));
      expect(snapshot).toEqual(ids.slice(1));
      expect(run.upload.getQueueStatus()).toMatchObject({ length: 2, inFlight: 0 });
      expect(shouldIgnoreNetworkCapture()).toBe(false);
      await flush(run.upload); expect(run.onUpload).toHaveBeenCalledTimes(1);
      const next = vi.fn(async (_log: LogEntry) => ({ success: true }));
      run.upload.setOnUpload(next); await flush(run.upload);
      expect(next.mock.calls.map(([log]) => log.logId)).toEqual(ids.slice(1));
      expect(run.upload.getQueueStatus()).toMatchObject({ length: 0, inFlight: 0 });
    });
  }

  it.each([false, true])('uninstall preserves unstarted records for reinstall (cache=%s)', async cache => {
    let snapshot: string[] = [];
    const run = setup(cache, logger => {
      logger.uninstall('upload');
      snapshot = (JSON.parse(localStorage.getItem(key) ?? '[]') as Array<{ log: LogEntry }>).map(item => item.log.logId);
    });
    await flush(run.upload);
    expect(run.onUpload.mock.calls.map(([log]) => log.logId)).toEqual(ids.slice(0, 1));
    expect(run.upload.getQueueStatus()).toMatchObject({ length: 2, inFlight: 0 });
    if (cache) expect(snapshot.sort()).toEqual([...ids].sort());
    expect(shouldIgnoreNetworkCapture()).toBe(false);
    run.logger.use(run.upload); await flush(run.upload);
    // An already started request can remain in the released cache after uninstall:
    // replay retains the existing at-least-once policy. Unstarted records send once.
    expect(run.onUpload.mock.calls.map(([log]) => log.logId)).toEqual(cache ? [...ids, ids[0]] : ids);
    expect(run.upload.getQueueStatus()).toMatchObject({ length: 0, inFlight: 0 });
  });

  it.each([false, true])('old batch cannot launch into a paused new installation (cache=%s)', async cache => {
    const run = setup(cache, (logger, upload) => {
      logger.uninstall('upload'); upload.setOnUpload(null); logger.use(upload);
    });
    await flush(run.upload);
    expect(run.onUpload.mock.calls.map(([log]) => log.logId)).toEqual(ids.slice(0, 1));
    expect(run.upload.getQueueStatus()).toMatchObject({ length: 2, inFlight: 0 });
    expect(shouldIgnoreNetworkCapture()).toBe(false);
    const next = vi.fn(async (_log: LogEntry) => ({ success: true }));
    run.upload.setOnUpload(next); await flush(run.upload);
    expect(next.mock.calls.map(([log]) => log.logId)).toEqual(ids.slice(1));
    expect(run.upload.getQueueStatus()).toMatchObject({ length: 0, inFlight: 0 });
  });
});
