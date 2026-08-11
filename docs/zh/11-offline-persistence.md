# 断网续传（OfflinePersistence）

> v1.10.1+ · `initAemeath({ upload })` 默认开启 · 断网期间落盘，联网后自动补传

> 如需纯内存投递，显式传 `offlinePersistence: false`。手动组装插件时仍需在
> `UploadPlugin` 之后安装 `OfflinePersistencePlugin`。

---

## 🚀 快速开始

```typescript
import { classifyHttpUploadResponse, initAemeath } from 'aemeath-js';

initAemeath({
  upload: async (log) => {
    const res = await fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
    return classifyHttpUploadResponse(res.status, res.headers.get('Retry-After'));
  },
  // offlinePersistence 默认即为 true
});
```

开启后：断网期间产生的日志写入 IndexedDB，网络恢复自动补传；浏览器关掉再打开也不丢。

---

## 🤔 和 `cache` 有什么区别

`UploadPlugin` 自带的 `cache` 是**队列镜像**，只解决页面重载：

| 场景                       | `cache`（内置） | `offlinePersistence` |
| -------------------------- | --------------- | -------------------- |
| 刷新页面 / 关闭后重开      | ✅              | ✅                   |
| 断网几分钟后恢复           | ⚠️ 队列暂停期间靠它兜底 | ✅ 自动补传 |
| 断网期间关闭浏览器，次日打开 | ❌ 默认 1 小时 TTL 已过 | ✅ 默认保留 7 天 |
| 日志被 UploadPlugin 丢弃   | ❌ 丢了就不在缓存里 | ✅ 落盘留待补传 |
| 存储介质                   | localStorage（~5MB 整源共享） | IndexedDB（默认 2MB 预算） |

一句话：`cache` 保的是**队列**，`offlinePersistence` 保的是**日志**。

---

## 🔧 工作原理

全部基于 `UploadPlugin` 的事件，不侵入主上传通道：

```
        断网
          │
          ├── UploadPlugin 暂停队列
          │      └─ upload:paused ──────────► 快照落盘
          │
          └── 期间新产生的日志
                 └─ upload:enqueued{paused} ► 落盘
          │
        （兜底）upload:drop ─────────────────► 落盘
          │
        网络恢复
          │
          ├── UploadPlugin 自己发出还在内存队列里的日志
          │      └─ upload:success ─────────► 删除持久副本
          │
          └── online / upload:resumed
                 └─ 分批 upload.requeue() ──► 补传剩余的
```

五条关键设计：

**成功才删。** 入队即删会在上传失败时丢掉唯一的持久副本，所以持久副本一直留到
`upload:success` 才清理。代价是短暂的双份存在，收益是任何一环崩掉都不丢日志。

**被明确拒收的也删。** 服务端回了 `shouldRetry: false` 或 `retryReason: 'payload'`，
说明这条日志再投多少次都会被拒。持久副本会就地清掉，不会留着占配额、也不会在
下次上线时被翻出来重投一遍。

**补传走 `requeue()`，不走 `logger.log()`。** 补传的日志直接进上传队列，不会二次
经过 `beforeSend`、不会触发业务侧的 `logger.on('log')`、不会被其它插件重复加工。
你的埋点统计不会因为一次断网恢复而凭空多出一批。

**单实例内不重复上报。** 网络恢复时，内存队列和持久层可能各持有同一条日志。
补传前会检查 `upload.isPending(logId)`，queued、in-flight、parked 副本都会跳过。
1.10.1 不包含跨标签页选主，因此后文的后端幂等要求是强制项。

**可恢复失败进入 parked，不删除。** 热重试有界，耗尽后日志进入 `parked` 并保留
持久副本；永久失败（`shouldRetry: false`、不可重试 4xx、payload 拒收）会立即清理。
`maxReplayAttempts` 仅保留为 legacy 补传链路的终止保护。

**分片身份由结构决定。** 只有 `tags.splitId` 同时带有 `splitIndex` 或 `splitTotal`
时才启用原子组语义；裸 `splitId` 仍是普通业务标签，独立日志不会被误绑后一起延迟、
淘汰或删除。旧 KV 记录若采用过旧解释，会在 hydrate 边界一次性规范化。

---

## 🕐 补传日志上的时间字段

补传的日志会带上三个额外信息，让你能区分"当时发生"和"事后补传"：

```jsonc
{
  "timestamp": 1717000000000,     // 捕获时刻，永远不变
  "tags": {
    "offlineReplay": true,        // 这是一条补传日志
    "uploadedAt": 1717003600000,  // 实际发出时刻（所有日志都有）
  }
}
```

