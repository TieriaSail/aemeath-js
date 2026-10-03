import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { OfflinePersistencePlugin } from '../src/plugins/OfflinePersistencePlugin';
import { UploadPlugin } from '../src/plugins/UploadPlugin';
import * as storeModule from '../src/plugins/offline/OfflineStore';
import { LogLevel, type LogEntry } from '../src/types';

const loggers: AemeathLogger[] = [];
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => { loggers.splice(0).forEach(logger => logger.destroy()); vi.useRealTimers(); });
function makeUpload() {
  const onUpload = vi.fn(async (_log: LogEntry) => ({ success: true }));
  const upload = new UploadPlugin({ onUpload, cache: { enabled: false }, saveOnUnload: false,
    queue: { concurrency: 3, deduplicationDelay: 0 } });
  return { upload, onUpload };
}
async function setup(split = false, count = split ? 2 : 1) {
  const create = storeModule.createOfflineStore;
  let armed = false;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async options => {
    const store = await create(options);
    return { ...store, get: async id => {
      const record = await store.get(id);
      if (armed && id === `admission-${count}`) { armed = false; entered(); await gate; }
      return record;
    } };
  });
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  const offline = new OfflinePersistencePlugin({ storage: 'localstorage', key: 'replay-admission' });
  logger.use(offline); await offline.whenReady();
  const logs: LogEntry[] = Array.from({ length: count }, (_, i) => ({
    logId: `admission-${i + 1}`, message: `admission-${i + 1}`, level: LogLevel.ERROR, timestamp: Date.now(),
    ...(split ? { tags: { splitId: 'admission-group', splitIndex: i + 1, splitTotal: count } } : {}),
  }));
  for (const log of logs) { logger.emit('upload:enqueued', { log, paused: true, source: 'live' }); await offline.whenReady(); }
  const { upload, onUpload } = makeUpload();
  armed = true; logger.use(upload); await blocked;
  const scanning = offline.whenReady(); await Promise.resolve();
  return { logger, offline, logs, upload, onUpload, release, scanning };
}
async function finish(run: Awaited<ReturnType<typeof setup>>, upload = run.upload) {
  run.release(); await run.scanning; await run.offline.whenReady();
  await vi.advanceTimersByTimeAsync(300); await upload.flush(); await run.offline.whenReady();
}

describe('offline replay admission after asynchronous reads', () => {
  for (const event of ['success', 'permanent-drop']) {
    it.each([false, true])(`does not replay a group made terminal during reading (${event}, split=%s)`, async split => {
      const run = await setup(split);
      if (event === 'success') run.logger.emit('upload:success', { log: run.logs[0]!, source: 'live' });
      else run.logger.emit('upload:drop', { log: run.logs[0]!, source: 'live', reason: 'no-retry' });
      await finish(run);
      expect(run.onUpload).not.toHaveBeenCalled();
      expect(run.upload.getQueueStatus()).toMatchObject({ length: 0, inFlight: 0, admitting: 0 });
    });
  }

  it('rechecks an earlier candidate when delivery occurs during a later group read', async () => {
    const run = await setup(false, 2);
    run.logger.emit('upload:success', { log: run.logs[0]!, source: 'live' });
    await finish(run);
    expect(run.onUpload.mock.calls.map(([log]) => log.logId)).toEqual(['admission-2']);
  });

  it('hands pending records to a replacement upload plugin without reserving them for the old one', async () => {
    const run = await setup(false, 2); const oldRequeue = vi.spyOn(run.upload, 'requeue');
    run.logger.uninstall('upload'); const replacement = makeUpload(); run.logger.use(replacement.upload);
    await finish(run, replacement.upload);
    expect(oldRequeue).not.toHaveBeenCalled();
    expect(run.onUpload).not.toHaveBeenCalled();
    expect(replacement.onUpload.mock.calls.map(([log]) => log.logId)).toEqual(['admission-1', 'admission-2']);
  });

  it('does not leave replay reservations after upload is uninstalled during reading', async () => {
    const run = await setup(); run.logger.uninstall('upload'); await finish(run);
    expect(run.offline.getStatus()).toMatchObject({ pending: 1, replaying: 0 });
    const replacement = makeUpload(); run.logger.use(replacement.upload); await run.offline.whenReady();
    await vi.advanceTimersByTimeAsync(300); await replacement.upload.flush();
    expect(replacement.onUpload).toHaveBeenCalledOnce();
  });

  it.each([false, true])('continues normal delayed replay (split=%s)', async split => {
    const run = await setup(split); await finish(run);
    expect(run.onUpload.mock.calls.map(([log]) => log.logId)).toEqual(run.logs.map(log => log.logId));
    expect(run.offline.getStatus()).toMatchObject({ pending: 0, replaying: 0 });
  });
});
