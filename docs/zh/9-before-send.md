# 9. `beforeSend` — 全链路日志最终拦截（隐私脱敏 / 过滤 / 字段补充）

> 适用版本：`aemeath-js@2.4.0+`
> 命名参考 [Sentry `beforeSend`](https://docs.sentry.io/platforms/javascript/configuration/filtering/#using-beforesend)。

---

## 一、它是什么？

`beforeSend` 是一个**全局**的钩子函数，作用于 SDK 日志管道的**末端**：

```
log() / 自动错误捕获 / NetworkPlugin / ...
              ↓
插件 beforeLog → 构建 LogEntry → 插件 afterLog → ★ beforeSend ★ → listener / UploadPlugin
```

**特点：**

- ✅ **作用于所有日志**：用户主动调用（`logger.info/error/...`）、自动错误捕获、`NetworkPlugin` 网络日志，全部经过
- ✅ **位于管道末端**：在所有插件 `afterLog` **之后**、所有 listener（含 `UploadPlugin`）**之前** 调用
- ✅ **fail-safe**：钩子内部的异常会被静默吞掉，不会影响日志主管道，更不会让你的页面崩溃
- ✅ **运行时可替换**：通过 `setBeforeSend(...)` 动态切换钩子（适合登录后才确定脱敏规则的场景）

---

## 二、三种返回值，三种语义

```ts
import { initAemeath } from 'aemeath-js';

initAemeath({
  beforeSend: (entry) => {
    // 1. 修改：返回新的 LogEntry
    return { ...entry, message: redact(entry.message) };

    // 2. 丢弃：返回 null
    // return null;

    // 3. 原样放行：返回 entry / undefined / void
    // return entry;
  },
});
```

| 返回值 | 行为 |
|--------|------|
| `LogEntry` | 使用修改后的 entry 继续传递 |
| `null` | **丢弃**该日志，listener 和 UploadPlugin **都收不到** |
| `undefined` / `void` / 直接返回 `entry` | 原样放行 |
| 抛出异常 | 原 entry 原样放行（fail-safe）；仅当 `debug: true` 时打印 `console.warn` |
| 返回 `Promise` / `thenable`（多见于误写 `async`） | 原样放行；**始终** `console.warn` 提示 hook 必须同步 |
| 其他非法值（数字 / 字符串 / 对象但缺 `logId` / `level`） | 原样放行；**始终** `console.warn` 提示返回值非法 |

---

## 三、`LogEntry` 数据结构（脱敏前你需要知道的）

要修改字段，必须先知道字段长什么样。下面是 `LogEntry` 的完整结构（来自 `src/types.ts`）：

```ts
interface LogEntry {
  /** 日志唯一 ID（自动生成，不要修改） */
  logId: string;
  /** 上报请求 ID（UploadPlugin 内部使用，可不管） */
  requestId?: string;
  /** 日志级别 */
  level: 'debug' | 'info' | 'track' | 'warn' | 'error';
  /** 主消息（脱敏首选目标） */
  message: string;
  /** 时间戳（ms） */
  timestamp: number;
  /** 环境标识（如 'production'） */
  environment?: string;
  /** 应用版本 */
  release?: string;

  /** 错误信息（仅 error 级别） */
  error?: {
    type: string;             // 'TypeError' / 'BusinessError' / 'NetworkError' / ...
    value: string;            // 错误消息（脱敏目标）
    stacktrace?: { frames: StackFrame[] };
    stack?: string;
    [key: string]: unknown;
  };
  // 注意：网络日志的 url/method/status/requestData/responseData 在 entry.context 上，
  // 不在 entry.error 上（详见下方 NetworkPlugin 日志结构示例）。

  /** 业务标签（用于过滤） */
  tags?: {
    errorCategory?: 'global' | 'promise' | 'resource' | 'early' | 'manual' | string;
    component?: string;
    action?: string;
    [key: string]: string | number | boolean | undefined;
  };

  /** 上下文（详细信息） */
  context?: {
    user?: { id?: string; name?: string; email?: string; [key: string]: unknown };
    device?: { platform: string; userAgent: string; ... };
    app?: { name: string; version: string; environment: string; ... };
    [key: string]: unknown;   // 用户自己加的字段也在这里
  };
}
```

### `NetworkPlugin` 自动捕获的日志结构

`NetworkPlugin` 把网络事件转成 `LogEntry`，**字段都写在 `tags` 与 `context` 上**（不是 `error`）：

```ts
{
  logId: 'log_xxx',
  level: 'info' | 'warn' | 'error',
  // 成功：'HTTP 200: GET /api/user' / 出错：'HTTP 500: POST /api/order' / 慢：'Slow request: ...'
  message: 'HTTP 200: GET /api/user',
  timestamp: 1234567890,
  tags: {
    errorCategory: 'http',                    // ← 注意是 'http'，不是 'network'
    type: 'fetch' | 'xhr' | 'request',         // 'request' 用于小程序 wx.request
    method: 'GET',
    httpStatus: 200,                          // 仅当有 status 时存在
    slow: true,                               // 仅慢请求时存在
  },
  context: {
    type: 'HTTP_REQUEST' | 'HTTP_ERROR',
    url: 'https://api.example.com/user?token=xxx&phone=13800138000',
    method: 'GET',
    status: 200,
    statusText: 'OK',
    duration: 123,
    timestamp: 1234567890,
    // ⚠️ requestData / responseData 类型是 unknown：
    // - JSON 请求 / 响应：会被 safeParseJSON 解析成 **对象**，例如 { password: 'secret' }
    // - FormData / Blob / ArrayBuffer：会被替换为占位符字符串（如 '[FormData]'）
    // - 非 JSON 文本：保留为原 **字符串**
    // 写脱敏规则时请同时处理 string / object 两种形态（见示例 basic.ts / redact-network.ts）。
    requestData: { password: 'secret' },      // 字段名是 requestData（不是 requestBody）
    responseData: { token: 'jwt_xxx' },       // 字段名是 responseData（不是 responseBody）
    error: { /* ... */ },                     // 仅当请求失败时存在
  },
  // 注意：错误请求时 entry.error 字段并不存在，错误信息在 entry.context.error 上
}
```

> 💡 **脱敏建议**：网络日志通常是隐私重灾区，建议至少处理 `context.url`、`context.requestData`、`context.responseData`。
> NetworkPlugin 当前**不会抓 request/response headers**，因此无需在 `beforeSend` 内处理 headers。

---

## 四、典型场景

### 场景 1：屏蔽 URL 中的敏感参数

```ts
import { initAemeath } from 'aemeath-js';

initAemeath({
  upload: async (log) => { /* ... */ },
  beforeSend: (entry) => {
    // 仅处理网络日志（NetworkPlugin 把 errorCategory 设为 'http'）
    if (entry.tags?.errorCategory !== 'http') return entry;

    const url = entry.context?.['url'];
    if (typeof url !== 'string') return entry;

    return {
      ...entry,
      context: {
        ...entry.context,
        url: url.replace(/(token|phone|idCard)=[^&]+/gi, '$1=***'),
      },
    };
  },
});
```

### 场景 2：移除请求 / 响应体（仅保留状态码）

```ts
beforeSend: (entry) => {
  if (entry.tags?.errorCategory !== 'http' || !entry.context) return entry;
  return {
    ...entry,
    context: {
      ...entry.context,
      requestData: '[REDACTED]',
      responseData: '[REDACTED]',
    },
  };
};
```

### 场景 3：脱敏用户上下文

```ts
beforeSend: (entry) => {
  if (!entry.context?.user) return entry;
  const { id } = entry.context.user as { id?: string };
  return {
    ...entry,
    context: {
      ...entry.context,
      user: id ? { id } : undefined, // 只保留 id，去掉 name / email / phone
    },
  };
};
```

### 场景 4：丢弃噪音日志

```ts
beforeSend: (entry) => {
  // 丢弃所有 401 / 403 网络日志
  if (
    entry.tags?.errorCategory === 'http'
    && [401, 403].includes(entry.context?.['status'] as number)
  ) {
    return null;
  }
  // 丢弃业务标记为 noise 的日志
  if (entry.tags?.errorCategory === 'noise') return null;
  return entry;
};
```

### 场景 5：统一注入 `traceId`（链路追踪）

```ts
beforeSend: (entry) => ({
  ...entry,
  context: {
    ...entry.context,
    traceId: getTraceId(),
  },
});
```

---

## 五、运行时动态切换（`setBeforeSend`）

某些场景下，**初始化时还不知道脱敏规则**（如用户登录后才能拿到 `userId`）。可在运行时随时替换：

```ts
import { initAemeath, setBeforeSend } from 'aemeath-js';

initAemeath({ upload: async (log) => { /* ... */ } });

// 用户登录后
setBeforeSend((entry) => {
  if (entry.context?.user) {
    return {
      ...entry,
      context: { ...entry.context, user: { id: currentUserId } },
    };
  }
  return entry;
});

// 用户登出 / 切换账号时
setBeforeSend(null); // 清除钩子，恢复原样放行
```

---

## 六、注意事项与常见陷阱

### 1. ❌ 不要在 `beforeSend` 内调用 `logger.error/info/...`

会导致**无限递归**。`SafeGuardPlugin` 会拦截，但仍应避免。

```ts
beforeSend: (entry) => {
  logger.info('processing entry'); // ❌ 不要！
  return entry;
};
```

### 2. ✅ 钩子异常永远不会让你的页面崩溃

```ts
beforeSend: (entry) => {
  throw new Error('boom'); // ✅ 静默吞掉，原 entry 继续放行
};
```

但**强烈建议**在写钩子时仍然加 `try-catch`，至少能在 dev 阶段及时发现 bug：

```ts
beforeSend: (entry) => {
  try {
    return { ...entry, message: redact(entry.message) };
  } catch (e) {
    if (process.env.NODE_ENV !== 'production') console.error(e);
    return entry;
  }
};
```

### 3. ✅ 必须返回**新对象**，不要 mutate 原对象

虽然 SDK 不会校验，但**修改原 entry 可能破坏其他 listener 看到的数据**：

```ts
// ❌ 不推荐
beforeSend: (entry) => {
  entry.message = redact(entry.message);
  return entry;
};

// ✅ 推荐
beforeSend: (entry) => ({ ...entry, message: redact(entry.message) });
```

### 4. ⚠️ `beforeSend` 是**最终关卡**，不替代业务侧脱敏

- 业务代码不应该把敏感数据塞进 context 然后指望 `beforeSend` 兜底
- `beforeSend` 是**最后一道防线**，不是**唯一一道防线**

### 5. ⚠️ 性能：钩子在每条日志上执行一次

避免在钩子内做重计算（如同步加密、复杂正则）。如果必须，考虑：

- 只对需要脱敏的字段做处理（用 `tags.errorCategory` 提前判断）
- 把复杂规则改为预编译（如 `const re = new RegExp(...)` 提到钩子外）

### 6. 与 `NetworkPlugin` 的 `urlFilter` / `excludeUrls` 的关系

| 选项 | 作用 |
|------|------|
| `network.excludeUrls` | **不捕获**该 URL 的网络日志 |
| `beforeSend` | 已经捕获后，**修改或丢弃** |

> 想完全不捕获某 URL → 用 `excludeUrls`
> 想捕获后过滤敏感字段 → 用 `beforeSend`

---

## 七、与插件优先级的关系

`beforeSend` 通过内置的 `BeforeSendPlugin` 实现，自动以 `priority: PluginPriority.LATEST` 注入，**永远在所有其他插件之后执行**（详见 [插件执行顺序](./8-plugin-ordering.md)）。

```ts
logger.getPlugins().forEach((p) => console.log(`[${p.priority}] ${p.name}`));
// [-1000] browser-api-errors
// [-100]  error-capture
// [-100]  safe-guard
// [0]     network
// [100]   upload
// [1000]  before-send  ← 永远最后
```

> 同优先级（如两个 `EARLY`）按 `use()` 调用顺序排，`initAemeath()` 默认先 use `error-capture` 再 use `safe-guard`。

> ⚠️ **不要给自定义插件传 `priority > 1000`**：那会让你的插件 `afterLog` 在 `BeforeSendPlugin` 之后跑，从而**绕过 `beforeSend` 脱敏**。如果你确实需要在 `beforeSend` 之后再处理（如最终序列化），请用 listener（`logger.on('log', ...)`），listener 是在所有 `afterLog`（含 `beforeSend`）之后执行的，看到的 entry 已经是脱敏后的版本。

---

## 八、API 总览

```ts
// 1. 初始化时一次性配置
initAemeath({
  beforeSend: (entry) => entry,
});

// 2. 运行时动态切换
import { setBeforeSend } from 'aemeath-js';
setBeforeSend((entry) => entry);
setBeforeSend(null); // 清除

// 3. 直接拿插件实例（高级用法）
const plugin = getAemeath().getPluginInstance('before-send');
(plugin as BeforeSendPlugin)?.setHook((entry) => entry);
```

---

## 九、FAQ

### Q1：旧版本（< 2.4.0）升级后需要改代码吗？

不需要。完全向下兼容。`beforeSend` 是新增的可选选项，不传就完全等同于旧行为。

### Q2：`beforeSend` 影响 console 输出吗？

不影响。Logger 的 console 输出在 `beforeSend` **之前**执行（属于 `log()` 内部），所以你看到的浏览器控制台输出还是原始内容；只有 listener 和 UploadPlugin 看到的才是处理后的结果。

### Q3：`beforeSend` 可以做异步处理吗？

**不可以。** 钩子必须同步返回。这是为了避免引入复杂的并发管理（试想：异步钩子 + 高频日志 + 上传顺序）。
若误写 `async`，返回的 Promise 会被忽略（脱敏/过滤不生效），并在控制台输出一条 `[Aemeath] ... Promise / thenable` 警告。
如果需要异步，请在 `upload` 函数内部处理。

### Q4：可以注册多个 `beforeSend` 吗？

通过 `initAemeath({ beforeSend })` 只能传一个。如果需要"链式"处理，可在自己的钩子内组合：

```ts
beforeSend: (entry) => {
  let result: LogEntry | null = entry;
  result = redactPII(result);
  if (!result) return null;
  result = filterNoise(result);
  return result;
};
```

也可以**自己实现一个插件**：

```ts
import { PluginPriority, type AemeathPlugin } from 'aemeath-js';

class MyRedactPlugin implements AemeathPlugin {
  readonly name = 'my-redact';
  readonly priority = PluginPriority.LATE; // 早于 LATEST 的 BeforeSendPlugin
  install() {}
  afterLog(entry) {
    return { ...entry, message: redact(entry.message) };
  }
}

logger.use(new MyRedactPlugin());
```

---

## 十、`setUpload`（运行时绑定上传）

与 `beforeSend` / `setBeforeSend` 对照阅读。从 **`aemeath-js` 主入口**导入：

```ts
import { initAemeath, setBeforeSend, setUpload } from 'aemeath-js';
```

在 Logger 已存在时再绑定或替换上传函数（例如登录后才拿到 token / endpoint）。

- **小程序**：使用精简入口导出的 `setUpload`，语义与 Web 对称。
- **传 `null`**：内部替换为「恒返回 `success: true`」的 no-op——队列里待上报项会以**成功**出队并被丢弃，**不是**失败重试；也不是整块冻结离线缓存。
- **懒装载**：若尚未装有 `UploadPlugin`，`setUpload(fn)` 会安装一个带默认 queue 配置的 `UploadPlugin`。
- **勿与增量 `initAemeath` 混搭踩坑**：若已通过 `setUpload` 装好 `UploadPlugin`，再次 `initAemeath({ upload, queue })` 时，`upload`/`queue` 等可能不会被采纳（见控制台告警）；请继续用 `setUpload(...)`，或先 `resetAemeath()` 再完整传入配置。
