/**
 * initAemeath 上的可靠性选项 —— 接线集成测试
 *
 * 1.x / 1.10.1：payloadSanitize 仍默认关闭；配置 upload 后持久化和 pause 默认开启。
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { LogEntry } from '../src/types';
import type { UploadResult } from '../src/plugins/UploadPlugin';

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

describe('initAemeath — 可靠性选项接线', () => {
  beforeEach(() => {
    vi.resetModules();
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    setOnLine(true);
    localStorage.clear();
  });

  afterEach(() => {
    setOnLine(true);
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('默认不装 PayloadSanitizePlugin，也不装 OfflinePersistencePlugin', async () => {
    const mod = await import('../src/singleton/index');
    const logger = mod.initAemeath();

    expect(logger.hasPlugin('payload-sanitize')).toBe(false);
    expect(logger.hasPlugin('offline-persistence')).toBe(false);

    mod.resetAemeath();
  });

  it('payloadSanitize: true 时装上', async () => {
    const mod = await import('../src/singleton/index');
    const logger = mod.initAemeath({ payloadSanitize: true });

    expect(logger.hasPlugin('payload-sanitize')).toBe(true);

    mod.resetAemeath();
  });

  it('payloadSanitize 的 maxBytes 会真的传到插件里', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const mod = await import('../src/singleton/index');
    const logger = mod.initAemeath({ payloadSanitize: { maxBytes: 1500 } });

    // 单字段远超 1500 → 应被拒绝；若 maxBytes 没传进去（默认 60000）则会正常放行
    logger.error('too big', { context: { huge: 'x'.repeat(9000) } });

    const plugin = logger.getPluginInstance('payload-sanitize') as unknown as {
      getStats(): { rejected: number };
    };
    expect(plugin.getStats().rejected).toBe(1);

    mod.resetAemeath();
  });

  it('配置 upload 后默认装上持久化，并能真的落盘+补传', async () => {
    let online = true;
    const uploadFn = vi.fn(async (_log: LogEntry): Promise<UploadResult> => {
      if (!online) throw new Error('network unreachable');
      return { success: true };
    });

    const mod = await import('../src/singleton/index');
    const logger = mod.initAemeath({
      upload: uploadFn,
      errorCapture: false,
      safeGuard: { enabled: false },
      enableConsole: false,
      queue: { suspectedOfflineThreshold: 1 },
    });

    expect(logger.hasPlugin('offline-persistence')).toBe(true);
    const offline = logger.getPluginInstance('offline-persistence') as unknown as {
      whenReady(): Promise<void>;
      getStatus(): { backend: string; pending: number };
    };
    await offline.whenReady();

    online = false;
    setOnLine(false);
    logger.error('captured while offline');
    await settle(15);
    expect(offline.getStatus().pending).toBe(1);

    online = true;
    setOnLine(true);
    window.dispatchEvent(new Event('online'));
    await settle(40);

    const sent = uploadFn.mock.calls.filter(
      (c) => (c[0] as LogEntry).message === 'captured while offline',
    );
    expect(sent).toHaveLength(1);
    expect(offline.getStatus().pending).toBe(0);

    mod.resetAemeath();
  });

  it('offlinePersistence: false 可关闭默认持久化并禁用 Upload cache', async () => {
    const mod = await import('../src/singleton/index');
    const logger = mod.initAemeath({
      upload: async () => ({
        success: false,
        shouldRetry: true,
        retryReason: 'server',
      }),
      offlinePersistence: false,
      errorCapture: false,
      safeGuard: { enabled: false },
      enableConsole: false,
    });

    expect(logger.hasPlugin('upload')).toBe(true);
    expect(logger.hasPlugin('offline-persistence')).toBe(false);
    logger.error('memory only');
    await settle(10);
    expect(localStorage.getItem('__logger_upload_queue__')).toBeNull();

    mod.resetAemeath();
  });

  it('显式关闭后可在一次增量调用里重新开启', async () => {
    const mod = await import('../src/singleton/index');
    const logger = mod.initAemeath({
      upload: async () => ({ success: true }),
      offlinePersistence: false,
    });
    expect(logger.hasPlugin('offline-persistence')).toBe(false);

    mod.initAemeath({ offlinePersistence: true });
    expect(logger.hasPlugin('offline-persistence')).toBe(true);
    const offline = logger.getPluginInstance('offline-persistence') as
      import('../src/plugins/OfflinePersistencePlugin').OfflinePersistencePlugin;
    await offline.whenReady();

    mod.resetAemeath();
  });

  it('setUpload 懒安装时默认装持久化，并尊重之前的显式关闭', async () => {
    const mod = await import('../src/singleton/index');
    let logger = mod.getAemeath();
    mod.setUpload(async () => ({ success: true }));
    expect(logger.hasPlugin('offline-persistence')).toBe(true);
    mod.resetAemeath();

    logger = mod.initAemeath({ offlinePersistence: false });
    mod.setUpload(async () => ({ success: true }));
    expect(logger.hasPlugin('upload')).toBe(true);
    expect(logger.hasPlugin('offline-persistence')).toBe(false);
    mod.resetAemeath();
  });

  it('setUpload(null) 真正暂停，并在重新绑定后原样恢复', async () => {
    const mod = await import('../src/singleton/index');
    const initialUpload = vi.fn(async () => ({ success: true }));
    const logger = mod.initAemeath({ upload: initialUpload, offlinePersistence: false });

    mod.setUpload(null);
    logger.error('after pause');
    await settle(10);
    expect(initialUpload).not.toHaveBeenCalled();

    const upload = logger.getPluginInstance('upload') as
      import('../src/plugins/UploadPlugin').UploadPlugin;
    expect(upload.getQueueStatus()).toMatchObject({ paused: true, length: 1 });

    const resumed = vi.fn(async () => ({ success: true }));
    mod.setUpload(resumed);
    await settle(15);
    expect(resumed).toHaveBeenCalledWith(expect.objectContaining({ message: 'after pause' }));
    expect(upload.getQueueStatus()).toMatchObject({ paused: false, length: 0 });
    mod.resetAemeath();
  });

  it('deliveryScope 变化时若仍有待投递日志则拒绝切换租户', async () => {
    const mod = await import('../src/singleton/index');
    const logger = mod.initAemeath({
      upload: async () => ({ success: true }),
      deliveryScope: 'tenant-a',
      offlinePersistence: false,
    });
    mod.setUpload(null);
    logger.error('tenant-a-secret');
    await settle(8);

    expect(() => mod.setUpload(async () => ({ success: true }), { deliveryScope: 'tenant-b' }))
      .toThrow(/Refusing to switch upload deliveryScope/);
    mod.resetAemeath();
  });

  it('onDrop 从 initAemeath 传下去后能收到 payload-too-large', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onDrop = vi.fn();
    const mod = await import('../src/singleton/index');
    const logger = mod.initAemeath({
      upload: async () => ({ success: true }),
      errorCapture: false,
      safeGuard: { enabled: false },
      enableConsole: false,
      payloadSanitize: { maxBytes: 1500 },
      onDrop,
    });

    logger.error('too big', { context: { huge: 'x'.repeat(9000) } });

    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop.mock.calls[0]![1]).toMatchObject({ reason: 'payload-too-large' });

    mod.resetAemeath();
  });

  it('增量初始化：第二次带上 offlinePersistence 也要装上，且不重复装', async () => {
    const mod = await import('../src/singleton/index');
    mod.initAemeath({ errorCapture: false, safeGuard: { enabled: false }, enableConsole: false });
    const logger = mod.initAemeath({
      upload: async () => ({ success: true }),
      offlinePersistence: true,
    });

    expect(logger.hasPlugin('offline-persistence')).toBe(true);
    expect(logger.hasPlugin('payload-sanitize')).toBe(false);

    mod.initAemeath({ offlinePersistence: true });
    const names = logger.getPlugins().map((p) => p.name);
    expect(names.filter((n) => n === 'offline-persistence')).toHaveLength(1);

    mod.resetAemeath();
  });

  it('增量初始化：UploadPlugin 已存在时，后补的 offlinePersistence 也要生效', async () => {
    const mod = await import('../src/singleton/index');
    mod.initAemeath({
      upload: async () => ({ success: true }),
      errorCapture: false,
      safeGuard: { enabled: false },
      enableConsole: false,
    });

    const logger = mod.initAemeath({ offlinePersistence: true });
    expect(logger.hasPlugin('offline-persistence')).toBe(true);

    mod.resetAemeath();
  });

  it('getAemeath() 兜底路径默认不装 PayloadSanitizePlugin', async () => {
    const mod = await import('../src/singleton/index');
    const logger = mod.getAemeath();
    expect(logger.hasPlugin('payload-sanitize')).toBe(false);
    mod.resetAemeath();
  });

  it('getAemeath() 之后显式 payloadSanitize: true 必须能装上', async () => {
    const mod = await import('../src/singleton/index');
    mod.getAemeath();

    const logger = mod.initAemeath({ payloadSanitize: true });
    expect(logger.hasPlugin('payload-sanitize')).toBe(true);

    mod.resetAemeath();
  });

  it('增量初始化不把随 UploadPlugin 生效的选项报成"已忽略"', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await import('../src/singleton/index');
    mod.getAemeath();

    mod.initAemeath({
      upload: async () => ({ success: true }),
      onDrop: () => {},
      cache: { enabled: false },
    });

    const ignoredWarning = warn.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('were ignored'));
    expect(ignoredWarning ?? '').not.toMatch(/onDrop|cache/);

    mod.resetAemeath();
  });

  it('增量初始化：后续可以补开 payloadSanitize', async () => {
    const mod = await import('../src/singleton/index');
    mod.initAemeath({
      errorCapture: false,
      safeGuard: { enabled: false },
      enableConsole: false,
    });

    const logger = mod.initAemeath({ payloadSanitize: true });
    expect(logger.hasPlugin('payload-sanitize')).toBe(true);

    mod.resetAemeath();
  });

  it('queue.offlinePolicy 默认 pause', async () => {
    const mod = await import('../src/singleton/index');
    const logger = mod.initAemeath({
      upload: async () => ({ success: false, shouldRetry: true, retryReason: 'network' }),
      errorCapture: false,
      safeGuard: { enabled: false },
      enableConsole: false,
      queue: { maxRetries: 1, suspectedOfflineThreshold: 1 },
    });

    logger.error('legacy path');
    await settle(30);

    const upload = logger.getPluginInstance('upload') as unknown as {
      getQueueStatus(): { paused: boolean; drops: { total: number } };
    };
    expect(upload.getQueueStatus().paused).toBe(true);

    mod.resetAemeath();
  });

  it('显式 queue.offlinePolicy: legacy 可恢复旧行为', async () => {
    const mod = await import('../src/singleton/index');
    const logger = mod.initAemeath({
      upload: async () => ({ success: false, shouldRetry: true, retryReason: 'network' }),
      errorCapture: false,
      safeGuard: { enabled: false },
      enableConsole: false,
      queue: { offlinePolicy: 'legacy', maxRetries: 1, suspectedOfflineThreshold: 1 },
    });

    logger.error('pause path');
    await settle(30);

    const upload = logger.getPluginInstance('upload') as unknown as {
      getQueueStatus(): { paused: boolean };
    };
    expect(upload.getQueueStatus().paused).toBe(false);

    mod.resetAemeath();
  });
});
