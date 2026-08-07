/**
 * 端到端数据完整性：清洗 / 上传 / 离线持久化三者的交互
 *
 * 这一组盯的是"没人单独出错，但合起来就丢数据或重复上报"的问题。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UploadPlugin, type UploadResult } from '../src/plugins/UploadPlugin';
import { PayloadSanitizePlugin } from '../src/plugins/PayloadSanitizePlugin';
import { BeforeSendPlugin } from '../src/plugins/BeforeSendPlugin';
import { AemeathLogger } from '../src/core/Logger';
import type { LogEntry } from '../src/types';

function setOnLine(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', {
    value,
    configurable: true,
    writable: true,
  });
}

describe('清洗 + 上传的数据完整性', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    vi.useFakeTimers();
    setOnLine(true);
    localStorage.clear();
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
    vi.useRealTimers();
    localStorage.clear();
  });

  it('两条完全相同、且都会被拆分的日志仍然要能去重', async () => {
    // splitId 是随机值，把它掺进去重 hash 会让内容相同的日志算出互不相交的
    // hash —— 去重彻底失效，1 次上报变 6 次。
    const uploaded: LogEntry[] = [];
    const plugin = new UploadPlugin({
      onUpload: async (log) => {
        uploaded.push(log);
        return { success: true } as UploadResult;
      },
      queue: { offlinePolicy: 'pause', deduplicationDelay: 50 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(new PayloadSanitizePlugin({ maxBytes: 2000 }));
    logger.use(plugin);

    const big = { a: 'a'.repeat(1200), b: 'b'.repeat(1200), c: 'c'.repeat(1200) };
    logger.error('boom', { context: { ...big } });
    logger.error('boom', { context: { ...big } });
    await vi.advanceTimersByTimeAsync(3000);

    const splitIds = new Set(uploaded.map((l) => String(l.tags?.splitId)));
    // 两组分片必须合并成一组，而不是各发各的
    expect(splitIds.size).toBe(1);
  });

  it('去重后不能出现 splitId 混搭的碎片', async () => {
    // 逐片去重时，胜出的分片可能来自不同的分组 —— 后端哪一组都拼不回来
    const uploaded: LogEntry[] = [];
    const plugin = new UploadPlugin({
      onUpload: async (log) => {
        uploaded.push(log);
        return { success: true } as UploadResult;
      },
      queue: { offlinePolicy: 'pause', deduplicationDelay: 50 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(new PayloadSanitizePlugin({ maxBytes: 2000 }));
    logger.use(plugin);

    const big = { a: 'a'.repeat(1200), b: 'b'.repeat(1200), c: 'c'.repeat(1200) };
    logger.error('boom', { context: { ...big } });
    logger.error('boom', { context: { ...big } });
    await vi.advanceTimersByTimeAsync(3000);

    const byId = new Map<string, Set<number>>();
    for (const log of uploaded) {
      const id = String(log.tags?.splitId);
      const set = byId.get(id) ?? new Set<number>();
      set.add(Number(log.tags?.splitIndex));
      byId.set(id, set);
    }
    // 留下来的那一组必须是完整的：1..N 一片不缺
    for (const [, indices] of byId) {
      const total = Number(uploaded[0]!.tags?.splitTotal);
      expect(indices.size).toBe(total);
    }
  });

  it('同一条日志的分片之间绝不能被合并', async () => {
    const uploaded: LogEntry[] = [];
    const plugin = new UploadPlugin({
      onUpload: async (log) => {
        uploaded.push(log);
        return { success: true } as UploadResult;
      },
      queue: { offlinePolicy: 'pause', deduplicationDelay: 50 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(new PayloadSanitizePlugin({ maxBytes: 2000 }));
    logger.use(plugin);

    logger.error('boom', {
      context: { a: 'a'.repeat(1200), b: 'b'.repeat(1200), c: 'c'.repeat(1200) },
    });
    await vi.advanceTimersByTimeAsync(3000);

    expect(uploaded.length).toBeGreaterThan(1);
    const indices = uploaded.map((l) => Number(l.tags?.splitIndex)).sort();
    expect(new Set(indices).size).toBe(uploaded.length);
  });

  it('beforeSend 拦掉一个分片时，同组其余分片也不能发出去', async () => {
    // 用户写的是"含 secret 的日志不要发"，可拆分后钩子是逐片调用的：
    // 只拦住带 secret 的那片，另外两片照发 —— 既漏数据又留下拼不回的碎片
    const uploaded: LogEntry[] = [];
    const plugin = new UploadPlugin({
      onUpload: async (log) => {
        uploaded.push(log);
        return { success: true } as UploadResult;
      },
      queue: { offlinePolicy: 'pause', deduplicationDelay: 50 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(new PayloadSanitizePlugin({ maxBytes: 2000 }));
    logger.use(
      new BeforeSendPlugin({
        beforeSend: (entry) => (entry.context?.['secret'] ? null : entry),
      }),
    );
    logger.use(plugin);

    logger.error('boom', {
      context: {
        secret: 's'.repeat(1200),
        other1: 'o'.repeat(1200),
        other2: 'p'.repeat(1200),
      },
    });
    await vi.advanceTimersByTimeAsync(3000);

    expect(uploaded).toEqual([]);
  });

  it('队列溢出淘汰某个分片时，整组一起淘汰', () => {
    // 半组分片对后端毫无意义：要么整组到齐，要么整组不发。
    // 断网让队列停住，这样淘汰完全由 maxSize 决定，不受上传进度干扰。
    setOnLine(false);
    const drops: LogEntry[] = [];
    const plugin = new UploadPlugin({
      onUpload: async () => ({ success: true }) as UploadResult,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 50, maxSize: 4 },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (log, info) => {
        if (info.reason === 'queue-overflow') drops.push(log);
      },
    });
    logger.use(new PayloadSanitizePlugin({ maxBytes: 2000 }));
    logger.use(plugin);

    logger.error('first', {
      context: { a: 'a'.repeat(1200), b: 'b'.repeat(1200), c: 'c'.repeat(1200) },
    });
    const splitTotal = 3;
    // 正好触发一次淘汰：不带修复时只会踢掉一片，带修复时整组三片一起走
    for (let i = 0; i < 2; i++) logger.error(`filler-${i}`);

    const droppedChunks = drops.filter((l) => l.tags?.splitId !== undefined);
    // 要么一片没丢，要么整组都丢 —— 绝不能只丢一两片
    expect(droppedChunks.length === 0 || droppedChunks.length === splitTotal).toBe(true);
  });

  it('溢出淘汰时已 inFlight 的分片也必须整组丢弃，后端不得收到残组', async () => {
    const releases: Array<(r: UploadResult) => void> = [];
    const uploaded: string[] = [];
    const plugin = new UploadPlugin({
      onUpload: (log) => {
        if (log.tags?.splitId === 'g1') {
          return new Promise<UploadResult>((res) => {
            releases.push(res);
          });
        }
        return Promise.resolve({ success: true } as UploadResult);
      },
      queue: { offlinePolicy: 'pause', deduplicationDelay: 10, maxSize: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.on('upload:success', (p: { log?: LogEntry }) => {
      if (p.log?.logId) uploaded.push(p.log.logId);
    });
    logger.use(plugin);

    const mk = (id: string, index: number): LogEntry =>
      ({
        logId: id,
        level: 'error',
        message: 'split-piece',
        timestamp: Date.now(),
        tags: { splitId: 'g1', splitIndex: index, splitTotal: 3 },
      }) as LogEntry;

    // maxSize=1：先飞起 p1，再让 p2 占住唯一队列槽
    plugin.requeue(mk('p1', 1));
    await vi.advanceTimersByTimeAsync(200);
    expect(releases).toHaveLength(1);
    plugin.requeue(mk('p2', 2));
    await vi.advanceTimersByTimeAsync(50);

    // p3 触发 overflow：淘汰队列里的 p2，并标记 inFlight 的 p1；p3 自身也同组丢掉
    plugin.requeue(mk('p3', 3));
    await vi.advanceTimersByTimeAsync(50);

    for (const release of releases) release({ success: true });
    await vi.advanceTimersByTimeAsync(200);

    expect(uploaded).toEqual([]);
  });

  it('splitTotal 大于 maxSize 时不得留下后续独苗残组', () => {
    setOnLine(false);
    const dropped: string[] = [];
    const plugin = new UploadPlugin({
      onUpload: async () => ({ success: true }) as UploadResult,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 50, maxSize: 2 },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (log, info) => {
        if (info.reason === 'queue-overflow') dropped.push(log.logId);
      },
    });
    logger.use(plugin);

    const mk = (id: string, index: number): LogEntry =>
      ({
        logId: id,
        level: 'error',
        message: 'split-piece',
        timestamp: Date.now(),
        tags: { splitId: 'big-group', splitIndex: index, splitTotal: 5 },
      }) as LogEntry;

    for (let i = 1; i <= 5; i++) plugin.requeue(mk(`p${i}`, i));

    expect(dropped.sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(plugin.getQueueStatus().length).toBe(0);
    expect(plugin.isPending('p4')).toBe(false);
    expect(plugin.isPending('p5')).toBe(false);
  });

  it('overflow 标记不得跨 remount 吞掉同 logId 的新成功', async () => {
    let hang = true;
    let release!: (r: UploadResult) => void;
    const successes: string[] = [];
    const plugin = new UploadPlugin({
      onUpload: (log) => {
        if (hang && log.logId === 'p1') {
          return new Promise<UploadResult>((res) => {
            release = res;
          });
        }
        return Promise.resolve({ success: true } as UploadResult);
      },
      queue: { offlinePolicy: 'pause', deduplicationDelay: 10, maxSize: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.on('upload:success', (p: { log?: LogEntry }) => {
      if (p.log?.logId) successes.push(p.log.logId);
    });
    logger.use(plugin);

    const mk = (id: string, index: number): LogEntry =>
      ({
        logId: id,
        level: 'error',
        message: 'split-piece',
        timestamp: Date.now(),
        tags: { splitId: 'g1', splitIndex: index, splitTotal: 3 },
      }) as LogEntry;

    plugin.requeue(mk('p1', 1));
    await vi.advanceTimersByTimeAsync(200);
    plugin.requeue(mk('p2', 2));
    plugin.requeue(mk('p3', 3));
    await vi.advanceTimersByTimeAsync(50);

    logger.uninstall('upload');
    hang = false;
    logger.use(plugin);
    plugin.requeue(mk('p1', 1));
    await vi.advanceTimersByTimeAsync(200);

    expect(successes).toContain('p1');

    // 旧飞行若仍挂起，settle 不得把上面的成功抹掉；这里放行仅避免未处理 Promise
    release?.({ success: true });
    await vi.advanceTimersByTimeAsync(50);
  });

  it('线上实际字节数要真的落在用户声明的 maxBytes 之内', async () => {
    // 清洗判定"在预算内"之后，decorateForUpload 还会追加 requestId / uploadedAt，
    // 不预留余量的话线上稳定超出上限约 110 字节 —— 而用户拿这个值对齐的是
    // 数据库列宽这种硬约束，超一点就是写入失败。
    // 扫一段长度，保证有若干条正好卡在边缘上。
    const budget = 4000;
    const oversized: number[] = [];
    const plugin = new UploadPlugin({
      onUpload: async (log) => {
        const size = new TextEncoder().encode(JSON.stringify(log)).length;
        if (size > budget) oversized.push(size);
        return { success: true } as UploadResult;
      },
      queue: { offlinePolicy: 'pause', deduplicationDelay: 10, maxSize: 500 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(new PayloadSanitizePlugin({ maxBytes: budget }));
    logger.use(plugin);

    for (let n = 3500; n <= 4100; n += 10) {
      logger.error(`edge-${n}`, { context: { blob: 'x'.repeat(n) } });
    }
    await vi.advanceTimersByTimeAsync(60000);

    expect(oversized).toEqual([]);
  });
});
