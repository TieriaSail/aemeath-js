# UploadPlugin - 日志上传插件

> 完全自定义的回调式上传，简单灵活

> 💡 **隐私保护提示**：UploadPlugin 不内置脱敏。如需对每条日志做隐私过滤 / 字段裁剪，请使用 [`beforeSend` 钩子](./9-before-send.md)（v1.5.0+），它会在 UploadPlugin 接收日志**之前**生效。

---

## 📦 核心特性

### 1. 上传回调（返回 UploadResult）⭐ NEW

通过返回值控制重试行为：

```typescript
interface UploadResult {
  success: boolean;
  shouldRetry?: boolean;
  error?: string;
}
```

### 2. 优先级回调

你定义日志优先级（1-100 的数字，越大越优先）

### 3. 队列机制

- 默认启用
- 串行处理（同一时间只有一个请求）
- 按优先级排序

### 4. 自动重试

- 失败自动降低优先级（-10）
- 重新入队重试
- 最多重试 3 次（可配置）
- 通过 `shouldRetry` 控制是否重试

### 5. 本地缓存

- 队列保存到 localStorage
- 页面刷新后自动恢复
- 自动清理过期日志

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
3. 重新入队
4. 再次尝试
5. 重复最多 3 次（可配置）

### 串行处理

- 同一时间只有一个上传请求
- 避免性能问题
- 确保请求顺序
- 每次请求间隔 100ms

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
      uploadTimeoutMs: 30000, // 单次上传超时；设为 0 可关闭
    },

    // 缓存配置
    cache: {
      enabled: true, // 启用缓存
      key: '__logger_queue__', // 缓存 key
    },

    // 页面卸载时上传
    saveOnUnload: true,
  }),
);
```

### 配置说明

| 配置项                 | 类型                                       | 默认值                    | 说明                              |
| ---------------------- | ------------------------------------------ | ------------------------- | --------------------------------- |
| `onUpload`             | `(log: LogEntry) => Promise<UploadResult>` | **必需**                  | 上传回调函数（返回 UploadResult） |
| `getPriority`          | `(log: LogEntry) => number`                | 按 level                  | 优先级回调                        |
| `queue.maxSize`        | `number`                                   | `100`                     | queued、parked 与未收齐分片准入项共用的总上限 |
| `queue.concurrency`    | `number`                                   | `1`                       | 逻辑日志并发数；同一 `splitId` 的分片保持串行 |
| `queue.maxRetries`     | `number`                                   | `3`                       | 最大重试次数                      |
| `queue.uploadInterval` | `number`                                   | `30000`                   | 自动上传间隔（毫秒）              |
| `queue.uploadTimeoutMs` | `number`                                  | `30000`                   | 单次上传等待上限（毫秒）；`0` 关闭 |
| `queue.offlinePolicy`  | `'pause' \| 'legacy'`                      | `'pause'`                 | 断网策略（`legacy` 可恢复 1.10.0 行为） |
| `queue.retryBackoff`   | `boolean \| { baseMs, maxMs }`             | 随 `offlinePolicy`        | 指数退避（`legacy` 默认关 / `pause` 默认开） |
| `onDrop`               | `(log, info) => void`                      | —                         | 日志被丢弃时回调（1.10.0+）       |
| `cache.enabled`        | `boolean`                                  | `true`                    | 是否启用缓存                      |
| `cache.key`            | `string`                                   | `__logger_upload_queue__` | 缓存 key                          |
| `saveOnUnload`         | `boolean`                                  | `true`                    | 页面卸载时保存队列到缓存          |

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

---

## 🛡️ 可靠投递（1.10.1+）

1.10.1 默认使用 `queue.offlinePolicy: 'pause'`：传输层失败会暂停；可恢复的服务端失败
先进行有界热重试，耗尽后进入 `parked`；服务端 `Retry-After` 会被遵守。只有需要临时
复现 1.10.0 行为时才使用 `legacy`。

```typescript
import { classifyHttpUploadResponse, initAemeath } from 'aemeath-js';

const logger = initAemeath({
  upload: async (log) => {
    try {
      const res = await fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
      return classifyHttpUploadResponse(res.status, res.headers.get('Retry-After'));
    } catch {
      return { success: false, shouldRetry: true, retryReason: 'network' };
    }
  },
  onDrop: (log, info) => console.warn('dropped', info.reason, log.logId),
});

logger.getDeliveryStatus(); // 统一查看 queued/in-flight/parked/persisted
```

要点：

- `classifyHttpUploadResponse()`：2xx 成功；408/425/429/5xx 可恢复；其余 4xx
  为永久失败（401/403 为刷新凭证场景保留可恢复语义）。
- 可返回原始 `retryAfter` 或换算后的 `retryAfterMs`；Axios 风格抛错中的
  `response.status` / `response.headers` 也会自动解析。
- `flush()` 只会跳过 SDK 自己的本地退避/网络暂停，不会越过服务端 `Retry-After`。
- 带已知 fetch 网络失败文案的 `TypeError` 才会暂停投递；回调自身的普通编程
  `TypeError` 会进入有界的 `callback-error` 路径。
- `setUpload(null)` 会真正冻结内存队列与持久副本；重新绑定后原样恢复，不调用旧端点、
  不消耗重试预算。
- 多租户必须设置 `deliveryScope`，并隔离 cache key、dbName 和 KV key；有待投递数据时
  SDK 会拒绝切换 scope。
- 真正丢弃以及 SDK 内容去重终态（`deduplicated`）会通过 `onDrop`、`upload:drop`、
  `delivery:dropped` 明确可观测；进入 `parked` 的可恢复失败不算丢弃。
- `queue.maxSize` 是 queued、parked 与未收齐分片共用的准入预算；SDK 分片按整组
  接纳和淘汰。只有同时带 `splitIndex` 或 `splitTotal` 的 `tags.splitId` 才启用
  原子组语义，裸 `splitId` 仍是普通业务标签，不会绑定独立日志。
- 标准入口 `initAemeath({ upload })` 默认启用[断网续传](./11-offline-persistence.md)；
  可用 `offlinePersistence: false` 显式关闭。

**版本**：1.10.1
**最后更新**：2026-08-11
