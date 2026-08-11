import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin } from '../src/plugins/UploadPlugin';
import type { AemeathPlugin, DeliveryStatus } from '../src/types';

describe('统一 Delivery 状态中心', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
    vi.useRealTimers();
  });

  it('未配置上传时返回 disabled，而不是要求调用方查找插件', () => {
    expect(logger.getDeliveryStatus()).toMatchObject({
      enabled: false,
      state: 'disabled',
      totalPending: 0,
      persistence: { enabled: false, backend: 'disabled' },
    });
  });

  it('按 logId 聚合内存与持久层，避免重复计数', () => {
    const now = Date.now();
    const upload = {
      name: 'upload',
      install() {},
      getQueueStatus: () => ({
        length: 1,
        inFlight: 1,
        parked: 1,
        paused: false,
        consecutiveFailures: 0,
        oldestPendingAgeMs: 3000,
        attempts: { total: 8, byReason: { success: 4, server: 4 } },
        drops: { total: 1, byReason: { 'queue-overflow': 1 } },
        items: [{ logId: 'queued', capturedAt: now - 1000 }],
        pendingItems: [
          { logId: 'queued', capturedAt: now - 1000 },
          { logId: 'shared', capturedAt: now - 2000 },
          { logId: 'parked', capturedAt: now - 3000 },
        ],
      }),
    } satisfies AemeathPlugin & { getQueueStatus(): object };
    const offline = {
      name: 'offline-persistence',
      install() {},
      getStatus: () => ({
        backend: 'indexeddb' as const,
        pending: 3,
        bytes: 1024,
        replaying: 1,
        quotaDrops: 0,
        giveUps: 0,
        replayed: 5,
        items: [
          { logId: 'shared', capturedAt: now - 2000 },
          { logId: 'parked', capturedAt: now - 3000 },
          { logId: 'persisted-only', capturedAt: now - 4000 },
        ],
      }),
    } satisfies AemeathPlugin & { getStatus(): object };

    logger.use(upload);
    logger.use(offline);

    expect(logger.getDeliveryStatus()).toMatchObject({
      enabled: true,
      state: 'degraded',
      totalPending: 4,
      queued: 1,
      inFlight: 1,
      parked: 1,
      persisted: 3,
      persistedOnly: 1,
      replaying: 1,
      attempts: { total: 8, byReason: { success: 4, server: 4 } },
      drops: { total: 1, byReason: { 'queue-overflow': 1 } },
      persistence: {
        enabled: true,
        backend: 'indexeddb',
        bytes: 1024,
        replayed: 5,
      },
    });
    expect(logger.getDeliveryStatus().oldestPendingAgeMs).toBeGreaterThanOrEqual(4000);
  });

  it('持久层仍在初始化时拒绝切换 deliveryScope，即使当前计数还是 0', () => {
    const upload = new UploadPlugin({
      onUpload: async () => ({ success: true }),
      deliveryScope: 'tenant-a',
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(upload);
    logger.use({
      name: 'offline-persistence',
      install() {},
      getStatus: () => ({
        backend: 'initializing',
        pending: 0,
        bytes: 0,
        replaying: 0,
        quotaDrops: 0,
        giveUps: 0,
        replayed: 0,
        items: [],
      }),
    } as unknown as AemeathPlugin);

    expect(logger.getDeliveryStatus()).toMatchObject({
      totalPending: 0,
      persistence: { enabled: true, backend: 'initializing' },
    });
    expect(() => upload.setOnUpload(async () => ({ success: true }), {
      deliveryScope: 'tenant-b',
    })).toThrow(/still initializing/);
    expect(upload.getDeliveryScope()).toBe('tenant-a');
  });

  it('发送统一生命周期别名与状态事件，同时保留 upload 事件', async () => {
    vi.useFakeTimers();
    const upload = new UploadPlugin({
      onUpload: async () => ({ success: true }),
      queue: { deduplicationDelay: 10 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    const legacyQueued = vi.fn();
    const deliveryQueued = vi.fn();
    const delivered = vi.fn();
    const statuses: DeliveryStatus[] = [];
    logger.on('upload:enqueued', legacyQueued);
    logger.on('delivery:queued', deliveryQueued);
    logger.on('delivery:delivered', delivered);
    logger.on('delivery:status', (status) => statuses.push(status as DeliveryStatus));

    logger.use(upload);
    logger.info('unified delivery events');

    expect(legacyQueued).toHaveBeenCalledTimes(1);
    expect(deliveryQueued).toHaveBeenCalledTimes(1);
    expect(statuses.some((status) => status.totalPending === 1)).toBe(true);

    await vi.advanceTimersByTimeAsync(200);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(logger.getDeliveryStatus()).toMatchObject({ state: 'idle', totalPending: 0 });
  });

  it('非 UploadPlugin 来源的 upload 事件也由 Logger 统一映射', () => {
    const dropped = vi.fn();
    logger.on('delivery:dropped', dropped);
    logger.emit('upload:drop', {
      log: {
        logId: 'external-drop',
        level: 'error',
        message: 'payload rejected before upload',
        timestamp: Date.now(),
      },
      reason: 'payload-too-large',
      source: 'payload-sanitize',
    });

    expect(dropped).toHaveBeenCalledTimes(1);
    expect(dropped.mock.calls[0]![0]).toMatchObject({ reason: 'payload-too-large' });
  });

  it('插件安装与卸载也推送统一状态，不留生命周期盲区', () => {
    const statuses: DeliveryStatus[] = [];
    logger.on('delivery:status', (status) => statuses.push(status as DeliveryStatus));
    const upload = new UploadPlugin({
      onUpload: async () => ({ success: true }),
      cache: { enabled: false },
      saveOnUnload: false,
    });

    logger.use(upload);
    expect(statuses[statuses.length - 1]).toMatchObject({ enabled: true, state: 'idle' });

    logger.uninstall('upload');
    expect(statuses[statuses.length - 1]).toMatchObject({ enabled: false, state: 'disabled' });
  });

  it('同名第三方插件缺少或抛出状态方法时不拖垮观测接口', () => {
    logger.use({ name: 'upload', install() {} });
    expect(() => logger.getDeliveryStatus()).not.toThrow();
    expect(logger.getDeliveryStatus()).toMatchObject({ enabled: true, totalPending: 0 });
    logger.uninstall('upload');

    logger.use({
      name: 'upload',
      install() {},
      getQueueStatus() {
        throw new Error('custom provider failed');
      },
    } as AemeathPlugin);
    expect(() => logger.getDeliveryStatus()).not.toThrow();
    expect(logger.getDeliveryStatus()).toMatchObject({ enabled: true, totalPending: 0 });
  });

  it('旧版不完整状态不会产生 undefined 字段或伪造 logId，并保留匿名计数', () => {
    logger.use({
      name: 'upload',
      install() {},
      getQueueStatus: () => ({
        length: 1,
        items: [{ logId: undefined, capturedAt: Number.NaN }],
      }),
    } as unknown as AemeathPlugin);

    const status = logger.getDeliveryStatus();
    expect(status).toMatchObject({
      enabled: true,
      state: 'delivering',
      totalPending: 1,
      queued: 1,
      inFlight: 0,
      parked: 0,
      consecutiveFailures: 0,
      attempts: { total: 0, byReason: {} },
      drops: { total: 0, byReason: {} },
    });
    expect(Number.isFinite(status.oldestPendingAgeMs)).toBe(true);
  });
});
