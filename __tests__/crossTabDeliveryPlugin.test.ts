import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { AemeathLogger } from '../src/core/Logger';
import { createMiniAppAdapter, type MiniAppAPI } from '../src/platform/miniapp';
import { CrossTabDeliveryPlugin } from '../src/plugins/CrossTabDeliveryPlugin';
import { OfflinePersistencePlugin } from '../src/plugins/OfflinePersistencePlugin';
import { purgeBrowserOfflinePersistenceStorage as purgeOfflinePersistenceStorage } from '../src/plugins/offline/BrowserOfflinePersistencePurge';
import { UploadPlugin, type UploadPayload } from '../src/plugins/UploadPlugin';
import { LogLevel } from '../src/types';
import * as rootExports from '../src/index';
import {
  createIndexedDbStore as createLegacyIndexedDbStore,
  type OfflineStore,
} from '../src/plugins/offline/OfflineStore';
import { coordinatedDatabaseName } from '../src/plugins/offline/OfflineProtocol';
import { createOfflineCoordinationStore } from '../src/plugins/offline/OfflineCoordinationStore';
import { createOfflineStore as createCoordinatedOfflineStore } from '../src/plugins/offline/CoordinatedOfflineStore';
import { createBrowserAdapter } from '../src/platform/browser';

