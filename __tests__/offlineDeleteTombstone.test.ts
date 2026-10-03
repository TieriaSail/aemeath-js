import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { OfflinePersistencePlugin } from '../src/plugins/OfflinePersistencePlugin';
import * as storeModule from '../src/plugins/offline/OfflineStore';
import { LogLevel, type LogEntry } from '../src/types';

const loggers: AemeathLogger[] = [];
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => { loggers.splice(0).forEach(logger => logger.destroy()); vi.useRealTimers(); });
async function setup(event: 'success' | 'no-retry' = 'success') {
  const create = storeModule.createOfflineStore;
  let armed = false, reading = false, opens = 0, release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async options => {
    const store = await create(options);
    if (++opens !== 1) return store;
    return { ...store,
      delete: async id => {
        if (armed) { armed = false; reading = true; throw Error('transient delete failure'); }
        await store.delete(id);
      },
      get: async id => {
        const record = await store.get(id);
        if (reading) { reading = false; entered(); await gate; }
        return record;
      },
    };
  });
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  const key = 'delete-tombstone';
  const options = { storage: 'localstorage' as const, key };
  const offline = new OfflinePersistencePlugin(options); logger.use(offline); await offline.whenReady();
  const log: LogEntry = { logId: 'deleted-log', message: 'must stay deleted', timestamp: Date.now(), level: LogLevel.ERROR };
  logger.emit('upload:enqueued', { log, paused: true, source: 'live' }); await offline.whenReady();
  armed = true;
  if (event === 'success') logger.emit('upload:success', { log, source: 'live' });
  else logger.emit('upload:drop', { log, source: 'live', reason: 'no-retry' });
  await blocked;
  const oldDone = offline.whenReady(); await Promise.resolve();
  const read = () => JSON.parse(localStorage.getItem(`${key}:r:${log.logId}`) ?? 'null') as storeModule.OfflineRecord | null;
  const metas = () => JSON.parse(localStorage.getItem(`${key}:index`) ?? '[]');
  return { logger, offline, options, log, release, oldDone, read, metas };
}

describe('late terminal marker after deletion was completed by another installation', () => {
  for (const event of ['success', 'no-retry'] as const) {
    it.each(['reinstall', 'replacement'] as const)(`does not recreate a ${event} record after %s cleaned it`, async action => {
      const run = await setup(event); run.logger.uninstall('offline-persistence');
      const current = action === 'reinstall' ? run.offline : new OfflinePersistencePlugin(run.options);
      run.logger.use(current); await current.whenReady();
      expect(run.read()).toBeNull(); expect(run.metas()).toEqual([]);
      run.release(); await run.oldDone;
      await vi.advanceTimersByTimeAsync(1500); await current.whenReady();
      expect(run.read()).toBeNull(); expect(run.metas()).toEqual([]);
      expect(current.getStatus()).toMatchObject({ pending: 0, buffered: 0 });
    });
  }

  it('still persists a terminal marker after uninstall when deletion remains pending', async () => {
    const run = await setup(); run.logger.uninstall('offline-persistence'); run.release(); await run.oldDone;
    expect(run.read()).toMatchObject({ terminal: true, logId: run.log.logId });
    const next = new OfflinePersistencePlugin(run.options); run.logger.use(next); await next.whenReady();
    expect(run.read()).toBeNull(); expect(run.metas()).toEqual([]);
  });

  it('still marks and automatically retries a current-installation delete failure', async () => {
    const run = await setup(); run.release(); await run.oldDone;
    expect(run.read()).toMatchObject({ terminal: true });
    await vi.advanceTimersByTimeAsync(1500); await run.offline.whenReady();
    expect(run.read()).toBeNull(); expect(run.metas()).toEqual([]);
  });
});
