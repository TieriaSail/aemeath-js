import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  runWithoutNetworkCapture,
  shouldIgnoreNetworkCapture,
  _resetIgnoreNetworkCapture,
} from '../src/utils/ignoreNetworkCapture';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin } from '../src/plugins/UploadPlugin';
import { NetworkPlugin } from '../src/plugins/NetworkPlugin';

describe('ignoreNetworkCapture', () => {
  beforeEach(() => {
    _resetIgnoreNetworkCapture();
  });

  afterEach(() => {
    _resetIgnoreNetworkCapture();
  });

  it('窗口内 shouldIgnore 为真，settle 后恢复', async () => {
    expect(shouldIgnoreNetworkCapture()).toBe(false);
    await runWithoutNetworkCapture(async () => {
      expect(shouldIgnoreNetworkCapture()).toBe(true);
      await Promise.resolve();
      expect(shouldIgnoreNetworkCapture()).toBe(true);
    });
    expect(shouldIgnoreNetworkCapture()).toBe(false);
  });

  it('嵌套 / 并发用引用计数，不会提前揭开', async () => {
    const a = runWithoutNetworkCapture(async () => {
      await new Promise((r) => setTimeout(r, 30));
      expect(shouldIgnoreNetworkCapture()).toBe(true);
    });
    const b = runWithoutNetworkCapture(async () => {
      expect(shouldIgnoreNetworkCapture()).toBe(true);
      await new Promise((r) => setTimeout(r, 5));
    });
    await Promise.all([a, b]);
    expect(shouldIgnoreNetworkCapture()).toBe(false);
  });

  it('同步抛出也会复位计数', async () => {
    await expect(
      runWithoutNetworkCapture(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(shouldIgnoreNetworkCapture()).toBe(false);
  });
});

describe('上报期间的 fetch 不被 NetworkPlugin 记录', () => {
  const originalFetch = globalThis.fetch;
  let logger: AemeathLogger;

  beforeEach(() => {
    _resetIgnoreNetworkCapture();
    logger = new AemeathLogger({ enableConsole: false });
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;
  });

  afterEach(() => {
    logger.destroy();
    globalThis.fetch = originalFetch;
    _resetIgnoreNetworkCapture();
  });

  it('忽略窗口内发起的 fetch 不产生网络日志', async () => {
    const logListener = vi.fn();
    logger.on('log', logListener);

    // 先挂 mock，再装 NetworkPlugin（安装时会 monkeypatch 当前 window.fetch）
    logger.use(
      new NetworkPlugin({
        logTypes: ['success', 'error', 'slow'],
        captureRequestBody: false,
        captureResponseBody: false,
        // 放行测试 URL，避免默认 exclude 掉 /api/logs 一类路径
        urlFilter: () => true,
      }),
    );

    await runWithoutNetworkCapture(async () => {
      await fetch('/collect', { method: 'POST', body: '{}' });
    });
    await fetch('/business', { method: 'GET' });

    await new Promise((r) => setTimeout(r, 50));

    const messages = logListener.mock.calls.map((c) => String(c[0]?.message ?? ''));
    expect(messages.some((m) => m.includes('/collect'))).toBe(false);
    expect(messages.some((m) => m.includes('/business'))).toBe(true);
  });
});

describe('UploadPlugin × NetworkPlugin：不能滚成自反馈环', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    _resetIgnoreNetworkCapture();
    localStorage.clear();
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetIgnoreNetworkCapture();
    localStorage.clear();
  });

  it('一条业务日志不应再派生出描述自身上报的网络日志', async () => {
    const uploaded: string[] = [];
    const logger = new AemeathLogger({ enableConsole: false });

    logger.use(
      new NetworkPlugin({
        logTypes: ['success', 'error', 'slow'],
        captureRequestBody: true,
        captureResponseBody: false,
        urlFilter: () => true,
      }),
    );
    logger.use(
      new UploadPlugin({
        onUpload: async (log) => {
          uploaded.push(log.message);
          await fetch('/v2/telemetry', {
            method: 'POST',
            body: JSON.stringify(log),
          });
          return { success: true };
        },
        queue: { uploadInterval: 50, deduplicationDelay: 0 },
        cache: { enabled: false },
        saveOnUnload: false,
      }),
    );

    logger.error('single business error');
    await new Promise((r) => setTimeout(r, 800));

    const selfLogs = uploaded.filter((m) => m.includes('/v2/telemetry'));
    expect(selfLogs, `自产网络日志：${JSON.stringify(selfLogs)}`).toHaveLength(0);
    expect(uploaded.filter((m) => m === 'single business error').length).toBe(1);

    logger.destroy();
  });
});
