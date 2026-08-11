# UploadPlugin - 日志上传插件

> 完全自定义的回调式上传，简单灵活

> 💡 **隐私保护提示**：UploadPlugin 不内置脱敏。如需对每条日志做隐私过滤 / 字段裁剪，请使用 [`beforeSend` 钩子](./9-before-send.md)（v2.4.0+），它会在 UploadPlugin 接收日志**之前**生效。

> ⚠️ **后端幂等是强制接入要求**：可靠投递采用至少一次语义。后端必须对
> `(projectId/tenantId, logId)` 建立唯一约束，已经接收过的 `logId` 应返回成功语义。
> `requestId` 每次尝试都会变化，只能用于链路排障，不能用于去重。

---

## 📦 核心特性

### 1. 上传回调（返回 UploadResult）

通过返回值控制重试行为：

```typescript
interface UploadResult {
  success: boolean;
  shouldRetry?: boolean;
  /** 失败分类决定调度方式，不再决定是否保留日志 */
  retryReason?:
    | 'network' | 'server' | 'payload' | 'auth' | 'rate-limit'
    | 'unknown' | 'callback-error' | 'cancelled';
  /** 服务端建议的最短等待时间，例如解析 HTTP Retry-After 后的毫秒数 */
  retryAfterMs?: number;
  /** 原始 HTTP Retry-After 响应头；支持秒数和 HTTP-date */
  retryAfter?: string | null;
  error?: string;
}
```

### 2. 优先级回调

你定义日志优先级（1-100 的数字，越大越优先）

### 3. 队列机制

- 默认启用
- 串行处理（同一时间只有一个请求）
- 按优先级排序

### 4. 自动重试（带指数退避）

- 失败自动降低优先级（-10）
- 按 1s → 2s → 4s…（上限 30s）退避后重新入队
- 最多重试 3 次（可配置）
- 热重试预算耗尽后进入 `parked` 冷却区，不再冒充“已丢弃”
- `shouldRetry` 表示是否重试，`retryReason` 只负责失败分类与调度

### 5. 断网暂停 ⭐ v2.4.0

