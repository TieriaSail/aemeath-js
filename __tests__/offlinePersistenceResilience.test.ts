/**
 * OfflinePersistencePlugin —— 存储异常下的终止性保证
 *
 * 持久层写不进去，是配额打满时的**常态**而不是意外。这一组测试守的是：
 * 存储坏掉时补传必须照样收敛，不能变成「投递 → 失败 → 重新投递」的死循环。
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin, type UploadResult } from '../src/plugins/UploadPlugin';
import { OfflinePersistencePlugin } from '../src/plugins/OfflinePersistencePlugin';
import type { LogEntry } from '../src/types';

function setOnLine(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', {
    value,
    configurable: true,
    writable: true,
  });
}

async function settle(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('OfflinePersistencePlugin — 存储异常下的终止性', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    setOnLine(true);
    localStorage.clear();
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
    setOnLine(true);
    localStorage.clear();
  });

  it('持久层写入一直失败时，补传仍在 maxReplayAttempts 内收敛', async () => {
    let online = true;
    const uploadFn = vi.fn(async (_log: LogEntry): Promise<UploadResult> => {
      if (!online) throw new Error('network unreachable');
      // 网络恢复后服务端一律拒收 → 每次补传都会 drop，触发 registerReplayFailure
      return { success: false, shouldRetry: false };
    });

    const upload = new UploadPlugin({
      onUpload: uploadFn as never,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({
      storage: 'localstorage',
      maxReplayAttempts: 3,
    });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();
    expect(offline.getStatus().backend).toBe('localstorage');

    // 1. 断网期间产生日志 → 落盘
    online = false;
    setOnLine(false);
    logger.error('stranded');
    await settle(10);
    expect(offline.getStatus().pending).toBe(1);

    // 2. 落盘之后冻结存储：写入一律失败（配额打满的典型形态），读取仍然正常
    const realSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function frozen(): void {
      throw new Error('QuotaExceededError');
    };

    try {
      // 3. 网络恢复，但服务端拒收 → 补传 → drop → 重新记账（而记账写不进去）
      online = true;
      setOnLine(true);
      window.dispatchEvent(new Event('online'));
      await settle(60);
    } finally {
      Storage.prototype.setItem = realSetItem;
    }

    // 关键断言：投递次数必须有上限。修复前这里是持续增长的请求风暴。
    expect(uploadFn.mock.calls.length).toBeLessThanOrEqual(5);
    expect(offline.getStatus().pending).toBe(0);
  });

  it('日志无法被存储引擎克隆时只丢它自己，不牵连已落盘的其它日志', async () => {
    // JSON 能序列化、structuredClone 不能：函数是最常见的一种。
    // 若把 DataCloneError 当成配额不足处理，就会白白淘汰掉 20% 的存量日志。
    const uploadFn = vi.fn(async (_log: LogEntry): Promise<UploadResult> => {
      throw new Error('offline');
    });

    const dropped: string[] = [];
    const upload = new UploadPlugin({
      onUpload: uploadFn as never,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, suspectedOfflineThreshold: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (_log, info) => {
        dropped.push(info.reason);
      },
    });
    const offline = new OfflinePersistencePlugin({ dbName: `clone-${Math.random()}` });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();
    expect(offline.getStatus().backend).toBe('indexeddb');

    setOnLine(false);
    for (let i = 0; i < 5; i++) {
      logger.error(`healthy ${i}`);
    }
    await settle(15);
    const before = offline.getStatus().pending;
    expect(before).toBe(5);

    // 绕开 PayloadSanitizePlugin（这里没装），直接投一条含函数的日志
    logger.error('has function', { context: { cb: () => undefined } });
    await settle(15);

    // 这一条存不下是应该的，但不是配额问题——不能记进 quotaDrops
    expect(offline.getStatus().quotaDrops).toBe(0);
    expect(dropped).toContain('storage-rejected');
    expect(dropped).not.toContain('storage-quota');
    expect(offline.getStatus().pending).toBe(before);
  });
});
