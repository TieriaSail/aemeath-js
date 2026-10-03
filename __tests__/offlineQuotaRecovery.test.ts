import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { OfflinePersistencePlugin } from '../src/plugins/OfflinePersistencePlugin';
import * as storeModule from '../src/plugins/offline/OfflineStore';
import { LogLevel, type LogEntry } from '../src/types';

const loggers: AemeathLogger[] = [];
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => { loggers.splice(0).forEach(logger => logger.destroy()); vi.useRealTimers(); });

async function setup(split: boolean, slot: number, failRead: boolean, delayFailure = false) {
  const create = storeModule.createOfflineStore;
  const handles: storeModule.OfflineStore[] = [];
  let quotaOnce = true, readFaultArmed = false, release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async options => {
    const store = await create(options); handles.push(store);
    if (handles.length !== 1) return store;
    return { ...store,
      put: async record => {
        if (record.logId === 'incoming' && quotaOnce) {
          quotaOnce = false; readFaultArmed = failRead;
          throw new DOMException('storage quota exhausted', 'QuotaExceededError');
        }
        await store.put(record);
      },
      get: async id => {
        if (readFaultArmed && id === `resident-${slot}`) {
          readFaultArmed = false;
          if (delayFailure) { entered(); await gate; }
          throw Error('candidate read temporarily unavailable');
        }
        return store.get(id);
      },
    };
  });
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  const offline = new OfflinePersistencePlugin({ storage: 'localstorage', key: 'quota-recovery', maxEntries: 3 });
  logger.use(offline); await offline.whenReady();
  const drops: string[] = [];
  logger.on('upload:drop', payload => drops.push((payload as { log: LogEntry }).log.logId));
  for (const index of [1, 2]) {
    const log: LogEntry = { logId: `resident-${index}`, message: 'resident', timestamp: Date.now(), level: LogLevel.ERROR,
      ...(split ? { tags: { splitId: 'resident-group', splitIndex: index, splitTotal: 2 } } : {}) };
    logger.emit('upload:enqueued', { log, paused: true, source: 'live' }); await offline.whenReady();
  }
  const now = Date.now();
  const incoming: LogEntry = { logId: 'incoming', message: 'retain this write intent', level: LogLevel.ERROR, timestamp: now };
  const start = () => logger.emit('upload:parked', { log: incoming, source: 'live', priority: 37,
    parkedUntil: now + 20000, serverNotBefore: now + 30000, parkCount: 2, reason: 'rate-limit' });
  return { logger, offline, handles, drops, start, now, release, blocked };
}

const candidates = [{ split: false, slot: 1 }, { split: true, slot: 1 }, { split: true, slot: 2 }];
describe('offline quota recovery after a transient candidate read failure', () => {
  it.each(candidates)('retains and retries the incoming write (split=$split, slot=$slot)', async ({ split, slot }) => {
    const run = await setup(split, slot, true); run.start(); await run.offline.whenReady();
    expect(run.offline.getStatus()).toMatchObject({ pending: 2, buffered: 1, quotaDrops: 0 });
    expect(run.drops).toEqual([]);
    expect((await run.handles[0]!.loadMeta()).map(meta => meta.logId).sort()).toEqual(['resident-1', 'resident-2']);
    await vi.advanceTimersByTimeAsync(1100); await run.offline.whenReady();
    expect(await run.handles[0]!.get('incoming')).toMatchObject({ priority: 37, notBefore: run.now + 20000,
      serverNotBefore: run.now + 30000, parkCount: 2, lastRetryReason: 'rate-limit' });
    expect(run.offline.getStatus()).toMatchObject({ pending: 3, buffered: 0, quotaDrops: 0 });
    expect(run.drops).toEqual([]);
  });

  it.each(candidates)('preserves successful quota eviction (split=$split, slot=$slot)', async ({ split, slot }) => {
    const run = await setup(split, slot, false); run.start(); await run.offline.whenReady();
    expect(run.drops).toEqual(split ? ['resident-1', 'resident-2'] : ['resident-1']);
    expect(run.offline.getStatus()).toMatchObject({ pending: split ? 1 : 2, buffered: 0, quotaDrops: split ? 2 : 1 });
    expect(await run.handles[0]!.get('incoming')).toMatchObject({ serverNotBefore: run.now + 30000, priority: 37 });
  });

  it('does not transfer a late old recovery failure into a new installation', async () => {
    const run = await setup(true, 2, true, true); run.start(); await run.blocked;
    const oldDone = run.offline.whenReady(); await Promise.resolve();
    run.logger.uninstall('offline-persistence'); run.logger.use(run.offline); await run.offline.whenReady();
    run.release(); await oldDone;
    await vi.advanceTimersByTimeAsync(1500); await run.offline.whenReady();
    expect(run.offline.getStatus()).toMatchObject({ pending: 2, buffered: 0, quotaDrops: 0 });
    expect(await run.handles[1]!.get('incoming')).toBeNull();
    expect(run.drops).toEqual([]);
  });
});
