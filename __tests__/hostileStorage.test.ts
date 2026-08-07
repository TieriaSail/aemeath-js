/**
 * 充满敌意的存储环境
 *
 * 真实世界里 `localStorage` 和 `indexedDB` 不只是"用不了"，而是**碰一下就抛**：
 * Safari 隐私模式、禁用 cookie、跨域 iframe、企业策略。这类环境下连
 * `window.localStorage` 这个属性读取本身都会抛 SecurityError。
 *
 * 这里要钉死的是：SDK 在这种宿主里必须仍然把日志送出去。
 * 缓存和离线补传可以失灵 —— 那是增强功能；但主链路不能倒。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin, type UploadResult } from '../src/plugins/UploadPlugin';
import { OfflinePersistencePlugin } from '../src/plugins/OfflinePersistencePlugin';

const settle = async (times = 20): Promise<void> => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 10));
};

/** 让某个全局属性"一读就抛"，模拟 SecurityError */
function poison(name: string): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
  });
  return () => {
    if (original) Object.defineProperty(globalThis, name, original);
    else delete (globalThis as Record<string, unknown>)[name];
  };
}

describe('存储一碰就抛的宿主', () => {
  let logger: AemeathLogger;
  let restores: Array<() => void> = [];

  beforeEach(() => {
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
    restores.forEach((r) => r());
    restores = [];
  });

  it('localStorage 一读就抛时，开着缓存的上传链路依然能把日志发出去', async () => {
    restores.push(poison('localStorage'));

    const uploadFn = vi.fn(async () => ({ success: true }) as UploadResult);
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0 },
      cache: { enabled: true }, // 明确开着 —— 它会失灵，但不能拖垮上传
      saveOnUnload: true,
    });

    expect(() => logger.use(plugin)).not.toThrow();
    logger.error('hostile storage');
    await settle();

    expect(uploadFn).toHaveBeenCalledTimes(1);
  });

  it('indexedDB 与 localStorage 双双抛异常时，离线插件降级但不拖垮上传', async () => {
    restores.push(poison('indexedDB'));
    restores.push(poison('localStorage'));

    const unhandled: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent): void => {
      unhandled.push(e.reason);
      e.preventDefault();
    };
    window.addEventListener('unhandledrejection', onUnhandled);

    const uploadFn = vi.fn(async () => ({ success: true }) as UploadResult);
    const upload = new UploadPlugin({
      onUpload: uploadFn,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0 },
      cache: { enabled: true },
      saveOnUnload: false,
    });
    const offline = new OfflinePersistencePlugin({ dbName: `hostile-${Math.random()}` });

    expect(() => {
      logger.use(upload);
      logger.use(offline);
    }).not.toThrow();

    await offline.whenReady();
    logger.error('still must ship');
    await settle();

    expect(uploadFn).toHaveBeenCalledTimes(1);
    // 降级到 noop 后台，而不是卡在初始化态
    expect(offline.getStatus().backend).toBe('noop');
    expect(unhandled).toEqual([]);

    window.removeEventListener('unhandledrejection', onUnhandled);
  });

  it('页面卸载时存储抛异常，不能把 beforeunload 处理器打断', async () => {
    const uploadFn = vi.fn(async () => ({ success: true }) as UploadResult);
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0, uploadInterval: 100000 },
      cache: { enabled: true },
      saveOnUnload: true,
    });
    logger.use(plugin);
    logger.error('pending at unload');

    // 日志入队之后才下毒：装载时探测通过，卸载时才翻脸
    restores.push(poison('localStorage'));

    expect(() => window.dispatchEvent(new Event('beforeunload'))).not.toThrow();
  });

  it('存储抛异常不能被 ErrorCapturePlugin 抓成业务错误反过来再上报', async () => {
    restores.push(poison('localStorage'));

    const uploadFn = vi.fn(async () => ({ success: true }) as UploadResult);
    const plugin = new UploadPlugin({
      onUpload: uploadFn,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0 },
      cache: { enabled: true },
      saveOnUnload: false,
    });
    logger.use(plugin);

    logger.error('one log in, one log out');
    await settle();

    // 存储失败是静默降级，不该额外造出日志
    expect(uploadFn).toHaveBeenCalledTimes(1);
  });
});
