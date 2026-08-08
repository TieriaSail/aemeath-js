# UploadPlugin - 日志上传插件

> 完全自定义的回调式上传，简单灵活

> 💡 **隐私保护提示**：UploadPlugin 不内置脱敏。如需对每条日志做隐私过滤 / 字段裁剪，请使用 [`beforeSend` 钩子](./9-before-send.md)（v2.4.0+），它会在 UploadPlugin 接收日志**之前**生效。

---

## 📦 核心特性

### 1. 上传回调（返回 UploadResult）

通过返回值控制重试行为：

```typescript
interface UploadResult {
  success: boolean;
  shouldRetry?: boolean;
  /** v2.5.0+：失败语义。传 'network' 可让本次失败不消耗重试预算 */
  retryReason?: 'network' | 'server' | 'payload';
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
- 通过 `shouldRetry` 控制是否重试

### 5. 断网暂停 ⭐ v2.4.0

判定网络不可用时**暂停队列**而不是继续打空枪：不调 `onUpload`、不消耗重试预算、
不丢日志，网络恢复后自动继续。详见 [可靠性与丢弃](#-可靠性与丢弃)。

### 6. 丢弃可观测 ⭐ v2.4.0

任何一条日志被放弃都会触发 `onDrop` 回调和 `upload:drop` 事件，并附带原因。

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
import { initAemeath, getAemeath } from 'aemeath-js';

initAemeath({
  upload: async (log) => {
    const response = await fetch('/api/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(log),
    });
    const data = await response.json();
    if (data.code === 200) {
      return { success: true };
    }
    return { success: false, shouldRetry: true, error: data.message };
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
import { AemeathLogger, UploadPlugin } from 'aemeath-js';

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
        const data = await response.json();
        if (data.code === 200) {
          return { success: true };
        }
        return { success: false, shouldRetry: true, error: data.message };
      } catch (error) {
        return { success: false, shouldRetry: true, error: error.message };
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

        const data = await response.json();

        if (data.code === 200) {
          return { success: true };
        } else {
          return {
            success: false,
            shouldRetry: true,
            error: data.message,
          };
        }
      } catch (error) {
        return {
          success: false,
          shouldRetry: true,
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
      return { success: res.ok };
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
失败 → 降低优先级（-10），重新入队重试
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
4. 重复最多 3 次（可配置），预算耗尽才丢弃

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
探测成功 或 收到 online 事件 → emit upload:resumed，继续正常消费
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

- **`maxRetries`** 防的是**单条毒丸日志** —— 整体链路正常，只有这一条反复被服务端拒绝。
- **`offlinePolicy`** 防的是**整条链路断掉** —— 此时队列暂停，根本不消耗重试预算。

因此断网场景下 `maxRetries` 不会被秒级耗尽，这正是 v2.5.0 修复的核心问题。

反过来也成立：后端整体故障（持续 5xx）走的是重试预算，队列不会暂停，日志按
`maxRetries` 耗尽后以 `max-retries` 明确丢弃。把它误判成"离线"会让队列无限期
挂起、预算永远耗不完，日志一路堆到溢出。

链路长时间不可用时，队列会涨到 `maxSize` 并按优先级从低到高溢出丢弃
（原因 `queue-overflow`），这是有界的、可观测的降级，不是静默丢失。

### 精确告诉 SDK 失败原因

`retryReason` 不是必填项，但填了效果更好：

```typescript
upload: async (log) => {
  try {
    const res = await fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
    if (res.ok) return { success: true };
    if (res.status === 413 || res.status === 400) {
      // 日志本身有问题，重试没有意义
      return { success: false, shouldRetry: false, retryReason: 'payload' };
    }
    // 服务端明确响应了失败 → 消耗重试预算
    return { success: false, shouldRetry: true, retryReason: 'server' };
  } catch {
    // 请求根本没发出去 → 不该算在这条日志头上
    return { success: false, shouldRetry: true, retryReason: 'network' };
  }
};
```

不传 `retryReason` 时按 `server` 处理，与旧版行为一致。

#### 回调抛异常时怎么判定

没有 `retryReason` 的话，SDK 只能靠抛出的异常来猜，而且只在拿到**正面证据**时
才判定为离线：

| 抛出的值 | 判定为 |
| --- | --- |
| `TypeError`（fetch 网络失败抛的就是它） | `network` |
| `AbortError` / `TimeoutError`，以及插件自己的上传超时 | `network` |
| `code` 为 `ERR_NETWORK`、`ECONNRESET`、`ETIMEDOUT` 等 | `network` |
| 异常上挂着 `response`（axios / ky / got 遇到 4xx、5xx） | `server` |
| 其余一切，包括你回调里自己的 bug | `server` |

这个不对称是刻意的。把服务端失败误判成 `network`，整个队列会暂停，上报静默停摆；
把网络失败误判成 `server`，只是消耗重试预算，最后以 `max-retries` 丢弃 —— 而这是
你能在 `onDrop` 里看见的。有界且可观测的损失优于无界且无声的停摆，所以举证责任
落在"离线"这一侧。

用 axios / ky / got 这类默认对非 2xx 抛异常的客户端，这条直接关系到你：后端故障
会走重试预算，而不是暂停队列 —— 与 2.4 的行为一致。想要确定性而不是启发式，就在
`onUpload` 里显式返回 `retryReason`。

### 知道自己丢了什么

```typescript
initAemeath({
  upload,
  onDrop: (log, info) => {
    // info.reason: 'no-retry' | 'max-retries' | 'queue-overflow' | 'cache-expired'
    //            | 'storage-quota' | 'payload-too-large' | 'offline-give-up'
    console.warn('[log dropped]', info.reason, log.logId);
  },
});

