import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  runWithoutNetworkCapture,
  shouldIgnoreNetworkCapture,
  _resetIgnoreNetworkCapture,
} from '../src/utils/ignoreNetworkCapture';
import { instrumentFetch, _resetFetchInstrumentation } from '../src/instrumentation/fetch';
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
      })
    ).rejects.toThrow('boom');
    expect(shouldIgnoreNetworkCapture()).toBe(false);
  });
});

describe('上报期间的 fetch 不被插桩层记录', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    _resetIgnoreNetworkCapture();
    _resetFetchInstrumentation();
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetFetchInstrumentation();
    _resetIgnoreNetworkCapture();
  });

  it('忽略窗口内发起的 fetch 不通知订阅者', async () => {
    const events: unknown[] = [];
    instrumentFetch((e) => events.push(e), {
      shouldCapture: () => true,
      captureRequestBody: false,
      captureResponseBody: false,
      maxResponseBodySize: 0,
      responseBodyCaptureTimeout: 0,
    });

    await runWithoutNetworkCapture(async () => {
      await fetch('/collect', { method: 'POST', body: '{}' });
    });
    await fetch('/business', { method: 'GET' });

    // 给异步通知一点时间
    await new Promise((r) => setTimeout(r, 50));

    expect(events).toHaveLength(1);
    expect((events[0] as { url: string }).url).toContain('/business');
  });
});

describe('UploadPlugin × NetworkPlugin：不能滚成自反馈环', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    _resetIgnoreNetworkCapture();
    _resetFetchInstrumentation();
    localStorage.clear();
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetFetchInstrumentation();
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
      })
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
      })
    );

    logger.error('single business error');
    await new Promise((r) => setTimeout(r, 800));

    const selfLogs = uploaded.filter((m) => m.includes('/v2/telemetry'));
    expect(selfLogs, `自产网络日志：${JSON.stringify(selfLogs)}`).toHaveLength(0);
    expect(uploaded.filter((m) => m === 'single business error').length).toBe(1);

    logger.destroy();
  });
});
