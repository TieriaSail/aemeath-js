import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { OfflinePersistencePlugin, OFFLINE_REPLAY_SOURCE } from '../src/plugins/OfflinePersistencePlugin';
import { UploadPlugin } from '../src/plugins/UploadPlugin';
import * as storeModule from '../src/plugins/offline/OfflineStore';
import { LogLevel, type LogEntry } from '../src/types';

const loggers: AemeathLogger[] = [];
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => { loggers.splice(0).forEach(logger => logger.destroy()); vi.useRealTimers(); });

async function setup(limit: number) {
  const create = storeModule.createOfflineStore;
  let failReads = 0;
  vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async options => {
    const store = await create(options);
    return { ...store, get: async id => {
      if (failReads > 0) { failReads--; throw Error('replay accounting read unavailable'); }
      return store.get(id);
    } };
  });
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  const key = 'replay-budget';
  const offline = new OfflinePersistencePlugin({ storage: 'localstorage', key, maxReplayAttempts: limit });
  logger.use(offline); await offline.whenReady();
  const log: LogEntry = { logId: 'budget-record', message: 'bounded replay', timestamp: Date.now(), level: LogLevel.ERROR };
  logger.emit('upload:enqueued', { log, source: 'live', paused: true }); await offline.whenReady();
  const giveUps: string[] = [];
  logger.on('upload:drop', payload => {
    const event = payload as { log: LogEntry; reason: string };
    if (event.reason === 'offline-give-up') giveUps.push(event.log.logId);
  });
  const failReplay = async () => {
    logger.emit('upload:drop', { log, source: OFFLINE_REPLAY_SOURCE, reason: 'max-retries' });
    await offline.whenReady();
  };
  const read = () => JSON.parse(localStorage.getItem(`${key}:r:${log.logId}`) ?? 'null') as storeModule.OfflineRecord | null;
  const connect = async () => {
    const sent: string[] = [];
    const upload = new UploadPlugin({ onUpload: async item => { sent.push(item.logId); return { success: true }; },
      cache: { enabled: false }, saveOnUnload: false, queue: { deduplicationDelay: 0 } });
    logger.use(upload); await offline.whenReady();
    await vi.advanceTimersByTimeAsync(1500); await upload.flush(); await offline.whenReady();
    return sent;
  };
  return { logger, offline, log, giveUps, failReplay, read, connect, fault: (count: number) => { failReads = count; } };
}

describe('offline replay budget during storage read failures', () => {
  for (const limit of [1, 2]) {
    it.each([1, Number.POSITIVE_INFINITY])(`enforces limit ${limit} despite accounting read failures (%s)`, async failures => {
      const run = await setup(limit);
      for (let attempt = 1; attempt < limit; attempt++) await run.failReplay();
      run.fault(failures); await run.failReplay();
      const exhaustedStatus = run.offline.getStatus();
      run.fault(0);
      expect(await run.connect()).toEqual([]);
      expect(exhaustedStatus).toMatchObject({ pending: 0, buffered: 0, giveUps: 1 });
      expect(run.read()).toBeNull();
      expect(run.giveUps).toEqual([run.log.logId]);
    });
  }

  it.each(['no-retry', 'payload-too-large'])('clears buffered retry state on terminal replay drop %s', async reason => {
    const run = await setup(3); run.fault(1);
    run.logger.emit('upload:retry-scheduled', { log: run.log, source: OFFLINE_REPLAY_SOURCE,
      reason: 'server', nextAttemptAt: Date.now() + 10 });
    await run.offline.whenReady();
    expect(run.offline.getStatus().buffered).toBe(1);
    run.logger.emit('upload:drop', { log: run.log, source: OFFLINE_REPLAY_SOURCE, reason });
    await run.offline.whenReady();
    const terminalStatus = run.offline.getStatus();
    expect(await run.connect()).toEqual([]);
    expect(terminalStatus).toMatchObject({ pending: 0, buffered: 0 });
    expect(run.read()).toBeNull();
  });

  it('clears earlier buffered accounting when a later failure exhausts the budget', async () => {
    const run = await setup(2); run.fault(1); await run.failReplay();
    expect(run.offline.getStatus().buffered).toBe(1);
    run.fault(1); await run.failReplay();
    const terminalStatus = run.offline.getStatus();
    expect(await run.connect()).toEqual([]);
    expect(terminalStatus).toMatchObject({ pending: 0, buffered: 0, giveUps: 1 });
    expect(run.giveUps).toEqual([run.log.logId]);
    expect(run.read()).toBeNull();
  });

  it('still recovers and sends when the budget has not been exhausted', async () => {
    const run = await setup(2); run.fault(1); await run.failReplay();
    expect(run.offline.getStatus()).toMatchObject({ pending: 1, buffered: 1, giveUps: 0 });
    await vi.advanceTimersByTimeAsync(1100); await run.offline.whenReady();
    expect(run.read()).toMatchObject({ replayAttempts: 1 });
    expect(await run.connect()).toEqual([run.log.logId]);
    expect(run.giveUps).toEqual([]); expect(run.read()).toBeNull();
  });

  it('preserves ordinary give-up with a readable record', async () => {
    const run = await setup(1); await run.failReplay();
    expect(run.offline.getStatus()).toMatchObject({ pending: 0, buffered: 0, giveUps: 1 });
    expect(run.giveUps).toEqual([run.log.logId]);
    expect(await run.connect()).toEqual([]); expect(run.read()).toBeNull();
  });
});
