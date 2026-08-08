/**
 * 载荷清洗（PayloadSanitize）— 纯函数实现
 *
 * 解决的问题：日志里混入 Data URL / Blob / 超大文本时，会撑爆上报接口、
 * 数据库字段（常见的 MySQL `TEXT` 上限是 65535 字节）以及本地缓存
 * （localStorage / IndexedDB 配额）。
 *
 * 三条规则，按顺序执行：
 *
 * 1. Data URL、Blob / File、ArrayBuffer / TypedArray → 结构化占位符。
 *    这类内容在日志里没有排障价值，且是撑爆存储的主要来源。
 * 2. 清洗后若**单个字段**仍超过 `maxBytes` → 整条拒绝。
 *    我们不做字段内切片：切开的半截 JSON 既难还原也难阅读，而且会纵容
 *    "单字段塞巨量文本" 这种本就该在业务侧解决的用法。
 * 3. 每个字段都不超限、但**整包**超过 `maxBytes` → 按字段拆成多条，
 *    用 `tags.splitId / splitIndex / splitTotal` 关联。
 *
 * 用户主动写入的文本一律不静默截断 —— 要么完整送达（可能分多条），
 * 要么明确拒绝并报错。
 */

import type { LogEntry, LogTags } from '../types';

/**
 * 单条上报体的默认字节上限。
 *
 * 取 60000 而不是 65535：给外层信封（请求包装、服务端补充字段、网关头）
 * 留出约 5KB 余量，保证整条日志能落进最常见的 `TEXT` 列。
 */
export const DEFAULT_MAX_BYTES = 60000;

/**
 * 小于等于此长度的 Data URL 会被原样保留。
 *
 * `data:,ok` 这类短 Data URL 本身就是有效信息，替换成占位符反而丢信息；
 * 真正需要拦截的是几十上百 KB 的 base64 图片 / 文件。
 */
const DATA_URL_INLINE_LIMIT = 256;

/** 短消息会内联进每个分片，方便后端阅读；超过则作为独立字段参与拆分 */
const MESSAGE_INLINE_LIMIT = 200;

/** 对象遍历的最大深度，超过则占位（防御畸形数据 / 深层递归结构） */
const MAX_DEPTH = 12;

/**
 * `maxBytes` 的下限
 *
 * 比这更小的预算连骨架都放不下，只会让每条日志都被拒收。低于此值直接回落默认值，
 * 而不是让用户悄无声息地丢掉全部日志。
 */
const MIN_MAX_BYTES = 1024;

/**
 * 为上报时追加的字段预留的字节数
 *
 * requestId(~40) + uploadedAt(~30) + droppedSinceLastReport(~30) + offlineReplay(~20)，
 * 实测最坏约 110 字节，取 256 留足余量。
 */
const UPLOAD_DECORATION_RESERVE = 256;

/** `strips` 诊断列表的记录上限，防止病态日志把它撑爆 */
const STRIP_RECORD_LIMIT = 50;

export interface PayloadSanitizeOptions {
  /**
   * 完整上报体的最大 UTF-8 字节数
   *
   * @default 60000
   */
  maxBytes?: number;
}

export type StripKind =
  | 'data-url'
  | 'binary'
  | 'circular'
  | 'depth'
  | 'unserializable'
  | 'budget';

export interface PayloadStrip {
  /** 被替换值的路径，如 `context.screenshot` */
  path: string;
  kind: StripKind;
  /** 被替换掉的原始字节数（`circular` / `depth` 为 0） */
  bytes: number;
}

export type PayloadSanitizeResult =
  | {
      status: 'ok';
      entries: LogEntry[];
      strips: PayloadStrip[];
      bytes: number;
    }
  | {
      status: 'split';
      entries: LogEntry[];
      strips: PayloadStrip[];
      bytes: number;
    }
  | {
      status: 'rejected';
      entries: [];
      strips: PayloadStrip[];
      bytes: number;
      /** 导致拒绝的字段路径 */
      field: string;
      /** 该字段自身的字节数 */
      fieldBytes: number;
      /**
       * 该字段实际被拿来比较的上限
       *
       * 不等于用户配置的 `maxBytes`：要扣掉上报时追加字段的预留，
       * 再扣掉这条日志自身骨架的开销。报错信息必须用这个值，
       * 否则会出现"3630 字节超过了 4000 字节上限"这种自相矛盾的提示。
       */
      budget: number;
    };

