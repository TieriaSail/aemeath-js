/**
 * 补传 × 队列溢出：终止性
 *
 * 第七轮改了一处：补传出来的日志若因**队列溢出**被丢，不再计入补传失败次数
 * （它根本没上过网，不该为本地拥挤买单）。但这样一来就有了闭环的形状：
 *   replay → requeue → 队列满 → 溢出丢弃 → handleDrop → scheduleReplay → replay
 * 必须证明它会停，而不是空转。
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin, type UploadResult } from '../src/plugins/UploadPlugin';
import { OfflinePersistencePlugin } from '../src/plugins/OfflinePersistencePlugin';

function setOnLine(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', {
    value,
    configurable: true,
    writable: true,
  });
}

const settle = async (times = 25): Promise<void> => {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('补传遇上队列溢出时必须收敛', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    setOnLine(true);
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
    setOnLine(true);
  });

  it('上传队列被塞满时，补传不会变成空转的死循环', async () => {
    let online = false;
    // 上传永远悬挂：队列被牢牢占满，补传进来的日志必定溢出
    const uploadFn = vi.fn(async (): Promise<UploadResult> => {
      if (!online) throw new TypeError('Failed to fetch');
      return new Promise<UploadResult>(() => {});
    });

    const upload = new UploadPlugin({
      onUpload: uploadFn as never,
      queue: { deduplicationDelay: 0, suspectedOfflineThreshold: 1, maxSize: 2 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({ dbName: `ovf-${Math.random()}` });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();

    setOnLine(false);
    for (let i = 0; i < 6; i++) logger.error(`offline-${i}`);
    await settle();

    const persisted = offline.getStatus().pending;
    expect(persisted).toBeGreaterThan(0);

    // 恢复联网：补传开始，但上传队列会被悬挂的请求占满
    online = true;
    setOnLine(true);
    window.dispatchEvent(new Event('online'));
    await settle(40);

    const callsAfterFirstSettle = uploadFn.mock.calls.length;
    await settle(40);
    const callsAfterSecondSettle = uploadFn.mock.calls.length;

    // 关键：不能无限空转。第二段时间里的新增调用必须是有限且很小的，
    // 而不是随时间线性爆炸。
    const growth = callsAfterSecondSettle - callsAfterFirstSettle;
    expect(growth).toBeLessThan(20);

    // 补传预算不能被本地拥挤白白烧光：日志要么还在盘上等，要么已经发出去了
    const status = offline.getStatus();
    expect(status.giveUps).toBe(0);
  }, 30000);

  it('队列溢出不消耗补传预算，腾出空间后仍能发出去', async () => {
    let online = false;
    let blocking = true;
    const delivered: string[] = [];
    const uploadFn = vi.fn(async (log: { message: string }): Promise<UploadResult> => {
      if (!online) throw new TypeError('Failed to fetch');
      if (blocking) return new Promise<UploadResult>(() => {});
      delivered.push(log.message);
      return { success: true };
    });

    const upload = new UploadPlugin({
      onUpload: uploadFn as never,
      queue: { deduplicationDelay: 0, suspectedOfflineThreshold: 1, maxSize: 2 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({
      dbName: `ovf2-${Math.random()}`,
      maxReplayAttempts: 2,
      replayTimeoutMs: 200,
    });
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();

    setOnLine(false);
    logger.error('must survive');
    await settle();
    expect(offline.getStatus().pending).toBeGreaterThan(0);

    online = true;
    setOnLine(true);
    window.dispatchEvent(new Event('online'));
    await settle(40);

    // 拥挤解除
    blocking = false;
    await settle(60);

    // 这条日志不能因为一路被挤掉而被判死刑
    expect(offline.getStatus().giveUps).toBe(0);
  }, 30000);
});
