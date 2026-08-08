/**
 * 上传超时 × ignore 窗口
 *
 * 2.5 固定 UPLOAD_TIMEOUT_MS = 30s：
 * - 超时只结束等待，队列继续；
 * - 忽略窗口再宽限一段（避免迟到上报 I/O 被 NetworkPlugin 记成自反馈），
 *   到期或 onUpload settle 后揭开；
 * - uninstall 仍会强制揭开。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  shouldIgnoreNetworkCapture,
  _resetIgnoreNetworkCapture,
} from '../src/utils/ignoreNetworkCapture';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin } from '../src/plugins/UploadPlugin';

describe('upload timeout × ignoreNetworkCapture', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    vi.useFakeTimers();
    _resetIgnoreNetworkCapture();
    logger = new AemeathLogger({ enableConsole: false });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    logger.destroy();
    _resetIgnoreNetworkCapture();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('超时后短暂宽限内仍忽略；宽限结束揭开，不能永久致盲', async () => {
    const upload = new UploadPlugin({
      onUpload: () => new Promise(() => undefined),
      queue: {
        deduplicationDelay: 0,
        maxRetries: 0,
        offlinePolicy: 'legacy',
      },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(upload);

    logger.error('hanging');
    await vi.advanceTimersByTimeAsync(10);
    expect(shouldIgnoreNetworkCapture()).toBe(true);

    // 已超时，但宽限未到：仍应忽略（挡住迟到的上报 I/O）
    await vi.advanceTimersByTimeAsync(30_000);
    expect(shouldIgnoreNetworkCapture()).toBe(true);

    // 宽限结束（再一个 UPLOAD_TIMEOUT_MS）后必须揭开
    await vi.advanceTimersByTimeAsync(30_000);
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
        offlinePolicy: 'legacy',
      },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(upload);

    logger.error('late-ok');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(shouldIgnoreNetworkCapture()).toBe(true);

    resolveUpload({ success: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(shouldIgnoreNetworkCapture()).toBe(false);
  });

  it('uninstall 强制揭开仍挂起的忽略窗口', async () => {
    const upload = new UploadPlugin({
      onUpload: () => new Promise(() => undefined),
      queue: { deduplicationDelay: 0, offlinePolicy: 'legacy' },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(upload);
    logger.error('stuck');
    await vi.advanceTimersByTimeAsync(10);
    expect(shouldIgnoreNetworkCapture()).toBe(true);

    upload.uninstall(logger);
    expect(shouldIgnoreNetworkCapture()).toBe(false);
  });
});
