/**
 * 2.4 ↔ 2.5 的缓存互操作
 *
 * 升级和回滚都会让两个版本读到对方写的 localStorage 条目（key 是同一个确定性常量）：
 *
 * - **升级**：2.4 攒下的待发日志必须能被 2.5 恢复。2.4 没写 `cachedAt`，
 *   若 2.5 拿 `undefined` 去算年龄，所有老日志会被当成过期一把清掉 ——
 *   用户升级一次就丢一次待发队列。
 * - **回滚**：2.5 发现问题被回退到 2.4 时，2.4 必须能读懂 2.5 写的条目。
 *   多出来的字段可以忽略，但缺了 2.4 依赖的字段就会崩在恢复流程里。
 *
 * 这两条都是"升级动作本身造成数据丢失"，属于最难向用户交代的一类。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin, type UploadResult } from '../src/plugins/UploadPlugin';

const CACHE_KEY = '__logger_upload_queue__';

const settle = async (n = 25): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 10));
};

/** 一条完全按 2.4 格式写出来的缓存条目：没有 cachedAt，也没有 source */
function legacyEntry(message: string, ageMs: number): unknown {
  const ts = Date.now() - ageMs;
  return {
    log: {
      logId: `legacy-${message}`,
      level: 'error',
      message,
      timestamp: ts,
    },
    priority: 100,
    retryCount: 0,
    timestamp: ts,
  };
}

describe('2.4 → 2.5 升级：老缓存必须能恢复', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    localStorage.clear();
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
    localStorage.clear();
  });

  it('2.4 写的缓存（没有 cachedAt）不能被 2.5 当成过期日志清空', async () => {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify([legacyEntry('legacy-a', 1000), legacyEntry('legacy-b', 60_000)])
    );

    const uploaded: string[] = [];
    const plugin = new UploadPlugin({
      onUpload: (async (log: { message: string }): Promise<UploadResult> => {
        uploaded.push(log.message);
        return { success: true };
      }) as never,
      queue: { deduplicationDelay: 0 },
      saveOnUnload: false,
    });
    logger.use(plugin);
    await settle();

    expect(uploaded).toContain('legacy-a');
    expect(uploaded).toContain('legacy-b');
  });

  it('2.4 缓存里真正过期的条目仍然按 TTL 丢弃，并且能报出来', async () => {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify([legacyEntry('too-old', 7_200_000), legacyEntry('still-fresh', 1000)])
    );

    const uploaded: string[] = [];
    const dropped: string[] = [];
    const plugin = new UploadPlugin({
      onUpload: (async (log: { message: string }): Promise<UploadResult> => {
        uploaded.push(log.message);
        return { success: true };
      }) as never,
      queue: { deduplicationDelay: 0 },
      saveOnUnload: false,
      onDrop: (log, info) => {
        if (info.reason === 'cache-expired') dropped.push(log.message);
      },
    });
    logger.use(plugin);
    await settle();

    expect(uploaded).toEqual(['still-fresh']);
    expect(dropped).toEqual(['too-old']);
  });

  it('2.4 缓存里 retryCount 已经用掉一部分时，预算要接着算而不是清零', async () => {
    const entry = legacyEntry('half-spent', 1000) as { retryCount: number };
    entry.retryCount = 2;
    localStorage.setItem(CACHE_KEY, JSON.stringify([entry]));

    let attempts = 0;
    const plugin = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => {
        attempts++;
        return { success: false, shouldRetry: true, retryReason: 'server', error: 'nope' };
      },
      queue: { deduplicationDelay: 0, maxRetries: 3, retryBackoff: false },
      saveOnUnload: false,
    });
    logger.use(plugin);
    await settle(60);

    // 预算是 3，已经用掉 2，最多再试 1~2 次就该丢弃，绝不能从头再来
    expect(attempts).toBeLessThanOrEqual(2);
  });
});

