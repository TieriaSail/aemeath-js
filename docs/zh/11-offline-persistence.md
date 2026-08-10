# 断网续传（OfflinePersistence）

> v2.5.0+ · 配置 `upload` 后**默认开启** · 断网期间落盘，联网后自动补传

> ⚠️ 持久副本是明文 JSON，默认最长保留 7 天。请先通过 `beforeSend` 脱敏，并按
> 业务合规要求评估是否适用；不允许本地持久化的项目请显式配置
> `offlinePersistence: false`。

> ⚠️ **后端必须按 `(projectId/tenantId, logId)` 幂等去重。** 离线恢复是至少一次
> 投递；服务端已写入但响应丢失时，客户端只能再次发送相同 `logId`。重复项应返回成功，
> 不能用每次变化的 `requestId` 去重。

---

## 🚀 快速开始

```typescript
import { initAemeath, classifyHttpUploadResponse } from 'aemeath-js';

initAemeath({
  upload: async (log) => {
    const res = await fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
    return classifyHttpUploadResponse(res.status, res.headers.get('Retry-After'));
  },
});
```

只要配置了 `upload`，断网期间产生的日志就会默认写入 IndexedDB，网络恢复自动补传；
浏览器关掉再打开也能恢复。可用 `offlinePersistence: false` 显式关闭；标准入口会同时
关闭并清除 Upload queue cache 与 OfflinePersistence 副本，确保之后不再本地留存。

---

## 🤔 和 `cache` 有什么区别

`UploadPlugin` 自带的 `cache` 是**队列镜像**，只解决页面重载：

| 场景                       | `cache`（内置） | `offlinePersistence` |
| -------------------------- | --------------- | -------------------- |
| 刷新页面 / 关闭后重开      | ✅              | ✅                   |
| 断网几分钟后恢复           | ⚠️ 队列暂停期间靠它兜底 | ✅ 自动补传 |
| 断网期间关闭浏览器，次日打开 | ❌ 默认 1 小时 TTL 已过 | ✅ 默认保留 7 天 |
| 可恢复失败耗尽热重试预算   | ✅ 镜像 `parked` 状态 | ✅ 保留持久副本 |
| 存储介质                   | localStorage（~5MB 整源共享） | IndexedDB（默认 2MB 预算） |

一句话：`cache` 保的是**队列**，`offlinePersistence` 保的是**日志**。
这两个机制内部仍独立，但标准入口的总开关 `offlinePersistence: false` 会同时关闭两者；
手动 `new UploadPlugin()` 时仍由 `cache.enabled` 单独控制。

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
        可恢复失败耗尽热预算
          └── upload:parked ─────────────────► 保留持久副本
        （兜底）queue-overflow / legacy drop ─► 落盘
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

**同一页面内避免双份恢复。** 网络恢复的瞬间，内存队列和持久层可能各持有同一条
日志的副本。补传前会检查 `upload.isPending(logId)`，本页面已在队列或正在飞行的一律
跳过。该检查不跨标签页；2.6 的跨标签设计见下方限制说明。

**parked 不消耗补传生命周期。** 默认上传策略下，可恢复失败耗尽热预算后由
`UploadPlugin` 持有在 `parked` 区，磁盘副本保持不动。冷却/`Retry-After` 到期（或显式
`flush()`）并成功后才删除；`online` 提示不会覆盖该期限。`maxReplayAttempts` 保留为
legacy 兼容保护：只有旧式
补传链路真的发出终态失败事件时才计数，parked 不计入。

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
    maxReplayAttempts: 3,      // legacy 补传失败保护；parked 不计数
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
| `maxEntries`        | `number`                                      | IDB 500 / KV 100   | **磁盘**最多保留条数，超出淘汰最旧的（不管内存队列） |
| `maxTotalBytes`     | `number`                                      | IDB 2MB / KV 512KB | **磁盘**最多占用字节，超出淘汰最旧的（不管内存队列） |
| `replayBatchSize`   | `number`                                      | `10`               | 避免恢复瞬间打爆服务端           |
| `maxReplayAttempts` | `number`                                      | `3`                | legacy 补传失败保护；parked 不计数 |
| `replayTimeoutMs`   | `number`                                      | `60000`            | 既无成功也无失败回执时的重投间隔 |
| `dbName`            | `string`                                      | `'aemeath-offline'`| IndexedDB 数据库名               |
| `key`               | `string`                                      | `'__aemeath_offline__'` | KV 后端 key 前缀            |
| `debug`             | `boolean`                                     | `false`            | 输出内部调试日志                 |

也可以手动安装（不使用 `initAemeath` 时）：

