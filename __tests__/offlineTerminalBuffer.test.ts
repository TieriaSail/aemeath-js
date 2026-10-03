import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { OfflinePersistencePlugin, OFFLINE_REPLAY_SOURCE } from '../src/plugins/OfflinePersistencePlugin';
import { UploadPlugin } from '../src/plugins/UploadPlugin';
import * as storeModule from '../src/plugins/offline/OfflineStore';
import { LogLevel, type LogEntry } from '../src/types';

const loggers: AemeathLogger[] = [];
const boundaries = ['initial-put', 'state-get', 'state-put', 'accounting-get', 'accounting-put'] as const;
type Boundary = typeof boundaries[number];
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => { loggers.splice(0).forEach(logger => logger.destroy()); vi.useRealTimers(); });

async function setup(boundary: Boundary) {
  const create = storeModule.createOfflineStore;
  let armed = false, release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async options => {
    const store = await create(options);
    const fail = async () => { armed = false; entered(); await gate; throw Error('late transient storage failure'); };
    return { ...store,
      get: async id => { if (armed && boundary.endsWith('get')) await fail(); return store.get(id); },
      put: async record => { if (armed && boundary.endsWith('put')) await fail(); await store.put(record); },
    };
  });
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  const key = 'terminal-buffer';
  const offline = new OfflinePersistencePlugin({ storage: 'localstorage', key, maxReplayAttempts: 3 });
  logger.use(offline); await offline.whenReady();
  const log: LogEntry = { logId: 'terminal-log', message: 'terminal must stay terminal', timestamp: Date.now(), level: LogLevel.ERROR };
  const enqueue = () => logger.emit('upload:enqueued', { log, source: 'live', paused: true });
  if (boundary !== 'initial-put') { enqueue(); await offline.whenReady(); }
  armed = true;
  if (boundary === 'initial-put') enqueue();
  else if (boundary.startsWith('state')) logger.emit('upload:retry-scheduled', {
    log, source: 'live', reason: 'server', nextAttemptAt: Date.now() + 10,
  });
  else logger.emit('upload:drop', { log, source: OFFLINE_REPLAY_SOURCE, reason: 'max-retries' });
  await blocked;
  const done = offline.whenReady(); await Promise.resolve();
  const read = () => JSON.parse(localStorage.getItem(`${key}:r:${log.logId}`) ?? 'null');
  return { logger, offline, log, release, done, read };
}
async function recover(run: Awaited<ReturnType<typeof setup>>) {
  const sent: string[] = [];
  const upload = new UploadPlugin({ onUpload: async log => { sent.push(log.logId); return { success: true }; },
    cache: { enabled: false }, saveOnUnload: false, queue: { concurrency: 3, deduplicationDelay: 0 } });
  run.logger.use(upload); await run.offline.whenReady();
  await vi.advanceTimersByTimeAsync(1500); await upload.flush(); await run.offline.whenReady();
  return sent;
}

describe('terminal delivery while a storage failure is pending', () => {
  for (const event of ['success', 'no-retry'] as const) {
    it.each(boundaries)(`does not resurrect after ${event} during %s`, async boundary => {
      const run = await setup(boundary);
      if (event === 'success') run.logger.emit('upload:success', { log: run.log, source: 'live' });
      else run.logger.emit('upload:drop', { log: run.log, source: OFFLINE_REPLAY_SOURCE, reason: 'no-retry' });
      run.release(); await run.done; await run.offline.whenReady();
      const terminalStatus = run.offline.getStatus();
      expect(await recover(run)).toEqual([]);
      expect(terminalStatus).toMatchObject({ pending: 0, buffered: 0 });
      expect(run.read()).toBeNull();
    });
  }
  it.each(boundaries)('still recovers nonterminal %s failures', async boundary => {
    const run = await setup(boundary); run.release(); await run.done; await run.offline.whenReady();
    expect(run.offline.getStatus().buffered).toBe(1);
    expect(await recover(run)).toEqual([run.log.logId]);
    expect(run.read()).toBeNull();
  });
});