// 等价的事件形式
getAemeath().on('upload:drop', ({ log, reason }) => { /* ... */ });
```

| 原因                | 什么时候出现                                       |
| ------------------- | -------------------------------------------------- |
| `no-retry`          | 服务端明确表示不必重试（`shouldRetry: false`）      |
| `max-retries`       | 重试预算耗尽                                       |
| `queue-overflow`    | 队列超过 `maxSize`，挤掉优先级最低的日志            |
| `cache-expired`     | 本地缓存中的日志超过 `cache.ttl`                    |
| `payload-too-large` | 单字段体积超限（见 [载荷清洗](./10-payload-sanitize.md)） |
| `storage-quota`     | 离线持久层写入失败或配额已满                        |
| `offline-give-up`   | 离线补传反复失败，放弃该条                          |

### 可用事件

| 事件               | 载荷                                    |
| ------------------ | --------------------------------------- |
| `upload:enqueued`  | `{ log, priority, source, paused }`     |
| `upload:success`   | `{ log, source }`                       |
| `upload:drop`      | `{ log, reason, retryCount, error, source }` |
| `upload:paused`    | `{ reason, queued, logs }`              |
| `upload:resumed`   | `{ queued }`                            |

### 随日志带出的上报期元数据

每条发出去的日志副本上会自动补两个字段（**不会**修改队列里的原始 entry）：

| 字段                            | 含义                                                        |
| ------------------------------- | ----------------------------------------------------------- |
| `requestId`                     | 每次上报尝试都不同，供消费端幂等去重                          |
| `tags.uploadedAt`               | **发出时刻**。与 `timestamp`（捕获时刻）配合，一眼看出是实时上报还是补传 |
| `tags.droppedSinceLastReport`   | 上次成功上报以来丢了多少条（有丢弃时才出现）                   |

后端看到的不再是一段无法解释的空白，而是"这里有个洞，深度 N"。不需要这些字段
可以在 [`beforeSend`](./9-before-send.md) 里删掉。

### 排查现场状态

```typescript
const upload = getAemeath().getPluginInstance('upload');
console.log(upload.getQueueStatus());
// { length, isProcessing, paused, consecutiveFailures,
//   drops: { total, byReason }, items }
```

### 回退到旧行为

```typescript
initAemeath({ upload, queue: { offlinePolicy: 'legacy' } });
```

`legacy` 关闭离线暂停与退避，完整回到 v2.4 行为：任何失败都消耗重试预算（包括
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
      await fetch('/api/logs', {
        method: 'POST',
        body: JSON.stringify(log),
      });
      return { success: true };
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
| `queue.maxSize`                   | `number`                                   | `100`                     | 队列最大长度                                |
| `queue.concurrency`               | `number`                                   | `1`                       | 并发上传数                                  |
| `queue.maxRetries`                | `number`                                   | `3`                       | 最大重试次数（防单条毒丸日志）              |
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

`OfflinePersistencePlugin` 同理，用 `dbName` 区分（见
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
    await fetch('/api/logs', { body: JSON.stringify(log) });
    return { success: true };
  } catch (error) {
    logger.error('Upload failed', { error }); // 这会再次触发上传！
    return { success: false, shouldRetry: true };
  }
};

// ✅ 正确 - 使用 console
onUpload: async (log) => {
  try {
    await fetch('/api/logs', { body: JSON.stringify(log) });
    return { success: true };
  } catch (error) {
    console.error('Upload failed:', error); // 安全
    return { success: false, shouldRetry: true };
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

  return { success: response.ok };
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
