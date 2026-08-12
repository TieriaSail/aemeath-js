# 断网续传（OfflinePersistence）

> v2.6.0+ · 配置 `upload` 后**默认开启持久化** · 多标签协调需显式安装独立插件

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
    const res = await fetch('/api/logs', {
      method: 'POST',
      body: JSON.stringify(log),
    });
    return classifyHttpUploadResponse(
      res.status,
      res.headers.get('Retry-After'),
    );
  },
});
```

只要配置了 `upload`，断网期间产生的日志就会默认写入 IndexedDB，网络恢复自动补传；
浏览器关掉再打开也能恢复。可用 `offlinePersistence: false` 显式关闭；标准入口会同时
关闭并清除 Upload queue cache 与 OfflinePersistence 副本，确保之后不再本地留存。

浏览器应用确实存在多标签同时运行时，再显式安装独立插件：

```typescript
import {
  AemeathLogger,
  OfflinePersistencePlugin,
  UploadPlugin,
} from 'aemeath-js';
import { CrossTabDeliveryPlugin } from 'aemeath-js/plugins/CrossTabDeliveryPlugin';

const logger = new AemeathLogger();
// 必须先预装协调插件，再安装会恢复缓存的 Upload 和 Offline。
logger.use(new CrossTabDeliveryPlugin());
logger.use(new UploadPlugin({ onUpload: upload }));
logger.use(new OfflinePersistencePlugin());
```

2.6.0 beta 中，多标签模式要求使用上面的显式安装顺序；不要先调用
`initAemeath({ upload })` 再补装插件。后者已经按 2.5.2 语义同步启动 Upload 缓存恢复，
插件不能追溯撤销已经发出的请求。这个约束换来的是：未启用插件时连缓存恢复时序也与
2.5.2 保持一致，而不是为了等待一个未来可能安装的插件而延迟所有用户。

未安装时仍使用原来的单上下文补传，不创建 leader、不打开 BroadcastChannel，也不探测
Web Locks；IndexedDB 仍使用 2.5.2 的 v1 `records` 存储，KV 也不写
namespace 绑定。该插件不在根入口和小程序入口中，小程序无需配置关闭选项。

启用插件时使用独立的 `${dbName}-aemeath-delivery-v2` 数据库，不会把默认 v1 数据库
升级到更高版本。因此灰度混跑 2.5 页面或回滚版本时，旧 SDK 仍能正常打开 v1；但这只是
**格式兼容**，不是把尚未送达的 v2 数据自动迁回 v1。移除插件前应先停止产生新日志，等
`offline.getStatus()` 的 `pending / buffered / replaying` 全部为 `0`，且
`crossTab.getStatus().leased === 0`，再移除配置并发布。紧急回滚时不要删除 v2 数据库；恢复
插件后仍可继续排空。首次升级只有在 `namespace` 保持默认的 `dbName:key` 规范身份时才自动迁移
无绑定的 v1 日志；自定义 namespace 无法证明旧正文属于哪个项目，SDK 会跳过读取和
迁移。若最终必须使用自定义 namespace，应先用默认配置完成迁移和补传，确认待投递数为
零后，再同时更换新的 `dbName` 与 namespace；不能把已绑定的同一数据库直接改绑。

---

## 🤔 和 `cache` 有什么区别

`UploadPlugin` 自带的 `cache` 是**队列镜像**，只解决页面重载：

| 场景                         | `cache`（内置）               | `offlinePersistence`       |
| ---------------------------- | ----------------------------- | -------------------------- |
| 刷新页面 / 关闭后重开        | ✅                            | ✅                         |
| 断网几分钟后恢复             | ⚠️ 队列暂停期间靠它兜底       | ✅ 自动补传                |
| 断网期间关闭浏览器，次日打开 | ❌ 默认 1 小时 TTL 已过       | ✅ 默认保留 7 天           |
| 可恢复失败耗尽热重试预算     | ✅ 镜像 `parked` 状态         | ✅ 保留持久副本            |
| 存储介质                     | localStorage（~5MB 整源共享） | IndexedDB（默认 2MB 预算） |

一句话：`cache` 保的是**队列**，`offlinePersistence` 保的是**日志**。
这两个机制内部仍独立，但标准入口的总开关 `offlinePersistence: false` 会同时关闭两者；
手动 `new UploadPlugin()` 时仍由 `cache.enabled` 单独控制。

---

## 🔧 工作原理

OfflinePersistence 默认使用单上下文持久状态机；安装 CrossTabDeliveryPlugin 后，恢复所有权
才升级为跨标签租约状态机：

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
          └── upload:parked ─────────────────► 持久化 parked 期限
        （兜底）queue-overflow / legacy drop ─► 落盘
          │
        网络恢复
          │
          ├── UploadPlugin 自己发出还在内存队列里的日志
          │      └─ upload:success ─────────► 删除持久副本
          │
          └── online / upload:resumed ──────► 单上下文补传
              （显式安装 CrossTabDeliveryPlugin 时）
              BroadcastChannel（仅唤醒）──► IDB 选主 + 整组 claim + fencing receipt
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

**显式启用后，跨标签只有一个恢复协调者。** IndexedDB 中的 leader lease、单调 epoch、逐记录 lease
和随机 fencing token 共同决定所有权。BroadcastChannel 只负责低延迟唤醒，Web Locks
只降低选主争用；两者都不是正确性来源。旧标签的失败、停放或终态回调若 token 已过期，
会被明确忽略；真实成功仍可按 `logId` 删除。

**Upload cache 先交接、后删除。** 页面启动时，Upload queue cache 不再和 OfflineStore
各自补传。缓存恢复项先冻结并写入 OfflineStore，全部提交或明确终态后才删除旧 cache；
交接过程中再次崩溃仍可从原 cache 恢复。

**parked 不消耗补传生命周期。** 默认上传策略下，可恢复失败耗尽热预算后由
`UploadPlugin` 持有在 `parked` 区，磁盘副本保持不动。冷却/`Retry-After` 到期（或显式
`flush()`）并成功后才删除；`online` 提示不会覆盖该期限。`maxReplayAttempts` 保留为
legacy 兼容保护：只有旧式
补传链路真的发出终态失败事件时才计数，parked 不计入。

**分片身份由结构决定。** 只有 `tags.splitId` 同时带有 `splitIndex` 或 `splitTotal`
时才启用原子组语义；裸 `splitId` 仍是普通业务标签，独立日志不会被误绑后一起延迟、
淘汰或删除。旧 KV 记录若采用过旧解释，会在 hydrate 边界一次性规范化。

---

## 🕐 补传日志上的时间字段

投递日志有三个不同身份字段，后端不要混用：

```jsonc
{
  "logId": "stable-across-retries", // 生命周期稳定；后端幂等键
  "requestId": "this-request-only", // 每次真实网络调用都变化
  "deliveryAttempt": 3, // 每次真实调用递增；多标签插件领取后会持久延续
  "timestamp": 1717000000000, // 捕获时刻，永远不变
  "tags": {
    "offlineReplay": true, // 这是一条补传日志
    "uploadedAt": 1717003600000, // 实际发出时刻（所有日志都有）
  },
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
    storage: 'auto', // 'auto' | 'indexeddb' | 'localstorage'
    ttl: 7 * 24 * 3600 * 1000, // 持久副本有效期
    maxEntries: 500, // 最多保留条数
    maxTotalBytes: 2_000_000, // 最多占用字节
    replayBatchSize: 10, // 每轮补传条数
    maxReplayAttempts: 3, // legacy 补传失败保护；parked 不计数
    replayTimeoutMs: 60000, // 补传对账超时
    dbName: 'aemeath-offline', // IndexedDB 库名
    key: '__aemeath_offline__', // localStorage key 前缀
    debug: false,
  },
});
```

| 配置项              | 类型                                      | 默认值                  | 说明                                                 |
| ------------------- | ----------------------------------------- | ----------------------- | ---------------------------------------------------- |
| `storage`           | `'auto' \| 'indexeddb' \| 'localstorage'` | `'auto'`                | 后端偏好，不可用时仍会降级                           |
| `ttl`               | `number`                                  | 7 天                    | 从落盘时刻算起                                       |
| `maxEntries`        | `number`                                  | IDB 500 / KV 100        | 已提交副本条数上限，也是暂态写意图缓冲的有界预算基数 |
| `maxTotalBytes`     | `number`                                  | IDB 2MB / KV 512KB      | 已提交副本字节上限，也是暂态写意图缓冲的有界预算基数 |
| `replayBatchSize`   | `number`                                  | `10`                    | 避免恢复瞬间打爆服务端                               |
| `maxReplayAttempts` | `number`                                  | `3`                     | legacy 补传失败保护；parked 不计数                   |
| `replayTimeoutMs`   | `number`                                  | `60000`                 | 既无成功也无失败回执时的重投间隔                     |
| `dbName`            | `string`                                  | `'aemeath-offline'`     | IndexedDB 数据库名                                   |
| `key`               | `string`                                  | `'__aemeath_offline__'` | KV 后端 key 前缀                                     |
| `debug`             | `boolean`                                 | `false`                 | 输出内部调试日志                                     |

也可以手动安装（不使用 `initAemeath` 时）：

```typescript
import {
  AemeathLogger,
  UploadPlugin,
  OfflinePersistencePlugin,
} from 'aemeath-js';
import { CrossTabDeliveryPlugin } from 'aemeath-js/plugins/CrossTabDeliveryPlugin';