describe('2.4 → 2.5 升级：默认行为不能悄悄改变', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    localStorage.clear();
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
    localStorage.clear();
  });

  it('普通体量的日志经过默认清洗后必须一字不变', async () => {
    // PayloadSanitizePlugin 是 2.5 新增且**默认开启**的。对老用户来说这是
    // 一次无声的行为变更：如果它对正常日志也动手（截断、替换 Data URL、
    // 改 logId），后端拿到的数据就和 2.4 不一样了，而没人会预料到。
    const { PayloadSanitizePlugin } = await import('../src/plugins/PayloadSanitizePlugin');
    const received: Array<Record<string, unknown>> = [];
    const plugin = new UploadPlugin({
      onUpload: (async (log: Record<string, unknown>): Promise<UploadResult> => {
        received.push(log);
        return { success: true };
      }) as never,
      queue: { deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(new PayloadSanitizePlugin());
    logger.use(plugin);

    const context = {
      userId: 'u-123',
      route: '/checkout/payment',
      // 小尺寸 Data URL：远在预算之内，不该被动
      avatar: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
      nested: { a: 1, b: [1, 2, 3], c: '一些中文说明' },
    };
    logger.error('payment failed', { context, tags: { biz: 'checkout' } });
    await settle();

    expect(received).toHaveLength(1);
    const got = received[0]!;
    expect(got.message).toBe('payment failed');
    expect(got.context).toEqual(context);
    expect((got.tags as Record<string, unknown>).biz).toBe('checkout');
    // 不该被打上任何拆分标记
    expect((got.tags as Record<string, unknown>).splitId).toBeUndefined();
  });

  it('默认预算下，一条相当大的日志仍然整条送出，不会被拆', async () => {
    const { PayloadSanitizePlugin } = await import('../src/plugins/PayloadSanitizePlugin');
    const received: Array<Record<string, unknown>> = [];
    const plugin = new UploadPlugin({
      onUpload: (async (log: Record<string, unknown>): Promise<UploadResult> => {
        received.push(log);
        return { success: true };
      }) as never,
      queue: { deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(new PayloadSanitizePlugin());
    logger.use(plugin);

    // 10KB 的堆栈 + 上下文，对监控日志来说已经偏大，但仍应低于 60KB 默认预算
    logger.error('big but normal', { context: { stack: 'at foo (bar.js:1:1)\n'.repeat(400) } });
    await settle();

    expect(received).toHaveLength(1);
    expect((received[0]!.tags as Record<string, unknown> | undefined)?.splitId).toBeUndefined();
  });
});

describe('2.5 → 2.4 回滚：新缓存不能让老版本崩', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    localStorage.clear();
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
    localStorage.clear();
  });

  it('2.5 写出的每一条都要满足 2.4 恢复流程依赖的字段', async () => {
    const plugin = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => ({
        success: false,
        shouldRetry: true,
        retryReason: 'server',
        error: 'hold',
      }),
      queue: { deduplicationDelay: 0, uploadInterval: 100000 },
      cache: { enabled: true },
      saveOnUnload: false,
    });
    logger.use(plugin);
    logger.error('will be cached', { context: { k: 'v' } });
    await settle();
    plugin.uninstall(logger as never);

    const raw = localStorage.getItem(CACHE_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as Array<Record<string, unknown>>;
    expect(parsed.length).toBeGreaterThan(0);

    for (const item of parsed) {
      // 2.4 的 restoreFromCache 会读这四个字段，缺一个就会在恢复时出问题
      expect(item).toHaveProperty('log');
      expect(item).toHaveProperty('priority');
      expect(item).toHaveProperty('retryCount');
      expect(item).toHaveProperty('timestamp');
      expect(typeof item.timestamp).toBe('number');
      expect((item.log as { logId?: string }).logId).toBeTruthy();
      // 2.4 按 `now - timestamp < 1h` 过滤，timestamp 必须是入队时刻而不是别的
      expect(Date.now() - (item.timestamp as number)).toBeLessThan(60 * 60 * 1000);
    }
  });

  it('2.5 的拆分分片回滚到 2.4 后仍是合法条目（各自独立上报，不会崩）', async () => {
    const { PayloadSanitizePlugin } = await import('../src/plugins/PayloadSanitizePlugin');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const plugin = new UploadPlugin({
      onUpload: async (): Promise<UploadResult> => ({
        success: false,
        shouldRetry: true,
        retryReason: 'server',
        error: 'hold',
      }),
      queue: { deduplicationDelay: 0, uploadInterval: 100000 },
      cache: { enabled: true },
      saveOnUnload: false,
    });
    logger.use(new PayloadSanitizePlugin({ maxBytes: 2000 }));
    logger.use(plugin);
    logger.error('split then rollback', {
      context: { a: 'x'.repeat(1200), b: 'y'.repeat(1200), c: 'z'.repeat(1200) },
    });
    await settle();
    plugin.uninstall(logger as never);

    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY)!) as Array<Record<string, unknown>>;
    expect(parsed.length).toBeGreaterThan(1);
    for (const item of parsed) {
      expect(item).toHaveProperty('log');
      expect(item).toHaveProperty('timestamp');
      const log = item.log as { logId?: string; message?: string };
      // logId 必须各不相同，否则 2.4 那边按 logId 去重会把分片吃掉
      expect(log.logId).toBeTruthy();
      expect(log.message).toBeTruthy();
    }
    const ids = parsed.map((i) => (i.log as { logId: string }).logId);
    expect(new Set(ids).size).toBe(ids.length);

    vi.mocked(console.warn).mockRestore();
  });
});
