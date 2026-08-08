# 载荷清洗（PayloadSanitize）

> v2.5.0+ · **默认启用** · 让每条日志都能安全落进接口、数据库和本地存储

---

## 🎯 解决什么问题

日志里混进 Data URL、Blob、几十 KB 的响应体是很常见的事 —— 尤其是
`NetworkPlugin` 自动捕获请求体 / 响应体的时候。这类内容会连锁引发一串故障：

| 环节             | 后果                                                   |
| ---------------- | ------------------------------------------------------ |
| 上报接口         | 请求体过大被网关拒绝（413），整条日志上报失败            |
| 数据库           | MySQL `TEXT` 只有 65535 字节，超出部分被静默截断        |
| localStorage     | 整源配额通常只有 ~5MB，一条日志就能把上传缓存挤爆        |
| IndexedDB        | 配额打满后写入失败，离线续传功能连带失效                 |

而 Data URL 里那串 base64 对排障几乎没有价值 —— 你需要知道的是"这里有一张
245KB 的 PNG"，不是这张图的每一个字节。

---

## 📦 三条规则

按顺序执行，**永远不静默截断用户主动写入的文本**：

### 1. 二进制内容 → 结构化占位符

Data URL、`Blob`、`File`、`ArrayBuffer`、TypedArray 会被替换成一行简短说明：

```typescript
logger.error('upload failed', {
  context: { screenshot: 'data:image/png;base64,iVBORw0KG...' }, // 245KB
});

// 实际上报的内容：
// context.screenshot === '[omitted:data-url mime=image/png bytes=245678]'
```

顺带还会处理两类会让日志根本发不出去的值：

- **循环引用** → `[omitted:circular]`（否则 `JSON.stringify` 直接抛异常）
- **无法序列化的对象** → `[omitted:unserializable]`（定点替换，同一条日志的其它字段照常送达）

> 短于 256 字节的 Data URL（如 `data:text/plain,ok`）会原样保留 ——
> 它本身就是有效信息，替换掉反而丢信息。
>
> 这条规则对**每一条**日志都生效，不只是超限的那些：一条整体很小的日志里
> 夹着 300 字节的内联 SVG，同样会被替换。如果你就是要原样记录小的 `data:` URI，
> 要么关掉本插件（`payloadSanitize: false`），要么存到别处、日志里只留引用。

### 2. 单字段超限 → 整条拒绝并报错

```typescript
logger.info('dump', { context: { blob: 'x'.repeat(200000) } });
```

```
[Aemeath] Log "xxx" was DROPPED: field "context.blob" alone is 200002 bytes,
above the 60000-byte budget for a single upload. A single field cannot be split,
so the whole entry is unsendable. Split the data across fields, store it
elsewhere and log a reference, or raise `payloadSanitize.maxBytes`.
```

**为什么是拒绝而不是截断？** 因为截断等于替你决定"哪一半重要"。日志库不该
替业务做这种判断 —— 单个字段就有 60KB，本身就是业务侧该修的问题。

这条丢弃是**可观测**的，两条路都能收到：`payload:rejected` 事件带上是哪个字段、
多大、以及它实际是拿哪个上限（`budget`）比的；同时它也会走 UploadPlugin 统一的丢弃出口，以 `payload-too-large` 原因
触发 `onDrop` 和 `upload:drop`。也就是说只接了 `onDrop` 的宿主不会漏掉它。

### 3. 整包超限 → 按字段拆成多条

每个字段都不超限、但加起来超了，就按字段边界拆开，一条都不少：

```typescript
logger.error('checkout failed', {
  context: { cart: /* 30KB */, user: /* 20KB */, trace: /* 25KB */ },
});
```

```jsonc
// 分片 1
{ "logId": "abc-1", "message": "checkout failed", "timestamp": 1717...,
  "tags": { "splitId": "abc", "splitIndex": 1, "splitTotal": 2, "splitBytes": 76543 },
  "context": { "cart": ..., "user": ... } }

// 分片 2
{ "logId": "abc-2", "message": "checkout failed", "timestamp": 1717...,
  "tags": { "splitId": "abc", "splitIndex": 2, "splitTotal": 2, "splitBytes": 76543 },
  "context": { "trace": ... } }
```

每个分片都是**独立合法**的 `LogEntry`，能单独入库；后端按 `tags.splitId` 归并即可。
同时 `console.warn` 提示一次，并触发 `payload:split` 事件。

#### 拆分对日志身份的影响

后端拿到分片之前，有三件事需要先知道：

- **每个分片有自己的 `logId`**（`abc-1`、`abc-2`…），原值保留在 `tags.splitId`。
  这是刻意的：若分片共用同一个 `logId`，把它当主键或幂等键的后端会把 N 个分片
  去重成一条，反而丢数据。
- **`splitId` / `splitIndex` / `splitTotal` / `splitBytes` 是保留 tag 名。** 你若有
  同名 tag，拆分时会被覆盖，以保证接收端拼得回来。
