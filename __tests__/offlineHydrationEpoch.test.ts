import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { OfflinePersistencePlugin } from '../src/plugins/OfflinePersistencePlugin';
import * as storeModule from '../src/plugins/offline/OfflineStore';
import { LogLevel, type LogEntry } from '../src/types';

const loggers: AemeathLogger[] = [];
const key = 'hydration-epoch';
beforeEach(() => { localStorage.clear(); });
afterEach(() => { loggers.splice(0).forEach(logger => logger.destroy()); });
type Boundary = 'meta-failure' | 'empty-meta-success' | 'cleanup-success' | 'read-success' | 'read-failure' | 'write-success' | 'write-failure';

async function setup(boundary: Boundary) {
  const now = Date.now();
  const log: LogEntry = { logId: 'legacy', message: 'legacy', level: LogLevel.ERROR, timestamp: now,
    tags: { splitId: 'business-only' } };
  const record: storeModule.OfflineRecord = { logId: log.logId, log, capturedAt: now, storedAt: now, priority: 1,
    bytes: JSON.stringify(log).length, replayAttempts: 0, splitId: 'business-only', serverNotBefore: now + 1000 };
  if (boundary !== 'empty-meta-success') {
    localStorage.setItem(`${key}:index`, JSON.stringify([record]));
    localStorage.setItem(`${key}:r:${log.logId}`, JSON.stringify(record));
  }
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  const unavailable = vi.fn(); logger.on('upload:offline-unavailable', unavailable);
  const create = storeModule.createOfflineStore;
  const handles: storeModule.OfflineStore[] = [];
  let gated = false, release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  const delay = async () => { gated = true; entered(); await gate; };
  vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async options => {
    const store = await create(options); handles.push(store);
    if (handles.length !== 1) {
      return boundary === 'empty-meta-success'
        ? { ...store, loadMeta: async () => { throw Error('new installation scan failed'); } }
        : store;
    }
    return { ...store,
      loadMeta: async () => {
        if (boundary === 'cleanup-success') {
          logger.emit('upload:success', { log, source: 'live' });
          throw Error('old installation scan failed before terminal cleanup');
        }
        const metas = await store.loadMeta();
        if (boundary === 'meta-failure' || boundary === 'empty-meta-success') {
          await delay();
          if (boundary === 'meta-failure') throw Error('delayed scan failure');
        }
        return metas;
      },
      get: async id => {
        const value = await store.get(id);
        if (!gated && boundary.startsWith('read')) {
          await delay();
          if (boundary === 'read-failure') throw Error('delayed legacy read failure');
        }
        return value;
      },
      put: async value => {
        if (!gated && boundary.startsWith('write')) {
          if (boundary === 'write-success') await store.put(value);
          await delay();
          if (boundary === 'write-failure') throw Error('delayed legacy write failure');
          return;
        }
        await store.put(value);
      },
      delete: async id => { await store.delete(id); if (!gated && boundary === 'cleanup-success') await delay(); },
    };
  });
  const offline = new OfflinePersistencePlugin({ storage: 'localstorage', key });
  logger.use(offline); await blocked;
  const oldReady = offline.whenReady(); await Promise.resolve();
  const persist = async (logId: string) => {
    logger.emit('upload:enqueued', { log: { ...log, logId, message: logId }, source: 'live', paused: true });
    await offline.whenReady();
  };
  return { logger, offline, log, now, release, oldReady, unavailable, handles, persist };
}

describe('offline hydration installation boundary', () => {
  it.each(['meta-failure', 'cleanup-success', 'read-success', 'read-failure', 'write-success', 'write-failure'] as const)(
    'stale %s cannot overwrite or disable a healthy new installation', async boundary => {
      const run = await setup(boundary);
      run.logger.uninstall('offline-persistence'); run.logger.use(run.offline); await run.offline.whenReady();
      if (boundary !== 'cleanup-success') {
        run.logger.emit('upload:retry-scheduled', { log: run.log, source: 'live', reason: 'rate-limit', serverNotBefore: run.now + 10000, nextAttemptAt: run.now + 10000 });
        await run.offline.whenReady();
      }
      await run.persist('new-record');
      const expected = run.offline.getStatus();
      run.release(); await run.oldReady;
      expect(run.unavailable).not.toHaveBeenCalled();
      expect(run.offline.getStatus()).toMatchObject({ pending: expected.pending, bytes: expected.bytes, buffered: 0 });
      if (boundary !== 'cleanup-success') {
        expect(await run.handles[1]!.get('legacy')).toMatchObject({ splitId: null, serverNotBefore: run.now + 10000 });
      }
      await run.persist('after-old-hydration');
      expect(await run.handles[1]!.get('after-old-hydration')).not.toBeNull();
      expect(run.offline.getStatus().pending).toBe(expected.pending + 1);
    },
  );

  it('old empty scan cannot re-enable writes after a new scan failed', async () => {
    const run = await setup('empty-meta-success');
    run.logger.uninstall('offline-persistence'); run.logger.use(run.offline); await run.offline.whenReady();
    expect(run.unavailable).toHaveBeenCalledOnce();
    run.release(); await run.oldReady;
    await run.persist('must-not-write');
    expect(await run.handles[1]!.get('must-not-write')).toBeNull();
    expect(run.offline.getStatus().pending).toBe(0);
    expect(run.unavailable).toHaveBeenCalledOnce();
  });

  it.each(['meta-failure', 'read-success', 'read-failure', 'write-success', 'write-failure'] as const)(
    'preserves current-installation hydration behavior for %s', async boundary => {
      const run = await setup(boundary); run.release(); await run.oldReady;
      await run.persist('after-current-hydration');
      if (boundary.endsWith('success')) {
        expect(run.unavailable).not.toHaveBeenCalled();
        expect(await run.handles[0]!.get('legacy')).toMatchObject({ splitId: null });
        expect(run.offline.getStatus().pending).toBe(2);
      } else {
        expect(run.unavailable).toHaveBeenCalledOnce();
        expect(run.offline.getStatus()).toMatchObject({ pending: 0, buffered: 0 });
        expect(await run.handles[0]!.get('after-current-hydration')).toBeNull();
        expect(await run.handles[0]!.get('legacy')).not.toBeNull();
      }
    },
  );
});
