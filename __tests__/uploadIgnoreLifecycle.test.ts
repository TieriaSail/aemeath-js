/**
 * UploadPlugin ignore 窗口生命周期
 *
 * 1. 同步 onUpload 抛错不能泄漏全局忽略计数，也不能静默丢掉队列项。
 * 2. uninstall 时若 onUpload 仍挂起，必须揭开本实例持有的忽略窗口，
 *    否则 NetworkPlugin 仍在时整页业务抓包永久致盲。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  shouldIgnoreNetworkCapture,
  _resetIgnoreNetworkCapture,
} from '../src/utils/ignoreNetworkCapture';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin } from '../src/plugins/UploadPlugin';
import { NetworkPlugin } from '../src/plugins/NetworkPlugin';

describe('UploadPlugin ignore 窗口生命周期', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    _resetIgnoreNetworkCapture();
    logger = new AemeathLogger({ enableConsole: false });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    logger.destroy();
    _resetIgnoreNetworkCapture();
    vi.restoreAllMocks();
  });

  it('同步 onUpload 抛错会释放忽略窗口，并走失败/丢弃路径', async () => {
    const dropped: string[] = [];
    const upload = new UploadPlugin({
      onUpload: () => {
        throw new Error('sync boom');
      },
      queue: { deduplicationDelay: 0, maxRetries: 0, offlinePolicy: 'legacy' },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (_log, info) => {
        dropped.push(info.reason);
      },
    });
    logger.use(upload);

    logger.error('sync-throw');
    await new Promise((r) => setTimeout(r, 40));

    expect(shouldIgnoreNetworkCapture()).toBe(false);
    expect(dropped).toContain('max-retries');
  });

  it('只卸 Upload 时，飞行中的 drop 仍能经 emitTarget 发出', async () => {
    let rejectUpload!: (e: Error) => void;
    const upload = new UploadPlugin({
      onUpload: () =>
        new Promise((_resolve, reject) => {
          rejectUpload = reject;
        }),
      queue: { deduplicationDelay: 0, maxRetries: 0, offlinePolicy: 'legacy' },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(upload);

    const drops: string[] = [];
    logger.on('upload:drop', (...args: unknown[]) => {
      const p = args[0] as { log?: { message?: string } };
      if (p.log?.message) drops.push(p.log.message);
    });

    logger.error('drop-after-upload-uninstall');
    await new Promise((r) => setTimeout(r, 20));
    upload.uninstall(logger);
    rejectUpload(new Error('gone'));
    await new Promise((r) => setTimeout(r, 40));

    expect(drops).toContain('drop-after-upload-uninstall');
  });

  it('只卸 Upload 时，飞行中的 success 仍能经 emitTarget 发出', async () => {
    let resolveUpload!: (v: { success: true }) => void;
    const upload = new UploadPlugin({
      onUpload: () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
      queue: { deduplicationDelay: 0, maxRetries: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(upload);

    const successes: string[] = [];
    logger.on('upload:success', (...args: unknown[]) => {
      const p = args[0] as { log?: { message?: string } };
      if (p.log?.message) successes.push(p.log.message);
    });

    logger.error('emit-after-upload-uninstall');
    await new Promise((r) => setTimeout(r, 20));

    // Offline 仍可能挂在 logger 上听事件；此处只卸 Upload
    upload.uninstall(logger);
    resolveUpload({ success: true });
    await new Promise((r) => setTimeout(r, 20));

    expect(successes).toContain('emit-after-upload-uninstall');
  });

  it('卸载后飞行中的可重试失败落定时会释放最后一个 logger 引用', async () => {
    let rejectUpload!: (error: Error) => void;
    const upload = new UploadPlugin({
      onUpload: () =>
        new Promise((_resolve, reject) => {
          rejectUpload = reject;
        }),
      queue: { deduplicationDelay: 0, maxRetries: 3, offlinePolicy: 'pause' },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(upload);

    logger.error('retryable-after-uninstall');
    await new Promise((resolve) => setTimeout(resolve, 20));
    upload.uninstall(logger);
    rejectUpload(new Error('temporary failure'));
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(upload.getQueueStatus().inFlight).toBe(0);
    expect((upload as unknown as { emitTarget: unknown }).emitTarget).toBeNull();
  });

  it('uninstall 时挂起的 onUpload 不会永久致盲 NetworkPlugin', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;

    try {
      const upload = new UploadPlugin({
        onUpload: () => new Promise(() => undefined),
        queue: { deduplicationDelay: 0, maxRetries: 0 },
        cache: { enabled: false },
        saveOnUnload: false,
      });
      logger.use(
        new NetworkPlugin({
          logTypes: ['success', 'error', 'slow'],
          captureRequestBody: false,
          captureResponseBody: false,
          urlFilter: () => true,
        }),
      );
      logger.use(upload);

      const networkLogs: string[] = [];
      logger.on('log', (...args: unknown[]) => {
        const entry = args[0] as { message?: string };
        networkLogs.push(String(entry.message));
      });

      logger.error('hanging-upload');
      await new Promise((r) => setTimeout(r, 20));
      expect(shouldIgnoreNetworkCapture()).toBe(true);

      // 只卸 Upload，NetworkPlugin 仍在
      upload.uninstall(logger);
      expect(shouldIgnoreNetworkCapture()).toBe(false);

      await fetch('/business-after-uninstall');
      await new Promise((r) => setTimeout(r, 50));

      // 忽略窗口已揭开，业务请求应能被 NetworkPlugin 记到
      expect(networkLogs.some((m) => m.includes('/business-after-uninstall'))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
