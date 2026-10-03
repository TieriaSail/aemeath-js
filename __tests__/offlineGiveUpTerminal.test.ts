import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { OfflinePersistencePlugin, OFFLINE_REPLAY_SOURCE } from '../src/plugins/OfflinePersistencePlugin';
import { UploadPlugin } from '../src/plugins/UploadPlugin';
import * as storeModule from '../src/plugins/offline/OfflineStore';
import { LogLevel, type LogEntry } from '../src/types';

const loggers: AemeathLogger[] = [];
const boundaries = ['get-success', 'get-failure', 'delete-success', 'delete-failure'] as const;
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
    return { ...store,
      get: async id => {
        const record = await store.get(id);
        if (armed && boundary.startsWith('get')) {
          armed = false; entered(); await gate;
          if (boundary === 'get-failure') throw Error('delayed accounting read failure');
        }
        return record;
      },
      delete: async id => {
        if (armed && boundary.startsWith('delete')) {
          armed = false;
          if (boundary === 'delete-success') await store.delete(id);
          entered(); await gate;
          if (boundary === 'delete-failure') throw Error('delayed give-up delete failure');
          return;
        }
        await store.delete(id);
      },
    };
  });
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  const key = 'giveup-terminal';
  const offline = new OfflinePersistencePlugin({ storage: 'localstorage', key, maxReplayAttempts: 1 });
  logger.use(offline); await offline.whenReady();
  const log: LogEntry = { logId: 'giveup-log', message: 'only one final result', timestamp: Date.now(), level: LogLevel.ERROR };
  logger.emit('upload:enqueued', { log, source: 'live', paused: true }); await offline.whenReady();
  const reasons: string[] = [];
  logger.on('upload:drop', value => { const event = value as { reason: string }; reasons.push(event.reason); });
  armed = true; logger.emit('upload:drop', { log, source: OFFLINE_REPLAY_SOURCE, reason: 'max-retries' }); await blocked;
  const done = offline.whenReady(); await Promise.resolve();
  const read = () => JSON.parse(localStorage.getItem(`${key}:r:${log.logId}`) ?? 'null');
  return { logger, offline, log, reasons, release, done, read };
}
async function finish(run: Awaited<ReturnType<typeof setup>>) {
  run.release(); await run.done; await run.offline.whenReady();
  await vi.advanceTimersByTimeAsync(1500); await run.offline.whenReady();
  expect(run.read()).toBeNull();
  expect(run.offline.getStatus()).toMatchObject({ pending: 0, buffered: 0, replaying: 0 });
  const onUpload = vi.fn(async () => ({ success: true }));
  const upload = new UploadPlugin({ onUpload, cache: { enabled: false }, saveOnUnload: false,
    queue: { concurrency: 3, deduplicationDelay: 0 } });
  run.logger.use(upload); await run.offline.whenReady(); await vi.advanceTimersByTimeAsync(300); await upload.flush();
  expect(onUpload).not.toHaveBeenCalled();
}

describe('give-up racing with an independent terminal result', () => {
  for (const event of ['success', 'no-retry'] as const) {
    it.each(boundaries)(`does not report give-up after ${event} during %s`, async boundary => {
      const run = await setup(boundary);
      if (event === 'success') run.logger.emit('upload:success', { log: run.log, source: 'live' });
      else run.logger.emit('upload:drop', { log: run.log, source: 'live', reason: 'no-retry' });
      await finish(run);
      expect(run.reasons).toEqual(event === 'success' ? ['max-retries'] : ['max-retries', 'no-retry']);
      expect(run.offline.getStatus().giveUps).toBe(0);
    });
  }
  it.each(boundaries)('still reports normal budget exhaustion once across %s', async boundary => {
    const run = await setup(boundary); await finish(run);
    expect(run.reasons).toEqual(['max-retries', 'offline-give-up']);
    expect(run.offline.getStatus().giveUps).toBe(1);
  });
});