`timestamp` 保持捕获时刻是刻意的 —— 改掉它，时间线上这条错误就会挪到用户根本没
操作的时间点。需要知道延迟了多久就算 `uploadedAt - timestamp`。

---

## ⚙️ 配置

```typescript
initAemeath({
  upload,
  offlinePersistence: {
    storage: 'auto',           // 'auto' | 'indexeddb' | 'localstorage'
    ttl: 7 * 24 * 3600 * 1000, // 持久副本有效期
    maxEntries: 500,           // 最多保留条数
    maxTotalBytes: 2_000_000,  // 最多占用字节
    replayBatchSize: 10,       // 每轮补传条数
    maxReplayAttempts: 3,      // legacy 补传终止保护
    replayTimeoutMs: 60000,    // 补传对账超时
    dbName: 'aemeath-offline', // IndexedDB 库名
    key: '__aemeath_offline__',// localStorage key 前缀
    debug: false,
  },
});
```

| 配置项              | 类型                                          | 默认值             | 说明                             |
| ------------------- | --------------------------------------------- | ------------------ | -------------------------------- |
| `storage`           | `'auto' \| 'indexeddb' \| 'localstorage'`     | `'auto'`           | 后端偏好，不可用时仍会降级       |
| `ttl`               | `number`                                      | 7 天               | 从落盘时刻算起                   |
| `maxEntries`        | `number`                                      | IDB 500 / KV 100   | 已提交副本条数上限，也是暂态写意图缓冲的有界预算基数 |
| `maxTotalBytes`     | `number`                                      | IDB 2MB / KV 512KB | 已提交副本字节上限，也是暂态写意图缓冲的有界预算基数 |
| `replayBatchSize`   | `number`                                      | `10`               | 避免恢复瞬间打爆服务端           |
| `maxReplayAttempts` | `number`                                      | `3`                | legacy 补传链路终止保护           |
| `replayTimeoutMs`   | `number`                                      | `60000`            | 既无成功也无失败回执时的重投间隔 |
| `dbName`            | `string`                                      | `'aemeath-offline'`| IndexedDB 数据库名               |
| `key`               | `string`                                      | `'__aemeath_offline__'` | KV 后端 key 前缀            |
| `debug`             | `boolean`                                     | `false`            | 输出内部调试日志                 |

也可以手动安装（不使用 `initAemeath` 时）：

```typescript
import { AemeathLogger, UploadPlugin, OfflinePersistencePlugin } from 'aemeath-js';

const logger = new AemeathLogger();
logger.use(new UploadPlugin({ onUpload }));
logger.use(new OfflinePersistencePlugin()); // 必须在 UploadPlugin 之后
```

---

## 💾 存储后端与降级

```
IndexedDB ──不可用──► localStorage ──不可用──► noop（不落盘，只警告）
```

**为什么优先 IndexedDB**：容量以百 MB 计而不是 5MB；异步 API 不阻塞主线程；
按 key 读写不需要每次序列化整个集合。localStorage 只是兜底。

如果上一次启动因 IndexedDB 暂时不可用而降级到 localStorage，下次 IndexedDB 恢复时，
SDK 会先把旧 KV 记录提交到 IndexedDB，确认提交成功后再删除 KV 副本，然后才开始
hydrate 和补传。迁移或完整性扫描失败时本轮进入只删不写的降级态，不会把半边数据
伪装成空库继续写入。

会走到降级的真实场景：Safari 无痕模式下 IndexedDB 打开会挂起（我们有 2 秒超时）、
部分 WebView 禁用了 IndexedDB、以及 `storage: 'localstorage'` 显式指定。

两种都不可用时（比如某些隐私模式下 `localStorage.setItem` 静默失败），插件退化为
`noop` 并输出一次警告，同时触发 `upload:offline-unavailable` 事件。**上传本身完全不受影响**，
只是失去了断网续传能力。

> 判定 localStorage 可用与否用的是"写入 → 读回 → 校验 → 清理"完整往返，
> 因为部分宿主的 `setItem` 会静默吞掉配额错误，只看是否抛异常并不可靠。

---

## ⚠️ 配额与丢弃

配额是真实存在的天花板，所以这里的策略是**明确淘汰 + 明确上报**，绝不静默：

1. 写入前检查条数与字节预算，超了就按落盘时间淘汰最旧的
2. 写入仍失败（多半是配额）→ 再淘汰 20% 重试一次
3. 还是失败 → 丢弃这条，以 `storage-quota` 原因触发 `onDrop`

按落盘时间而不是优先级淘汰：断网期间日志优先级往往完全一样，时间顺序是唯一
稳定可预期的标准。

### 持久化预算与上传队列相互独立

