/**
 * 扩扫 findings 回归：remount / flush / Offline 双发 / split 级联 / toJSON
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin, type UploadResult } from '../src/plugins/UploadPlugin';
import { OfflinePersistencePlugin } from '../src/plugins/OfflinePersistencePlugin';
import { sanitizeLogEntry } from '../src/utils/payloadSanitize';
import {
  shouldIgnoreNetworkCapture,
  _resetIgnoreNetworkCapture,
} from '../src/utils/ignoreNetworkCapture';
import { LogLevel, type LogEntry } from '../src/types';

function setOnLine(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', {
    value,
    configurable: true,
    writable: true,
  });
}

describe('expand-scan fixes', () => {
  beforeEach(() => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    setOnLine(true);
    vi.useRealTimers();
    _resetIgnoreNetworkCapture();
  });
  afterEach(() => {
    setOnLine(true);
    vi.useRealTimers();
    _resetIgnoreNetworkCapture();
  });

  it('pause 模式下 remount 后必须能继续出队', async () => {
    vi.useFakeTimers();
    const logger = new AemeathLogger({ enableConsole: false });
    try {
      let calls = 0;
      const plugin = new UploadPlugin({
        onUpload: async () => {
          calls++;
          if (calls === 1) throw new TypeError('Failed to fetch');
          return { success: true };
        },
        queue: {
          offlinePolicy: 'pause',
          deduplicationDelay: 0,
          suspectedOfflineThreshold: 1,
        },
        cache: { enabled: false },
        saveOnUnload: false,
      });
      logger.use(plugin);
      logger.error('pause-me');
      await vi.advanceTimersByTimeAsync(500);
      expect(plugin.getQueueStatus().paused).toBe(true);

      logger.uninstall('upload');
      logger.use(plugin);
      expect(plugin.getQueueStatus().paused).toBe(false);

      await vi.advanceTimersByTimeAsync(500);
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      logger.destroy();
      vi.useRealTimers();
    }
  });

  it('flush 在 isProcessing 时必须等到飞行结束', async () => {
    vi.useFakeTimers();
    const logger = new AemeathLogger({ enableConsole: false });
    try {
      let resolveUpload!: (v: UploadResult) => void;
      const upload = new UploadPlugin({
        onUpload: () =>
          new Promise((resolve) => {
            resolveUpload = resolve;
          }),
        queue: { deduplicationDelay: 0, offlinePolicy: 'legacy' },
        cache: { enabled: false },
        saveOnUnload: false,
      });
      logger.use(upload);
      logger.error('slow');
      await vi.advanceTimersByTimeAsync(20);
      expect(upload.getQueueStatus().isProcessing).toBe(true);

      let flushDone = false;
      const flushP = upload.flush().then(() => {
        flushDone = true;
      });
      await vi.advanceTimersByTimeAsync(5);
      expect(flushDone).toBe(false);

      resolveUpload({ success: true });
      // 飞行结束 + 串行间隔 + 可能的第二轮 processQueue
      await vi.advanceTimersByTimeAsync(2_000);
      await flushP;
      expect(flushDone).toBe(true);
      expect(upload.getQueueStatus().length).toBe(0);
    } finally {
      logger.destroy();
      vi.useRealTimers();
    }
  });

  it('Offline remount 重开库窗口不得双发', async () => {
    const logger = new AemeathLogger({ enableConsole: false });
    const delivered: string[] = [];
    let online = false;
    const upload = new UploadPlugin({
      onUpload: (async (log: { message: string }): Promise<UploadResult> => {
        if (!online) throw new TypeError('Failed to fetch');
        delivered.push(log.message);
        return { success: true };
      }) as never,
      queue: { deduplicationDelay: 0, suspectedOfflineThreshold: 1, offlinePolicy: 'pause' },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({ dbName: `fix-dup-${Math.random()}` });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();

    setOnLine(false);
    logger.error('dup-candidate');
    await new Promise((r) => setTimeout(r, 80));
    expect(offline.getStatus().pending).toBe(1);

    offline.uninstall(logger);
    const storeMod = await import('../src/plugins/offline/OfflineStore');
    const realCreate = storeMod.createOfflineStore;
    const spy = vi.spyOn(storeMod, 'createOfflineStore').mockImplementation(async (opts) => {
      await new Promise((r) => setTimeout(r, 150));
      return realCreate(opts);
    });
    try {
      offline.install(logger);
      online = true;
      setOnLine(true);
      window.dispatchEvent(new Event('online'));
      await new Promise((r) => setTimeout(r, 50));
      await offline.whenReady();
      await new Promise((r) => setTimeout(r, 250));
      expect(delivered.filter((m) => m === 'dup-candidate')).toHaveLength(1);
      expect(offline.getStatus().pending).toBe(0);
    } finally {
      spy.mockRestore();
      logger.destroy();
    }
  }, 20000);

  it('Offline remount 后 totalBytes 不得翻倍', async () => {
    const logger = new AemeathLogger({ enableConsole: false });
    const upload = new UploadPlugin({
      onUpload: async () => {
        throw new TypeError('Failed to fetch');
      },
      queue: { deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({ dbName: `fix-bytes-${Math.random()}` });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();
    setOnLine(false);
    logger.error('a');
    logger.error('b');
    await new Promise((r) => setTimeout(r, 80));
    const before = offline.getStatus();
    offline.uninstall(logger);
    offline.install(logger);
    await offline.whenReady();
    const after = offline.getStatus();
    expect(after.bytes).toBe(before.bytes);
    expect(after.pending).toBe(before.pending);
    logger.destroy();
  }, 20000);

  it('no-retry 丢弃同 splitId 排队兄弟', async () => {
    const logger = new AemeathLogger({ enableConsole: false });
    const dropped: Array<{ idx?: unknown; reason: string }> = [];
    const uploaded: unknown[] = [];
    // 直接构造已拆分的队列，避开 sanitize 拆分时机的不确定性
    const splitId = 'split-group-1';
    const chunks: LogEntry[] = [0, 1, 2].map((i) => ({
      logId: `L-${i}`,
      level: LogLevel.ERROR,
      message: 'fat',
      timestamp: Date.now(),
      tags: { splitId, splitIndex: i + 1, splitTotal: 3 },
    }));

    const upload = new UploadPlugin({
      onUpload: async (log: LogEntry): Promise<UploadResult> => {
        uploaded.push(log.tags?.splitIndex);
        if (log.tags?.splitIndex === 1) {
          return { success: false, shouldRetry: false, error: 'reject first' };
        }
        return { success: true };
      },
      queue: { deduplicationDelay: 0, maxRetries: 0, offlinePolicy: 'legacy' },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (log, info) => dropped.push({ idx: log.tags?.splitIndex, reason: info.reason }),
    });
    logger.use(upload);
    for (const c of chunks) {
      upload.requeue(c, { priority: 50 });
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(dropped.map((d) => d.idx).sort()).toEqual([1, 2, 3]);
    expect(dropped.every((d) => d.reason === 'no-retry')).toBe(true);
    // 第一片被拒后，排队兄弟被级联丢掉，不应再成功上传
    expect(uploaded).toEqual([1]);
    logger.destroy();
  });

  it('stale 可重试失败在 cache=off 时必须回队', async () => {
    vi.useFakeTimers();
    const logger = new AemeathLogger({ enableConsole: false });
    try {
      let rejectUpload!: (e: unknown) => void;
      const plugin = new UploadPlugin({
        onUpload: () =>
          new Promise((_, rej) => {
            rejectUpload = rej;
          }),
        queue: {
          deduplicationDelay: 0,
          offlinePolicy: 'pause',
          suspectedOfflineThreshold: 1,
        },
        cache: { enabled: false },
        saveOnUnload: false,
      });
      logger.use(plugin);
      let keepId = '';
      logger.on('log', (e: LogEntry) => {
        keepId = e.logId;
      });
      logger.error('keep-me');
      await vi.advanceTimersByTimeAsync(20);
      logger.uninstall('upload');
      logger.use(plugin);
      rejectUpload(new TypeError('Failed to fetch'));
      await vi.advanceTimersByTimeAsync(50);
      // 回队后可能立刻再起飞（inFlight），不能只看 queue.length
      expect(plugin.isPending(keepId)).toBe(true);
    } finally {
      logger.destroy();
      vi.useRealTimers();
    }
  });

  it('直接 install（不经 uninstall）不得泄漏 ignore 窗口', async () => {
    vi.useFakeTimers();
    const logger = new AemeathLogger({ enableConsole: false });
    try {
      let resolveUpload!: (v: UploadResult) => void;
      const plugin = new UploadPlugin({
        onUpload: () =>
          new Promise((r) => {
            resolveUpload = r;
          }),
        queue: { deduplicationDelay: 0 },
        cache: { enabled: false },
        saveOnUnload: false,
      });
      logger.use(plugin);
      logger.error('y');
      await vi.advanceTimersByTimeAsync(20);
      expect(shouldIgnoreNetworkCapture()).toBe(true);
      plugin.install(logger);
      resolveUpload({ success: true });
      await vi.advanceTimersByTimeAsync(50);
      expect(shouldIgnoreNetworkCapture()).toBe(false);
    } finally {
      logger.destroy();
      vi.useRealTimers();
    }
  });

  it('Upload 已卸载时飞行中的 no-retry 仍 emit，Offline remount 后不得再补传', async () => {
    const logger = new AemeathLogger({ enableConsole: false });
    let resolveUpload!: (v: UploadResult) => void;
    const upload = new UploadPlugin({
      onUpload: () =>
        new Promise((r) => {
          resolveUpload = r;
        }),
      queue: { deduplicationDelay: 0, offlinePolicy: 'pause', suspectedOfflineThreshold: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({ dbName: `late-drop-${Math.random()}` });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();

    setOnLine(false);
    logger.error('reject-me');
    await new Promise((r) => setTimeout(r, 80));
    expect(offline.getStatus().pending).toBe(1);

    // 恢复并起飞，然后先卸 Offline（留 late listener），再卸 Upload
    setOnLine(true);
    window.dispatchEvent(new Event('online'));
    await new Promise((r) => setTimeout(r, 30));
    offline.uninstall(logger);
    upload.uninstall(logger);
    resolveUpload({ success: false, shouldRetry: false, error: 'nope' });
    await new Promise((r) => setTimeout(r, 50));

    offline.install(logger);
    await offline.whenReady();
    await new Promise((r) => setTimeout(r, 80));
    expect(offline.getStatus().pending).toBe(0);
    logger.destroy();
  }, 20000);

  it('toJSON 返回的 Data URL 会被清洗', () => {
    const result = sanitizeLogEntry({
      logId: 'L',
      level: 'error',
      message: 'm',
      timestamp: 1,
      context: {
        img: {
          toJSON: () => 'data:image/png;base64,' + 'A'.repeat(800),
        },
      },
    } as never);
    const entry = result.entries[0]!;
    const img = (entry.context as Record<string, unknown>)['img'];
    expect(String(img)).toMatch(/^\[omitted:data-url/);
    expect(result.strips.some((s) => s.kind === 'data-url')).toBe(true);
  });
});
