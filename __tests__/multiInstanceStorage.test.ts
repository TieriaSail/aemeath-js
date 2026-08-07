/**
 * 同一个页面上两个 SDK 实例
 *
 * 现实场景：宿主站自己接了 aemeath，页面里嵌的第三方组件 / 微前端子应用
 * 也接了 aemeath，两边是**不同的项目、不同的上报地址**。
 *
 * 缓存 key 和离线库名都有确定性默认值，两个实例默认就会撞在一起。
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin, type UploadResult } from '../src/plugins/UploadPlugin';

const settle = async (times = 20): Promise<void> => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 10));
};

describe('一个页面两个实例，默认配置', () => {
  beforeEach(() => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('各自配了 cache.key 之后，A 的日志不会被 B 的实例上报走', async () => {
    // ---- 第一次访问：只有 A 在跑，网络挂了，日志留在缓存里 ----
    const loggerA = new AemeathLogger({ enableConsole: false });
    const uploadA = vi.fn(async (): Promise<UploadResult> => {
      throw new TypeError('Failed to fetch');
    });
    const pluginA = new UploadPlugin({
      onUpload: uploadA,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, uploadInterval: 100000 },
      cache: { key: 'project-a-queue' },
      saveOnUnload: true,
    });
    loggerA.use(pluginA);
    loggerA.error('project-A-secret');
    await settle();
    pluginA.uninstall(loggerA as never);
    loggerA.destroy();

    expect(localStorage.getItem('project-a-queue')).toContain('project-A-secret');

    // ---- 第二次访问：页面上换成了 B 项目的实例 ----
    const loggerB = new AemeathLogger({ enableConsole: false });
    const deliveredToB: string[] = [];
    const uploadB = vi.fn(async (log: { message: string }): Promise<UploadResult> => {
      deliveredToB.push(log.message);
      return { success: true };
    });
    const pluginB = new UploadPlugin({
      onUpload: uploadB as never,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0 },
      cache: { key: 'project-b-queue' },
      saveOnUnload: false,
    });
    loggerB.use(pluginB);
    await settle();
    loggerB.destroy();

    // A 项目的日志绝不该出现在 B 项目的上报地址上
    expect(deliveredToB).not.toContain('project-A-secret');
  });

  it('两个实例同时在跑时，第二个让出缓存并给出可操作的警告', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loggerA = new AemeathLogger({ enableConsole: false });
    const loggerB = new AemeathLogger({ enableConsole: false });
    const hang = async (): Promise<UploadResult> => {
      throw new TypeError('Failed to fetch');
    };

    const pluginA = new UploadPlugin({
      onUpload: hang,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, uploadInterval: 100000 },
      saveOnUnload: false,
    });
    const pluginB = new UploadPlugin({
      onUpload: hang,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, uploadInterval: 100000 },
      saveOnUnload: false,
    });
    loggerA.use(pluginA);
    loggerB.use(pluginB);

    loggerA.error('from-A');
    loggerB.error('from-B');
    await settle();

    pluginA.uninstall(loggerA as never);
    pluginB.uninstall(loggerB as never);

    const cached = localStorage.getItem('__logger_upload_queue__') ?? '';
    // 先到的实例保住缓存；后到的让位，绝不能把先到的抹掉
    expect(cached).toContain('from-A');
    expect(cached).not.toContain('from-B');

    const text = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(text).toContain('cache key');
    expect(text).toContain('cache.key');

    warn.mockRestore();
    loggerA.destroy();
    loggerB.destroy();
  });

  it('让位是暂时的：撞车方走人后重装，缓存要能重新打开', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loggerA = new AemeathLogger({ enableConsole: false });
    const loggerB = new AemeathLogger({ enableConsole: false });
    const hang = async (): Promise<UploadResult> => {
      throw new TypeError('Failed to fetch');
    };
    const pluginA = new UploadPlugin({ onUpload: hang, queue: { offlinePolicy: 'pause', deduplicationDelay: 0, uploadInterval: 100000 }, saveOnUnload: false });
    const pluginB = new UploadPlugin({ onUpload: hang, queue: { offlinePolicy: 'pause', deduplicationDelay: 0, uploadInterval: 100000 }, saveOnUnload: false });

    loggerA.use(pluginA);
    loggerB.use(pluginB); // B 让位

    pluginA.uninstall(loggerA as never); // A 走人，key 归还
    pluginB.uninstall(loggerB as never);

    // 换个 logger 重装（use() 对同名插件是幂等的，同一个 logger 装不进去）
    const loggerB2 = new AemeathLogger({ enableConsole: false });
    loggerB2.use(pluginB); // 此时无人竞争，缓存应重新打开

    loggerB2.error('from-B-later');
    await settle();
    pluginB.uninstall(loggerB2 as never);
    loggerB2.destroy();

    const cached = localStorage.getItem('__logger_upload_queue__') ?? '';
    expect(cached).toContain('from-B-later');

    vi.mocked(console.warn).mockRestore();
    loggerA.destroy();
    loggerB.destroy();
  });

  it('两个离线插件共用一个库时，第二个不接管存储', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { OfflinePersistencePlugin } = await import('../src/plugins/OfflinePersistencePlugin');
    const loggerA = new AemeathLogger({ enableConsole: false });
    const loggerB = new AemeathLogger({ enableConsole: false });

    const offA = new OfflinePersistencePlugin();
    const offB = new OfflinePersistencePlugin();
    loggerA.use(offA);
    loggerB.use(offB);
    await offA.whenReady();
    await offB.whenReady();

    expect(offA.getStatus().backend).not.toBe('noop');
    expect(offB.getStatus().backend).toBe('noop');

    const text = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(text).toContain('dbName');

    warn.mockRestore();
    loggerA.destroy();
    loggerB.destroy();
  });
});
