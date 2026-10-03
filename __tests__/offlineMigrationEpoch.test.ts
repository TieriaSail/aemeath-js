import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { AemeathLogger } from '../src/core/Logger';
import { OfflinePersistencePlugin } from '../src/plugins/OfflinePersistencePlugin';
import * as storeModule from '../src/plugins/offline/OfflineStore';
import { LogLevel, type LogEntry } from '../src/types';

const loggers: AemeathLogger[] = [];
const key = 'migration-epoch';
beforeEach(() => { localStorage.clear(); vi.stubGlobal('indexedDB', new IDBFactory()); });
afterEach(() => { loggers.splice(0).forEach(logger => logger.destroy()); vi.unstubAllGlobals(); });
type Boundary = 'fallback-read-success' | 'fallback-read-failure' | 'primary-read-success' | 'primary-read-failure' | 'primary-write-success' | 'primary-write-failure';

async function setup(boundary: Boundary) {
  const now = Date.now();
  const log: LogEntry = { logId: 'migrating', message: 'migrating', level: LogLevel.ERROR, timestamp: now };
  const record: storeModule.OfflineRecord = { logId: log.logId, log, capturedAt: now, storedAt: now, priority: 1,
    bytes: JSON.stringify(log).length, replayAttempts: 0, splitId: null, serverNotBefore: now + 1000 };
  localStorage.setItem(`${key}:index`, JSON.stringify([record]));
  localStorage.setItem(`${key}:r:${log.logId}`, JSON.stringify(record));
  const create = storeModule.createOfflineStore;
  let primaryOpens = 0, gated = false;
  let primary!: storeModule.OfflineStore;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  const fallbackClose = vi.fn();
  vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async options => {
    const isPrimary = options.preference !== 'localstorage';
    if (isPrimary && ++primaryOpens > 1) {
      // The next installation sees IDB unavailable and legitimately uses KV.
      return create({ ...options, preference: 'localstorage' });
    }
    const store = await create(options);
    if (isPrimary) primary = store;
    const prefix = isPrimary ? 'primary' : 'fallback';
    return { ...store,
      get: async id => {
        const value = await store.get(id);
        if (!gated && boundary.startsWith(`${prefix}-read`)) {
          gated = true; entered(); await gate;
          if (boundary.endsWith('failure')) throw Error('delayed migration read failure');
        }
        return value;
      },
      put: async value => {
        if (isPrimary && !gated && boundary.startsWith('primary-write')) {
          gated = true;
          if (boundary.endsWith('success')) await store.put(value);
          entered(); await gate;
          if (boundary.endsWith('failure')) throw Error('delayed migration write failure');
          return;
        }
        await store.put(value);
      },
      close: () => { if (!isPrimary) fallbackClose(); store.close(); },
    };
  });
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  const unavailable = vi.fn(); logger.on('upload:offline-unavailable', unavailable);
  const offline = new OfflinePersistencePlugin({ storage: 'indexeddb', dbName: key, key });
  logger.use(offline); await blocked;
  const oldReady = offline.whenReady(); await Promise.resolve();
  const persist = async (logId: string) => {
    logger.emit('upload:enqueued', { log: { ...log, logId, message: logId }, source: 'live', paused: true });
    await offline.whenReady();
  };
  return { logger, offline, log, now, release, oldReady, unavailable, fallbackClose, persist, primary: () => primary };
}

describe('offline fallback migration installation boundary', () => {
  it.each(['fallback-read-success', 'fallback-read-failure', 'primary-read-success', 'primary-read-failure', 'primary-write-success', 'primary-write-failure'] as const)(
    'stale %s preserves a new installation using the fallback backend', async boundary => {
      const run = await setup(boundary);
      run.logger.uninstall('offline-persistence'); run.logger.use(run.offline); await run.offline.whenReady();
      expect(run.offline.getStatus().backend).toBe('localstorage');
      run.logger.emit('upload:retry-scheduled', { log: run.log, source: 'live', reason: 'rate-limit', serverNotBefore: run.now + 10000, nextAttemptAt: run.now + 10000 });
      await run.offline.whenReady();
      run.release(); await run.oldReady;
      expect(run.unavailable).not.toHaveBeenCalled();
      expect(JSON.parse(localStorage.getItem(`${key}:r:${run.log.logId}`)!)).toMatchObject({ serverNotBefore: run.now + 10000 });
      await run.persist('after-old-migration');
      expect(localStorage.getItem(`${key}:r:after-old-migration`)).not.toBeNull();
      expect(run.offline.getStatus()).toMatchObject({ pending: 2, buffered: 0 });
      expect(run.fallbackClose).toHaveBeenCalledOnce();
    },
  );

  it('still migrates after a delayed read in the current installation', async () => {
    const run = await setup('fallback-read-success'); run.release(); await run.oldReady;
    expect(run.offline.getStatus()).toMatchObject({ backend: 'indexeddb', pending: 1 });
    expect(await run.primary().get(run.log.logId)).toMatchObject({ log: run.log, serverNotBefore: run.now + 1000 });
    expect(localStorage.getItem(`${key}:r:${run.log.logId}`)).toBeNull();
    expect(run.unavailable).not.toHaveBeenCalled(); expect(run.fallbackClose).toHaveBeenCalledOnce();
  });

  it('retains the source and reports a current-installation migration write failure', async () => {
    const run = await setup('primary-write-failure'); run.release(); await run.oldReady;
    expect(localStorage.getItem(`${key}:r:${run.log.logId}`)).not.toBeNull();
    expect(await run.primary().get(run.log.logId)).toBeNull();
    expect(run.unavailable).toHaveBeenCalledOnce(); expect(run.fallbackClose).toHaveBeenCalledOnce();
  });
});
