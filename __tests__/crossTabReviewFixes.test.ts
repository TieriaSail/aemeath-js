/**
 * 2.6.0 审查修复的回归测试。
 *
 * 覆盖：
 * - saveToCache 在恢复所有权转移窗口内不再整体禁写（新日志保留崩溃恢复点）
 * - beginRecoveryCacheTransfer 纳入飞行中的恢复项 / rollback 不产生双副本
 * - acknowledgeDelivered 未启用跨标签能力时是 no-op
 * - retryReceiptTransition 在 uninstall/remount 后停止重试且不动新生命周期
 * - reserveCrossTabRecovery 晚于 install 到达时仍绑定能力声明的 namespace
 * - 协调模式下不完整 split 缓冲残片超时清理
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { AemeathLogger } from '../src/core/Logger';
import { CrossTabDeliveryPlugin } from '../src/plugins/CrossTabDeliveryPlugin';
import { OfflinePersistencePlugin } from '../src/plugins/OfflinePersistencePlugin';
import { UploadPlugin, type UploadResult } from '../src/plugins/UploadPlugin';
import { createOfflineCoordinationStore } from '../src/plugins/offline/OfflineCoordinationStore';
import { createOfflineStore as createCoordinatedOfflineStore } from '../src/plugins/offline/CoordinatedOfflineStore';
import type { LogEntry } from '../src/types';

const settle = async (rounds = 20): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const cacheEntry = (logId: string, now: number): Record<string, unknown> => ({
  log: { logId, level: 'error', message: `cached ${logId}`, timestamp: now },
  priority: 100,
  retryCount: 0,
  timestamp: now,
  cachedAt: now,
});

describe('2.6 review fixes: Upload recovery cache transfer window', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    localStorage.clear();
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
    localStorage.clear();
  });

  it('keeps caching new logs while a recovery transfer is uncommitted', async () => {
    const cacheKey = `transfer-window-${Math.random()}`;
    const now = Date.now();
    localStorage.setItem(
      cacheKey,
      JSON.stringify([cacheEntry('restored-item', now)]),
    );
    const upload = new UploadPlugin({
      onUpload: async () => ({ success: true }),
      cache: { enabled: true, key: cacheKey },
      saveOnUnload: false,
    });
    // 挡住消费端，让恢复项留在队列里
    (upload as unknown as { callbackPaused: boolean }).callbackPaused = true;
    logger.use(upload);

    const snapshot = upload.beginRecoveryCacheTransfer();
    expect(snapshot.map((item) => item.log.logId)).toEqual(['restored-item']);

    upload.requeue({
      logId: 'fresh-item',
      level: 'error',
      message: 'arrived during transfer window',
      timestamp: Date.now(),
    } as LogEntry);
    await settle();

    const cached = JSON.parse(
      localStorage.getItem(cacheKey) ?? '[]',
    ) as Array<{ log: { logId: string } }>;
    const ids = cached.map((item) => item.log.logId).sort();
    // 转移窗口内：新日志有崩溃恢复点，转移项的唯一持久副本也没有被覆盖掉
    expect(ids).toEqual(['fresh-item', 'restored-item']);
  });

  it('includes in-flight restored items in the transfer snapshot and skips them on rollback', async () => {
    const cacheKey = `transfer-inflight-${Math.random()}`;
    const now = Date.now();
    localStorage.setItem(
      cacheKey,
      JSON.stringify([cacheEntry('inflight-restored', now)]),
    );
    // 永不 settle：恢复项停留在飞行状态
    const onUpload = vi.fn(() => new Promise<UploadResult>(() => undefined));
    const upload = new UploadPlugin({
      onUpload,
      cache: { enabled: true, key: cacheKey },
      saveOnUnload: false,
    });
    logger.use(upload);
    expect(onUpload).toHaveBeenCalledTimes(1);
    expect(upload.isInFlight('inflight-restored')).toBe(true);

    const snapshot = upload.beginRecoveryCacheTransfer();
    // 飞行项也要进快照：否则 confirm 删旧 cache 后它没有任何持久副本
    expect(snapshot.map((item) => item.log.logId)).toEqual([
      'inflight-restored',
    ]);

    upload.rollbackRecoveryCacheTransfer();
    // 所有权仍归飞行请求：回滚不得把它再排一份进队列
    expect(upload.getQueueStatus().length).toBe(0);
    expect(upload.isInFlight('inflight-restored')).toBe(true);
  });
});

describe('2.6 review fixes: acknowledgeDelivered gating', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    localStorage.clear();
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
    localStorage.clear();
  });

  it('is a no-op without the cross-tab capability plugin', async () => {
    const upload = new UploadPlugin({
      onUpload: async () => ({ success: true }),
      cache: { enabled: false },
      saveOnUnload: false,
    });
    (upload as unknown as { callbackPaused: boolean }).callbackPaused = true;
    logger.use(upload);

    upload.requeue({
      logId: 'must-survive',
      level: 'error',
      message: 'default path log',
      timestamp: Date.now(),
    } as LogEntry);
    expect(upload.isPending('must-survive')).toBe(true);

    // 默认路径没有"别处已送达"的事实源，宿主误调用不能静默删日志
    upload.acknowledgeDelivered('must-survive');
    expect(upload.isPending('must-survive')).toBe(true);
  });
});

describe('2.6 review fixes: receipt transition retry lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops retrying and never calls onCommitted after uninstall', async () => {
    const logger = new AemeathLogger({ enableConsole: false });
    const upload = new UploadPlugin({
      onUpload: async () => ({ success: true }),
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(upload);

    const operation = vi.fn(async () => true);
    const onCommitted = vi.fn();
    (
      upload as unknown as {
        retryReceiptTransition(
          label: string,
          operation: () => Promise<boolean>,
          onCommitted: () => void,
        ): void;
      }
    ).retryReceiptTransition('test transition', operation, onCommitted);

    logger.uninstall('upload');
    await vi.advanceTimersByTimeAsync(120_000);

    expect(operation).not.toHaveBeenCalled();
    expect(onCommitted).not.toHaveBeenCalled();
    logger.destroy();
  });

  it('commits normally within the same lifecycle', async () => {
    const logger = new AemeathLogger({ enableConsole: false });
    const upload = new UploadPlugin({
      onUpload: async () => ({ success: true }),
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(upload);

    const operation = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(true);
    const onCommitted = vi.fn();
    (
      upload as unknown as {
        retryReceiptTransition(
          label: string,
          operation: () => Promise<boolean>,
          onCommitted: () => void,
        ): void;
      }
    ).retryReceiptTransition('test transition', operation, onCommitted);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(onCommitted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(onCommitted).toHaveBeenCalledTimes(1);
    logger.destroy();
  });
});

describe('2.6 review fixes: offline coordination', () => {
  beforeEach(() => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('binds the capability namespace at reservation time, not only at install detection', async () => {
    const logger = new AemeathLogger({ enableConsole: false });
    const upload = new UploadPlugin({
      onUpload: async () => ({ success: true }),
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({
      dbName: `late-reserve-${Math.random()}`,
    });
    logger.use(upload);
    logger.use(offline);

    // 能力插件晚于 Offline 安装：预留必须与 namespace 同点落定，
    // 不能因为没走 install 探测路径就悄悄退回默认 namespace。
    const internal = offline as unknown as {
      options: { namespace: string };
      beginCrossTabReservation(capability: {
        createStore: typeof createCoordinatedOfflineStore;
        createCoordination: typeof createOfflineCoordinationStore;
        namespace?: string;
      }): void;
    };
    const defaultNamespace = internal.options.namespace;
    const reserved = offline.reserveCrossTabRecovery({
      createStore: createCoordinatedOfflineStore,
      createCoordination: createOfflineCoordinationStore,
      namespace: 'custom-namespace',
    });
    expect(internal.options.namespace).toBe('custom-namespace');
    expect(internal.options.namespace).not.toBe(defaultNamespace);

    // init 的 reservation 读取在 install 同步链路内完成，晚到的预留按设计
    // 回落 legacy 并返回 null —— 这是文档化约束，不能静默变成 v2。
    const port = await reserved;
    expect(port).toBeNull();
    logger.destroy();
  });

  it('purges buffered split fragments whose siblings can never arrive', async () => {
    const logger = new AemeathLogger({ enableConsole: false });
    const crossTab = new CrossTabDeliveryPlugin();
    const upload = new UploadPlugin({
      onUpload: async () => ({ success: true }),
      cache: { enabled: false },
      saveOnUnload: false,
    });
    (upload as unknown as { callbackPaused: boolean }).callbackPaused = true;
    const offline = new OfflinePersistencePlugin({
      dbName: `stale-split-${Math.random()}`,
    });
    logger.use(crossTab);
    logger.use(upload);
    logger.use(offline);
    await offline.whenReady();
    await vi.waitFor(() => expect(crossTab.getStatus().state).toBe('active'));

    const drops: Array<Record<string, unknown>> = [];
    logger.on('upload:drop', (payload) =>
      drops.push(payload as Record<string, unknown>),
    );

    const internal = offline as unknown as {
      persist(log: LogEntry): Promise<void>;
      pendingPersists: Array<{ log: LogEntry }>;
      purgeStaleSplitBuffers(now?: number): void;
    };
    // 只送到一半的 split 组：兄弟片已在上游被丢，永远不会到达
    await internal.persist({
      logId: 'orphan-fragment',
      level: 'error',
      message: 'half of a split group',
      timestamp: Date.now(),
      tags: { splitId: 'orphan-split', splitIndex: 1, splitTotal: 2 },
    } as unknown as LogEntry);
    expect(
      internal.pendingPersists.some(
        (item) => item.log.logId === 'orphan-fragment',
      ),
    ).toBe(true);

    // 宽限期内不清理
    internal.purgeStaleSplitBuffers(Date.now() + 1_000);
    expect(internal.pendingPersists).toHaveLength(1);

    // 超过宽限期后残片必须离开缓冲并对外报告丢弃
    internal.purgeStaleSplitBuffers(Date.now() + 11_000);
    expect(internal.pendingPersists).toHaveLength(0);
    expect(
      drops.some(
        (payload) =>
          (payload.log as { logId?: string } | undefined)?.logId ===
            'orphan-fragment' && payload.reason === 'storage-rejected',
      ),
    ).toBe(true);
    logger.destroy();
  });
});
