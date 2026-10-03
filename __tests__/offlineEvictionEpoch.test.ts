import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { OfflinePersistencePlugin } from '../src/plugins/OfflinePersistencePlugin';
import * as storeModule from '../src/plugins/offline/OfflineStore';
import { LogLevel, type LogEntry } from '../src/types';

const loggers: AemeathLogger[] = [];
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => { loggers.splice(0).forEach(logger => logger.destroy()); vi.useRealTimers(); });

async function setup(split: boolean, slot: number, fail: boolean) {
  const create = storeModule.createOfflineStore;
  const handles: storeModule.OfflineStore[] = [];
  let armed = false;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async options => {
    const store = await create(options); handles.push(store);
    if (handles.length !== 1) return store;
    return { ...store, get: async id => {
      const record = await store.get(id);
      if (armed && id === `resident-${slot}`) {
        armed = false; entered(); await gate;
        if (fail) throw Error('delayed eviction read failure');
      }
      return record;
    } };
  });
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  const offline = new OfflinePersistencePlugin({ storage: 'localstorage', key: 'eviction-epoch', maxEntries: 2 });
  logger.use(offline); await offline.whenReady();
  const drops: string[] = [];
  logger.on('upload:drop', value => { drops.push((value as { log: LogEntry }).log.logId); });
  const residents: LogEntry[] = [1, 2].map(index => ({
    logId: `resident-${index}`, message: `resident-${index}`, timestamp: Date.now(), level: LogLevel.ERROR,
    ...(split ? { tags: { splitId: 'resident-group', splitIndex: index, splitTotal: 2 } } : {}),
  }));
  const persist = (log: LogEntry) => logger.emit('upload:enqueued', { log, paused: true, source: 'live' });
  for (const log of residents) { persist(log); await offline.whenReady(); }
  expect(offline.getStatus().pending).toBe(2);
  armed = true;
  persist({ logId: 'old-incoming', message: 'old admission', level: LogLevel.ERROR, timestamp: Date.now() });
  await blocked;
  const oldDone = offline.whenReady(); await Promise.resolve();
  return { logger, offline, handles, release, oldDone, drops };
}

describe('offline eviction preparation installation boundary', () => {
  const cases = [
    { split: false, slot: 1, fail: false },
    { split: false, slot: 1, fail: true },
    { split: true, slot: 1, fail: false },
    { split: true, slot: 1, fail: true },
    { split: true, slot: 2, fail: false },
    { split: true, slot: 2, fail: true },
  ];
  it.each(cases)('stops an old read before deletion (split=$split, slot=$slot, fail=$fail)', async ({ split, slot, fail }) => {
    const run = await setup(split, slot, fail);
    run.logger.uninstall('offline-persistence'); run.logger.use(run.offline); await run.offline.whenReady();
    run.release(); await run.oldDone;
    await vi.advanceTimersByTimeAsync(1500); await run.offline.whenReady();
    expect(run.offline.getStatus()).toMatchObject({ pending: 2, buffered: 0, quotaDrops: 0 });
    expect((await run.handles[1]!.loadMeta()).map(meta => meta.logId).sort()).toEqual(['resident-1', 'resident-2']);
    expect(run.drops).toEqual([]);
  });

  for (const fail of [false, true]) {
    it.each([false, true])(`still completes current-installation eviction (read failure=${fail}, split=%s)`, async split => {
      const run = await setup(split, split ? 2 : 1, fail);
      run.release(); await run.oldDone;
      if (fail) {
        expect(run.offline.getStatus()).toMatchObject({ pending: 2, buffered: 1, quotaDrops: 0 });
        expect(run.drops).toEqual([]);
        await vi.advanceTimersByTimeAsync(1500); await run.offline.whenReady();
      }
      const removed = split ? ['resident-1', 'resident-2'] : ['resident-1'];
      expect(run.drops).toEqual(removed);
      expect(run.offline.getStatus()).toMatchObject({ pending: split ? 1 : 2, buffered: 0, quotaDrops: removed.length });
      expect((await run.handles[0]!.loadMeta()).map(meta => meta.logId).sort()).toEqual(split ? ['old-incoming'] : ['old-incoming', 'resident-2']);
    });
  }
});
