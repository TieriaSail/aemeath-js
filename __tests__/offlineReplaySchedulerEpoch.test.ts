import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { OfflinePersistencePlugin } from '../src/plugins/OfflinePersistencePlugin';
import { UploadPlugin } from '../src/plugins/UploadPlugin';
import * as storeModule from '../src/plugins/offline/OfflineStore';
import { LogLevel, type LogEntry } from '../src/types';

const loggers: AemeathLogger[] = [];
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => { loggers.splice(0).forEach(logger => logger.destroy()); vi.useRealTimers(); });

async function setup(storageRetry: boolean, oldFailure = false) {
  const create = storeModule.createOfflineStore;
  let opening = 0, armed = false, oldReads = 0, newFailures = 0;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async options => {
    const store = await create(options), generation = ++opening;
    return { ...store, get: async id => {
      const record = await store.get(id);
      if (generation === 1 && armed) {
        if (storageRetry && oldReads++ === 0) throw Error('initial read failure');
        armed = false; entered(); await gate;
        if (oldFailure) throw Error('late old read failure');
      }
      if (generation > 1 && newFailures > 0) {
        newFailures--; throw Error('new installation transient read failure');
      }
      return record;
    } };
  });
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  const offline = new OfflinePersistencePlugin({ storage: 'localstorage', key: 'scheduler-epoch' });
  logger.use(offline); await offline.whenReady();
  const log: LogEntry = { logId: 'scheduler-log', message: 'recover after reinstall', level: LogLevel.ERROR, timestamp: Date.now() };
  logger.emit('upload:enqueued', { log, paused: true, source: 'live' }); await offline.whenReady();
  const onUpload = vi.fn(async (_log: LogEntry) => ({ success: true }));
  const upload = new UploadPlugin({ onUpload, cache: { enabled: false }, saveOnUnload: false,
    queue: { concurrency: 3, deduplicationDelay: 0, uploadInterval: 100000 } });
  armed = true; logger.use(upload);
  if (storageRetry) { await offline.whenReady(); await vi.advanceTimersByTimeAsync(1000); }
  await blocked;
  const oldDone = offline.whenReady(); await Promise.resolve();
  return { logger, offline, onUpload, upload, release, oldDone,
    failNewRead: () => { newFailures = 1; } };
}

async function checkRecovered(run: Awaited<ReturnType<typeof setup>>) {
  await vi.advanceTimersByTimeAsync(1500); await run.offline.whenReady(); await run.upload.flush(); await run.offline.whenReady();
  expect(run.onUpload).toHaveBeenCalledOnce();
  expect(run.offline.getStatus()).toMatchObject({ pending: 0, replaying: 0, buffered: 0 });
}

describe('offline replay scheduler installation boundary', () => {
  it.each([false, true])('preserves the new read-retry wake when an old scan finishes (storageRetry=%s)', async storageRetry => {
    const run = await setup(storageRetry);
    run.logger.uninstall('offline-persistence'); run.failNewRead();
    run.logger.use(run.offline); await run.offline.whenReady();
    expect(run.onUpload).not.toHaveBeenCalled();
    expect(run.offline.getStatus()).toMatchObject({ pending: 1, buffered: 0 });
    run.release(); await run.oldDone;
    // No online/install event: only the new installation's retry timer can recover.
    await checkRecovered(run);
  });

  it.each([false, true])('still recovers current-installation read failures (storageRetry=%s)', async storageRetry => {
    const run = await setup(storageRetry, true);
    run.release(); await run.oldDone;
    // The storage-retry path has already backed off once, so its next delay is 2s.
    await vi.advanceTimersByTimeAsync(1000);
    await checkRecovered(run);
  });

  it('keeps new buffered writes after an old deletion-retry returns', async () => {
    const create = storeModule.createOfflineStore;
    let opening = 0, deletes = 0, failNewPut = true;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const blocked = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async options => {
      const store = await create(options), generation = ++opening;
      return { ...store,
        delete: async id => {
          if (generation === 1 && id === 'delivered') {
            if (++deletes === 1) throw Error('transient delete failure');
            await store.delete(id); entered(); await gate; return;
          }
          await store.delete(id);
        },
        put: async record => {
          if (generation > 1 && record.logId === 'new-buffer' && failNewPut) {
            failNewPut = false; throw Error('transient new write failure');
          }
          await store.put(record);
        },
      };
    });
    const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
    const offline = new OfflinePersistencePlugin({ storage: 'localstorage', key: 'scheduler-delete-handoff' });
    logger.use(offline); await offline.whenReady();
    const log: LogEntry = { logId: 'delivered', message: 'old terminal record', level: LogLevel.ERROR, timestamp: Date.now() };
    logger.emit('upload:enqueued', { log, paused: true, source: 'live' }); await offline.whenReady();
    logger.emit('upload:success', { log, source: 'live' }); await offline.whenReady();
    await vi.advanceTimersByTimeAsync(1000); await blocked;
    const oldDone = offline.whenReady(); await Promise.resolve();
    logger.uninstall('offline-persistence'); logger.use(offline); await offline.whenReady();
    const next = { ...log, logId: 'new-buffer', message: 'new buffered record' };
    logger.emit('upload:enqueued', { log: next, paused: true, source: 'live' }); await offline.whenReady();
    expect(offline.getStatus()).toMatchObject({ pending: 0, buffered: 1 });
    release(); await oldDone;
    expect(offline.getStatus()).toMatchObject({ pending: 0, buffered: 1 });
    await vi.advanceTimersByTimeAsync(1500); await offline.whenReady();
    expect(offline.getStatus()).toMatchObject({ pending: 1, buffered: 0 });
    const onUpload = vi.fn(async (_log: LogEntry) => ({ success: true }));
    const upload = new UploadPlugin({ onUpload, cache: { enabled: false }, saveOnUnload: false,
      queue: { concurrency: 3, deduplicationDelay: 0 } });
    logger.use(upload); await offline.whenReady(); await vi.advanceTimersByTimeAsync(300); await upload.flush();
    expect(onUpload.mock.calls.map(([item]) => item.logId)).toEqual(['new-buffer']);
  });

});
