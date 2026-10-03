import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { OfflinePersistencePlugin } from '../src/plugins/OfflinePersistencePlugin';
import * as storeModule from '../src/plugins/offline/OfflineStore';
import { LogLevel, type LogEntry } from '../src/types';

const loggers: AemeathLogger[] = [];
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => { loggers.splice(0).forEach(logger => logger.destroy()); vi.useRealTimers(); });
type Reason = 'storage-quota' | 'storage-rejected';

async function setup(reason: Reason, failRead: boolean, gateRead: boolean) {
  const create = storeModule.createOfflineStore;
  const handles: storeModule.OfflineStore[] = [];
  let armed = false, release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async options => {
    const store = await create(options); handles.push(store);
    if (handles.length !== 1) return store;
    return { ...store, get: async id => {
      const record = await store.get(id);
      if (armed && gateRead && id === 'resident-1') {
        armed = false; entered(); await gate;
        if (failRead) throw Error('delayed rejected sibling read');
      }
      return record;
    } };
  });
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  const offline = new OfflinePersistencePlugin({ storage: 'localstorage', key: 'rejection-epoch', maxTotalBytes: 2500 });
  logger.use(offline); await offline.whenReady();
  const drops: string[] = [];
  logger.on('upload:drop', payload => { drops.push((payload as { log: LogEntry }).log.logId); });
  const makeLog = (index: number): LogEntry => ({ logId: `resident-${index}`, message: 'split member', timestamp: Date.now(), level: LogLevel.ERROR,
    tags: { splitId: 'rejected-group', splitIndex: index, splitTotal: gateRead ? 2 : 3 } });
  const persist = (log: LogEntry) => logger.emit('upload:enqueued', { log, paused: true, source: 'live' });
  for (let index = 1; index <= (gateRead ? 1 : 2); index++) { persist(makeLog(index)); await offline.whenReady(); }
  const incoming = makeLog(gateRead ? 2 : 3);
  if (reason === 'storage-quota') incoming.message = 'x'.repeat(3000);
  else { const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic; incoming.context = cyclic; }
  armed = true;
  const start = () => persist(incoming);
  return { logger, offline, handles, release, blocked, drops, persist, start };
}

describe('offline split rejection installation boundary', () => {
  it('does not reject a new split group when old quota recovery returns after reinstall', async () => {
    const create = storeModule.createOfflineStore;
    const handles: storeModule.OfflineStore[] = [];
    let armed = false, release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const blocked = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async options => {
      const store = await create(options); handles.push(store);
      if (handles.length !== 1) return store;
      return { ...store,
        put: async record => {
          if (record.logId === 'old-incoming') {
            armed = true;
            throw new DOMException('quota exhausted', 'QuotaExceededError');
          }
          await store.put(record);
        },
        get: async id => {
          const record = await store.get(id);
          if (armed && id === 'unrelated-resident') { armed = false; entered(); await gate; }
          return record;
        },
      };
    });
    const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
    const offline = new OfflinePersistencePlugin({ storage: 'localstorage', key: 'quota-rejection-epoch' });
    logger.use(offline); await offline.whenReady();
    const drops: string[] = [];
    logger.on('upload:drop', payload => { drops.push((payload as { log: LogEntry }).log.logId); });
    const persist = (logId: string, splitIndex?: number) => logger.emit('upload:enqueued', {
      paused: true, source: 'live', log: { logId, message: logId, timestamp: Date.now(), level: LogLevel.ERROR,
        ...(splitIndex === undefined ? {} : { tags: { splitId: 'new-group', splitIndex, splitTotal: 2 } }) },
    });
    persist('unrelated-resident'); await offline.whenReady();
    persist('old-incoming', 2); await blocked;
    const oldDone = offline.whenReady(); await Promise.resolve();
    logger.uninstall('offline-persistence'); logger.use(offline); await offline.whenReady();
    persist('new-sibling', 1); await offline.whenReady();
    release(); await oldDone;
    persist('new-tail', 2); await offline.whenReady();
    expect(drops).toEqual([]);
    expect(offline.getStatus()).toMatchObject({ pending: 3, buffered: 0, quotaDrops: 0 });
    expect((await handles[1]!.loadMeta()).map(meta => meta.logId).sort()).toEqual(['new-sibling', 'new-tail', 'unrelated-resident']);
  });

  for (const reason of ['storage-quota', 'storage-rejected'] as const) {
    it.each([false, true])(`stale ${reason} sibling read cannot delete from a new installation (failure=%s)`, async failRead => {
      const run = await setup(reason, failRead, true);
      run.start(); await run.blocked;
      const oldDone = run.offline.whenReady(); await Promise.resolve();
      run.logger.uninstall('offline-persistence'); run.logger.use(run.offline); await run.offline.whenReady();
      run.release(); await oldDone;
      await vi.advanceTimersByTimeAsync(1500); await run.offline.whenReady();
      expect(run.drops).toEqual([]);
      expect(run.offline.getStatus()).toMatchObject({ pending: 1, buffered: 0, quotaDrops: 0 });
      expect((await run.handles[1]!.loadMeta()).map(meta => meta.logId)).toEqual(['resident-1']);
    });

    it.each([false, true])(`current ${reason} rejection still deletes by indexed id (read failure=%s)`, async failRead => {
      const run = await setup(reason, failRead, true);
      run.start(); await run.blocked; run.release(); await run.offline.whenReady();
      expect(run.drops).toEqual(failRead ? ['resident-2'] : ['resident-1', 'resident-2']);
      expect(run.offline.getStatus()).toMatchObject({ pending: 0, buffered: 0, quotaDrops: reason === 'storage-quota' ? 2 : 0 });
      expect(await run.handles[0]!.loadMeta()).toEqual([]);
    });

    it(`stops ${reason} notifications if a host drop listener reinstalls the plugin`, async () => {
      const run = await setup(reason, false, false);
      let reinstalled = false;
      run.logger.on('upload:drop', () => {
        if (reinstalled) return;
        reinstalled = true;
        run.logger.uninstall('offline-persistence'); run.logger.use(run.offline);
        run.persist({ logId: 'new-record', message: 'new record', timestamp: Date.now(), level: LogLevel.ERROR });
      });
      run.start(); const oldDone = run.offline.whenReady(); await oldDone; await run.offline.whenReady();
      expect(reinstalled).toBe(true);
      expect(run.drops).toEqual(['resident-1']);
      expect(run.offline.getStatus()).toMatchObject({ pending: 1, buffered: 0, quotaDrops: 0 });
      expect((await run.handles[1]!.loadMeta()).map(meta => meta.logId)).toEqual(['new-record']);
    });
  }
});