// ==================== 字节计算 ====================

const textEncoder: { encode(input: string): { length: number } } | null =
  typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/** 字符串的 UTF-8 字节数 */
export function utf8Bytes(str: string): number {
  if (textEncoder) {
    try {
      return textEncoder.encode(str).length;
    } catch {
      /* fall through to manual counting */
    }
  }
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < str.length &&
      // 必须确认后一个真的是低代理，否则 "\uD800中" 这种孤立代理
      // 会把后面那个汉字一并吞掉，算出的字节数偏低
      str.charCodeAt(i + 1) >= 0xdc00 &&
      str.charCodeAt(i + 1) <= 0xdfff
    ) {
      // 代理对 → 一个 4 字节字符
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * 值序列化成 JSON 后的 UTF-8 字节数
 *
 * 无法序列化时返回 `Infinity`，调用方按 "超限" 处理。
 */
export function jsonBytes(value: unknown): number {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return Infinity;
  }
  return json === undefined ? 0 : utf8Bytes(json);
}

// ==================== 二进制 / Data URL 识别 ====================

/**
 * Data URL 的规范形态：`data:[<mediatype>][;base64],<data>`
 *
 * 只认逗号之前不含空白的形式，避免把普通句子里的 "data:" 误判成 Data URL。
 */
const DATA_URL_RE = /^data:[^\s,]*,/;

function isDataUrl(value: string): boolean {
  return value.length > 5 && DATA_URL_RE.test(value);
}

function dataUrlMime(value: string): string {
  const comma = value.indexOf(',');
  const head = value.slice(5, comma === -1 ? undefined : comma);
  const mime = head.split(';')[0];
  return mime && mime.length > 0 ? mime : 'unknown';
}

interface BinaryInfo {
  kind: string;
  bytes: number;
  type?: string;
}

/**
 * 识别 Blob / File / ArrayBuffer / TypedArray / DataView
 *
 * 用 `Object.prototype.toString` + duck-typing 而不是 `instanceof`：
 * 跨 realm（iframe、jsdom、小程序容器）时 `instanceof` 并不可靠。
 */
function detectBinary(value: object): BinaryInfo | null {
  const tag = Object.prototype.toString.call(value);

  if (tag === '[object Blob]' || tag === '[object File]') {
    const blob = value as { size?: unknown; type?: unknown };
    return {
      kind: tag === '[object File]' ? 'file' : 'blob',
      bytes: typeof blob.size === 'number' ? blob.size : -1,
      type: typeof blob.type === 'string' && blob.type ? blob.type : undefined,
    };
  }

  if (tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]') {
    const buffer = value as { byteLength?: unknown };
    return {
      kind: 'arraybuffer',
      bytes: typeof buffer.byteLength === 'number' ? buffer.byteLength : -1,
    };
  }

  if (ArrayBuffer.isView(value)) {
    return { kind: 'binary', bytes: (value as ArrayBufferView).byteLength };
  }

  // 未被上面命中的 Blob-like（部分小程序 / polyfill 环境 toString 不标准）
  const duck = value as { size?: unknown; arrayBuffer?: unknown };
  if (typeof duck.size === 'number' && typeof duck.arrayBuffer === 'function') {
    return { kind: 'blob', bytes: duck.size };
  }

  return null;
}

function placeholder(parts: Array<string | undefined>): string {
  return `[omitted:${parts.filter(Boolean).join(' ')}]`;
}

/**
 * 归一化 `maxBytes`
 *
 * 小数是个真陷阱：`60000.5` 能过"大于 0"的检查，却让骨架预算永远算不平，
 * 结果是每一条日志都被拒收。过小的值同理 —— 骨架本身就放不下。
 * 两种情况都回落到默认值，而不是静默丢光日志。
 */
export function normalizeMaxBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_BYTES;
  const floored = Math.floor(value);
  return floored >= MIN_MAX_BYTES ? floored : DEFAULT_MAX_BYTES;
}

// ==================== 深度清洗 ====================

interface WalkState {
  strips: PayloadStrip[];
  /** 剩余可访问节点数，见 WALK_NODE_BUDGET */
  budget: number;
}