- **小字段复制到每个分片，大字段不复制。** 512 字节以内的内容 —— `context.userId`、
  `context.sessionId`、你自己的业务 tag —— 会出现在所有分片上，因此按会话 join、
  按 tag 告警在每个分片上都成立。真正撑爆体积的大字段（以及被当作一个整体的
  `error`）各自只落在一个分片里。所以一条 error 日志拆成 3 片，会得到三条
  `level: "error"`，其中只有一条带 `error` 对象。

如果你的入库表对"只出现在某一片"的字段设了 `NOT NULL`，要么先按 `splitId` 拼回
再写库，要么调大 `maxBytes` 让拆分不触发。

拆分只在**字段边界**上发生，不会把一个字段劈成两半。短消息（≤200 字节）会内联
进每个分片方便阅读；`level` / `timestamp` / `environment` / `release` 全部复制到每一片。

---

## ⚙️ 配置

```typescript
initAemeath({
  upload,
  payloadSanitize: true, // 默认值，可省略
});

// 自定义上限
initAemeath({
  upload,
  payloadSanitize: { maxBytes: 30000 },
});

// 关闭（不推荐）
initAemeath({ upload, payloadSanitize: false });
```

| 配置项    | 类型     | 默认值  | 说明                        |
| --------- | -------- | ------- | --------------------------- |
| `maxBytes`| `number` | `60000` | 单条上报体的最大 UTF-8 字节数 |

### 默认值为什么是 60000

以最常见的落库方式倒推：MySQL `TEXT` 列上限 **65535 字节**。留出约 5KB 给
请求包装、服务端补充字段和网关头，60000 是一个能让整条日志稳稳进库的安全值。

注意口径是**整条上报体序列化后的 UTF-8 字节数**，不是字符数：一个汉字 3 字节，
一个 emoji 4 字节。60000 字节约等于 20000 个汉字或 60000 个 ASCII 字符。

如果你的后端用的是 `MEDIUMTEXT`（16MB）或 MongoDB，可以放心调高。

### 关闭意味着什么

```
[Aemeath] `payloadSanitize` is disabled. Data URLs, Blobs and oversized text will be
uploaded and cached as-is, which can break your upload endpoint, truncate database
columns and exhaust localStorage / IndexedDB quota. You are on your own here.
```

关闭后超大日志会原样进入上传队列与本地缓存。上表里那一串后果就都是你的了。

---

## 🔭 观测

```typescript
const logger = getAemeath();

logger.on('payload:split', ({ splitId, chunks, bytes }) => {
  console.log(`log ${splitId} split into ${chunks} parts (${bytes} bytes)`);
});

logger.on('payload:rejected', ({ logId, field, fieldBytes, budget }) => {
  console.log(`log ${logId} rejected: ${field} is ${fieldBytes} bytes, limit ${budget}`);
});

// 累计计数
const plugin = logger.getPluginInstance('payload-sanitize');
console.log(plugin.getStats());
// { processed, sanitized, split, splitChunks, rejected }
```

控制台提示会自动收敛：占位提示每个会话只出现一次，拆分警告和拒绝错误各最多
连续输出 3 次后转为静默计数 —— 生产环境不会被日志库自己刷屏，但计数一条不少。

---

## 🧩 在管道中的位置

```
采集插件（ErrorCapture / Network / Performance…）
        ↓
   PayloadSanitizePlugin   ← 就在这里
        ↓
   BeforeSendPlugin（你的 beforeSend 钩子）
        ↓
   listener / UploadPlugin
```

放在 `beforeSend` **之前**是刻意的：你写脱敏逻辑时面对的已经是清洗过的骨架，
不必自己判断某个字段是不是 200KB 的 base64。

拆分产生的多条日志会各自完整地走完后续管道 —— `beforeSend` 对每个分片都会调用一次。

从这里开始，一个分组是"要么整组到齐，要么整组不发"。如果你的 `beforeSend` 拦下了
其中一片，SDK 会把同组其余分片一并丢掉：半组分片后端拼不回来，而放行其余分片
恰恰会漏掉你本想拦住的那条日志。上传队列溢出时同理，淘汰的是整组而不是单片。

### 拆分放大的是请求数，不是日志数

`SafeGuardPlugin` 的限流是在清洗**之前**按日志条数计的，所以一条拆成 3 片的日志
会变成 3 次上报。限流放行 4 条，最终可能发出 12 个请求。

这是拆分的固有代价 —— 字节总得送到后端 —— 但它只发生在真的超出 `maxBytes` 的日志上。
如果你观察到持续拆分，该改的是上游：别再往日志里塞大载荷，或者在存储扛得住的前提下
调大 `maxBytes`。两条内容相同、且都会被拆分的日志仍然会按整组去重，
所以重复报错不会被成倍放大。

---

## 🔗 相关文档

- [UploadPlugin](./4-upload-plugin.md) — 队列、重试与丢弃
- [断网续传](./11-offline-persistence.md) — 离线落盘与自动补传
- [`beforeSend` 钩子](./9-before-send.md) — 全链路最终拦截
