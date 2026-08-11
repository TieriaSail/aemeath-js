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
import { LogLevel, type LogEntry } from '../src/types';

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

  it('去重丢弃回调同步重新入队的日志不能被队列提交覆盖', async () => {
    const uploaded: string[] = [];
    let rescued = false;
    let plugin!: UploadPlugin;
    plugin = new UploadPlugin({
      onUpload: async (log) => {
        uploaded.push(log.logId);
        return { success: true } as UploadResult;
      },
      queue: { deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (_log, info) => {
        if (!rescued && info.reason === 'deduplicated') {
          rescued = true;
          plugin.requeue({
            logId: 'dedup-rescue',
            level: LogLevel.ERROR,
            message: 'requeued from onDrop',
            timestamp: Date.now(),
          });
        }
      },
    });
    logger.use(plugin);
    logger.error('same message');
    logger.error('same message');

    await vi.advanceTimersByTimeAsync(500);

    expect(rescued).toBe(true);
    expect(uploaded).toContain('dedup-rescue');
    expect(uploaded).toHaveLength(2);
  });

  it('所有入队入口共享 logId 唯一所有权，同一生命周期不能并发重复请求', async () => {
    const uploaded: string[] = [];
    const plugin = new UploadPlugin({
      onUpload: async (log) => {
        uploaded.push(log.logId);
        return { success: true } as UploadResult;
      },
      queue: { deduplicationDelay: 0, concurrency: 4 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);
    const log = {
      logId: 'stable-one-owner', level: 'error', message: 'same identity', timestamp: Date.now(),
    } as LogEntry;

    plugin.requeue([log, { ...log }]);
    await vi.advanceTimersByTimeAsync(500);
    expect(uploaded).toEqual(['stable-one-owner']);
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
      queue: { deduplicationDelay: 50 },
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
      queue: { deduplicationDelay: 50 },
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
      queue: { deduplicationDelay: 50 },
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
      queue: { deduplicationDelay: 50 },
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
      queue: { deduplicationDelay: 50, maxSize: 4 },
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

  it('未收齐的分片不得调用 onUpload，后端不会先收到孤片', async () => {
    const received: string[] = [];
    const dropped: Array<{ id: string; reason: string }> = [];
    const plugin = new UploadPlugin({
      onUpload: async (log) => {
        received.push(log.logId);
        return { success: true } as UploadResult;
      },
      queue: { deduplicationDelay: 10, maxSize: 3 },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (log, info) => dropped.push({ id: log.logId, reason: info.reason }),
    });
    logger.use(plugin);

    const makeChunk = (id: string, index: number): LogEntry =>
      ({
        logId: id,
        level: LogLevel.ERROR,
        message: 'split-piece',
        timestamp: Date.now(),
        tags: { splitId: 'g1', splitIndex: index, splitTotal: 3 },
      }) as LogEntry;

    plugin.requeue(makeChunk('p1', 1));
    await vi.advanceTimersByTimeAsync(200);

    expect(received).toEqual([]);
    expect(dropped).toEqual([{ id: 'p1', reason: 'storage-rejected' }]);
    expect(plugin.isPending('p1')).toBe(false);
  });

  it('splitTotal 大于 maxSize 时不得留下后续独苗残组', () => {
    setOnLine(false);
    const dropped: string[] = [];
    const plugin = new UploadPlugin({
      onUpload: async () => ({ success: true }) as UploadResult,
      queue: { deduplicationDelay: 50, maxSize: 2 },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (log, info) => {
        if (info.reason === 'queue-overflow') dropped.push(log.logId);
      },
    });
    logger.use(plugin);

    const makeChunk = (id: string, index: number): LogEntry =>
      ({
        logId: id,
        level: LogLevel.ERROR,
        message: 'split-piece',
        timestamp: Date.now(),
        tags: { splitId: 'big-group', splitIndex: index, splitTotal: 5 },
      }) as LogEntry;

    for (let index = 1; index <= 5; index++) {
      plugin.requeue(makeChunk(`p${index}`, index));
    }

    expect(dropped.sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(plugin.getQueueStatus().length).toBe(0);
    expect(plugin.isPending('p3')).toBe(false);
    expect(plugin.isPending('p4')).toBe(false);
  });

  it('未收齐分片与 queue/parked 共用同一个容量上限，最后一片再原子转换', () => {
    setOnLine(false);
    const dropped: string[] = [];
    const plugin = new UploadPlugin({
      onUpload: async () => ({ success: true }) as UploadResult,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 60_000, maxSize: 4 },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (log, info) => {
        if (info.reason === 'queue-overflow') dropped.push(log.logId);
      },
    });
    logger.use(plugin);
    logger.error('resident-1');
    logger.error('resident-2');

    const mk = (group: string, id: string, index: number, total = 3): LogEntry => ({
      logId: id,
      level: LogLevel.ERROR,
      message: 'split admission capacity',
      timestamp: Date.now(),
      tags: { splitId: group, splitIndex: index, splitTotal: total },
    });
    plugin.requeue(mk('reserved', 'r1', 1));
    plugin.requeue(mk('reserved', 'r2', 2));

    expect(plugin.getQueueStatus()).toMatchObject({ length: 2, parked: 0, admitting: 2 });
    plugin.requeue(mk('other', 'other-1', 1, 2), { priority: 1 });
    expect(dropped).toContain('other-1');
    expect(plugin.isPending('other-1')).toBe(false);
    expect(
      plugin.getQueueStatus().length
        + plugin.getQueueStatus().parked
        + plugin.getQueueStatus().admitting,
    ).toBeLessThanOrEqual(4);

    plugin.requeue(mk('reserved', 'r3', 3));
    expect(plugin.getQueueStatus()).toMatchObject({ length: 4, parked: 0, admitting: 0 });
    expect(['r1', 'r2', 'r3'].every((id) => plugin.isPending(id))).toBe(true);
  });

  it('高优先级普通日志应原子淘汰低优先级未收齐分片组', () => {
    setOnLine(false);
    const dropped: string[] = [];
    const plugin = new UploadPlugin({
      onUpload: async () => ({ success: true }) as UploadResult,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 60_000, maxSize: 3 },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (log, info) => {
        if (info.reason === 'queue-overflow') dropped.push(log.logId);
      },
    });
    logger.use(plugin);
    logger.error('resident');
    const chunk = (id: string, index: number): LogEntry => ({
      logId: id,
      level: LogLevel.ERROR,
      message: 'low-priority admission',
      timestamp: Date.now(),
      tags: { splitId: 'low-admission', splitIndex: index, splitTotal: 3 },
    });
    plugin.requeue(chunk('low-1', 1), { priority: 1 });
    plugin.requeue(chunk('low-2', 2), { priority: 1 });

    plugin.requeue({
      logId: 'high-incoming',
      level: LogLevel.ERROR,
      message: 'high-priority ordinary log',
      timestamp: Date.now(),
    }, { priority: 100 });

    expect(dropped.sort()).toEqual(['low-1', 'low-2']);
    expect(plugin.isPending('low-1')).toBe(false);
    expect(plugin.isPending('low-2')).toBe(false);
    expect(plugin.isPending('high-incoming')).toBe(true);
    expect(plugin.getQueueStatus()).toMatchObject({ length: 2, admitting: 0 });
  });

  it('容量淘汰回调同步重入时，完整分片组仍必须一次性取得所有权', () => {
    setOnLine(false);
    let injected = false;
    let plugin!: UploadPlugin;
    const entry = (logId: string): LogEntry => ({
      logId,
      level: LogLevel.ERROR,
      message: logId,
      timestamp: Date.now(),
    });
    plugin = new UploadPlugin({
      onUpload: async () => ({ success: true }) as UploadResult,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 60_000, maxSize: 3 },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (log, info) => {
        if (!injected && log.logId === 'low-a' && info.reason === 'queue-overflow') {
          injected = true;
          plugin.requeue(entry('reentrant'), { priority: 200 });
        }
      },
    });
    logger.use(plugin);
    plugin.requeue(entry('low-a'), { priority: 1 });
    plugin.requeue(entry('low-b'), { priority: 1 });
    const group = [1, 2].map((index): LogEntry => ({
      ...entry(`atomic-${index}`),
      tags: { splitId: 'atomic-reentrant', splitIndex: index, splitTotal: 2 },
    }));

    plugin.requeue(group, { priority: 100 });

    expect(injected).toBe(true);
    expect(group.every((item) => plugin.isPending(item.logId))).toBe(true);
    expect(plugin.isPending('reentrant')).toBe(true);
    expect(plugin.getQueueStatus()).toMatchObject({ length: 3, admitting: 0 });
  });

  it('容量淘汰必须把新条目纳入优先级比较，低优先级不能挤掉高优先级', () => {
    setOnLine(false);
    const dropped: string[] = [];
    const plugin = new UploadPlugin({
      onUpload: async () => ({ success: true }) as UploadResult,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 60_000, maxSize: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (log, info) => {
        if (info.reason === 'queue-overflow') dropped.push(log.logId);
      },
    });
    logger.use(plugin);
    const entry = (logId: string): LogEntry => ({
      logId, level: LogLevel.ERROR, message: logId, timestamp: Date.now(),
    });
    plugin.requeue(entry('high'), { priority: 100 });
    plugin.requeue(entry('low'), { priority: 1 });

    expect(plugin.isPending('high')).toBe(true);
    expect(plugin.isPending('low')).toBe(false);
    expect(dropped).toEqual(['low']);
  });

  it('同一 splitId 只能有一个待投递组所有者', () => {
    setOnLine(false);
    const rejected: string[] = [];
    const plugin = new UploadPlugin({
      onUpload: async () => ({ success: true }) as UploadResult,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 60_000, maxSize: 6 },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (log, info) => {
        if (info.reason === 'storage-rejected') rejected.push(log.logId);
      },
    });
    logger.use(plugin);
    const group = (prefix: string): LogEntry[] => [1, 2].map((index) => ({
      logId: `${prefix}-${index}`,
      level: LogLevel.ERROR,
      message: prefix,
      timestamp: Date.now(),
      tags: { splitId: 'owned-split', splitIndex: index, splitTotal: 2 },
    }));
    plugin.requeue(group('first'));
    plugin.requeue(group('second'));

    expect(group('first').every((item) => plugin.isPending(item.logId))).toBe(true);
    expect(group('second').every((item) => plugin.isPending(item.logId))).toBe(false);
    expect(rejected.sort()).toEqual(['second-1', 'second-2']);
  });

  it('只有分片坐标才启用原子组语义，裸 splitId 业务标签不能级联丢弃', async () => {
    const attempted: string[] = [];
    const dropped: string[] = [];
    const upload = new UploadPlugin({
      onUpload: async (log): Promise<UploadResult> => {
        attempted.push(log.logId);
        return log.logId === 'business-tag-a'
          ? { success: false, shouldRetry: false }
          : { success: true };
      },
      queue: { concurrency: 1, deduplicationDelay: 0, retryBackoff: false },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (log) => dropped.push(log.logId),
    });
    logger.use(upload);
    upload.requeue(['a', 'b'].map((suffix): LogEntry => ({
      logId: `business-tag-${suffix}`,
      level: LogLevel.ERROR,
      message: `independent ${suffix}`,
      timestamp: Date.now(),
      tags: { splitId: 'business-correlation-only' },
    })));

    await vi.advanceTimersByTimeAsync(1000);

    expect(attempted).toEqual(['business-tag-a', 'business-tag-b']);
    expect(dropped).toEqual(['business-tag-a']);
  });

  it('完整分片组可通过原子淘汰腾出容量，不能因可靠性保护退化为无条件拒绝', () => {
    setOnLine(false);
    const splitDrops: string[] = [];
    const plugin = new UploadPlugin({
      onUpload: async () => ({ success: true }) as UploadResult,
      queue: { deduplicationDelay: 50, maxSize: 4 },
      cache: { enabled: false },
      saveOnUnload: false,
      onDrop: (log) => {
        if (log.tags?.splitId === 'admit-group') splitDrops.push(log.logId);
      },
    });
    logger.use(plugin);
    logger.error('filler-1');
    logger.error('filler-2');
    const chunks = [1, 2, 3].map((index): LogEntry => ({
      logId: `admit-${index}`,
      level: LogLevel.ERROR,
      message: 'atomic admission',
      timestamp: Date.now(),
      tags: { splitId: 'admit-group', splitIndex: index, splitTotal: 3 },
    }));
    plugin.requeue(chunks);

    expect(splitDrops).toEqual([]);
    expect(chunks.every((chunk) => plugin.isPending(chunk.logId))).toBe(true);
    expect(plugin.getQueueStatus().length).toBe(4);
  });

  it('未收齐分片的接纳状态不得跨 remount 污染新的完整组', async () => {
    const successes: string[] = [];
    const plugin = new UploadPlugin({
      onUpload: async () => ({ success: true }) as UploadResult,
      queue: { deduplicationDelay: 10, maxSize: 3 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.on('upload:success', (payload: { log?: LogEntry }) => {
      if (payload.log?.logId) successes.push(payload.log.logId);
    });
    logger.use(plugin);

    const makeChunk = (id: string, index: number): LogEntry =>
      ({
        logId: id,
        level: LogLevel.ERROR,
        message: 'split-piece',
        timestamp: Date.now(),
        tags: { splitId: 'g1', splitIndex: index, splitTotal: 3 },
      }) as LogEntry;

    plugin.requeue(makeChunk('p1', 1));
    logger.uninstall('upload');
    logger.use(plugin);
    plugin.requeue(makeChunk('p1', 1));
    plugin.requeue(makeChunk('p2', 2));
    plugin.requeue(makeChunk('p3', 3));
    await vi.advanceTimersByTimeAsync(500);

    expect(successes.sort()).toEqual(['p1', 'p2', 'p3']);
  });

  it('分片拒绝与未收齐状态都必须有硬上限，恶意 splitId 不能造成常驻内存增长', () => {
    const plugin = new UploadPlugin({
      onUpload: async () => ({ success: true }) as UploadResult,
      queue: { deduplicationDelay: 60_000, maxSize: 1 },
      cache: { enabled: false },
      saveOnUnload: false,
    });
    logger.use(plugin);
    const makeChunk = (group: string, id: string, index: number): LogEntry => ({
      logId: id,
      level: LogLevel.ERROR,
      message: 'hostile split metadata',
      timestamp: Date.now(),
      tags: { splitId: group, splitIndex: index, splitTotal: 2 },
    });
    for (let i = 0; i < 1100; i++) {
      plugin.requeue([
        makeChunk(`rejected-${i}`, `r-${i}-1`, 1),
        makeChunk(`rejected-${i}`, `r-${i}-2`, 2),
      ]);
    }
    for (let i = 0; i < 1100; i++) plugin.requeue(makeChunk(`pending-${i}`, `p-${i}`, 1));

    const internals = plugin as unknown as {
      rejectedSplitIds: Map<string, unknown>;
      pendingSplitAdmissions: Map<string, unknown>;
    };
    expect(internals.rejectedSplitIds.size).toBeLessThanOrEqual(1024);
    expect(internals.pendingSplitAdmissions.size).toBeLessThanOrEqual(1024);
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
      queue: { deduplicationDelay: 10, maxSize: 500 },
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
