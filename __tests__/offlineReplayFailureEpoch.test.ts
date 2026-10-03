import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { OfflinePersistencePlugin, OFFLINE_REPLAY_SOURCE } from '../src/plugins/OfflinePersistencePlugin';
import * as storeModule from '../src/plugins/offline/OfflineStore';
import { LogLevel, type LogEntry } from '../src/types';

const loggers: AemeathLogger[] = [];
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => { loggers.splice(0).forEach(logger => logger.destroy()); vi.useRealTimers(); });
type Boundary = 'get-success' | 'get-failure' | 'put-failure' | 'delete-success';

async function setup(boundary: Boundary, maxReplayAttempts = 3) {
  const create = storeModule.createOfflineStore;
  const handles: storeModule.OfflineStore[] = [];
  let armed = false;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async options => {
    const store = await create(options); handles.push(store);
    if (handles.length !== 1) return store;
    return { ...store,
      get: async id => {
        const record = await store.get(id);
        if (armed && boundary.startsWith('get')) {
          armed = false; entered(); await gate;
          if (boundary === 'get-failure') throw Error('delayed replay get failure');
        }
        return record;
      },
      put: async record => {
        if (armed && boundary === 'put-failure') {
          armed = false; entered(); await gate; throw Error('delayed replay put failure');
        }
        await store.put(record);
      },
      delete: async id => {
        await store.delete(id);
        if (armed && boundary === 'delete-success') { armed = false; entered(); await gate; }
      },
    };
  });
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  const offline = new OfflinePersistencePlugin({ storage: 'localstorage', key: 'replay-failure-epoch', maxReplayAttempts });
  logger.use(offline); await offline.whenReady();
  const log: LogEntry = { logId: 'replay-record', message: 'replay failure', timestamp: Date.now(), level: LogLevel.ERROR };
  logger.emit('upload:enqueued', { log, paused: true, source: 'live' }); await offline.whenReady();
  const giveUps: string[] = [];
  logger.on('upload:drop', value => {
    const event = value as { log: LogEntry; reason: string };
    if (event.reason === 'offline-give-up') giveUps.push(event.log.logId);
  });
  armed = true;
  logger.emit('upload:drop', { log, reason: 'max-retries', source: OFFLINE_REPLAY_SOURCE });
  await blocked;
  const oldDone = offline.whenReady(); await Promise.resolve();
  return { logger, offline, log, handles, release, oldDone, giveUps };
}
async function reinstall(run: Awaited<ReturnType<typeof setup>>) {
  run.logger.uninstall('offline-persistence'); run.logger.use(run.offline); await run.offline.whenReady();
}

describe('offline replay failure installation boundary', () => {
  it.each(['get-success', 'get-failure', 'put-failure'] as const)('stale %s cannot recreate a record delivered after reinstall', async boundary => {
    const run = await setup(boundary); await reinstall(run);
    run.logger.emit('upload:success', { log: run.log, source: OFFLINE_REPLAY_SOURCE }); await run.offline.whenReady();
    expect(await run.handles[1]!.get(run.log.logId)).toBeNull();
    run.release(); await run.oldDone;
    await vi.advanceTimersByTimeAsync(1500); await run.offline.whenReady();
    expect(run.offline.getStatus()).toMatchObject({ pending: 0, buffered: 0, giveUps: 0 });
    expect(await run.handles[1]!.get(run.log.logId)).toBeNull();
    expect(run.giveUps).toEqual([]);
  });

  it('does not apply an old give-up decision after a pending read crosses reinstall', async () => {
    const run = await setup('get-success', 1); await reinstall(run);
    run.release(); await run.oldDone;
    expect(run.offline.getStatus()).toMatchObject({ pending: 1, giveUps: 0 });
    expect(await run.handles[1]!.get(run.log.logId)).toMatchObject({ replayAttempts: 0 });
    expect(run.giveUps).toEqual([]);
  });

  it('does not report an already committed old give-up into the new installation', async () => {
    const run = await setup('delete-success', 1); await reinstall(run);
    run.release(); await run.oldDone;
    expect(run.offline.getStatus()).toMatchObject({ pending: 0, giveUps: 0 });
    expect(await run.handles[1]!.get(run.log.logId)).toBeNull();
    expect(run.giveUps).toEqual([]);
  });

  it.each(['get-failure', 'put-failure'] as const)('retains current-installation replay accounting after %s', async boundary => {
    const run = await setup(boundary); run.release(); await run.oldDone;
    expect(run.offline.getStatus()).toMatchObject({ pending: 1, buffered: 1, giveUps: 0 });
    await vi.advanceTimersByTimeAsync(1500); await run.offline.whenReady();
    expect(run.offline.getStatus()).toMatchObject({ pending: 1, buffered: 0 });
    expect(await run.handles[0]!.get(run.log.logId)).toMatchObject({ replayAttempts: 1 });
  });

  it('still gives up exactly once at the current-installation budget', async () => {
    const run = await setup('get-success', 1); run.release(); await run.oldDone; await run.offline.whenReady();
    expect(run.offline.getStatus()).toMatchObject({ pending: 0, giveUps: 1 });
    expect(await run.handles[0]!.get(run.log.logId)).toBeNull();
    expect(run.giveUps).toEqual([run.log.logId]);
  });
});
