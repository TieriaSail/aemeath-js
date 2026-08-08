/**
 * 拆卸路径的容错
 *
 * 卸载是一条**线性**的清理链：反注册监听、清定时器、关存储、断引用。
 * 其中反注册走的是宿主 API（小程序的 offAppHide、浏览器的 removeEventListener、
 * IndexedDB 的 close），抛不抛不由我们说了算。
 *
 * 链上任何一环抛出，后面的清理就全被跳过。后果不是报错，而是：
 * 监听器留在宿主上、`this.logger` 不置空 —— 这个已卸载的实例连同它引用的
 * 整个 logger（及其全部插件、队列、缓存）永远回收不掉。
 * 在 HMR / 框架频繁 remount 的应用里，这是按次数累积的内存泄漏。
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin, type UploadResult } from '../src/plugins/UploadPlugin';
import { OfflinePersistencePlugin } from '../src/plugins/OfflinePersistencePlugin';

const settle = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10));
};

describe('拆卸链上任何一环抛出，都不能中断清理', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    localStorage.clear();
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('onBeforeExit 的反注册抛异常时，online 监听和 logger 引用仍要断干净', async () => {
    const plugin = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => ({ success: true }),
      queue: { deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: true,
    });
    logger.use(plugin);

    // 模拟宿主的 offAppHide / removeEventListener 翻脸
    const internals = plugin as unknown as { unregisterBeforeExit: (() => void) | null };
    internals.unregisterBeforeExit = () => {
      throw new Error('host refused to detach');
    };

    expect(() => plugin.uninstall(logger as never)).not.toThrow();

    // 引用必须断掉，否则这个实例会把整个 logger 一起钉在内存里
    expect((plugin as unknown as { logger: unknown }).logger).toBeNull();
    expect((plugin as unknown as { boundHandleLog: unknown }).boundHandleLog).toBeNull();
    expect((plugin as unknown as { boundHandleOnline: unknown }).boundHandleOnline).toBeNull();
    expect(internals.unregisterBeforeExit).toBeNull();
  });

  it('反注册抛异常后，缓存 key 仍要归还给接任实例', async () => {
    const first = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => ({ success: true }),
      queue: { deduplicationDelay: 0 },
      cache: { enabled: true, key: 'teardown-key' },
      saveOnUnload: true,
    });
    logger.use(first);
    (first as unknown as { unregisterBeforeExit: () => void }).unregisterBeforeExit = () => {
      throw new Error('nope');
    };
    first.uninstall(logger as never);

    // 接任实例应当能正常认领同一个 key（不被让位、缓存照常工作）
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger2 = new AemeathLogger({ enableConsole: false });
    const second = new UploadPlugin({
      // shouldRetry 让它留在队列里等退避，卸载时才有东西可存盘；
      // 不加的话是 no-retry，一上来就丢了，缓存永远是空的，用例形同虚设
      onUpload: async (): Promise<UploadResult> => ({
        success: false,
        shouldRetry: true,
        retryReason: 'server',
        error: 'hold',
      }),
      queue: { deduplicationDelay: 0, uploadInterval: 100000 },
      cache: { enabled: true, key: 'teardown-key' },
      saveOnUnload: false,
    });
    logger2.use(second);
    logger2.error('second instance log');
    await settle();
    second.uninstall(logger2 as never);

    expect(localStorage.getItem('teardown-key')).toContain('second instance log');
    const text = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(text).not.toContain('share the cache key');

    warn.mockRestore();
    logger2.destroy();
  });

  it('卸载后的墓碑实例不能再收日志，也不能再覆盖缓存', async () => {
    const plugin = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => ({
        success: false,
        shouldRetry: true,
        retryReason: 'server',
        error: 'hold',
      }),
      queue: { deduplicationDelay: 0, uploadInterval: 100000 },
      cache: { enabled: true, key: 'tombstone-key' },
      saveOnUnload: true,
    });
    logger.use(plugin);
    logger.error('written before teardown');
    await settle();

    (plugin as unknown as { unregisterBeforeExit: () => void }).unregisterBeforeExit = () => {
      throw new Error('nope');
    };
    plugin.uninstall(logger as never);

    // 卸载时应当把队列存下来，这样才有一份真实内容可供后续比对
    const after = localStorage.getItem('tombstone-key');
    expect(after).toContain('written before teardown');

    const queuedAtTeardown = plugin.getQueueStatus().length;
    logger.error('should not reach the dead instance');
    await settle();

    // 卸载不清空队列（那份已经存进缓存了），但绝不能再收新的
    expect(plugin.getQueueStatus().length).toBe(queuedAtTeardown);
    expect(localStorage.getItem('tombstone-key')).toBe(after);
    expect(localStorage.getItem('tombstone-key')).not.toContain('dead instance');
  });

  it('store.close() 抛异常时，离线插件的引用仍要断干净', async () => {
    const offline = new OfflinePersistencePlugin({ dbName: `teardown-${Math.random()}` });
    logger.use(offline);
    await offline.whenReady();

    const internals = offline as unknown as { store: { close: () => void } | null };
    if (internals.store) {
      internals.store.close = () => {
        throw new Error('close failed');
      };
    }

    expect(() => offline.uninstall(logger as never)).not.toThrow();
    expect(internals.store).toBeNull();
    expect((offline as unknown as { logger: unknown }).logger).toBeNull();
  });

  it('某个事件反注册抛异常时，其余监听器仍要摘干净', async () => {
    const upload = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => ({ success: true }),
      queue: { deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({ dbName: `teardown2-${Math.random()}` });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();

    const realOff = logger.off.bind(logger);
    let first = true;
    vi.spyOn(logger, 'off').mockImplementation(((event: string, fn: never) => {
      if (first) {
        first = false;
        throw new Error('detach exploded');
      }
      return realOff(event as never, fn);
    }) as never);

    expect(() => offline.uninstall(logger as never)).not.toThrow();

    vi.mocked(logger.off).mockRestore();

    // 全部 handler 都应已从内部清单里移除，卸载后再来事件也不该被处理
    expect((offline as unknown as { handlers: unknown[] }).handlers).toHaveLength(0);
    expect((offline as unknown as { logger: unknown }).logger).toBeNull();
  });
});