describe('CrossTabDeliveryPlugin opt-in boundary', () => {
  beforeEach(() => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it('keeps the default offline plugin on the exact 2.5 IndexedDB protocol', async () => {
    const dbName = `cross-tab-default-${Math.random()}`;
    const logger = new AemeathLogger({ enableConsole: false });
    const upload = new UploadPlugin({
      onUpload: async () => ({ success: true }),
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({
      dbName,
    });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();

    expect(logger.hasPlugin('cross-tab-delivery')).toBe(false);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(db.version).toBe(1);
    expect(Array.from(db.objectStoreNames)).toEqual(['records']);
    db.close();
    logger.destroy();
  });

  it('activates the v2 coordination store only when installed synchronously', async () => {
    const logger = new AemeathLogger({ enableConsole: false });
    const upload = new UploadPlugin({
      onUpload: async () => ({ success: true }),
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({
      dbName: `cross-tab-opt-in-${Math.random()}`,
    });
    const crossTab = new CrossTabDeliveryPlugin();
    logger.use(crossTab);
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();

    await vi.waitFor(() => expect(crossTab.getStatus().state).toBe('active'));
    const internal = offline as unknown as {
      store: OfflineStore;
      options: { namespace: string };
    };
    const coordination = createOfflineCoordinationStore(internal.store);
    await vi.waitFor(async () =>
      expect(
        await coordination.getLeadership(internal.options.namespace),
      ).not.toBeNull(),
    );

    logger.destroy();
  });

  it('keeps v1 reopenable after v2 opt-in and stores coordination in a separate database', async () => {
    const dbName = `cross-tab-generation-${Math.random()}`;
    const logger = new AemeathLogger({ enableConsole: false });
    const crossTab = new CrossTabDeliveryPlugin();
    const offline = new OfflinePersistencePlugin({ dbName });
    logger.use(crossTab);
    logger.use(
      new UploadPlugin({
        onUpload: async () => ({ success: true }),
        cache: { enabled: false },
        saveOnUnload: false,
      }),
    );
    logger.use(offline);
    await offline.whenReady();
    await vi.waitFor(() => expect(crossTab.getStatus().state).toBe('active'));

    const coordinatedDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(coordinatedDatabaseName(dbName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(coordinatedDb.version).toBe(2);
    coordinatedDb.close();
    logger.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const legacy = await createLegacyIndexedDbStore(dbName);
    expect(legacy.backend).toBe('indexeddb');
    const v1Db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(v1Db.version).toBe(1);
    expect(Array.from(v1Db.objectStoreNames)).toEqual(['records']);
    v1Db.close();
    legacy.close();
  });

  it('serializes quick uninstall and remount of the same plugin instance', async () => {
    const logger = new AemeathLogger({ enableConsole: false });
    const crossTab = new CrossTabDeliveryPlugin();
    const offline = new OfflinePersistencePlugin({
      dbName: `cross-tab-remount-${Math.random()}`,
    });
    logger.use(crossTab);
    logger.use(
      new UploadPlugin({
        onUpload: async () => ({ success: true }),
        cache: { enabled: false },
        saveOnUnload: false,
      }),
    );
    logger.use(offline);
    await offline.whenReady();
    await vi.waitFor(() => expect(crossTab.getStatus().state).toBe('active'));

    expect(logger.uninstall('cross-tab-delivery')).toBe(true);
    logger.use(crossTab);
    await vi.waitFor(() => expect(crossTab.getStatus().state).toBe('active'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(crossTab.getStatus().state).toBe('active');
    logger.destroy();
  });

  it('atomically detaches a replaced UploadPlugin and lets the new instance reclaim an idle receipt', async () => {
    const logger = new AemeathLogger({ enableConsole: false });
    const crossTab = new CrossTabDeliveryPlugin();
    const firstUploadFn = vi.fn(async () => ({ success: true }));
    const firstUpload = new UploadPlugin({
      onUpload: firstUploadFn,
      queue: { deduplicationDelay: 1_000 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    // Hold the network consumer while allowing the durable coordinator to
    // dispatch a claimed receipt into Upload's queue.
    (firstUpload as unknown as { callbackPaused: boolean }).callbackPaused =
      true;
    const offline = new OfflinePersistencePlugin({
      dbName: `cross-tab-upload-replace-${Math.random()}`,
    });
    logger.use(crossTab);
    logger.use(firstUpload);
    logger.use(offline);
    await offline.whenReady();
    await vi.waitFor(() => expect(crossTab.getStatus().state).toBe('active'));

    const now = Date.now();
    await (
      offline as unknown as {
        persist(log: {
          logId: string;
          level: 'error';
          message: string;
          timestamp: number;
        }): Promise<void>;
      }
    ).persist({
      logId: 'upload-replacement',
      level: 'error',
      message: 'must move to the replacement UploadPlugin',
      timestamp: now,
    });
    (
      crossTab as unknown as {
        coordinator: { wake(reason?: string): void } | null;
      }
    ).coordinator?.wake('test-record');
    await vi.waitFor(() =>
      expect(firstUpload.getQueueStatus().length).toBe(1),
    );
    expect(firstUploadFn).not.toHaveBeenCalled();

    expect(logger.uninstall('upload')).toBe(true);
    const replacementFn = vi.fn(async (_payload: UploadPayload) => ({
      success: true,
    }));
    const replacement = new UploadPlugin({
      onUpload: replacementFn,
      queue: { deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(replacement);

    await vi.waitFor(() => expect(crossTab.getStatus().state).toBe('active'));
    await vi.waitFor(() => expect(replacementFn).toHaveBeenCalledTimes(1));
    expect(replacementFn.mock.calls[0]?.[0]).toMatchObject({
      logId: 'upload-replacement',
      deliveryAttempt: 1,
    });
    expect(firstUploadFn).not.toHaveBeenCalled();
    logger.destroy();
  });

  it('keeps v2 recovery dormant after CrossTab uninstall and never starts legacy replay', async () => {
    const logger = new AemeathLogger({ enableConsole: false });
    const crossTab = new CrossTabDeliveryPlugin();
    const uploadFn = vi.fn(async () => ({ success: true }));
    const upload = new UploadPlugin({
      onUpload: uploadFn,
      queue: { deduplicationDelay: 1_000 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    (upload as unknown as { callbackPaused: boolean }).callbackPaused = true;
    const offline = new OfflinePersistencePlugin({
      dbName: `cross-tab-fail-closed-${Math.random()}`,
    });
    logger.use(crossTab);
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();
    await vi.waitFor(() => expect(crossTab.getStatus().state).toBe('active'));

    const now = Date.now();
    const internal = offline as unknown as {
      store: OfflineStore;
      persist(log: {
        logId: string;
        level: 'error';
        message: string;
        timestamp: number;
      }): Promise<void>;
    };
    await internal.persist({
      logId: 'dormant-after-uninstall',
      level: 'error',
      message: 'v2 must remain the only owner',
      timestamp: now,
    });
    (
      crossTab as unknown as {
        coordinator: { wake(reason?: string): void } | null;
      }
    ).coordinator?.wake('test-record');
    await vi.waitFor(() => expect(upload.getQueueStatus().length).toBe(1));

    expect(logger.uninstall('cross-tab-delivery')).toBe(true);
    (upload as unknown as { callbackPaused: boolean }).callbackPaused = false;
    await vi.waitFor(() =>
      expect(internal.store.get('dormant-after-uninstall')).resolves.toMatchObject({
        state: 'pending',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(uploadFn).not.toHaveBeenCalled();

    logger.use(crossTab);
    await vi.waitFor(() => expect(crossTab.getStatus().state).toBe('active'));
    await vi.waitFor(() => expect(uploadFn).toHaveBeenCalledTimes(1));
    logger.destroy();
  });

  it('does not expose a fresh split until the whole group commits atomically', async () => {
    const logger = new AemeathLogger({ enableConsole: false });
    const crossTab = new CrossTabDeliveryPlugin();
    const offline = new OfflinePersistencePlugin({
      dbName: `cross-tab-atomic-split-${Math.random()}`,
    });
    logger.use(crossTab);
    logger.use(
      new UploadPlugin({
        onUpload: async () => ({ success: true }),
        cache: { enabled: false },
        saveOnUnload: false,
      }),
    );
    logger.use(offline);
    await offline.whenReady();
    await vi.waitFor(() => expect(crossTab.getStatus().state).toBe('active'));
    const internal = offline as unknown as {
      store: OfflineStore;
      epoch: number;
      persist(log: {
        logId: string;
        level: 'error';
        message: string;
        timestamp: number;
        tags: Record<string, unknown>;
      }): Promise<void>;
    };
    const now = Date.now();
    const first = {
      logId: 'atomic-split-1',
      level: 'error' as const,
      message: 'part 1',
      timestamp: now,
      tags: { splitId: 'atomic-split', splitIndex: 1, splitTotal: 2 },
    };
    const second = {
      logId: 'atomic-split-2',
      level: 'error' as const,
      message: 'part 2',
      timestamp: now,
      tags: { splitId: 'atomic-split', splitIndex: 2, splitTotal: 2 },
    };

    await internal.persist(first);
    await expect(internal.store.get(first.logId)).resolves.toBeNull();
    await internal.persist(second);
    await expect(internal.store.get(first.logId)).resolves.not.toBeNull();
    await expect(internal.store.get(second.logId)).resolves.not.toBeNull();
    logger.destroy();
  });

  it('hands restored Upload cache to the coordinator before the first network call', async () => {
    const cacheKey = `cross-tab-cache-${Math.random()}`;
    const now = Date.now();
    localStorage.setItem(
      cacheKey,
      JSON.stringify([
        {
          log: {
            logId: 'coordinated-cache-log',
            level: LogLevel.ERROR,
            message: 'coordinated cache',
            timestamp: now,
          },
          priority: 100,
          retryCount: 0,
          timestamp: now,
          cachedAt: now,
          source: 'live',
        },
      ]),
    );
    const uploadFn = vi.fn(async (_log: unknown) => ({ success: true }));
    const logger = new AemeathLogger({ enableConsole: false });
    const upload = new UploadPlugin({
      onUpload: uploadFn,
      queue: { deduplicationDelay: 0 },
      cache: { enabled: true, key: cacheKey },
      saveOnUnload: false,
    });
    const beginTransfer = vi.spyOn(upload, 'beginRecoveryCacheTransfer');
    const offline = new OfflinePersistencePlugin({
      dbName: `cross-tab-cache-db-${Math.random()}`,
    });
    const crossTab = new CrossTabDeliveryPlugin();

    logger.use(crossTab);
    logger.use(upload);
    expect(
      (
        upload as unknown as {
          queue: Array<{ log: { logId: string }; restoredFromCache?: boolean }>;
        }
      ).queue,
    ).toEqual([
      expect.objectContaining({
        log: expect.objectContaining({ logId: 'coordinated-cache-log' }),
        restoredFromCache: true,
      }),
    ]);
    logger.use(offline);
    await offline.whenReady();
    await vi.waitFor(() => expect(crossTab.getStatus().state).toBe('active'));
    await vi.waitFor(() => expect(uploadFn).toHaveBeenCalledTimes(1));

    expect(beginTransfer).toHaveBeenCalledTimes(1);
    expect(beginTransfer.mock.results[0]?.value).toHaveLength(1);
    expect(uploadFn.mock.calls[0]?.[0]).toMatchObject({
      logId: 'coordinated-cache-log',
      deliveryAttempt: 1,
    });
    logger.destroy();
    localStorage.removeItem(cacheKey);
  });

  it('is browser-only and becomes an inert unsupported plugin on miniapp adapters', async () => {
    const values = new Map<string, string>();
    const api: MiniAppAPI = {
      getStorageSync: (key) => values.get(key) ?? '',
      setStorageSync: (key, value) => {
        values.set(key, value);
      },
      removeStorageSync: (key) => {
        values.delete(key);
      },
    };
    const logger = new AemeathLogger({
      enableConsole: false,
      platform: createMiniAppAdapter('wechat', api),
    });
    const crossTab = new CrossTabDeliveryPlugin();
    logger.use(crossTab);
    await vi.waitFor(() =>
      expect(crossTab.getStatus()).toMatchObject({
        state: 'unsupported',
        mode: 'disabled',
        degradedReason: 'browser-only',
      }),
    );
    logger.destroy();
  });

  it('falls all the way back to the 2.5 KV protocol when IndexedDB is unavailable', async () => {
    const keyPrefix = `cross-tab-kv-fallback-${Math.random()}`;
    vi.stubGlobal('indexedDB', undefined);
    let store: Awaited<
      ReturnType<typeof createCoordinatedOfflineStore>
    > | null = null;
    try {
      store = await createCoordinatedOfflineStore({
        preference: 'auto',
        platform: createBrowserAdapter(),
        dbName: `cross-tab-kv-db-${Math.random()}`,
        keyPrefix,
        namespace: 'custom-project',
      });
      expect(store.backend).toBe('localstorage');
      expect(localStorage.getItem(`${keyPrefix}:namespace-v2`)).toBeNull();
    } finally {
      store?.close();
      vi.unstubAllGlobals();
      localStorage.removeItem(`${keyPrefix}:index`);
      localStorage.removeItem(`${keyPrefix}:namespace-v2`);
    }
  });

  it('uses the complete 2.5 persistence path after the opt-in store falls back to KV', async () => {
    const key = `cross-tab-kv-runtime-${Math.random()}`;
    vi.stubGlobal('indexedDB', undefined);
    const logger = new AemeathLogger({ enableConsole: false });
    const drops: Array<{ reason?: string }> = [];
    logger.on('upload:drop', (payload) => drops.push(payload));
    const crossTab = new CrossTabDeliveryPlugin();
    const offline = new OfflinePersistencePlugin({
      storage: 'auto',
      dbName: `cross-tab-kv-runtime-db-${Math.random()}`,
      key,
    });
    try {
      logger.use(crossTab);
      logger.use(
        new UploadPlugin({
          onUpload: () => new Promise(() => undefined),
          cache: { enabled: false },
          saveOnUnload: false,
        }),
      );
      logger.use(offline);
      await offline.whenReady();
      await vi.waitFor(() =>
        expect(crossTab.getStatus().state).toBe('unsupported'),
      );

      const internal = offline as unknown as {
        store: OfflineStore;
        crossTabStoreActive: boolean;
        persist(log: {
          logId: string;
          level: 'error';
          message: string;
          timestamp: number;
          tags: Record<string, unknown>;
        }): Promise<void>;
      };
      expect(internal.crossTabStoreActive).toBe(false);
      expect(internal.store.backend).toBe('localstorage');
      const now = Date.now();
      await internal.persist({
        logId: 'kv-split-1',
        level: 'error',
        message: 'part 1',
        timestamp: now,
        tags: { splitId: 'kv-split', splitIndex: 1, splitTotal: 2 },
      });
      await internal.persist({
        logId: 'kv-split-2',
        level: 'error',
        message: 'part 2',
        timestamp: now,
        tags: { splitId: 'kv-split', splitIndex: 2, splitTotal: 2 },
      });

      await expect(internal.store.get('kv-split-1')).resolves.not.toBeNull();
      await expect(internal.store.get('kv-split-2')).resolves.not.toBeNull();
      expect(
        drops.filter((drop) => drop.reason === 'storage-rejected'),
      ).toEqual([]);
    } finally {
      logger.destroy();
      vi.unstubAllGlobals();
      localStorage.removeItem(`${key}:index`);
      localStorage.removeItem(`${key}:record:kv-split-1`);
      localStorage.removeItem(`${key}:record:kv-split-2`);
    }
  });

  it('returns restored Upload cache ownership before sending when IndexedDB is unavailable', async () => {
    const cacheKey = `cross-tab-kv-cache-${Math.random()}`;
    const now = Date.now();
    localStorage.setItem(
      cacheKey,
      JSON.stringify([
        {
          log: {
            logId: 'kv-restored-cache',
            level: LogLevel.ERROR,
            message: 'must return to upload',
            timestamp: now,
          },
          priority: 100,
          retryCount: 0,
          timestamp: now,
          cachedAt: now,
        },
      ]),
    );
    vi.stubGlobal('indexedDB', undefined);
    const onUpload = vi.fn(async (_log: unknown) => ({ success: true }));
    const logger = new AemeathLogger({ enableConsole: false });
    const crossTab = new CrossTabDeliveryPlugin();
    const offline = new OfflinePersistencePlugin({
      key: `cross-tab-kv-cache-store-${Math.random()}`,
    });
    try {
      logger.use(crossTab);
      logger.use(
        new UploadPlugin({
          onUpload,
          queue: { deduplicationDelay: 0 },
          cache: { enabled: true, key: cacheKey },
          saveOnUnload: false,
        }),
      );
      logger.use(offline);
      await offline.whenReady();
      await vi.waitFor(() =>
        expect(crossTab.getStatus().state).toBe('unsupported'),
      );
      await vi.waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1));
      expect(onUpload.mock.calls[0]?.[0]).toMatchObject({
        logId: 'kv-restored-cache',
      });
      expect(onUpload.mock.calls[0]?.[0]).not.toHaveProperty('deliveryAttempt');
    } finally {
      logger.destroy();
      vi.unstubAllGlobals();
      localStorage.removeItem(cacheKey);
    }
  });

  it('never deletes an expired record during hydrate while another tab owns a live lease', async () => {
    const dbName = `cross-tab-live-lease-${Math.random()}`;
    const keyPrefix = '__aemeath_offline__';
    const namespace = `${dbName}:${keyPrefix}`;
    const now = Date.now();
    const setupStore = await createCoordinatedOfflineStore({
      preference: 'indexeddb',
      platform: createBrowserAdapter(),
      dbName,
      keyPrefix,
      namespace,
      allowFallback: false,
    });
    await setupStore.put({
      logId: 'live-leased-expired',
      storedAt: now - 60_000,
      capturedAt: now - 60_000,
      priority: 1,
      bytes: 100,
      replayAttempts: 0,
      log: {
        logId: 'live-leased-expired',
        level: LogLevel.ERROR,
        message: 'must survive hydrate',
        timestamp: now - 60_000,
      },
    });
    const setupCoordination = createOfflineCoordinationStore(setupStore);
    const leader = await setupCoordination.tryAcquireLeadership({
      namespace,
      ownerId: 'other-tab',
      now,
      leaseMs: 60_000,
    });
    expect(leader).not.toBeNull();
    const claim = await setupCoordination.claimBatch({
      namespace,
      ownerId: 'other-tab',
      epoch: leader!.epoch,
      now,
      leaseMs: 60_000,
      limit: 1,
      candidateGroups: [['live-leased-expired']],
    });
    expect(claim.status).toBe('claimed');
    const leaseToken = claim.records[0]?.leaseToken;
    setupStore.close();

    const logger = new AemeathLogger({ enableConsole: false });
    const crossTab = new CrossTabDeliveryPlugin();
    const offline = new OfflinePersistencePlugin({
      dbName,
      key: keyPrefix,
      ttl: 1,
    });
    logger.use(crossTab);
    logger.use(
      new UploadPlugin({
        onUpload: () => new Promise(() => undefined),
        cache: { enabled: false },
        saveOnUnload: false,
      }),
    );
    logger.use(offline);
    await offline.whenReady();
    await vi.waitFor(() => expect(crossTab.getStatus().state).toBe('active'));

    const internal = offline as unknown as { store: OfflineStore };
    await expect(
      internal.store.get('live-leased-expired'),
    ).resolves.toMatchObject({
      state: 'leased',
      leaseOwner: 'other-tab',
      leaseToken,
    });
    logger.destroy();
  });

  it('explicit persistence disable also clears a dormant v2 queue', async () => {
    const dbName = `cross-tab-purge-${Math.random()}`;
    const keyPrefix = '__aemeath_offline__';
    const namespace = `${dbName}:${keyPrefix}`;
    const store = await createCoordinatedOfflineStore({
      preference: 'indexeddb',
      platform: createBrowserAdapter(),
      dbName,
      keyPrefix,
      namespace,
      allowFallback: false,
    });
    const now = Date.now();
    await store.put({
      logId: 'dormant-v2',
      storedAt: now,
      capturedAt: now,
      priority: 1,
      bytes: 100,
      replayAttempts: 0,
      log: {
        logId: 'dormant-v2',
        level: LogLevel.ERROR,
        message: 'dormant',
        timestamp: now,
      },
    });
    store.close();

    await purgeOfflinePersistenceStorage(createBrowserAdapter(), {
      dbName,
      key: keyPrefix,
      namespace,
    });
    const inspect = await createCoordinatedOfflineStore({
      preference: 'indexeddb',
      platform: createBrowserAdapter(),
      dbName,
      keyPrefix,
      namespace,
      allowFallback: false,
    });
    await expect(inspect.get('dormant-v2')).resolves.toBeNull();
    inspect.close();
  });

  it('is absent from the root entry and must be imported from its plugin subpath', () => {
    expect('CrossTabDeliveryPlugin' in rootExports).toBe(false);
  });
});