```typescript
import { Aemeath, UploadPlugin, OfflinePersistencePlugin } from 'aemeath-js';

const logger = new Aemeath();
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
2. 遇到明确配额错误 → 再淘汰 20% 重试一次
3. 配额重试仍失败 → 以 `storage-quota` 触发 `onDrop`
4. 非配额的不可存储值 → 不淘汰健康日志，以 `storage-rejected` 单独上报

按落盘时间而不是优先级淘汰：断网期间日志优先级往往完全一样，时间顺序是唯一
稳定可预期的标准。

### `maxEntries` / `maxTotalBytes` 只管磁盘

这两项约束的是**离线库落盘容量**，不是 `UploadPlugin` 的内存队列：

| 场景 | 谁说了算 | 结果 |
|---|---|---|
| 同页断网 → 恢复（页面没关） | 内存队列 | 磁盘上被淘汰的条目，**仍可能从内存发出去** |
| 关页 / 刷新后只剩磁盘 | `maxEntries` / `maxTotalBytes` | 淘汰生效，最早的补不回来 |

这是刻意的分层：临时断网、页面还开着时，不应因为磁盘满了就把内存里
本来能发出去的日志一并扔掉。磁盘配额保护的是「页面死后还能捡回多少」。

想限制**同页**积压，请调上传队列的 `queue.maxSize`（那才管内存）。
磁盘淘汰本身会走 `onDrop`（`reason: 'storage-quota'`），可观测，但不会
同步踢掉内存队列。

```typescript
initAemeath({
  upload,
  // 配置 upload 后已默认开启；只有调参时才需要再传对象配置
  onDrop: (log, info) => {
    if (info.reason === 'storage-quota') {
      // 存储满了，这条没能留下
    }
    if (info.reason === 'storage-rejected') {
      // 该条无法被持久化引擎接受，不是容量不足
    }
  },
});
```

---

## 🔭 状态查询

```typescript
const plugin = getAemeath().getPluginInstance('offline-persistence');

plugin.getStatus();
// {
//   backend: 'indexeddb',  // 或 'localstorage' / 'noop' / 'initializing'
//   pending: 42,           // 待补传条数
//   bytes: 128374,         // 估算占用
//   replaying: 3,          // 正在补传
//   quotaDrops: 0,         // 因配额丢弃
//   giveUps: 0,            // legacy 补传链路因反复失败放弃
//   replayed: 137,         // 成功补传
//   items: [{ logId, capturedAt, state: 'persisted' | 'replaying' }],
// }

await plugin.clear(); // 清空所有持久副本
```

跨 Upload 与持久层查看全局状态时，不要把两个计数直接相加；同一个 `logId` 通常同时
存在于内存和磁盘。使用统一接口，它会按 `logId` 去重：

```typescript
const status = getAemeath().getDeliveryStatus();
// { totalPending, queued, inFlight, parked, persisted, persistedOnly, replaying, ... }
```

`logger.on('delivery:status', listener)` 可订阅统一快照，成功落盘另有
`delivery:persisted` 事件。旧的 `plugin.getStatus()` 继续作为存储层诊断接口。

---

## 🚧 已知限制

**2.5 多标签页可能重复补传。** 每个标签页各自持有一份存储句柄，同一条日志可能被
多个标签页同时补传。后端必须按 `logId` 幂等去重，并将重复项视为成功。

**尽力而为，不是事务保证。** IndexedDB 写入是异步的，进程被强杀（崩溃、
`window.close()` 后立即关机）时最后几笔未落盘的写入会丢。

**同一页面上多个实例要各配一组独立的 `dbName` 和 `key`。** `dbName` 标识
IndexedDB，`key` 标识 KV 降级后端；共享其中任一资源时，A 攒下的离线日志都可能被
B 自动补传到 B 的上报地址上 —— 补传是
自动发生的，这类串台尤其难查。SDK 检测到撞车时会**让第二个实例停用**（`getStatus().backend`
返回 `'noop'`）并在控制台报出提示。要让两边在任一后端都能持久化，两项都要区分：

```ts
new OfflinePersistencePlugin({ dbName: 'host-offline', key: 'host-offline' });
new OfflinePersistencePlugin({ dbName: 'widget-offline', key: 'widget-offline' });
```

`UploadPlugin` 的 `cache.key` 有同样的要求，见
[上传插件](./4-upload-plugin.md)。

**不做加密。** 落盘的是明文 JSON，默认 TTL 为 7 天。日志里有敏感信息的话，请在
[`beforeSend`](./9-before-send.md) 里先脱敏 —— 它在落盘之前执行。

**强制依赖 `logId` 幂等。** 补传使用与首次上报相同的 `logId`（`requestId` 每次
不同）。后端必须建立 `(projectId/tenantId, logId)` 唯一约束，并把重复项视为成功。

---

## 🔗 相关文档

- [UploadPlugin](./4-upload-plugin.md) — 队列、重试、丢弃与事件
- [载荷清洗](./10-payload-sanitize.md) — 控制单条日志体积，避免撑爆存储
- [`beforeSend` 钩子](./9-before-send.md) — 落盘前脱敏
