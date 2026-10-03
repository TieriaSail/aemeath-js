import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { OfflinePersistencePlugin } from '../src/plugins/OfflinePersistencePlugin';
import { UploadPlugin } from '../src/plugins/UploadPlugin';
import * as storeModule from '../src/plugins/offline/OfflineStore';
import { LogLevel, type LogEntry } from '../src/types';

const loggers: AemeathLogger[] = [];
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => { loggers.splice(0).forEach(logger => logger.destroy()); vi.useRealTimers(); });
type Fault = 'quota' | 'permanent' | 'retry-quota' | 'retry-permanent' | 'recovery-return' | 'preflight-return';
async function setup(split: boolean, fault: Fault = 'quota') {
  const create = storeModule.createOfflineStore;
  let release!: () => void, entered!: () => void, writes = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async options => {
    const store = await create(options);
    return { ...store, put: async record => {
      if (record.logId === 'finished') {
        writes++;
        if ((fault.startsWith('retry') || fault === 'recovery-return') && writes === 1) throw new DOMException('quota', 'QuotaExceededError');
        if (!fault.endsWith('return') && writes === (fault.startsWith('retry') ? 2 : 1)) {
          entered(); await gate;
          throw new DOMException('delayed storage failure', fault.endsWith('permanent') ? 'DataCloneError' : 'QuotaExceededError');
        }
      }
      await store.put(record);
    }, delete: async id => {
      await store.delete(id);
      if (fault.endsWith('return') && id === 'resident-1') { entered(); await gate; }
    } };
  });
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  const key = 'terminal-quota';
  const offline = new OfflinePersistencePlugin({ storage: 'localstorage', key, maxEntries: fault === 'preflight-return' ? 2 : 10 });
  logger.use(offline); await offline.whenReady();
  const drops: Array<{ id: string; reason: string }> = [];
  logger.on('upload:drop', value => { const e = value as { log: LogEntry; reason: string }; drops.push({ id: e.log.logId, reason: e.reason }); });
  for (const index of [1, 2]) {
    const log: LogEntry = { logId: `resident-${index}`, message: 'still needs delivery', timestamp: Date.now(), level: LogLevel.ERROR,
      ...(split ? { tags: { splitId: 'resident-group', splitIndex: index, splitTotal: 2 } } : {}) };
    logger.emit('upload:enqueued', { log, paused: true, source: 'live' }); await offline.whenReady();
  }
  const log: LogEntry = { logId: 'finished', message: 'already terminal', timestamp: Date.now(), level: LogLevel.ERROR };
  logger.emit('upload:enqueued', { log, paused: true, source: 'live' }); await blocked;
  const done = offline.whenReady(); await Promise.resolve();
  const residentIds = () => JSON.parse(localStorage.getItem(`${key}:index`) ?? '[]').map((meta: { logId: string }) => meta.logId).sort() as string[];
  return { logger, offline, log, drops, release, done, residentIds, writes: () => writes };
}
async function settle(run: Awaited<ReturnType<typeof setup>>) { run.release(); await run.done; await run.offline.whenReady(); }
async function delivered(run: Awaited<ReturnType<typeof setup>>) {
  const ids: string[] = [];
  const upload = new UploadPlugin({ onUpload: async log => { ids.push(log.logId); return { success: true }; },
    cache: { enabled: false }, saveOnUnload: false, queue: { concurrency: 3, deduplicationDelay: 0 } });
  run.logger.use(upload); await run.offline.whenReady(); await vi.advanceTimersByTimeAsync(500); await upload.flush(); await run.offline.whenReady();
  return ids.sort();
}

describe('terminal delivery during quota recovery', () => {
  for (const event of ['success', 'no-retry'] as const) {
    it.each([false, true])(`does not evict healthy residents for a ${event} record (split=%s)`, async split => {
      const run = await setup(split);
      if (event === 'success') run.logger.emit('upload:success', { log: run.log, source: 'live' });
      else run.logger.emit('upload:drop', { log: run.log, source: 'live', reason: 'no-retry' });
      await settle(run);
      expect(run.residentIds()).toEqual(['resident-1', 'resident-2']);
      expect(run.writes()).toBe(1);
      expect(run.drops.filter(drop => drop.reason.startsWith('storage-'))).toEqual([]);
      expect(run.offline.getStatus()).toMatchObject({ pending: 2, quotaDrops: 0 });
      expect(await delivered(run)).toEqual(['resident-1', 'resident-2']);
    });
  }
  it.each(['permanent', 'retry-quota', 'retry-permanent'] as const)('does not report another terminal result after success during %s', async fault => {
    const run = await setup(false, fault); const before = [...run.drops];
    run.logger.emit('upload:success', { log: run.log, source: 'live' }); await settle(run);
    expect(run.drops).toEqual(before);
    expect(run.residentIds()).toEqual(fault.startsWith('retry') ? ['resident-2'] : ['resident-1', 'resident-2']);
  });
  it.each(['recovery-return', 'preflight-return'] as const)('stops writing after success while awaiting %s', async fault => {
    const run = await setup(false, fault);
    run.logger.emit('upload:success', { log: run.log, source: 'live' }); await settle(run);
    // The first victim was already deleted; do not undo that transaction, but
    // the finished incoming record must not start another write afterwards.
    expect(run.writes()).toBe(fault === 'recovery-return' ? 1 : 0);
    expect(run.residentIds()).toEqual(['resident-2']);
    expect(await delivered(run)).toEqual(['resident-2']);
  });
  it.each([false, true])('preserves ordinary quota eviction and retry (split=%s)', async split => {
    const run = await setup(split); await settle(run);
    expect(run.residentIds()).toEqual(split ? ['finished'] : ['finished', 'resident-2']);
    expect(run.writes()).toBe(2);
    expect(run.offline.getStatus().quotaDrops).toBe(split ? 2 : 1);
    expect(await delivered(run)).toEqual(split ? ['finished'] : ['finished', 'resident-2']);
  });
});
