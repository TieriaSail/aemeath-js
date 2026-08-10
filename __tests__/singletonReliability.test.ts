/**
 * initAemeath 上的可靠性选项 —— 接线集成测试
 *
 * 插件本身的行为在各自的测试里已经覆盖。这里守的是**发出去的那个 API**：
 * 用户写的 `initAemeath({...})` 到底有没有把插件装上、选项有没有传进去、
 * 二次调用（增量初始化）会不会重复装或漏装。
 *
 * 单测全绿但接线漏了，用户拿到的就是一个「文档里有、实际不生效」的功能。
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

  it('未配置 upload 时默认装上 PayloadSanitizePlugin，但不空装 OfflinePersistencePlugin', async () => {
    const mod = await import('../src/singleton/index');
    const logger = mod.initAemeath();

    expect(logger.hasPlugin('payload-sanitize')).toBe(true);
    expect(logger.hasPlugin('offline-persistence')).toBe(false);

    mod.resetAemeath();
  });

  it('payloadSanitize: false 时不装', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await import('../src/singleton/index');
    const logger = mod.initAemeath({ payloadSanitize: false });

    expect(logger.hasPlugin('payload-sanitize')).toBe(false);

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

  it('配置 upload 后默认装上 OfflinePersistencePlugin，并能真的落盘+补传', async () => {
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

  it('offlinePersistence: false 可显式关闭默认持久化', async () => {
    const mod = await import('../src/singleton/index');
    const logger = mod.initAemeath({
      upload: async () => ({ success: true }),
      offlinePersistence: false,
    });

    expect(logger.hasPlugin('upload')).toBe(true);
    expect(logger.hasPlugin('offline-persistence')).toBe(false);

    const upload = logger.getPluginInstance('upload') as import('../src/plugins/UploadPlugin').UploadPlugin;
    upload.setOnUpload(async () => ({
      success: false,
      shouldRetry: true,
      retryReason: 'server',
    }));
    logger.error('memory only');
    await settle(10);
    expect(localStorage.getItem('__logger_upload_queue__')).toBeNull();

    mod.resetAemeath();
  });

  it('显式关闭后立即重开仍会清理默认 IDB 与过去降级遗留的 KV 副本', async () => {
    const now = Date.now();
    const logId = 'stale-fallback-copy';
    const record = {
      logId,
      storedAt: now,
      capturedAt: now,
      priority: 0,
      bytes: 128,
      replayAttempts: 0,
      log: {
        logId,
        level: 'error',
        message: 'must not survive explicit opt-out',
        timestamp: now,
      },
    };
    // 模拟旧会话因 IDB 不可用而写入默认 KV；当前会话 IDB 已恢复可用。
    localStorage.setItem('__aemeath_offline__:r:stale-fallback-copy', JSON.stringify(record));
    localStorage.setItem(
      '__aemeath_offline__:index',
      JSON.stringify([{ ...record, log: undefined }]),
    );

    const mod = await import('../src/singleton/index');
    const logger = mod.initAemeath({
      upload: async () => ({ success: true }),
      offlinePersistence: false,
    });
    // 不等待异步清理就重新开启，新的资源认领不能令正在进行的 purge 提前让路。
    mod.initAemeath({ offlinePersistence: true });
    const offline = logger.getPluginInstance('offline-persistence') as import('../src/plugins/OfflinePersistencePlugin').OfflinePersistencePlugin;
    await offline.whenReady();

    expect(localStorage.getItem('__aemeath_offline__:index')).toBeNull();
    expect(localStorage.getItem('__aemeath_offline__:r:stale-fallback-copy')).toBeNull();
    mod.resetAemeath();
  });

  it('先显式关闭、后增量安装 upload 时不能把持久化偷偷装回来', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await import('../src/singleton/index');
    mod.initAemeath({ offlinePersistence: false });

    const logger = mod.initAemeath({ upload: async () => ({ success: true }) });
    expect(logger.hasPlugin('upload')).toBe(true);
    expect(logger.hasPlugin('offline-persistence')).toBe(false);

    mod.resetAemeath();
  });

  it('setUpload 懒安装 UploadPlugin 时也默认安装持久化，且尊重之前的显式关闭', async () => {
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
    // 先只配置基础项（真实场景：入口先 init，登录后才补上传配置）
    mod.initAemeath({ errorCapture: false, safeGuard: { enabled: false }, enableConsole: false });
    const logger = mod.initAemeath({
      upload: async () => ({ success: true }),
      offlinePersistence: true,
    });

    expect(logger.hasPlugin('offline-persistence')).toBe(true);
    expect(logger.hasPlugin('payload-sanitize')).toBe(true);

    // 第三次再调，不能装出第二份
    mod.initAemeath({ offlinePersistence: true });
    const names = logger.getPlugins().map((p) => p.name);
    expect(names.filter((n) => n === 'offline-persistence')).toHaveLength(1);
    expect(names.filter((n) => n === 'payload-sanitize')).toHaveLength(1);

    mod.resetAemeath();
  });

  it('增量初始化：UploadPlugin 已存在时，后补的 offlinePersistence 也要生效', async () => {
    // 真实场景：入口就把 upload 配好了，离线续传是后来（读到开关 / 灰度）才打开的。
    // 如果这个选项只在"顺便新建 UploadPlugin"时才被处理，用户就会拿到一个
    // 文档里有、实际什么都没发生的开关。
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

  it('增量初始化：offlinePersistence: false 能卸载默认安装的持久化插件', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await import('../src/singleton/index');
    const logger = mod.initAemeath({ upload: async () => ({ success: true }) });
    expect(logger.hasPlugin('offline-persistence')).toBe(true);

    mod.initAemeath({ offlinePersistence: false });
    expect(logger.hasPlugin('offline-persistence')).toBe(false);

    mod.resetAemeath();
  });

  it('运行时关闭会清除已有持久副本，重新开启不会复活重复上报', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const key = `runtime-disable-${Math.random()}`;
    let online = false;
    const uploadFn = vi.fn(async (): Promise<UploadResult> => online
      ? { success: true }
      : { success: false, shouldRetry: true, retryReason: 'network' });
    const mod = await import('../src/singleton/index');
    const logger = mod.initAemeath({
      upload: uploadFn,
      offlinePersistence: { storage: 'localstorage', key },
      errorCapture: false,
      safeGuard: { enabled: false },
      enableConsole: false,
      queue: { suspectedOfflineThreshold: 1 },
    });
    const offline = logger.getPluginInstance('offline-persistence') as import('../src/plugins/OfflinePersistencePlugin').OfflinePersistencePlugin;
    await offline.whenReady();
    setOnLine(false);
    logger.error('do not resurrect');
    await settle(15);
    expect(offline.getStatus().pending).toBe(1);

    mod.initAemeath({ offlinePersistence: false });
    await settle(15);
    expect(localStorage.getItem(`${key}:index`)).toBeNull();
    expect(localStorage.getItem('__logger_upload_queue__')).toBeNull();

    online = true;
    setOnLine(true);
    const upload = logger.getPluginInstance('upload') as import('../src/plugins/UploadPlugin').UploadPlugin;
    await upload.flush();
    expect(uploadFn).toHaveBeenCalledTimes(1);

    mod.initAemeath({ offlinePersistence: { storage: 'localstorage', key } });
    const remounted = logger.getPluginInstance('offline-persistence') as import('../src/plugins/OfflinePersistencePlugin').OfflinePersistencePlugin;
    await remounted.whenReady();
    await settle(10);
    expect(uploadFn).toHaveBeenCalledTimes(1);
    expect(remounted.getStatus().pending).toBe(0);
    mod.resetAemeath();
  });

  it('增量初始化：显式关闭后一次 true 调用即可重新开启持久化', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await import('../src/singleton/index');
    const logger = mod.initAemeath({
      upload: async () => ({ success: true }),
      offlinePersistence: false,
    });
    expect(logger.hasPlugin('offline-persistence')).toBe(false);

    mod.initAemeath({ offlinePersistence: true });
    expect(logger.hasPlugin('offline-persistence')).toBe(true);

    mod.resetAemeath();
  });

  it('关闭后立即用 true 重开会等待清理完成，并恢复之前的自定义存储配置', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const key = `remembered-options-${Math.random()}`;
    const mod = await import('../src/singleton/index');
    const logger = mod.initAemeath({
      upload: async () => ({ success: true }),
      offlinePersistence: { storage: 'localstorage', key, ttl: 123_456 },
    });
    const first = logger.getPluginInstance('offline-persistence') as unknown as {
      whenReady(): Promise<void>;
      options: { key: string; ttl: number };
    };
    await first.whenReady();

    mod.initAemeath({ offlinePersistence: false });
    // 刻意不等待异步 purge：重装必须在资源级 purge 完成后再打开同一个 store。
    mod.initAemeath({ offlinePersistence: true });

    const reopened = logger.getPluginInstance('offline-persistence') as unknown as {
      whenReady(): Promise<void>;
      options: { key: string; ttl: number };
    };
    expect(reopened).toBeDefined();
    expect(reopened.options).toMatchObject({ key, ttl: 123_456 });
    await reopened.whenReady();
    mod.resetAemeath();
  });

  it('getAemeath() 兜底路径也要装上默认启用的 PayloadSanitizePlugin', async () => {
    // 早期错误正是走这条路径的。默认启用的安全网不能因为用户先调了
    // getAemeath() 而消失，否则"默认开"就要看入口而定
    const mod = await import('../src/singleton/index');
    const logger = mod.getAemeath();
    expect(logger.hasPlugin('payload-sanitize')).toBe(true);
    mod.resetAemeath();
  });

  it('getAemeath() 之后显式 payloadSanitize: false 必须真的关掉', async () => {
    // 兜底路径现在会默认装上它，那用户后续显式说"不要"就必须能撤销 ——
    // 只装不卸的话，这个开关对走过 getAemeath() 的用户永远失效
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await import('../src/singleton/index');
    mod.getAemeath();

    const logger = mod.initAemeath({ payloadSanitize: false });
    expect(logger.hasPlugin('payload-sanitize')).toBe(false);

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

  it('增量初始化：首次关掉 payloadSanitize，后续可以补开', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await import('../src/singleton/index');
    mod.initAemeath({
      payloadSanitize: false,
      errorCapture: false,
      safeGuard: { enabled: false },
      enableConsole: false,
    });

    const logger = mod.initAemeath({ payloadSanitize: true });
    expect(logger.hasPlugin('payload-sanitize')).toBe(true);

    mod.resetAemeath();
  });

  it('queue.offlinePolicy 等新配置能透传到 UploadPlugin', async () => {
    const mod = await import('../src/singleton/index');
    const logger = mod.initAemeath({
      upload: async () => ({ success: false, shouldRetry: true, retryReason: 'network' }),
      errorCapture: false,
      safeGuard: { enabled: false },
      enableConsole: false,
      queue: { offlinePolicy: 'legacy', maxRetries: 1 },
    });

    logger.error('legacy path');
    await settle(30);

    const upload = logger.getPluginInstance('upload') as unknown as {
      getQueueStatus(): { paused: boolean; drops: { total: number } };
    };
    // legacy 明确不暂停：配置没透传的话默认 'pause' 会让这里是 true
    expect(upload.getQueueStatus().paused).toBe(false);

    mod.resetAemeath();
  });
});
