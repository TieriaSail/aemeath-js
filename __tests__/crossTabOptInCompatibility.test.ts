import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import {
  OfflinePersistencePlugin,
  type OfflinePersistencePluginOptions,
} from '../src/plugins/OfflinePersistencePlugin';
import { UploadPlugin, type UploadResult } from '../src/plugins/UploadPlugin';
import type { AemeathPlugin, LogEntry } from '../src/types';

const settle = async (rounds = 30): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe('CrossTabDeliveryPlugin disabled: 2.5.2 compatibility contract', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    localStorage.clear();
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
    localStorage.clear();
  });

  it('does not add deliveryAttempt to ordinary upload payloads', async () => {
    const received: LogEntry[] = [];
    const upload = new UploadPlugin({
      onUpload: async (log): Promise<UploadResult> => {
        received.push(log);
        return { success: true };
      },
      queue: { deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(upload);
    logger.error('2.5 payload');
    await settle();

    expect(received).toHaveLength(1);
    expect(received[0]).toHaveProperty('requestId');
    expect(received[0]).not.toHaveProperty('deliveryAttempt');
  });

  it('keeps deliveryAttempt out of the core LogEntry type', () => {
    type MustRemainFalse<T extends false> = T;
    type CoreLogEntryHasDeliveryAttempt = MustRemainFalse<
      'deliveryAttempt' extends keyof LogEntry ? true : false
    >;
    const result: CoreLogEntryHasDeliveryAttempt = false;
    expect(result).toBe(false);
  });

  it('keeps cross-tab namespace out of the 2.5 OfflinePersistence options', () => {
    type MustRemainFalse<T extends false> = T;
    type CoreOptionsHaveNamespace = MustRemainFalse<
      'namespace' extends keyof OfflinePersistencePluginOptions ? true : false
    >;
    const result: CoreOptionsHaveNamespace = false;
    expect(result).toBe(false);
  });

  it('does not treat an unrelated plugin with the same public name as the SDK capability', () => {
    const cacheKey = `compat-name-collision-${Math.random()}`;
    const now = Date.now();
    localStorage.setItem(
      cacheKey,
      JSON.stringify([
        {
          log: {
            logId: 'cached-name-collision',
            level: 'error',
            message: 'cached name collision',
            timestamp: now,
          },
          priority: 100,
          retryCount: 0,
          timestamp: now,
          cachedAt: now,
        },
      ]),
    );
    const unrelated = {
      name: 'cross-tab-delivery',
      install() {
        /* unrelated user plugin */
      },
    } satisfies AemeathPlugin;
    const onUpload = vi.fn(() => new Promise<UploadResult>(() => undefined));

    logger.use(unrelated);
    logger.use(
      new UploadPlugin({
        onUpload,
        cache: { enabled: true, key: cacheKey },
        saveOnUnload: false,
      }),
    );

    expect(onUpload).toHaveBeenCalledTimes(1);
  });

  it('does not transfer Upload cache ownership to OfflinePersistence', async () => {
    const upload = new UploadPlugin({
      onUpload: async () => ({ success: true }),
      cache: { enabled: true, key: `compat-cache-${Math.random()}` },
      saveOnUnload: false,
    });
    const beginTransfer = vi.spyOn(upload, 'beginRecoveryCacheTransfer');
    const offline = new OfflinePersistencePlugin({
      storage: 'localstorage',
      key: `compat-offline-${Math.random()}`,
    });

    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();

    expect(beginTransfer).not.toHaveBeenCalled();
  });

  it('preserves the cached item source exposed by 2.5.2 lifecycle events', async () => {
    const cacheKey = `compat-source-${Math.random()}`;
    const now = Date.now();
    localStorage.setItem(
      cacheKey,
      JSON.stringify([
        {
          log: {
            logId: 'cached-source',
            level: 'error',
            message: 'cached source',
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
    const successes: Array<Record<string, unknown>> = [];
    logger.on('upload:success', (payload) => successes.push(payload));
    logger.use(
      new UploadPlugin({
        onUpload: async () => ({ success: true }),
        queue: { deduplicationDelay: 0 },
        cache: { enabled: true, key: cacheKey },
        saveOnUnload: false,
      }),
    );
    await settle();

    expect(successes).toHaveLength(1);
    expect(successes[0]?.source).toBe('live');
  });

  it('starts default Upload cache recovery in the same synchronous install turn as 2.5.2', () => {
    const cacheKey = `compat-immediate-${Math.random()}`;
    const now = Date.now();
    localStorage.setItem(
      cacheKey,
      JSON.stringify([
        {
          log: {
            logId: 'cached-immediate',
            level: 'error',
            message: 'cached immediate',
            timestamp: now,
          },
          priority: 100,
          retryCount: 0,
          timestamp: now,
          cachedAt: now,
        },
      ]),
    );
    const onUpload = vi.fn(() => new Promise<UploadResult>(() => undefined));

    logger.use(
      new UploadPlugin({
        onUpload,
        cache: { enabled: true, key: cacheKey },
        saveOnUnload: false,
      }),
    );

    expect(onUpload).toHaveBeenCalledTimes(1);
  });

  it('does not create a v2 namespace binding in the 2.5 KV backend', async () => {
    const key = `compat-kv-${Math.random()}`;
    const offline = new OfflinePersistencePlugin({
      storage: 'localstorage',
      key,
    });
    logger.use(
      new UploadPlugin({
        onUpload: async () => ({ success: true }),
        cache: { enabled: false },
        saveOnUnload: false,
      }),
    );
    logger.use(offline);
    await offline.whenReady();

    expect(localStorage.getItem(`${key}:namespace-v2`)).toBeNull();
  });
});
