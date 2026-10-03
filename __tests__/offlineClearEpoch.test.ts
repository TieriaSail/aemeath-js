import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { AemeathLogger } from '../src/core/Logger';
import { OfflinePersistencePlugin } from '../src/plugins/OfflinePersistencePlugin';
import * as storeModule from '../src/plugins/offline/OfflineStore';
import { LogLevel } from '../src/types';

const loggers: AemeathLogger[] = [];
beforeEach(() => { localStorage.clear(); vi.stubGlobal('indexedDB', new IDBFactory()); });
afterEach(() => { loggers.splice(0).forEach(logger => logger.destroy()); vi.unstubAllGlobals(); });
type Backend = 'localstorage' | 'indexeddb';
type Boundary = 'initializing' | 'clear-success' | 'clear-failure';

async function setup(storage: Backend, boundary: Boundary) {
  const create = storeModule.createOfflineStore;
  const handles: storeModule.OfflineStore[] = [];
  let first = true, intercepted = false;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(storeModule, 'createOfflineStore').mockImplementation(async options => {
    const isFirst = first; first = false;
    const store = await create(options); handles.push(store);
    if (!isFirst) return store;
    if (boundary === 'initializing') { entered(); await gate; return store; }
    return { ...store, clear: async () => {
      if (intercepted) return store.clear();
      intercepted = true;
      if (boundary === 'clear-success') await store.clear();
      entered(); await gate;
      if (boundary === 'clear-failure') throw Error('delayed clear failure');
    } };
  });
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  const offline = new OfflinePersistencePlugin({ storage, key: 'clear-epoch', dbName: 'clear-epoch' });
  const persist = async (logId: string) => {
    logger.emit('upload:enqueued', { log: { logId, message: logId, level: LogLevel.ERROR, timestamp: Date.now() }, paused: true, source: 'live' });
    await offline.whenReady();
  };
  logger.use(offline);
  if (boundary !== 'initializing') { await offline.whenReady(); await persist('old-record'); }
  const cleared = offline.clear().then(() => null, (error: unknown) => error);
  await blocked;
  return { logger, offline, persist, cleared, release, store: () => { const matching = handles.filter(handle => handle.backend === storage); return matching[matching.length - 1]!; } };
}

describe('offline clear installation boundary', () => {
  for (const boundary of ['clear-success', 'clear-failure'] as const) {
    it.each(['localstorage', 'indexeddb'] as const)(`late ${boundary} cannot change a new installation (%s)`, async storage => {
      const run = await setup(storage, boundary);
      run.logger.uninstall('offline-persistence'); run.logger.use(run.offline); await run.offline.whenReady();
      await run.persist('new-record');
      run.release(); const outcome = await run.cleared;
      if (boundary === 'clear-failure') expect(outcome).toEqual(Error('delayed clear failure'));
      else expect(outcome).toBeNull();
      expect(run.offline.getStatus().items.map(item => item.logId)).toContain('new-record');
      expect(await run.store().get('new-record')).not.toBeNull();
      // A late error must not disable the new store or silently discard new writes.
      await run.persist('after-clear-return');
      expect(await run.store().get('after-clear-return')).not.toBeNull();
      expect(run.offline.getStatus().pending).toBe(boundary === 'clear-failure' ? 3 : 2);
    });
  }

  it.each(['localstorage', 'indexeddb'] as const)('a clear waiting for old initialization cannot clear a new installation (%s)', async storage => {
    const run = await setup(storage, 'initializing');
    run.logger.uninstall('offline-persistence'); run.logger.use(run.offline); await run.offline.whenReady();
    await run.persist('new-record'); run.release(); expect(await run.cleared).toBeNull();
    expect(run.offline.getStatus()).toMatchObject({ pending: 1 });
    expect(await run.store().get('new-record')).not.toBeNull();
  });

  it.each(['clear-success', 'clear-failure'] as const)('preserves current-installation completion semantics (%s)', async boundary => {
    const run = await setup('localstorage', boundary); run.release(); const outcome = await run.cleared;
    if (boundary === 'clear-failure') {
      expect(outcome).toEqual(Error('delayed clear failure'));
      expect(run.offline.getStatus().pending).toBe(1);
      expect(await run.store().get('old-record')).not.toBeNull();
      await run.offline.clear();
    } else expect(outcome).toBeNull();
    expect(run.offline.getStatus()).toMatchObject({ pending: 0, buffered: 0, bytes: 0 });
    await run.persist('after-current-clear'); expect(await run.store().get('after-current-clear')).not.toBeNull();
  });
});
