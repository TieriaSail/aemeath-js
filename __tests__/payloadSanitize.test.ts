/**
 * PayloadSanitize —— 载荷清洗（占位 / 拒绝 / 拆分）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { PayloadSanitizePlugin } from '../src/plugins/PayloadSanitizePlugin';
import { UploadPlugin } from '../src/plugins/UploadPlugin';
import { sanitizeLogEntry, utf8Bytes, jsonBytes } from '../src/utils/payloadSanitize';
import { LogLevel, type LogEntry } from '../src/types';

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    logId: 'log-1',
    level: LogLevel.ERROR,
    message: 'boom',
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe('utf8Bytes', () => {
  it('ASCII 每字符 1 字节', () => {
    expect(utf8Bytes('hello')).toBe(5);
  });

  it('中文每字符 3 字节', () => {
    expect(utf8Bytes('日志')).toBe(6);
  });

  it('emoji（代理对）4 字节', () => {
    expect(utf8Bytes('🙂')).toBe(4);
  });

  it('无法序列化的值按超限处理', () => {
    expect(jsonBytes(BigInt(1))).toBe(Infinity);
  });
});

describe('sanitizeLogEntry', () => {
  it('小日志原样返回同一个引用', () => {
    const entry = makeEntry({ context: { userId: 'u1' } });
    const result = sanitizeLogEntry(entry);
    expect(result.status).toBe('ok');
    expect(result.entries[0]).toBe(entry);
    expect(result.strips).toEqual([]);
  });

  it('长 Data URL 被替换成带 mime 和字节数的占位符', () => {
    const dataUrl = `data:image/png;base64,${'A'.repeat(5000)}`;
    const result = sanitizeLogEntry(makeEntry({ context: { shot: dataUrl } }));

    expect(result.status).toBe('ok');
    const shot = (result.entries[0]!.context as Record<string, string>)['shot']!;
    expect(shot).toMatch(/^\[omitted:data-url mime=image\/png bytes=\d+\]$/);
    expect(result.strips[0]).toMatchObject({ path: 'context.shot', kind: 'data-url' });
  });

  it('短 Data URL 保留原样（本身就是有效信息）', () => {
    const entry = makeEntry({ context: { tiny: 'data:text/plain,ok' } });
    const result = sanitizeLogEntry(entry);
    expect((result.entries[0]!.context as Record<string, string>)['tiny']).toBe(
      'data:text/plain,ok',
    );
  });

  it('普通字符串里的 "data:" 不会被误判', () => {
    const entry = makeEntry({ message: 'failed to load data: timeout after 3s' });
    const result = sanitizeLogEntry(entry);
    expect(result.entries[0]!.message).toBe('failed to load data: timeout after 3s');
    expect(result.strips).toEqual([]);
  });

  it('Blob 被替换成占位符', () => {
    const blob = new Blob(['x'.repeat(1000)], { type: 'image/png' });
    const result = sanitizeLogEntry(makeEntry({ context: { file: blob } }));
    const placeholder = (result.entries[0]!.context as Record<string, string>)['file']!;
    expect(placeholder).toContain('[omitted:blob');
    expect(placeholder).toContain('type=image/png');
  });

  it('ArrayBuffer / TypedArray 被替换成占位符', () => {
    const result = sanitizeLogEntry(
      makeEntry({ context: { buf: new ArrayBuffer(64), view: new Uint8Array(8) } }),
    );
    const ctx = result.entries[0]!.context as Record<string, string>;
    expect(ctx['buf']).toBe('[omitted:arraybuffer bytes=64]');
    expect(ctx['view']).toBe('[omitted:binary bytes=8]');
  });

  it('循环引用被替换而不是抛异常', () => {
    const cyclic: Record<string, unknown> = { name: 'node' };
    cyclic['self'] = cyclic;
    const result = sanitizeLogEntry(makeEntry({ context: { tree: cyclic } }));
    expect(result.status).toBe('ok');
    expect(JSON.stringify(result.entries[0])).toContain('[omitted:circular]');
  });

  it('整包超限时按字段拆成多条，内容不丢', () => {
    const maxBytes = 2000;
    const entry = makeEntry({
      context: {
        a: 'a'.repeat(900),
        b: 'b'.repeat(900),
        c: 'c'.repeat(900),
      },
    });
    const result = sanitizeLogEntry(entry, { maxBytes });

    expect(result.status).toBe('split');
    expect(result.entries.length).toBeGreaterThan(1);

    // 每个分片都在预算内，且自带关联元数据
    for (const chunk of result.entries) {
      expect(jsonBytes(chunk)).toBeLessThanOrEqual(maxBytes);
      expect(chunk.tags?.splitId).toBe('log-1');
      expect(chunk.tags?.splitTotal).toBe(result.entries.length);
      expect(chunk.level).toBe(LogLevel.ERROR);
      expect(chunk.timestamp).toBe(entry.timestamp);
    }

    // 分片各有独立 logId，避免后端 / 持久层按 logId 记账时互相覆盖
    const ids = new Set(result.entries.map((e) => e.logId));
    expect(ids.size).toBe(result.entries.length);

    // 三个字段一个都不少
    const merged = Object.assign({}, ...result.entries.map((e) => e.context ?? {}));
    expect(merged['a']).toHaveLength(900);
    expect(merged['b']).toHaveLength(900);
    expect(merged['c']).toHaveLength(900);
  });

  it('短 message 内联进每个分片，方便后端阅读', () => {
    const result = sanitizeLogEntry(
      makeEntry({
        message: 'upload failed',
        context: { a: 'a'.repeat(900), b: 'b'.repeat(900) },
      }),
      // 1200 会因为上报字段预留（maxBytes/8，上限 256）而放不下 900 字节的字段
      { maxBytes: 1400 },
    );
    expect(result.status).toBe('split');
    for (const chunk of result.entries) {
      expect(chunk.message).toBe('upload failed');
    }
  });

  it('单字段超限时整条拒绝，并指出是哪个字段', () => {
    const result = sanitizeLogEntry(
      makeEntry({ context: { huge: 'x'.repeat(5000) } }),
      { maxBytes: 2000 },
    );

    expect(result.status).toBe('rejected');
    expect(result.entries).toHaveLength(0);
    if (result.status === 'rejected') {
      expect(result.field).toBe('context.huge');
      expect(result.fieldBytes).toBeGreaterThan(2000);
    }
  });

  it('拒绝时报出的上限必须真的小于字段大小，不能自相矛盾', () => {
    // 实际生效的上限要扣掉上报字段预留和骨架开销，比用户配置的 maxBytes 小。
    // 报错里若直接印 maxBytes，就会出现"3630 字节超过了 4000 字节上限"这种
    // 让人以为 SDK 坏了的提示。扫一段刚好卡在这个缝里的长度。
    for (let n = 3400; n <= 4000; n += 20) {
      const result = sanitizeLogEntry(makeEntry({ context: { blob: 'x'.repeat(n) } }), {
        maxBytes: 4000,
      });
      if (result.status !== 'rejected') continue;
      expect(result.fieldBytes).toBeGreaterThan(result.budget);
    }
  });

  it('先占位再判定大小：巨大的 Data URL 不会导致整条被拒', () => {
    const result = sanitizeLogEntry(
      makeEntry({ context: { shot: `data:image/png;base64,${'A'.repeat(100000)}` } }),
      { maxBytes: 2000 },
    );
    expect(result.status).toBe('ok');
  });
});

describe('PayloadSanitizePlugin', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    logger.destroy();
    vi.restoreAllMocks();
  });

  it('清洗后的日志才会到达 listener', () => {
    logger.use(new PayloadSanitizePlugin());
    const received: LogEntry[] = [];
    logger.on('log', ((entry: LogEntry) => received.push(entry)) as never);

    logger.error('with screenshot', {
      context: { shot: `data:image/png;base64,${'A'.repeat(5000)}` },
    });

    expect(received).toHaveLength(1);
    expect(String((received[0]!.context as Record<string, unknown>)['shot'])).toContain(
      '[omitted:data-url',
    );
  });

  it('超限日志扇出成多条，listener 收到全部分片', () => {
    logger.use(new PayloadSanitizePlugin({ maxBytes: 1500 }));
    const received: LogEntry[] = [];
    logger.on('log', ((entry: LogEntry) => received.push(entry)) as never);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    logger.error('big', {
      context: { a: 'a'.repeat(700), b: 'b'.repeat(700), c: 'c'.repeat(700) },
    });

    expect(received.length).toBeGreaterThan(1);
    expect(new Set(received.map((e) => e.tags?.splitId)).size).toBe(1);
    expect(console.warn).toHaveBeenCalled();
  });

  it('单字段超限时丢弃整条，并 console.error + 发出事件', () => {
    logger.use(new PayloadSanitizePlugin({ maxBytes: 1500 }));
    const received: LogEntry[] = [];
    const rejected: unknown[] = [];
    logger.on('log', ((entry: LogEntry) => received.push(entry)) as never);
    logger.on('payload:rejected', ((payload: unknown) => rejected.push(payload)) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.error('too big', { context: { huge: 'x'.repeat(9000) } });

    expect(received).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ field: 'context.huge' });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('拒绝的日志也要走 onDrop / upload:drop，不能只发自己的事件', () => {
    // 这是**默认启用**的插件里唯一的丢弃路径。只监听 onDrop 的宿主
    // （文档和示例都把 payload-too-large 列为一种原因）不能对它一无所知。
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onDrop = vi.fn();
    const drops: unknown[] = [];

    logger.use(
      new UploadPlugin({
        onUpload: async () => ({ success: true }),
        queue: { deduplicationDelay: 10 },
        cache: { enabled: false },
        saveOnUnload: false,
        onDrop,
      }),
    );
    logger.use(new PayloadSanitizePlugin({ maxBytes: 1500 }));
    logger.on('upload:drop', ((payload: unknown) => drops.push(payload)) as never);

    logger.error('too big', { context: { huge: 'x'.repeat(9000) } });

    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop.mock.calls[0]![1]).toMatchObject({ reason: 'payload-too-large' });
    expect(drops).toHaveLength(1);
  });

  it('没装 UploadPlugin 时拒绝仍然发出 upload:drop', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const drops: unknown[] = [];
    logger.use(new PayloadSanitizePlugin({ maxBytes: 1500 }));
    logger.on('upload:drop', ((payload: unknown) => drops.push(payload)) as never);

    logger.error('too big', { context: { huge: 'x'.repeat(9000) } });

    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ reason: 'payload-too-large' });
  });

  it('反复超限时控制台提示会收敛，但计数不丢', () => {
    const plugin = new PayloadSanitizePlugin({ maxBytes: 1500 });
    logger.use(plugin);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    for (let i = 0; i < 10; i++) {
      logger.error('too big', { context: { huge: 'x'.repeat(9000) } });
    }

    expect(errorSpy.mock.calls.length).toBeLessThanOrEqual(3);
    expect(plugin.getStats().rejected).toBe(10);
  });

  it('无法序列化的字段被定点占位，整条日志仍然送达', () => {
    const plugin = new PayloadSanitizePlugin();
    logger.use(plugin);
    const received: LogEntry[] = [];
    logger.on('log', ((entry: LogEntry) => received.push(entry)) as never);

    // 制造一个会让 JSON 序列化抛异常的值
    const hostile = {
      toJSON() {
        throw new Error('nope');
      },
    };
    logger.error('hostile', { context: { hostile, keep: 'this survives' } });

    expect(received).toHaveLength(1);
    expect(received[0]!.message).toBe('hostile');
    const ctx = received[0]!.context as Record<string, unknown>;
    expect(ctx['hostile']).toBe('[omitted:unserializable]');
    expect(ctx['keep']).toBe('this survives');
    expect(plugin.getStats().rejected).toBe(0);
  });
});

describe('分片的身份与关联字段', () => {
  const big = (n: number) => 'x'.repeat(n);

  it('关联维度复制到每个分片，不会只留在第一片', () => {
    // 分片 2..N 没有 userId / sessionId 就成了孤儿：按会话 join 不上、按 tag 告警漏报
    const result = sanitizeLogEntry(
      {
        logId: 'L1',
        level: 'error',
        message: 'boom',
        timestamp: Date.now(),
        tags: { feature: 'checkout', team: 'payments' },
        context: { userId: 'u-1', sessionId: 's-1', a: big(30000), b: big(30000), c: big(30000) },
      } as never,
      { maxBytes: 50000 },
    );

    expect(result.status).toBe('split');
    expect(result.entries.length).toBeGreaterThan(1);
    for (const chunk of result.entries) {
      expect(chunk.context).toMatchObject({ userId: 'u-1', sessionId: 's-1' });
      expect(chunk.tags).toMatchObject({ feature: 'checkout', team: 'payments' });
    }
  });

  it('用户自带的 splitId tag 不能覆盖分片元数据', () => {
    // LogTags 是开放索引签名，splitId 在 2.4 是完全合法的用户 tag 名
    const result = sanitizeLogEntry(
      {
        logId: 'L2',
        level: 'info',
        message: 'm',
        timestamp: Date.now(),
        tags: { splitId: 'MY-OWN-CORRELATION-ID' },
        context: { a: big(30000), b: big(30000), c: big(30000) },
      } as never,
      { maxBytes: 50000 },
    );

    expect(result.status).toBe('split');
    for (const chunk of result.entries) {
      expect(chunk.tags?.splitId).toBe('L2');
    }
  });

  it('复制字段不会把分片撑过预算', () => {
    const context: Record<string, unknown> = { big1: big(30000), big2: big(30000) };
    for (let i = 0; i < 200; i++) context[`dim${i}`] = `value-${i}`;

    const result = sanitizeLogEntry(
      { logId: 'L3', level: 'info', message: 'm', timestamp: Date.now(), context } as never,
      { maxBytes: 50000 },
    );

    expect(result.status).toBe('split');
    for (const chunk of result.entries) {
      expect(jsonBytes(chunk)).toBeLessThanOrEqual(50000);
    }
  });
});

describe('恶意与畸形输入', () => {
  const big = (n: number) => 'x'.repeat(n);

  it('抛异常的 getter 只影响它自己，不能让整条日志绕过体积预算', () => {
    // 兜底 catch 返回 undefined = 原样放行。一个惰性字段抛异常就让
    // 体积预算、Data URL 替换、拒绝/拆分**全部失效**，且毫无提示
    const ctx: Record<string, unknown> = { pad: big(5000) };
    Object.defineProperty(ctx, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter boom');
      },
    });

    const result = sanitizeLogEntry(
      { logId: 'L', level: 'error', message: 'm', timestamp: Date.now(), context: ctx } as never,
      { maxBytes: 2000 },
    );

    expect(result.status).not.toBe('ok');
    expect(() => JSON.stringify(result.entries)).not.toThrow();
  });

  it('被吊销的 Proxy 不会让清洗器整体失效', () => {
    const { proxy, revoke } = Proxy.revocable({ a: 1 }, {});
    revoke();
    const result = sanitizeLogEntry(
      { logId: 'L', level: 'info', message: 'm', timestamp: Date.now(), context: { proxy } } as never,
      {},
    );
    expect(result.status).toBe('ok');
    expect(() => JSON.stringify(result.entries)).not.toThrow();
  });

  it('清洗器只额外读一次 getter', () => {
    // 2 = 遍历读 1 次 + 末尾算体积时 JSON.stringify 读 1 次。后者无法避免。
    // 盯住这个数是为了防止遍历里再冒出"读一次比较、再读一次赋值"的写法：
    // 带副作用或惰性计算的 getter（典型如 DOM 测量）会因此被多跑几遍。
    let reads = 0;
    const ctx: Record<string, unknown> = {};
    Object.defineProperty(ctx, 'lazy', {
      enumerable: true,
      get() {
        reads++;
        return 'v';
      },
    });
    sanitizeLogEntry(
      { logId: 'L', level: 'info', message: 'm', timestamp: Date.now(), context: ctx } as never,
      {},
    );
    expect(reads).toBe(2);
  });

  it('拆分不能丢掉骨架白名单之外的顶层字段', () => {
    // 宿主插件可以往 LogEntry 上挂自定义顶层字段，LogEntry 本身也还会加字段。
    // 白名单式复制会让它们在拆分时凭空消失，而插件还报告"没有内容被丢弃"
    const result = sanitizeLogEntry(
      {
        logId: 'L',
        level: 'error',
        message: 'm',
        timestamp: 123,
        breadcrumbs: ['a', 'b', 'c'],
        traceId: 'T-1',
        context: { a: big(30000), b: big(30000), c: big(30000) },
      } as never,
      { maxBytes: 50000 },
    );

    expect(result.status).toBe('split');
    for (const chunk of result.entries) {
      expect((chunk as never as Record<string, unknown>)['breadcrumbs']).toEqual(['a', 'b', 'c']);
      expect((chunk as never as Record<string, unknown>)['traceId']).toBe('T-1');
    }
  });

  it('每个分片都必须真的不超预算（sharedContext 为空的情形）', () => {
    // 之前的用例都带一堆小字段，sharedContext 非空 —— 恰好是外壳被算进探针的
    // 那种情况，因此掩盖了这个溢出
    for (const maxBytes of [60000, 20000, 8000, 2048]) {
      const context: Record<string, unknown> = {};
      for (let i = 0; i < 6; i++) context[`f${i}`] = big(Math.floor(maxBytes / 4));
      const result = sanitizeLogEntry(
        { logId: 'L', level: 'info', message: 'm', timestamp: 1, context } as never,
        { maxBytes },
      );
      for (const chunk of result.entries) {
        expect(jsonBytes(chunk)).toBeLessThanOrEqual(maxBytes);
      }
    }
  });

  it('共享引用的 DAG 不会指数爆炸', () => {
    let node: Record<string, unknown> = { leaf: 'v' };
    for (let d = 0; d < 11; d++) {
      node = { a: node, b: node, c: node, d: node, e: node };
    }
    const started = Date.now();
    const result = sanitizeLogEntry(
      { logId: 'L', level: 'info', message: 'm', timestamp: 1, context: { node } } as never,
      {},
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.entries.length + (result.status === 'rejected' ? 1 : 0)).toBeGreaterThan(0);
  });

  it('__proto__ 键既不丢失，也不会换掉副本的原型', () => {
    const context = JSON.parse('{"__proto__":{"toJSON":"HIJACKED"},"keep":"v"}');
    const result = sanitizeLogEntry(
      {
        logId: 'L',
        level: 'info',
        message: 'm',
        timestamp: 1,
        context: { ...context, pic: `data:image/png;base64,${big(600)}` },
      } as never,
      {},
    );
    const out = result.entries[0]!.context as Record<string, unknown>;
    expect(out['keep']).toBe('v');
    expect(JSON.parse(JSON.stringify(out))).toHaveProperty('keep', 'v');
    expect(({} as Record<string, unknown>)['toJSON']).toBeUndefined();
  });

  it('无法序列化的 message 只替换它自己，不牵连 context', () => {
    const result = sanitizeLogEntry(
      {
        logId: 'L',
        level: 'info',
        message: { toJSON() { throw new Error('nope'); } } as never,
        timestamp: 1,
        context: { keep: 'important' },
      } as never,
      {},
    );
    expect(result.status).toBe('ok');
    expect(result.entries[0]!.context).toMatchObject({ keep: 'important' });
  });

  it('超大的保留 tag 不会让整条日志被拒收', () => {
    // splitId 在拆分时一定会被元数据覆盖，为一个注定被丢弃的值拒收整条日志毫无道理
    const result = sanitizeLogEntry(
      {
        logId: 'L',
        level: 'info',
        message: 'm',
        timestamp: 1,
        tags: { splitId: big(70000) },
        context: { a: big(30000), b: big(30000) },
      } as never,
      { maxBytes: 50000 },
    );
    expect(result.status).toBe('split');
  });

  it('小数 maxBytes 不会让每条日志都被拒收', () => {
    const result = sanitizeLogEntry(
      { logId: 'L', level: 'info', message: 'hi', timestamp: 1 } as never,
      { maxBytes: 0.5 },
    );
    expect(result.status).toBe('ok');
  });

  it('utf8Bytes 对孤立代理不能少算', () => {
    for (const s of ['\uD800中', '\uD83D\uDE00', 'a\uDC00b', '中文', '👨‍👩‍👧']) {
      expect(utf8Bytes(s)).toBe(Buffer.byteLength(s, 'utf8'));
    }
  });
});

describe('拆分的内容守恒', () => {
  it('分片内容之和等于原日志内容，一个字段都不能少', () => {
    // 这是拆分路径唯一真正重要的不变量。缺了它，"白名单漏抄字段"这类
    // 静默丢数据可以一路通过所有其它测试
    const context: Record<string, string> = {};
    for (let i = 0; i < 8; i++) context[`blob${i}`] = `${i}`.repeat(9000);
    const tags = { feature: 'checkout', team: 'payments' };

    const result = sanitizeLogEntry(
      {
        logId: 'L',
        level: 'error',
        message: 'boom',
        timestamp: 7,
        environment: 'prod',
        release: '1.2.3',
        traceId: 'T-9',
        error: { type: 'Err', message: 'bad' },
        tags,
        context,
      } as never,
      { maxBytes: 40000 },
    );

    expect(result.status).toBe('split');

    const seenContext: Record<string, unknown> = {};
    let sawError = false;
    for (const chunk of result.entries) {
      Object.assign(seenContext, chunk.context ?? {});
      if (chunk.error) sawError = true;
      // 每个分片都得是能独立入库的合法条目
      expect(chunk.logId).toBeTruthy();
      expect(chunk.level).toBe('error');
      expect(chunk.timestamp).toBe(7);
      expect((chunk as never as Record<string, unknown>)['traceId']).toBe('T-9');
      expect(chunk.tags).toMatchObject({ splitId: 'L', splitTotal: result.entries.length });
    }

    expect(sawError).toBe(true);
    for (const key of Object.keys(context)) {
      expect(seenContext[key]).toBe(context[key]);
    }
    for (const [key, value] of Object.entries(tags)) {
      for (const chunk of result.entries) {
        expect((chunk.tags as Record<string, unknown>)[key]).toBe(value);
      }
    }
  });
});
