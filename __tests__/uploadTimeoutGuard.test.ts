/**
 * 上传超时 × ignore 窗口
 *
 * 1.10.1 默认 30 秒超时；显式设为 0 可关闭。开启时：
 * - 超时只结束等待，队列继续；
 * - 忽略窗口再宽限一段（避免迟到上报 I/O 被 NetworkPlugin 记成自反馈），
 *   到期或 onUpload settle 后揭开；
 * - uninstall 仍会强制揭开（见 uploadIgnoreLifecycle）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  shouldIgnoreNetworkCapture,
  _resetIgnoreNetworkCapture,
} from '../src/utils/ignoreNetworkCapture';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin } from '../src/plugins/UploadPlugin';

describe('uploadTimeoutMs × ignoreNetworkCapture', () => {
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

  it('显式 0 不限制：慢回调仍算成功', async () => {
    let resolveUpload!: (v: { success: true }) => void;
    const upload = new UploadPlugin({
      onUpload: () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
      queue: { deduplicationDelay: 0, maxRetries: 0, uploadTimeoutMs: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(upload);

    const drops: string[] = [];
    logger.on('upload:drop', (...args: unknown[]) => {
      const p = args[0] as { reason?: string };
      if (p.reason) drops.push(p.reason);
    });

    logger.error('slow');
    await new Promise((r) => setTimeout(r, 20));
    expect(shouldIgnoreNetworkCapture()).toBe(true);

    resolveUpload({ success: true });
    await upload.flush();
    expect(drops).toEqual([]);
    expect(shouldIgnoreNetworkCapture()).toBe(false);
  });

  it('超时后短暂宽限内仍忽略；宽限结束或 settle 后揭开', async () => {
    let resolveUpload!: (v: { success: true }) => void;
    const upload = new UploadPlugin({
      onUpload: () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
      queue: {
        deduplicationDelay: 0,
        maxRetries: 0,
        uploadTimeoutMs: 30,
        offlinePolicy: 'legacy',
      },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(upload);

    logger.error('hanging');
    await new Promise((r) => setTimeout(r, 10));
    expect(shouldIgnoreNetworkCapture()).toBe(true);

    // 已超时，但宽限未到：仍应忽略（挡住迟到的上报 I/O）
    await new Promise((r) => setTimeout(r, 40));
    expect(shouldIgnoreNetworkCapture()).toBe(true);

    // 宽限结束（再一个 uploadTimeoutMs）后必须揭开，不能永久致盲
    await new Promise((r) => setTimeout(r, 40));
    expect(shouldIgnoreNetworkCapture()).toBe(false);

    resolveUpload({ success: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(shouldIgnoreNetworkCapture()).toBe(false);
  });

  it('超时后 onUpload 提前 settle 时立刻揭开忽略窗口', async () => {
    let resolveUpload!: (v: { success: true }) => void;
    const upload = new UploadPlugin({
      onUpload: () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
      queue: {
        deduplicationDelay: 0,
        maxRetries: 0,
        uploadTimeoutMs: 30,
        offlinePolicy: 'legacy',
      },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(upload);

    logger.error('late-ok');
    await new Promise((r) => setTimeout(r, 50));
    expect(shouldIgnoreNetworkCapture()).toBe(true);

    resolveUpload({ success: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(shouldIgnoreNetworkCapture()).toBe(false);
  });

  it('超时在 legacy 下会消耗重试并最终丢弃', async () => {
    const dropped: string[] = [];
    const plugin = new UploadPlugin({
      onUpload: () => new Promise(() => undefined),
      queue: {
        deduplicationDelay: 0,
        maxRetries: 0,
        uploadTimeoutMs: 20,
        offlinePolicy: 'legacy',
      },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (_log, info) => {
        dropped.push(info.reason);
      },
    });
    logger.use(plugin);
    logger.error('never settles');
    await new Promise((r) => setTimeout(r, 80));
    expect(dropped).toContain('max-retries');
    expect(shouldIgnoreNetworkCapture()).toBe(false);
  });
});
