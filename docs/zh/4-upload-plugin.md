# UploadPlugin - 日志上传插件

> 完全自定义的回调式上传，简单灵活

---

## 📦 核心特性

### 1. 上传回调（返回 UploadResult）⭐ NEW

你完全控制如何上传日志，并通过返回值控制重试行为：

```typescript
interface UploadResult {
  success: boolean; // 是否成功
  shouldRetry?: boolean; // 是否需要重试（仅在 success = false 时有效）
  error?: string; // 错误信息
}
```

**为什么使用返回值而不是抛出错误？**

- ✅ 更明确：清晰表达成功/失败/是否重试
- ✅ 更可控：可以区分"不重试"和"需要重试"
- ✅ 更安全：不会触发全局错误捕获

### 2. 优先级回调

你定义日志优先级（1-100 的数字，越大越优先）

### 3. 队列机制

- 默认启用
- 串行处理（同一时间只有一个请求）
- 按优先级排序

### 4. 自动重试

- 失败自动降低优先级（-10）
- 重新入队重试
- 最多重试 5 次（可配置）
- 通过 `shouldRetry` 控制是否重试

### 5. 本地缓存

- 队列保存到 localStorage
- 页面刷新后自动恢复
- 自动清理过期日志

---

## 🚀 快速开始

### 基础用法

```typescript
import { Logger, UploadPlugin } from 'aemeath-js';

const logger = new Logger();

logger.use(
  new UploadPlugin({
    // 上传回调（必需）- 返回 UploadResult
    onUpload: async (log) => {
      try {
        const response = await fetch('/api/logs', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(log),
        });

        const data = await response.json();

        // 检查业务返回码
        if (data.code === 200) {
          return { success: true };
        } else {
          return {
            success: false,
            shouldRetry: true, // 业务错误，需要重试
            error: data.message,
          };
        }
      } catch (error) {
        // 网络错误
        return {
          success: false,
          shouldRetry: true, // 网络错误，需要重试
          error: error.message,
        };
      }
    },
  }),
);

// 使用
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
      await fetch('/api/logs', {
        method: 'POST',
        body: JSON.stringify(log),
      });
    },

    // 优先级回调
    getPriority: (log) => {
      // error 日志最高优先级
      if (log.level === 'error') return 100;

      // 紧急业务日志
      if (log.extra?.urgent) return 80;

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
  - `info`: 10
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
    },

    // 缓存配置
    cache: {
      enabled: true, // 启用缓存
      key: '__logger_queue__', // 缓存 key
    },

    // 页面卸载时上传
    uploadOnUnload: true,
  }),
);
```

### 配置说明

| 配置项                 | 类型                                       | 默认值                    | 说明                              |
| ---------------------- | ------------------------------------------ | ------------------------- | --------------------------------- |
| `onUpload`             | `(log: LogEntry) => Promise<UploadResult>` | **必需**                  | 上传回调函数（返回 UploadResult） |
| `getPriority`          | `(log: LogEntry) => number`                | 按 level                  | 优先级回调                        |
| `queue.maxSize`        | `number`                                   | `100`                     | 队列最大长度                      |
| `queue.concurrency`    | `number`                                   | `1`                       | 并发上传数                        |
| `queue.maxRetries`     | `number`                                   | `3`                       | 最大重试次数                      |
| `queue.uploadInterval` | `number`                                   | `30000`                   | 自动上传间隔（毫秒）              |
| `cache.enabled`        | `boolean`                                  | `true`                    | 是否启用缓存                      |
| `cache.key`            | `string`                                   | `__logger_upload_queue__` | 缓存 key                          |
| `uploadOnUnload`       | `boolean`                                  | `true`                    | 页面卸载时是否上传                |

---

## 💡 最佳实践

### 1. 避免无限循环

```typescript
// ❌ 错误 - 会导致无限循环
onUpload: async (log) => {
  try {
    await fetch('/api/logs', { body: JSON.stringify(log) });
  } catch (error) {
    logger.error('Upload failed', error); // 这会再次触发上传！
  }
};

// ✅ 正确 - 使用 console
onUpload: async (log) => {
  try {
    await fetch('/api/logs', { body: JSON.stringify(log) });
  } catch (error) {
    console.error('Upload failed:', error); // 安全
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

  const response = await fetch('/api/logs', {
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(log),
  });

  // 如果 401，刷新 token 后重试
  if (response.status === 401) {
    token = await refreshAuthToken();
    await fetch('/api/logs', {
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(log),
    });
  }
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

## 🎯 对比总结

| 特性            | 旧版（endpoint） | 新版（callback）       |
| --------------- | ---------------- | ---------------------- |
| **灵活性**      | ❌ 受限          | ✅ 完全控制            |
| **认证**        | ❌ 困难          | ✅ 轻松                |
| **跨域**        | ❌ 难配置        | ✅ 原生支持            |
| **自定义头**    | ❌ 受限          | ✅ 任意 headers        |
| **HTTP 客户端** | ❌ 内置 fetch    | ✅ 任意（fetch/axios） |
| **优先级**      | ❌ 固定          | ✅ 自定义（1-100）     |
| **队列**        | ✅ 有            | ✅ 有（改进）          |
| **串行处理**    | ❌ 无            | ✅ 有                  |
| **API 复杂度**  | ⭐⭐⭐           | ⭐                     |

**更简单、更灵活、更强大！** 🎉

---

**版本**：1.1.0  
**最后更新**：2026-02-05