这两项约束已提交的离线副本；存储短暂故障时，未提交写意图也会按同一预算派生出的
上限留在内存等待退避重试。它们不约束独立的 `UploadPlugin` 队列：

| 场景 | 谁说了算 | 结果 |
|---|---|---|
| 同页断网 → 恢复（页面没关） | 内存队列 | 磁盘上被淘汰的条目，**仍可能从内存发出去** |
| 关页 / 刷新后只剩磁盘 | `maxEntries` / `maxTotalBytes` | 淘汰生效，最早的补不回来 |
| 存储短暂失败 | 持久化写意图缓冲 | 指数退避后重试；超过有界预算会明确上报，不会无限增长 |

这是刻意的分层：临时断网、页面还开着时，不应因为磁盘满了就把内存里
本来能发出去的日志一并扔掉。磁盘配额保护的是「页面死后还能捡回多少」。

想限制**同页**积压，请调上传队列的 `queue.maxSize`（那才管内存）。
磁盘淘汰本身会走 `onDrop`（`reason: 'storage-quota'`），可观测，但不会
同步踢掉内存队列。

```typescript
initAemeath({
  upload,
  onDrop: (log, info) => {
    if (info.reason === 'storage-quota') {
      // 存储满了，这条没能留下
    }
  },
});
```

---

## 🔭 状态查询

需要上传队列与持久层的统一视图时，优先使用
[`logger.getDeliveryStatus()`](./12-delivery-status.md)。

```typescript
const plugin = getAemeath().getPluginInstance('offline-persistence');

plugin.getStatus();
// {
//   backend: 'indexeddb',  // 或 'localstorage' / 'noop' / 'initializing'
//   pending: 42,           // 待补传条数
//   buffered: 2,           // 尚未提交的写入/元数据更新
//   bytes: 128374,         // 估算占用
//   replaying: 3,          // 正在补传
//   quotaDrops: 0,         // 因配额丢弃
//   giveUps: 0,            // 因反复失败放弃
//   replayed: 137,         // 成功补传
//   items: [{ logId, capturedAt, state: 'persisted' | 'replaying' | 'buffering' }],
// }

await plugin.clear(); // 清空已提交副本及未提交的写入/删除意图
```

---

## 🚧 已知限制

### 后端必须按 `logId` 幂等

**多标签页可能重复补传。** 1.10.1 能阻止单个 SDK 实例内部重复，但不会在多个标签页
之间选主，同一条记录仍可能多次到达接口。

日志接收接口**必须**对 `(项目/租户作用域, logId)` 建唯一约束；重复键应返回成功，
但不能再次写入。`logId` 在重试和离线补传中保持不变；`requestId` 每次尝试都会变化，
绝不能用作幂等键。拆分后的每个分片本身有独立 `logId`。

这是正确性要求，不是可选优化。跨标签页协调计划放入 2.6.0，但即使未来完成，网络
结果不确定仍要求后端幂等。

**以事务提交为成功边界，但进程关闭阶段仍是尽力而为。** IndexedDB 只有在事务
`oncomplete` 后才报告成功，单个 request 的 success 不算落盘。若浏览器在提交前终止
进程，SDK 无法补完操作；KV 降级层的正文与索引也无法组成原生事务。失败会明确暴露，
不会被报告成已经持久化。

**同一页面上多个实例必须分别配置 `dbName`、KV `key` 与上传 `cache.key`。**
两个实例共用任一可能的存储资源时，A 攒下的离线日志会被 B 自动补传到 B 的上报地址上 —— 补传是
自动发生的，这类串台尤其难查。SDK 检测到撞车时会**让第二个实例停用**（`getStatus().backend`
返回 `'noop'`）并在控制台报出提示。要让两边都能持久化，各配一个库名：

```ts
new OfflinePersistencePlugin({ dbName: 'host-offline', key: 'host-offline-kv' });
new OfflinePersistencePlugin({ dbName: 'widget-offline', key: 'widget-offline-kv' });
```

`UploadPlugin` 的 `cache.key` 有同样的要求，见
[上传插件](./4-upload-plugin.md)。

**不做加密。** 落盘的是明文 JSON。日志里有敏感信息的话，请在
[`beforeSend`](./9-before-send.md) 里先脱敏 —— 它在落盘之前执行。

---

## 🔗 相关文档

- [UploadPlugin](./4-upload-plugin.md) — 队列、重试、丢弃与事件
- [统一 Delivery 状态中心](./12-delivery-status.md) — 聚合状态与生命周期别名
- [载荷清洗](./10-payload-sanitize.md) — 控制单条日志体积，避免撑爆存储
- [`beforeSend` 钩子](./9-before-send.md) — 落盘前脱敏