/**
 * 一次清洗最多访问多少个节点
 *
 * `seen` 是按路径维护的（正确的环检测语义），代价是同一个对象被 k 条路径引用就会
 * 被走 k 次。于是一个共享引用的 DAG 会以分支数的深度次方爆炸 —— 实测 12 个对象、
 * 每个持有 5 份同一子节点的引用，就能让主线程卡住数秒。
 *
 * 深度上限拦不住这个（每条路径都很浅），所以需要一个独立的总量预算。
 * 超预算后停止下钻并留下占位符：宁可少清洗一部分，也不能把宿主页面卡死。
 */
const WALK_NODE_BUDGET = 50000;

/**
 * 安全读取属性
 *
 * 载荷里出现一个抛异常的 getter 或 Proxy 陷阱是完全可能的（懒加载字段、
 * ORM 实体、被吊销的 Proxy）。让异常一路冒到 `PayloadSanitizePlugin` 的兜底
 * catch，后果是**整条日志原样放行** —— 体积预算、Data URL 替换、拒绝/拆分
 * 全部失效，而且没有任何提示。逐属性兜住，把它降级成一次普通的替换。
 */
function safeRead(source: Record<string, unknown>, key: string): { ok: boolean; value: unknown } {
  try {
    return { ok: true, value: source[key] };
  } catch {
    return { ok: false, value: undefined };
  }
}

function safeKeys(source: object): string[] {
  try {
    return Object.keys(source);
  } catch {
    return [];
  }
}

/**
 * 记录一次替换
 *
 * `strips` 纯粹是诊断信息，会被 debug 日志整个打出来。一条含上千个 Data URL 的
 * 日志能让它涨到失控，所以只留前若干条 —— 定位问题看几条就够了。
 */
function recordStrip(state: WalkState, strip: PayloadStrip): void {
  if (state.strips.length >= STRIP_RECORD_LIMIT) return;
  state.strips.push(strip);
}

/**
 * 递归清洗一个值；未发生替换时**返回原引用**（copy-on-write），
 * 避免给绝大多数正常日志带来无谓的对象拷贝。
 */
function sanitizeValue(
  value: unknown,
  path: string,
  depth: number,
  state: WalkState,
  seen: Set<object>,
): unknown {
  if (typeof value === 'string') {
    if (isDataUrl(value)) {
      const bytes = utf8Bytes(value);
      if (bytes > DATA_URL_INLINE_LIMIT) {
        recordStrip(state, { path, kind: 'data-url', bytes });
        return placeholder(['data-url', `mime=${dataUrlMime(value)}`, `bytes=${bytes}`]);
      }
    }
    return value;
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (depth >= MAX_DEPTH) {
    recordStrip(state, { path, kind: 'depth', bytes: 0 });
    return placeholder([`depth>${MAX_DEPTH}`]);
  }

  if (state.budget <= 0) {
    recordStrip(state, { path, kind: 'budget', bytes: 0 });
    return placeholder(['walk-budget-exceeded']);
  }
  state.budget--;

  let binary: BinaryInfo | null;
  try {
    binary = detectBinary(value);
  } catch {
    // 被吊销的 Proxy 连 Object.prototype.toString 都会抛
    recordStrip(state, { path, kind: 'unserializable', bytes: 0 });
    return placeholder(['unserializable']);
  }
  if (binary) {
    const bytes = binary.bytes >= 0 ? binary.bytes : 0;
    recordStrip(state, { path, kind: 'binary', bytes });
    return placeholder([
      binary.kind,
      binary.type ? `type=${binary.type}` : undefined,
      binary.bytes >= 0 ? `bytes=${binary.bytes}` : undefined,
    ]);
  }

  if (seen.has(value)) {
    recordStrip(state, { path, kind: 'circular', bytes: 0 });
    return placeholder(['circular']);
  }

  // Date：交给 JSON.stringify 的原生路径（ISO 字符串），不要走 toJSON 再洗一遍
  if (value instanceof Date) {
    return value;
  }

  // 其它自带 toJSON 的对象：先求值再清洗。
  // 直接放行会让 `{ toJSON: () => 'data:image/...' }` 绕过 Data URL 占位。
  try {
    if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
      let json: unknown;
      try {
        json = (value as { toJSON: () => unknown }).toJSON();
      } catch {
        recordStrip(state, { path, kind: 'unserializable', bytes: 0 });
        return placeholder(['unserializable']);
      }
      if (json !== value) {
        return sanitizeValue(json, path, depth, state, seen);
      }
      return value;
    }
  } catch {
    recordStrip(state, { path, kind: 'unserializable', bytes: 0 });
    return placeholder(['unserializable']);
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      let changed = false;
      const next: unknown[] = new Array(value.length);
      for (let i = 0; i < value.length; i++) {
        const read = safeRead(value as unknown as Record<string, unknown>, String(i));
        if (!read.ok) {
          recordStrip(state, { path: `${path}[${i}]`, kind: 'unserializable', bytes: 0 });
          next[i] = placeholder(['unserializable']);
          changed = true;
          continue;
        }
        const sanitized = sanitizeValue(read.value, `${path}[${i}]`, depth + 1, state, seen);
        next[i] = sanitized;
        if (sanitized !== read.value) changed = true;
      }
      return changed ? next : value;
    }

    const source = value as Record<string, unknown>;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const key of safeKeys(source)) {
      const childPath = path ? `${path}.${key}` : key;
      // 只读一次：重复读会让带副作用 / 惰性计算的 getter 多跑几遍，
      // 也会让每次返回新对象的 getter（`get items() { return [...] }`）
      // 恒等比较永远为假，白白退化掉 copy-on-write
      const read = safeRead(source, key);
      if (!read.ok) {
        recordStrip(state, { path: childPath, kind: 'unserializable', bytes: 0 });
        setSafe(next, key, placeholder(['unserializable']));
        changed = true;
        continue;
      }
      const sanitized = sanitizeValue(read.value, childPath, depth + 1, state, seen);
      setSafe(next, key, sanitized);
      if (sanitized !== read.value) changed = true;
    }
    return changed ? next : value;
  } finally {
    seen.delete(value);
  }
}