判定网络不可用时**暂停队列**而不是继续打空枪：不调 `onUpload`、不消耗重试预算、
不丢日志，网络恢复后自动继续。详见 [可靠性与丢弃](#-可靠性与丢弃)。

### 6. 丢弃可观测 ⭐ v2.4.0

只有日志生命周期真正终止时才触发 `onDrop` 和 `upload:drop`。进入 `parked`
不是丢弃，会单独触发 `upload:parked`。

### 7. 本地缓存

- 队列保存到 localStorage，页面刷新后自动恢复
- 按写入时刻计算 TTL（默认 1 小时，可配置）
- ⚠️ 缓存是**队列镜像**，只解决页面重载丢失，**不提供断网续传** ——
  那是 [OfflinePersistencePlugin](./11-offline-persistence.md) 的职责

---

## 🚀 快速开始

### 单例模式（推荐）

`initAemeath()` 直接接受 `upload` 回调，无需手动注册 `UploadPlugin`：

```typescript
import { initAemeath, getAemeath, classifyHttpUploadResponse } from 'aemeath-js';

initAemeath({
  upload: async (log) => {
    const response = await fetch('/api/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(log),
    });
    if (!response.ok) {
      return classifyHttpUploadResponse(
        response.status,
        response.headers.get('Retry-After'),
      );
    }
    const data = await response.json();
    if (data.code === 200) {
      return { success: true };
    }
    return { success: false, shouldRetry: true, retryReason: 'server', error: data.message };
  },
});

const logger = getAemeath();
logger.error('Something went wrong', { error });
```

> **与 NetworkPlugin 共存**：`onUpload` 执行期间（含其 await）发起的 fetch / XHR /
> `wx.request` 会被自动跳过网络监控，不会再被记成一条 `HTTP 200: POST /api/logs`
> 然后滚成自反馈环。你**不必**把上报地址塞进 `network.excludeUrls`——那是留给
> 第三方埋点等其它端点的。

### 手动组装

```typescript
import { AemeathLogger, UploadPlugin, classifyHttpUploadResponse } from 'aemeath-js';

const logger = new AemeathLogger();

logger.use(
  new UploadPlugin({
    onUpload: async (log) => {
      try {
        const response = await fetch('/api/logs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(log),
        });
        if (!response.ok) {
          return classifyHttpUploadResponse(
            response.status,
            response.headers.get('Retry-After'),
          );
        }
        const data = await response.json();
        if (data.code === 200) {
          return { success: true };
        }
        return { success: false, shouldRetry: true, retryReason: 'server', error: data.message };
      } catch (error) {
        return { success: false, shouldRetry: true, retryReason: 'network', error: error.message };
      }
    },
  }),
);

logger.error('Something went wrong', { error });
```

### 带认证

```typescript
logger.use(
  new UploadPlugin({
    onUpload: async (log) => {
      try {
        const token = getAuthToken(); // 你的认证逻辑

        const response = await fetch('/api/logs', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(log),
        });

        if (!response.ok) {
          return classifyHttpUploadResponse(
            response.status,
            response.headers.get('Retry-After'),
          );
        }

        const data = await response.json();

        if (data.code === 200) {
          return { success: true };
        } else {
          return {
            success: false,
            shouldRetry: true,
            retryReason: 'server',
            error: data.message,
          };
        }
      } catch (error) {
        return {
          success: false,
          shouldRetry: true,
          retryReason: 'network',
          error: error.message,
        };
      }
    },
  }),
);
```

### 自定义优先级

```typescript
logger.use(
  new UploadPlugin({
    onUpload: async (log) => {
      const res = await fetch('/api/logs', {
        method: 'POST',
        body: JSON.stringify(log),
      });
      return classifyHttpUploadResponse(res.status, res.headers.get('Retry-After'));
    },

    // 优先级回调
    getPriority: (log) => {
      // error 日志最高优先级
      if (log.level === 'error') return 100;

      // 紧急业务日志
      if (log.tags?.urgent) return 80;

      // warn 日志普通优先级
      if (log.level === 'warn') return 50;

      // 其他低优先级
      return 10;
    },
  }),
);
```

---

## 📊 工作原理

### 队列处理流程

```
日志捕获
    ↓
计算优先级（通过 getPriority 回调）
    ↓
加入优先级队列（按优先级排序）
    ↓
保存到本地缓存
    ↓
串行处理队列（同一时间只有一个请求）
    ↓
调用 onUpload 回调
    ↓
成功 → 从队列移除
    ↓
可恢复失败 → 降低优先级（-10），重新入队热重试
    ↓
热预算耗尽 → parked 冷却，稍后重新探测（不是 drop）
```

### 优先级系统

- 优先级是 **1-100 的数字**
- 数字越大越优先
- 默认优先级：
  - `error`: 100
  - `warn`: 50
  - `info` / `track`: 10
  - `debug`: 1

### 重试机制

1. 上传失败
2. 降低优先级 10 个单位
3. 按指数退避（1s → 2s → 4s…，上限 30s）安排下次尝试
4. 重复最多 3 次（可配置）
5. 热预算耗尽后进入 `parked`；冷却/`Retry-After` 到期或显式 `flush()` 才会重试。
   `online` 只放行因网络暂停的活跃队列，不会覆盖服务端等待时间。

### 串行处理

- 同一时间只有一个上传请求
- 避免性能问题
- 确保请求顺序
- 每次请求间隔 100ms

---

## 🛡️ 可靠性与丢弃

> v2.4.0 起，UploadPlugin 不再在断网时静默吞掉日志。

### 断网时会发生什么

```
判定离线
    ↓
暂停队列（emit upload:paused，附带当前扣住的日志快照）
    ↓
不调 onUpload · 不消耗重试预算 · 不丢日志
    ↓
5s → 10s → 20s…（上限 60s）发起一次「半开」探测
    ↓
收到 online 事件 → 只放行一条半开探测
    ↓
探测成功/收到服务端响应 → emit upload:resumed，继续正常消费
```

判定依据有两条，缺一不可：

| 信号                       | 含义                                                             |
| -------------------------- | ---------------------------------------------------------------- |
| `navigator.onLine === false` | 确定离线。此时连一次 `onUpload` 都不会调用                        |
| 连续**传输层**失败 ≥ `suspectedOfflineThreshold`（默认 3） | 疑似离线。WebView 里 `onLine` 常常只表示"有网络接口"，需要启发式兜底 |

只有**传输层**失败算数：你回了 `retryReason: 'network'`，或 `onUpload` 抛出的异常
能被认定为网络错误（判定规则见下）。服务端回了 5xx 恰恰证明链路是通的，那类失败
不会让队列暂停，走的是重试预算那条路。

同时有两个计数在跑：全局的连续失败数（判断"整条链路断了"）和每条日志各自的
连续传输失败数（判断"这一条一直发不出去"）。任一达到阈值都会暂停，因此不断
产生的其它日志不会把暂停判定"稀释"掉。

触发暂停的那一次失败会被**退还**，不计入重试预算。

### 重试预算 vs 离线暂停

两者防的是不同的事，不要混淆：

- **`maxRetries`** 限制单条日志在一个周期里的**热重试**，避免请求风暴；它不再等于日志生命周期上限。
- **`offlinePolicy`** 防的是**整条链路断掉** —— 此时队列暂停，根本不消耗重试预算。

因此断网场景下 `maxRetries` 不会被秒级耗尽，这正是 v2.5.0 修复的核心问题。

反过来也成立：后端整体故障（持续 5xx）走的是热重试预算，队列不会误判为离线。
预算耗尽的日志进入 `parked`，首次冷却 60 秒，后续按指数增长到最多 15 分钟；
每次只唤醒一条作为恢复探测。`parked` 与活跃队列共用 `queue.maxSize`，所以总内存
仍然有界；容量不足时才会以 `queue-overflow` 明确淘汰。

queued、parked 与未收齐的分片准入项都消耗同一份容量预算；SDK 分片按整组接纳和
淘汰。只有同时带 `splitIndex` 或 `splitTotal` 的 `tags.splitId` 才启用原子组语义，
裸 `splitId` 仍是普通业务标签，不会把独立日志绑定在一起。

链路长时间不可用时，队列会涨到 `maxSize` 并按优先级从低到高溢出丢弃
（原因 `queue-overflow`），这是有界的、可观测的降级，不是静默丢失。

### 精确告诉 SDK 失败原因

`shouldRetry` 与 `retryReason` 是正交的：前者表达意图，后者决定调度。兼容规则如下：

- `{ success: false, shouldRetry: true }`：重试，原因归为 `unknown`。
- `{ success: false, retryReason: 'server' }`：有明确失败分类，也视为重试意图。
- `{ success: false, shouldRetry: false }`：终态，不重试。
- 裸 `{ success: false }`：为兼容旧版本仍按终态处理。
- `retryReason: 'payload'`：终态；`network` 不消耗热重试预算。

推荐同时填写两者：

```typescript
import { classifyHttpUploadResponse } from 'aemeath-js';

upload: async (log) => {
  try {
    const res = await fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
    return classifyHttpUploadResponse(res.status, res.headers.get('Retry-After'));
  } catch {
    // 请求根本没发出去 → 不该算在这条日志头上
    return { success: false, shouldRetry: true, retryReason: 'network' };
  }
};
```

服务端返回 `Retry-After` 时，把原始响应头放进 `retryAfter` 即可。SDK 自动解析
delta-seconds（如 `120`）和 HTTP-date，并取服务端等待时间与本地指数退避中的较大值。
如果业务已经完成换算，可继续传 `retryAfterMs`；两者同时存在时它优先。

`flush()` 可以跳过 SDK 自己的本地退避和本地网络暂停，但绝不会越过服务端拥有的
`Retry-After` 截止时间。

#### 回调抛异常时怎么判定

没有 `retryReason` 的话，SDK 只能靠抛出的异常来猜，而且只在拿到**正面证据**时
才判定为离线：

| 抛出的值 | 判定为 |
| --- | --- |
| 带已知 fetch 网络文案的 `TypeError`（如 `Failed to fetch`、`Load failed`、`NetworkError …`） | `network` |
| `TimeoutError`，以及插件自己的上传超时 | `network` |
| `AbortError` | `cancelled`（不作为整条链路断开的证据） |
| `code` 为 `ERR_NETWORK`、`ECONNRESET`、`ETIMEDOUT` 等 | `network` |
| 异常 `response.status` 为 400/404/405/410/413/422 | `payload`（终态） |
| 异常 `response.status` 为 401/403 | `auth`（可恢复，例如刷新凭证） |
| 异常 `response.status` 为 429 | `rate-limit`；常见 `response.headers` 形态中的 `Retry-After` 会自动解析 |
| 异常上挂着其它 `response`（axios / ky / got） | `server` |
| 其余一切，包括回调自身产生的普通编程 `TypeError` | `callback-error` |

这个不对称是刻意的。把服务端失败误判成 `network`，整个队列会暂停，上报静默停摆；
把网络失败误判成其它可恢复原因，只会消耗热重试预算并进入 `parked`，不会暂停整条
队列，也不会伪造一次 drop。因此举证责任仍落在“离线”这一侧。

用 axios / ky / got 这类默认对非 2xx 抛异常的客户端，这条直接关系到你：后端故障
会走热重试预算，而不是暂停队列。想要确定性而不是启发式，就在
`onUpload` 里显式返回 `retryReason`。

### 知道自己丢了什么

```typescript
initAemeath({
  upload,
  onDrop: (log, info) => {
    // info.reason: 'no-retry' | 'queue-overflow' | 'cache-expired'
    //            | 'storage-quota' | 'storage-rejected' | 'payload-too-large'
    //            | 'deduplicated'
    // max-retries / offline-give-up 只会出现在 legacy 兼容链路
    console.warn('[log dropped]', info.reason, log.logId);
  },
});

// 等价的事件形式
getAemeath().on('upload:drop', ({ log, reason }) => { /* ... */ });
```

| 原因                | 什么时候出现                                       |
| ------------------- | -------------------------------------------------- |
| `no-retry`          | 服务端明确表示不必重试（`shouldRetry: false`）      |
| `max-retries`       | 仅 `offlinePolicy: 'legacy'`：重试预算耗尽         |
| `queue-overflow`    | 队列超过 `maxSize`，挤掉优先级最低的日志            |
| `cache-expired`     | 本地缓存中的日志超过 `cache.ttl`                    |
| `payload-too-large` | 单字段体积超限（见 [载荷清洗](./10-payload-sanitize.md)） |
| `storage-quota`     | 离线持久层配额已满                                  |
| `storage-rejected`  | 日志无法被持久化引擎接受（非配额问题）              |
| `offline-give-up`   | legacy 补传链路反复失败，放弃该条                   |
| `deduplicated`      | SDK 内容去重选择了另一个 `logId` 作为保留项          |

### 可用事件

| 事件               | 载荷                                    |
| ------------------ | --------------------------------------- |
| `upload:enqueued`  | `{ log, priority, source, paused }`     |
| `upload:attempt`   | `{ log, source, retryCount }`           |
| `upload:retry-scheduled` | `{ log, source, reason, retryCount, nextAttemptAt }` |
| `upload:parked`    | `{ log, priority, source, reason, retryCount, parkedUntil }` |
| `upload:unparked`  | `{ log, source, reason }`                |
| `upload:success`   | `{ log, source }`                       |
| `upload:drop`      | `{ log, reason, retryCount, error, source }` |
| `upload:paused`    | `{ reason, queued, logs }`              |
| `upload:resumed`   | `{ queued }`                            |

2.5.1 同时提供统一别名：`delivery:queued`、`delivery:attempt`、
`delivery:retry-scheduled`、`delivery:parked`、`delivery:unparked`、
`delivery:delivered`、`delivery:dropped`、`delivery:paused` 和 `delivery:resumed`。
持久层另有 `delivery:persisted`、`delivery:persistence-unavailable`；
`delivery:status` 在统一状态变化时给出完整快照。原有 `upload:*` 事件保持兼容。

### 随日志带出的上报期元数据

每条发出去的日志副本会补充上报期元数据（**不会**修改队列里的原始 entry）：

| 字段                            | 含义                                                        |
| ------------------------------- | ----------------------------------------------------------- |
| `requestId`                     | 每次上报尝试都不同，用于请求关联与排障                        |
| `logId`                         | 跨重试、parked 与离线补传保持不变；后端必须以它做幂等去重      |
| `tags.uploadedAt`               | **发出时刻**。与 `timestamp`（捕获时刻）配合，一眼看出是实时上报还是补传 |
| `tags.droppedSinceLastReport`   | 上次成功上报以来丢了多少条（有丢弃时才出现）                   |

后端看到的不再是一段无法解释的空白，而是"这里有个洞，深度 N"。不需要这些字段
可以在 [`beforeSend`](./9-before-send.md) 里删掉。

### 排查现场状态

```typescript
const logger = getAemeath();
console.log(logger.getDeliveryStatus());
// {
//   state: 'idle' | 'delivering' | 'paused' | 'degraded' | 'disabled',
//   totalPending,       // 按 logId 合并内存和磁盘，不重复计数
//   queued, inFlight, parked, persisted, persistedOnly, replaying,
//   oldestPendingAgeMs, consecutiveFailures,
//   attempts: { total, byReason },
//   drops: { total, byReason },
//   persistence: { enabled, backend, bytes, quotaDrops, giveUps, replayed },
// }

logger.on('delivery:status', (status) => {
  // 只在注册监听器后构建并推送状态快照
});

// 需要插件调试细节时，旧接口仍然可用：
const upload = logger.getPluginInstance('upload');
console.log(upload.getQueueStatus());
```

为保持补丁版本兼容，`getQueueStatus().items` 仍然只是活跃队列快照，继续满足
`items.length === length`。需要 queued + in-flight + parked 的全量条目时请用
`pendingItems`；`getDeliveryStatus()` 已经使用这个全量视图。

### 回退到旧行为

```typescript
initAemeath({ upload, queue: { offlinePolicy: 'legacy' } });
```

`legacy` 关闭离线暂停、parked 与退避，完整回到旧行为：任何失败都消耗重试预算（包括
传输层失败），预算耗尽即丢弃。仅用于回归对比，不建议生产使用 —— 断网时日志会在
几秒内被打光。

---

## ⚙️ 配置选项

### 完整配置示例

```typescript
logger.use(
  new UploadPlugin({
    // 上传回调（必需）
    onUpload: async (log) => {
      const response = await fetch('/api/logs', {
        method: 'POST',
        body: JSON.stringify(log),
      });
      return classifyHttpUploadResponse(
        response.status,
        response.headers.get('Retry-After'),
      );
    },

    // 优先级回调（可选）
    getPriority: (log) => {
      if (log.level === 'error') return 100;
      if (log.level === 'warn') return 50;
      return 10;
    },

    // 队列配置
    queue: {
      maxSize: 200, // 队列最大长度
      concurrency: 1, // 并发数（建议保持为 1）
      maxRetries: 3, // 最大重试次数
      uploadInterval: 30000, // 上传间隔（毫秒）
      offlinePolicy: 'pause', // 断网时暂停而不是耗尽重试预算
      retryBackoff: true, // 指数退避（base 1s / max 30s）
      suspectedOfflineThreshold: 3, // 连续多少次传输层失败判定为疑似离线
    },

    // 缓存配置
    cache: {
      enabled: true, // 启用缓存
      key: '__logger_queue__', // 缓存 key
      ttl: 3600000, // 有效期，从写入缓存时刻算起
    },

    // 日志被丢弃时的回调
    onDrop: (log, info) => {
      console.warn('dropped', info.reason, log.logId);
    },

    // 页面卸载时上传
    saveOnUnload: true,
  }),
);
```

### 配置说明

| 配置项                            | 类型                                       | 默认值                    | 说明                                        |
| --------------------------------- | ------------------------------------------ | ------------------------- | ------------------------------------------- |
| `onUpload`                        | `(log: LogEntry) => Promise<UploadResult>` | **必需**                  | 上传回调函数（返回 UploadResult）           |
| `getPriority`                     | `(log: LogEntry) => number`                | 按 level                  | 优先级回调                                  |
| `onDrop`                          | `(log, info) => void`                      | —                         | 日志被丢弃时的回调（v2.5.0+）               |
| `queue.maxSize`                   | `number`                                   | `100`                     | queued、parked 与未收齐分片准入项共用的总上限 |
| `queue.concurrency`               | `number`                                   | `1`                       | 逻辑日志并发数；同一 `splitId` 的分片保持串行 |
| `queue.maxRetries`                | `number`                                   | `3`                       | 每周期热重试次数，耗尽后进入 parked         |
| `queue.uploadInterval`            | `number`                                   | `30000`                   | 自动上传间隔（毫秒）                        |
| `queue.offlinePolicy`             | `'pause' \| 'legacy'`                      | `'pause'`                 | 断网策略（v2.5.0+）                         |
| `queue.retryBackoff`              | `boolean \| { baseMs, maxMs }`             | `true`                    | 指数退避（v2.5.0+）                         |
| `queue.suspectedOfflineThreshold` | `number`                                   | `3`                       | 连续多少次传输层失败判定为疑似离线（v2.5.0+） |
| `cache.enabled`                   | `boolean`                                  | `true`                    | 是否启用缓存                                |
| `cache.key`                       | `string`                                   | `__logger_upload_queue__` | 缓存 key                                    |
| `cache.ttl`                       | `number`                                   | `3600000`                 | 缓存有效期，从写入时刻算起（v2.5.0+）       |
| `saveOnUnload`                    | `boolean`                                  | `true`                    | 页面卸载时保存队列到缓存                    |

### 同一页面上有多个实例时，必须各配一个 `cache.key`

`cache.key` 有确定性的默认值（`__logger_upload_queue__`）。宿主站和内嵌的第三方组件、
或微前端的主子应用各自接入 SDK 时，两个实例默认会抢同一个 localStorage 条目：

- **互相覆盖**：后存的把先存的整个抹掉，那些日志再也回不来了；
- **串台**：下次打开时两边从同一个 key 恢复，A 项目的日志被发到 B 项目的上报地址。

SDK 会检测这种撞车，**让第二个实例关掉缓存**并在控制台报出可操作的提示 —— 上报主链路
不受影响，只是这个实例失去"刷新后续传"的能力。要让两边都保留缓存，各配一个 key：

```ts
// 宿主站
new UploadPlugin({ onUpload, cache: { key: 'host-queue' } });

// 内嵌组件
new UploadPlugin({ onUpload, cache: { key: 'widget-queue' } });
```

`OfflinePersistencePlugin` 同理，需要同时区分 `dbName` 与降级 `key`（见
[离线持久化](./11-offline-persistence.md)）。

> SDK 无法自动区分两个实例分属哪个项目 —— 它手上没有任何稳定的项目身份标识，
> 靠安装顺序自动改名会在脚本异步加载时翻转，把稳定的问题变成偶发的串台。
> 所以这里选择报错让位，把决定权交给你。

---

## 💡 最佳实践

### 1. 避免无限循环

```typescript
// ❌ 错误 - 会导致无限循环
onUpload: async (log) => {
  try {
    const response = await fetch('/api/logs', { body: JSON.stringify(log) });
    return classifyHttpUploadResponse(response.status, response.headers.get('Retry-After'));
  } catch (error) {
    logger.error('Upload failed', { error }); // 这会再次触发上传！
    return { success: false, shouldRetry: true, retryReason: 'network' };
  }
};

// ✅ 正确 - 使用 console
onUpload: async (log) => {
  try {
    const response = await fetch('/api/logs', { body: JSON.stringify(log) });
    return classifyHttpUploadResponse(response.status, response.headers.get('Retry-After'));
  } catch (error) {
    console.error('Upload failed:', error); // 安全
    return { success: false, shouldRetry: true, retryReason: 'network' };
  }
};
```

### 2. 保持优先级逻辑简单

```typescript
// ✅ 好 - 简单清晰
getPriority: (log) => {
  if (log.level === 'error') return 100;
  if (log.level === 'warn') return 50;
  return 10;
};

// ❌ 避免 - 过于复杂
getPriority: (log) => {
  // 大量复杂计算...
  return result; // 会减慢日志记录速度
};
```

### 3. 处理 Token 刷新

```typescript
onUpload: async (log) => {
  let token = getAuthToken();

  let response = await fetch('/api/logs', {
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(log),
  });

  // 如果 401，刷新 token 后重试
  if (response.status === 401) {
    token = await refreshAuthToken();
    response = await fetch('/api/logs', {
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(log),
    });
  }

  return classifyHttpUploadResponse(
    response.status,
    response.headers.get('Retry-After'),
  );
};
```

---

## 📖 使用示例

查看 `examples/5-upload-plugin/` 目录获取完整示例：

- `basic.ts` - 基础用法
- `with-auth.ts` - 带认证
- `with-axios.ts` - 使用 Axios
- `advanced.ts` - 高级用法（重试、监控）
- `project-config-example.ts` - 完整项目配置

**版本**：1.1.0  
**最后更新**：2026-02-05