const logger = new AemeathLogger();
// 可选协调插件必须最先安装，才能在 Upload 恢复 cache 前声明接管。
const crossTab = new CrossTabDeliveryPlugin({
  namespace: 'project-a', // 可选；默认由 Offline 的 dbName + key 稳定派生
  debug: false,
});
const offline = new OfflinePersistencePlugin();
logger.use(crossTab);
logger.use(new UploadPlugin({ onUpload }));
logger.use(offline); // 必须在 UploadPlugin 之后
```

`namespace` 与协调诊断开关属于可选插件，不属于 `OfflinePersistencePluginOptions`：

| CrossTab 配置项 | 类型      | 默认值       | 说明                                                  |
| --------------- | --------- | ------------ | ----------------------------------------------------- |
| `namespace`     | `string`  | `dbName:key` | v2 投递隔离域；已有 v1 待投递数据时先用默认值完成迁移 |
| `debug`         | `boolean` | `false`      | 输出协调器诊断日志                                    |

---

## 💾 存储后端与降级

```
IndexedDB ──不可用──► localStorage ──不可用──► noop（不落盘，只警告）
```

**为什么多标签插件只接受 IndexedDB**：除了容量和异步 API，它还能在一个事务里原子校验
leader epoch、领取整组记录并写入 fencing token。localStorage 无法提供相同保证，因此
CrossTabDeliveryPlugin 不会伪装成“尽力协调”；后端降级到 KV 时，它报告 `unsupported`，
OfflinePersistence 恢复原来的单上下文补传。

> **服务端必须按 `logId` 做幂等去重。** SDK 的租约和 fencing 能消除同版本正常运行时的
> 多标签竞争，但无法把“服务端已接收、浏览器在提交成功证明前崩溃”变成分布式 exactly-once；
> 2.5/2.6 灰度混跑或紧急回滚也可能产生重复请求。`deliveryAttempt` 只用于观测尝试世代，
> 不能替代 `logId` 唯一约束。

显式安装多标签插件后，一个 IndexedDB `dbName` 或 KV `key` 只能绑定一个 `namespace`。不同项目/租户仍应配置不同
的 `dbName` 与 `key`；若误用同一物理资源，SDK 会在读取任何日志正文前拒绝冲突绑定或安全
降级，不能依靠只隔离 leader 来掩盖串台风险。`clear()` 只清投递数据，不解除该身份绑定。

SDK 分片在协调数据库中以整组事务提交，其他标签页不会看到“已写第一片、其余尚未写”
的中间状态。`replayBatchSize` 是每轮吞吐软目标：如果一个完整分片组本身超过该值，仍会
整组领取一次，而不是永久饿死。TTL 清理同样在事务中复核活动 lease；真实请求在途时，
卸载协调插件不会提前释放该记录，接任标签只能等待结果或 lease 到期。

如果上一次启动因 IndexedDB 暂时不可用而降级到 localStorage，下次 IndexedDB 恢复时，
SDK 会先把旧 KV 记录提交到 IndexedDB，确认提交成功后再删除 KV 副本，然后才开始
hydrate 和补传。迁移或完整性扫描失败时本轮进入只删不写的降级态，不会把半边数据
伪装成空库继续写入。

会走到降级的真实场景：Safari 无痕模式下 IndexedDB 打开会挂起（我们有 3 秒超时）、
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

### 持久化预算与上传队列相互独立

这两项约束已提交的离线副本；存储短暂故障时，未提交写意图也会按同一预算派生出的
上限留在内存等待退避重试。它们不约束独立的 `UploadPlugin` 队列：

| 场景                        | 谁说了算                       | 结果                                                 |
| --------------------------- | ------------------------------ | ---------------------------------------------------- |
| 同页断网 → 恢复（页面没关） | 内存队列                       | 磁盘上被淘汰的条目，**仍可能从内存发出去**           |
| 关页 / 刷新后只剩磁盘       | `maxEntries` / `maxTotalBytes` | 淘汰生效，最早的补不回来                             |
| 存储短暂失败                | 持久化写意图缓冲               | 指数退避后重试；超过有界预算会明确上报，不会无限增长 |

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
//   buffered: 2,           // 尚未提交的写入/元数据更新
//   bytes: 128374,         // 估算占用
//   replaying: 3,          // 正在补传
//   quotaDrops: 0,         // 因配额丢弃
//   giveUps: 0,            // legacy 补传链路因反复失败放弃
//   replayed: 137,         // 成功补传
//   items: [{ logId, capturedAt, state: 'persisted' | 'replaying' | 'buffering' }],
// }

await plugin.clear(); // 清空已提交副本及未提交的写入/删除意图
```