/**
 * 写入属性，`__proto__` 也当普通键
 *
 * `JSON.parse('{"__proto__":{...}}')` 会产生一个自有的 `__proto__` 键。用 `=` 赋值
 * 会触发继承来的 setter：这个键被静默丢掉，副本的原型还被换成了那个值。
 * 后者更糟 —— 若该值带 `toJSON`，整个对象的序列化结果都会被它劫持。
 */
function setSafe(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return;
  }
  target[key] = value;
}

// ==================== 拆分 ====================

interface SplitUnit {
  kind: 'message' | 'error' | 'tag' | 'context';
  key?: string;
  value: unknown;
  bytes: number;
}

/** 分片元数据独占的 tag 键，用户同名 tag 会被覆盖 */
const RESERVED_SPLIT_TAGS = new Set(['splitId', 'splitIndex', 'splitTotal', 'splitBytes']);

/** 单个字段小于这个体积才复制到每个分片 */
const SHARED_FIELD_LIMIT = 512;

/** 复制字段占单片预算的上限，防止小字段太多把分片撑爆 */
const SHARED_FIELD_BUDGET_RATIO = 0.25;

/** 被拆成装箱单元、因而不能直接进骨架的字段 */
const REDISTRIBUTED_FIELDS = new Set(['message', 'error', 'tags', 'context']);

/**
 * 构造每个分片共享的骨架
 *
 * 关键点是**白名单式复制会静默丢数据**。宿主插件完全可以往 LogEntry 上挂自定义
 * 顶层字段（面包屑、trace 上下文…），`LogEntry` 本身也还会继续加字段。只抄已知的
 * 几个，其余的在拆分时凭空消失，而 `totalBytes` 又是按整条算的 —— 于是插件一边
 * 丢掉 80% 的内容，一边报告"已拆成 N 条，没有内容被丢弃"。
 *
 * 所以这里改成：除了会被重新分配的那四个字段，其余顶层字段一律复制到骨架。
 */
function buildSkeleton(entry: LogEntry): LogEntry {
  const skeleton = { message: entry.message } as LogEntry;
  const source = entry as unknown as Record<string, unknown>;
  for (const key of safeKeys(entry)) {
    if (REDISTRIBUTED_FIELDS.has(key)) continue;
    const read = safeRead(source, key);
    if (!read.ok || read.value === undefined) continue;
    setSafe(skeleton as unknown as Record<string, unknown>, key, read.value);
  }
  return skeleton;
}

