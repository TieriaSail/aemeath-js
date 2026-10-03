import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { OfflinePersistencePlugin } from '../src/plugins/OfflinePersistencePlugin';
import { UploadPlugin } from '../src/plugins/UploadPlugin';
import * as storeModule from '../src/plugins/offline/OfflineStore';
import { LogLevel, type LogEntry } from '../src/types';

const loggers: AemeathLogger[] = [];
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => { loggers.splice(0).forEach(logger => logger.destroy()); vi.useRealTimers(); });
type Boundary = 'get-success' | 'get-failure' | 'put-success' | 'put-failure';

async function setup(boundary: Boundary) {
  const create = storeModule.createOfflineStore;
  let armed = false, opening = 0;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  const handles: storeModule.OfflineStore[] = [];
  vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async options => {
    const store = await create(options); handles.push(store);
    if (++opening !== 1) return store;
    return { ...store,
      get: async id => {
        const record = await store.get(id);
        if (armed && boundary.startsWith('get')) {
          armed = false; entered(); await gate;
          if (boundary === 'get-failure') throw Error('delayed get failure');
        }
        return record;
      },
      put: async record => {
        if (armed && boundary.startsWith('put')) {
          armed = false;
          // A committed transaction may notify its caller after reinstall.
          if (boundary === 'put-success') await store.put(record);
          entered(); await gate;
          if (boundary === 'put-failure') throw Error('delayed put failure');
          return;
        }
        await store.put(record);
      },
    };
  });
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  const offline = new OfflinePersistencePlugin({ storage: 'localstorage', key: 'state-epoch' });
  logger.use(offline); await offline.whenReady();
  const now = Date.now();
  const log: LogEntry = { logId: 'epoch-record', message: 'deadline update', timestamp: now, level: LogLevel.ERROR };
  function update(delay: number) {
    logger.emit('upload:retry-scheduled', { log, source: 'live', reason: 'rate-limit', nextAttemptAt: now + delay, serverNotBefore: now + delay });
  }
  update(1000); await offline.whenReady();
  armed = true; update(5000); await blocked;
  const oldDone = offline.whenReady(); await Promise.resolve();
  return { logger, offline, now, log, handles, release, oldDone, update };
}

describe('offline retry-state installation boundary', () => {
  it.each(['get-success', 'get-failure', 'put-success', 'put-failure'] as const)(
    'ignores stale %s after reinstall without shortening the new deadline', async boundary => {
      const run = await setup(boundary);
      run.logger.uninstall('offline-persistence'); run.logger.use(run.offline); await run.offline.whenReady();
      run.update(10000); await run.offline.whenReady();
      run.release(); await run.oldDone;
      expect(run.offline.getStatus()).toMatchObject({ pending: 1, buffered: 0 });
      expect(await run.handles[1]!.get(run.log.logId)).toMatchObject({ notBefore: run.now + 10000, serverNotBefore: run.now + 10000 });

      // Check the hydrated in-memory index too: a stale write completion must
      // not permit replay early even when the newer disk record is correct.
      const onUpload = vi.fn(async () => ({ success: true }));
      const upload = new UploadPlugin({ onUpload, cache: { enabled: false }, saveOnUnload: false,
        queue: { concurrency: 3, deduplicationDelay: 0 } });
      vi.setSystemTime(run.now + 6000); run.logger.use(upload);
      await run.offline.whenReady(); await vi.advanceTimersByTimeAsync(20); await upload.flush();
      expect(onUpload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(4000); await run.offline.whenReady(); await upload.flush();
      expect(onUpload).toHaveBeenCalledOnce();
    },
  );

  it.each(['get-failure', 'put-failure'] as const)('still retries current-installation %s', async boundary => {
    const run = await setup(boundary); run.release(); await run.oldDone;
    expect(run.offline.getStatus()).toMatchObject({ pending: 1, buffered: 1 });
    await vi.advanceTimersByTimeAsync(1500); await run.offline.whenReady();
    expect(run.offline.getStatus()).toMatchObject({ pending: 1, buffered: 0 });
    expect(await run.handles[0]!.get(run.log.logId)).toMatchObject({ notBefore: run.now + 5000, serverNotBefore: run.now + 5000 });
  });
});