跨 Upload 与持久层查看全局状态时，不要把两个计数直接相加；同一个 `logId` 通常同时
存在于内存和磁盘。使用统一接口，它会按 `logId` 去重：

```typescript
const status = getAemeath().getDeliveryStatus();
// { totalPending, queued, inFlight, parked, persisted, buffered, persistedOnly, replaying, ... }
```

`logger.on('delivery:status', listener)` 可订阅统一快照，成功落盘另有
`delivery:persisted` 事件。旧的 `plugin.getStatus()` 继续作为存储层诊断接口。

多标签状态属于独立插件，不污染统一状态对象：

```typescript
const crossTab = getAemeath().getPluginInstance('cross-tab-delivery');
crossTab.getStatus();
// { state: 'active', mode: 'strong', role: 'leader', leaderEpoch, leased, ... }
```

也可订阅 `cross-tab-delivery:status`、`cross-tab-delivery:leader-changed`、
`cross-tab-delivery:lease-recovered` 和 `cross-tab-delivery:degraded`。

---

## 🚧 已知限制

**显式安装 CrossTabDeliveryPlugin 后会在 IndexedDB 上协调补传，但仍是至少一次。** 正常多标签恢复由 leader lease
和记录 fencing 阻止并发补传；服务端已经提交、响应却丢失时，任何客户端都无法证明
“未成功”，所以仍可能再次发送相同 `logId`。localStorage/KV 不参与跨标签协调；后端降级时
恢复单上下文补传。
后端必须按 `logId` 幂等去重，并将重复项视为成功。

**以事务提交为成功边界，但进程关闭阶段仍是尽力而为。** IndexedDB 只有在事务
`oncomplete` 后才报告成功，单个 request 的 success 不算落盘。若浏览器在提交前终止
进程，SDK 无法补完操作；KV 降级层的正文与索引也无法组成原生事务。失败会明确暴露，
不会被报告成已经持久化。

**同一页面上多个实例要各配一组独立的 `dbName` 和 `key`。** `dbName` 标识
IndexedDB，`key` 标识 KV 降级后端；共享其中任一资源时，A 攒下的离线日志都可能被
B 自动补传到 B 的上报地址上 —— 补传是
自动发生的，这类串台尤其难查。SDK 检测到撞车时会**让第二个实例停用**（`getStatus().backend`
返回 `'noop'`）并在控制台报出提示。要让两边在任一后端都能持久化，两项都要区分：

```ts
new OfflinePersistencePlugin({ dbName: 'host-offline', key: 'host-offline' });
new OfflinePersistencePlugin({
  dbName: 'widget-offline',
  key: 'widget-offline',
});
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