/** 找出对象里体积最大的顶层字段，用于把"整体太大"落到一个具体的名字上 */
function largestField(entry: LogEntry): string | undefined {
  let name: string | undefined;
  let max = 0;
  const source = entry as unknown as Record<string, unknown>;
  for (const key of safeKeys(entry)) {
    const read = safeRead(source, key);
    if (!read.ok) continue;
    const bytes = jsonBytes(read.value);
    if (Number.isFinite(bytes) && bytes > max) {
      max = bytes;
      name = key;
    }
  }
  return name;
}

function splitPlaceholderMessage(index: number, total: number): string {
  return `[aemeath:split ${index}/${total}]`;
}

/**
 * 把一条超限日志按字段拆成多条
 *
 * 每个分片都是**独立合法**的 LogEntry：共享骨架（level / timestamp /
 * environment / release）+ 一部分字段 + 关联元数据。
 */
function splitEntry(
  entry: LogEntry,
  maxBytes: number,
  totalBytes: number,
): PayloadSanitizeResult {
  const messageBytes = jsonBytes(entry.message);
  const inlineMessage = messageBytes <= MESSAGE_INLINE_LIMIT;

  const skeleton = buildSkeleton(entry);

  // 小字段复制到每个分片，只有大字段才装箱分配。
  //
  // 强制日志分片的从来是那一两个大字段；userId / sessionId / url / 业务 tag 这些
  // 又小又是**关联维度**。把它们也装箱，分片 2..N 就成了没有归属的孤儿：
  // 按会话 join 不上、按 tag 告警漏报。复制的代价是几百字节 × N，很划算。
  const sharedTags: Record<string, unknown> = {};
  const sharedContext: Record<string, unknown> = {};
  let sharedBytes = 0;
  const sharedBudget = Math.floor(maxBytes * SHARED_FIELD_BUDGET_RATIO);

  const units: SplitUnit[] = [];
  if (!inlineMessage) {
    units.push({ kind: 'message', value: entry.message, bytes: messageBytes });
  }
  if (entry.error !== undefined) {
    units.push({ kind: 'error', value: entry.error, bytes: jsonBytes(entry.error) + 10 });
  }
  const collect = (
    source: Record<string, unknown> | undefined,
    kind: 'tag' | 'context',
    sharedSink: Record<string, unknown>,
  ) => {
    if (!source) return;
    for (const key of Object.keys(source)) {
      const value = source[key];
      if (value === undefined) continue;
      // 保留键在拆分时一定会被元数据覆盖，留着它只会有害：既占预算，
      // 又可能因为自身超大而让整条日志因一个注定要被丢弃的值被拒收
      if (kind === 'tag' && RESERVED_SPLIT_TAGS.has(key)) continue;
      const bytes = jsonBytes(key) + jsonBytes(value) + 2;
      if (bytes <= SHARED_FIELD_LIMIT && sharedBytes + bytes <= sharedBudget) {
        sharedSink[key] = value;
        sharedBytes += bytes;
        continue;
      }
      units.push({ kind, key, value, bytes });
    }
  };
  collect(entry.tags as Record<string, unknown> | undefined, 'tag', sharedTags);
  collect(entry.context as Record<string, unknown> | undefined, 'context', sharedContext);

  // 骨架预算必须是**真正的上界**，否则"每个分片都不超 maxBytes"这个核心不变量
  // 就是假的。以下三处都曾各差几个字节，实测能在默认配置下拼出 60009 字节的分片：
  //   1. 分片的 logId 是 `${logId}-${index}`，比裸 logId 长
  //   2. 装箱进 context 的字段会凭空造出 `,"context":{}` 外壳，
  //      而 sharedContext 为空时探针里根本没有 context
  //   3. 占位消息在 total >= 1000 时比 `999/999` 更长
  const maxIndexWidth = String(units.length + 1).length;
  const probeSuffix = '-'.padEnd(maxIndexWidth + 1, '9');
  const skeletonProbe: LogEntry = {
    ...skeleton,
    logId: `${entry.logId}${probeSuffix}`,
    message: inlineMessage
      ? entry.message
      : splitPlaceholderMessage(Number(probeSuffix.slice(1)), units.length + 1),
    tags: {
      ...sharedTags,
      splitId: entry.logId,
      splitIndex: units.length + 1,
      splitTotal: units.length + 1,
      splitBytes: totalBytes,
    },
    // 即使 sharedContext 为空，装箱也可能给分片加上 context 外壳
    context: { ...sharedContext } as LogEntry['context'],
  };
  const skeletonBytes = jsonBytes(skeletonProbe);
  const perChunkBudget = maxBytes - skeletonBytes;

  if (perChunkBudget <= 0) {
    // 骨架自己就超预算，说明某个**不可拆分的顶层字段**太大。报 "(skeleton)"
    // 对用户毫无帮助，得指出到底是哪个字段，否则这条丢弃无从排查。
    return {
      status: 'rejected',
      entries: [],
      strips: [],
      bytes: totalBytes,
      field: largestField(skeleton) ?? '(skeleton)',
      fieldBytes: skeletonBytes,
      budget: maxBytes,
    };
  }

  // 任何单字段自身超预算 → 无法通过拆分解决，整条拒绝
  for (const unit of units) {
    if (unit.bytes > perChunkBudget) {
      return {
        status: 'rejected',
        entries: [],
        strips: [],
        bytes: totalBytes,
        field: describeUnit(unit),
        fieldBytes: unit.bytes,
        budget: perChunkBudget,
      };
    }
  }

  // 贪心装箱：字段顺序保持原样，保证分片内容可预期
  const bins: SplitUnit[][] = [];
  let current: SplitUnit[] = [];
  let currentBytes = 0;
  for (const unit of units) {
    if (current.length > 0 && currentBytes + unit.bytes > perChunkBudget) {
      bins.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(unit);
    currentBytes += unit.bytes;
  }
  if (current.length > 0) bins.push(current);
  if (bins.length === 0) bins.push([]);

  const total = bins.length;
  const entries: LogEntry[] = bins.map((bin, i) => {
    const index = i + 1;
    const chunk: LogEntry = {
      ...skeleton,
      logId: `${entry.logId}-${index}`,
      message: inlineMessage ? entry.message : splitPlaceholderMessage(index, total),
    };
    const tags: Record<string, unknown> = { ...sharedTags };
    let context: Record<string, unknown> | undefined =
      Object.keys(sharedContext).length > 0 ? { ...sharedContext } : undefined;

    for (const unit of bin) {
      switch (unit.kind) {
        case 'message':
          chunk.message = unit.value as string;
          break;
        case 'error':
          chunk.error = unit.value as LogEntry['error'];
          break;
        case 'tag':
          tags[unit.key!] = unit.value;
          break;
        case 'context':
          context = context ?? {};
          context[unit.key!] = unit.value;
          break;
      }
    }

    // 元数据最后写：`LogTags` 是开放索引签名，用户完全可以有一个自己的 `splitId`。
    // 让用户值覆盖掉它，接收端就再也拼不回这条日志了 —— 保留键必须赢。
    tags['splitId'] = entry.logId;
    tags['splitIndex'] = index;
    tags['splitTotal'] = total;
    tags['splitBytes'] = totalBytes;

    chunk.tags = tags as LogTags;
    if (context) chunk.context = context;
    return chunk;
  });

  return { status: 'split', entries, strips: [], bytes: totalBytes };
}

function describeUnit(unit: SplitUnit): string {
  switch (unit.kind) {
    case 'message':
      return 'message';
    case 'error':
      return 'error';
    case 'tag':
      return `tags.${unit.key}`;
    default:
      return `context.${unit.key}`;
  }
}

/**
 * 逐字段找出无法 JSON 序列化的值并替换成占位符
 *
 * 只在整条序列化失败时才走这里 —— 对每个值都试一次 `JSON.stringify`
 * 代价不小，不能放进常规路径。
 */
function neutralizeUnserializable(entry: LogEntry, state: WalkState): LogEntry {
  const PLACEHOLDER = placeholder(['unserializable']);
  const next: LogEntry = { ...entry };

  const check = (value: unknown, path: string): boolean => {
    if (Number.isFinite(jsonBytes(value))) return false;
    recordStrip(state, { path, kind: 'unserializable', bytes: 0 });
    return true;
  };

  // message 也要修：漏掉它的话第二遍仍然是 Infinity，整条日志会被当成
  // "连骨架都序列化不了"而拒收 —— 完好的 context 跟着一起陪葬，
  // 这正是本函数存在的意义所要避免的
  if (check(next.message, 'message')) {
    next.message = PLACEHOLDER;
  }
  if (next.error !== undefined && check(next.error, 'error')) {
    next.error = { type: 'Unserializable', value: PLACEHOLDER };
  }
  if (next.tags) {
    const tags: Record<string, unknown> = { ...next.tags };
    for (const key of Object.keys(tags)) {
      if (check(tags[key], `tags.${key}`)) tags[key] = PLACEHOLDER;
    }
    next.tags = tags as LogTags;
  }
  if (next.context) {
    const context: Record<string, unknown> = { ...next.context };
    for (const key of Object.keys(context)) {
      if (check(context[key], `context.${key}`)) context[key] = PLACEHOLDER;
    }
    next.context = context;
  }

  return next;
}

// ==================== 入口 ====================

/**
 * 清洗一条日志
 *
 * @returns
 * - `ok`：一条（可能已替换掉 Data URL / 二进制）
 * - `split`：多条分片，全部需要上报
 * - `rejected`：单字段超限，整条不可上报
 */
export function sanitizeLogEntry(
  entry: LogEntry,
  options: PayloadSanitizeOptions = {},
): PayloadSanitizeResult {
  // 留出上报时追加字段的余量。
  //
  // UploadPlugin.decorateForUpload() 会在真正发出的副本上加 requestId、
  // tags.uploadedAt、tags.droppedSinceLastReport，OfflinePersistencePlugin 补传时
  // 还会加 offlineReplay。这些都发生在清洗判定"已经在预算内"之后，
  // 于是线上实际字节数稳定超出用户声明的上限约 110 字节。
  // 用户拿 maxBytes 对齐的是数据库列宽这类硬约束，超一点就是写入失败。
  const declaredMaxBytes = normalizeMaxBytes(options.maxBytes);
  // 预算很小时按比例收，避免固定 256 把小预算吃掉一大截
  const reserve = Math.min(UPLOAD_DECORATION_RESERVE, Math.floor(declaredMaxBytes / 8));
  const maxBytes = declaredMaxBytes - reserve;

  const state: WalkState = { strips: [], budget: WALK_NODE_BUDGET };
  const seen = new Set<object>();

  let sanitized = entry;
  const nextMessage = sanitizeValue(entry.message, 'message', 1, state, seen);
  const nextError = entry.error
    ? sanitizeValue(entry.error, 'error', 1, state, seen)
    : entry.error;
  const nextTags = entry.tags ? sanitizeValue(entry.tags, 'tags', 1, state, seen) : entry.tags;
  const nextContext = entry.context
    ? sanitizeValue(entry.context, 'context', 1, state, seen)
    : entry.context;

  if (
    nextMessage !== entry.message ||
    nextError !== entry.error ||
    nextTags !== entry.tags ||
    nextContext !== entry.context
  ) {
    sanitized = { ...entry };
    sanitized.message = typeof nextMessage === 'string' ? nextMessage : String(nextMessage);
    if (nextError !== undefined) sanitized.error = nextError as LogEntry['error'];
    if (nextTags !== undefined) sanitized.tags = nextTags as LogTags;
    if (nextContext !== undefined) sanitized.context = nextContext as LogEntry['context'];
  }

  let totalBytes = jsonBytes(sanitized);

  // 整条无法序列化（`toJSON` 抛异常、BigInt 之类）：定点替换掉罪魁字段。
  // 不能当成"体积超限"处理 —— 那会把一条本来只是某个字段有毛病的日志整条丢掉。
  if (!Number.isFinite(totalBytes)) {
    sanitized = neutralizeUnserializable(sanitized, state);
    totalBytes = jsonBytes(sanitized);
    if (!Number.isFinite(totalBytes)) {
      // 连骨架都序列化不了，只能放弃
      return {
        status: 'rejected',
        entries: [],
        strips: state.strips,
        bytes: 0,
        field: '(entry)',
        fieldBytes: 0,
        budget: maxBytes,
      };
    }
  }

  if (totalBytes <= maxBytes) {
    return { status: 'ok', entries: [sanitized], strips: state.strips, bytes: totalBytes };
  }

  const result = splitEntry(sanitized, maxBytes, totalBytes);
  return { ...result, strips: state.strips } as PayloadSanitizeResult;
}
