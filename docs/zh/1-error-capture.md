# 模块1：错误捕获

## 🚀 快速开始

### 单例模式（推荐）

`initAemeath()` 默认启用 `ErrorCapturePlugin`，无需额外配置：

```typescript
import { initAemeath, getAemeath, classifyHttpUploadResponse } from 'aemeath-js';

initAemeath({
  upload: async (log) => {
    const res = await fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
    return classifyHttpUploadResponse(res.status, res.headers.get('Retry-After'));
  },
});

const logger = getAemeath();
```

### 手动组装

```typescript
import { AemeathLogger, ErrorCapturePlugin } from 'aemeath-js';

const logger = new AemeathLogger();
logger.use(new ErrorCapturePlugin());
```

✅ 自动捕获：

- 全局 JS 错误
- Promise 未处理错误
- 资源加载失败
- 启用 `BrowserApiErrorsPlugin` 后，还可在其覆盖的回调入口取得原始异常；它不能恢复浏览器从未暴露的错误细节。

---

## 📚 API

### 路由过滤（routeMatch）

`routeMatch` 是 `initAemeath()` 中的**全局**配置，控制所有插件（错误捕获、网络监控、性能监控）。每个插件也可以配置自己的 `routeMatch` 来进一步缩小范围。

```typescript
initAemeath({
  upload: async (log) => { /* ... */ return { success: true }; },

  // 全局 routeMatch — 对所有插件生效
  routeMatch: {
    includeRoutes: ['/home', '/product', /^\/user\/.+/],
    excludeRoutes: ['/debug'],
  },

  // 插件级 routeMatch — 仅对错误捕获生效，进一步缩小范围
  errorCapture: {
    routeMatch: {
      includeRoutes: ['/checkout'],
    },
  },
});
```

**规则：**
- `excludeRoutes` 优先级高于 `includeRoutes`。
- 路由支持三种匹配模式：精确字符串、正则表达式、函数 `(path: string) => boolean`。
- 如果只设置了 `excludeRoutes`，则排除的路由之外都会被监控。
- 如果只设置了 `includeRoutes`，则只监控这些路由。

### ErrorCapturePluginOptions

```typescript
interface ErrorCapturePluginOptions {
  /** 是否捕获未处理的 Promise 拒绝 @default true */
  captureUnhandledRejection?: boolean;
  /** 是否捕获资源加载错误 @default true */
  captureResourceError?: boolean;
  /** 是否捕获 console.error @default false */
  captureConsoleError?: boolean;
  /** 自定义错误过滤函数（返回 false 跳过该错误） */
  errorFilter?: (error: Error) => boolean;
  /** 插件级路由匹配（在全局 routeMatch 基础上进一步缩小范围） */
  routeMatch?: RouteMatchConfig;
  /** 调试模式 @default false */
  debug?: boolean;
}
```

### 单例模式 — errorCapture 选项

使用 `initAemeath()` 时，`errorCapture` 接受联合类型：

```typescript
// 方式 1：boolean（默认 true）
initAemeath({
  errorCapture: true,
});

// 方式 2：object，启用并配置 ErrorCapturePlugin
initAemeath({
  errorCapture: {
    enabled: true,
    captureUnhandledRejection: true,
    captureResourceError: true,
    captureConsoleError: true,
    debug: false,
    routeMatch: {
      includeRoutes: ['/checkout', '/payment'],
    },
    errorFilter: (error) => !error.message.includes('预期忽略的错误'),
  },
});
```

对象内的 `errorFilter` 优先于顶层兼容配置 `errorFilter`。`captureResourceError` 可独立
控制资源加载错误拦截；启用后资源错误同样遵循路由匹配、过滤和自动去重规则。

启用 `captureConsoleError` 时，只捕获 `console.error` 参数中携带的 `Error` 对象。SDK
自身通过 `logger.error()` 输出到控制台的错误不会再次被捕获；宿主手动捕获点与控制台
输出同一错误时，仍应按业务需要验证日志数量。

---

## 💡 使用示例

### React 集成

```tsx
import React, { Component } from 'react';
import { getAemeath } from 'aemeath-js';

const logger = getAemeath();

class ErrorBoundary extends Component {
  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    logger.error('React error', {
      error,
      context: { componentStack: errorInfo.componentStack },
    });
  }

  render() {
    return this.props.children;
  }
}
```

### Vue 集成

```typescript
import { createApp } from 'vue';
import { getAemeath } from 'aemeath-js';

const logger = getAemeath();
const app = createApp(App);

app.config.errorHandler = (err, instance, info) => {
  logger.error('Vue error', {
    error: err,
    context: { componentName: instance?.$options.name, info },
  });
};
```

### 手动捕获

```typescript
try {
  dangerousOperation();
} catch (error) {
  logger.error('Operation failed', {
    error,
    context: { operation: 'dangerousOperation' },
  });
}
```

---

## 🛡️ 浏览器 API 增强捕获（BrowserApiErrorsPlugin）

### 解决什么问题？

在 iOS WKWebView、Android WebView 等跨域受限环境中，`window.onerror` 只能获取到 `"Script error."`，无法得到完整的错误信息和堆栈。`BrowserApiErrorsPlugin` 通过为浏览器 API 的回调函数注入 try-catch 包裹，在错误发生的第一现场捕获完整的错误详情。

### 默认行为

`initAemeath()` 默认启用此插件，无需额外配置：

```typescript
initAemeath({
  upload: async (log) => { /* ... */ return { success: true }; },
});
// BrowserApiErrorsPlugin 已自动启用
```

### 覆盖的浏览器 API

| API | 说明 |
|-----|------|
| `EventTarget.addEventListener` | 为事件回调注入 try-catch |
| `EventTarget.removeEventListener` | 自动识别包装后的监听器 |
| `setTimeout` / `setInterval` | 为定时器回调注入 try-catch |
| `requestAnimationFrame` | 为动画回调注入 try-catch |
| `XMLHttpRequest.send` | 为 XHR 的 onload / onerror / onreadystatechange 等回调注入 try-catch |

### 配置选项

```typescript
initAemeath({
  upload: async (log) => { /* ... */ return { success: true }; },

  // 方式 1：禁用
  browserApiErrors: false,

  // 方式 2：自定义配置
  browserApiErrors: {
    eventTarget: true,           // 是否 patch addEventListener @default true
    timer: true,                 // 是否 patch setTimeout/setInterval @default true
    requestAnimationFrame: true, // 是否 patch requestAnimationFrame @default true
    xhr: true,                   // 是否 patch XMLHttpRequest.send @default true
  },
});
```

### 手动组装

```typescript
import { AemeathLogger, BrowserApiErrorsPlugin, ErrorCapturePlugin } from 'aemeath-js';

const logger = new AemeathLogger();

// ⚠️ BrowserApiErrorsPlugin 必须在 ErrorCapturePlugin 之前安装
logger.use(new BrowserApiErrorsPlugin());
logger.use(new ErrorCapturePlugin());
```

### 去重机制

当 try-catch 捕获到错误后，错误仍会被 re-throw（保持原始行为）。此时 `window.onerror` 也会收到同一个错误。两条观测保留独立 occurrenceId；同一原始对象通过 errorObjectId 关联，不按一个时间窗口吞掉后续全局异常。

### 注意事项

- 此插件用于浏览器环境
- 不影响 `fetch` 请求错误（fetch 错误通过 Promise rejection 捕获，已被 `ErrorCapturePlugin` 覆盖）
- 卸载插件后所有 API 会恢复为原始实现

---

## 📖 更多

- [早期错误捕获](./2-early-error-capture.md)
- [Source Map 解析](./3-sourcemap-parser.md)
- [上传插件](./4-upload-plugin.md)


## 异常证据协议

沿用现有 `initAemeath` / `ErrorCapturePlugin` 配置即可，无需新增开关。自动捕获的日志会提供
`entry.error.evidence`；排查时先查看原始消息 `entry.error.value`，再根据栈来源决定是否解析。
具体用法见[按证据来源解析](./3-sourcemap-parser.md#按证据来源解析)。

`error.evidence.schemaVersion = 1` 区分捕获渠道、早期/运行期阶段、原始名称、reason 类型和栈来源。
`error.stack` 仅保存输入携带的原始栈；已知补造栈放在 `evidence.captureStack`，无栈错误不会自动补造 Error。
`stackOrigin` 为 `original`、`capture-site` 或 `unavailable`。`Script error.` 加空位置时标记
`missingStackReason: 'browser-redacted'`，这不是某个 CDN/CORS 配置出错的根因证明。
原始栈也可能是异常创建位置，不保证就是最后一次 throw 的位置。

兼容期间 `error.type`、日志消息、级别及 `tags.errorCategory` 保持既有捕获分类；真实名称查看
`evidence.originalName`。SDK 不向原始 Error 写入 `type/source` 等属性。`errorFilter` 收到原始
Error（包括跨 realm Error），保留旧配置的引用、`instanceof` 和自定义异常方法判断；过滤器显式
修改/脱敏后的内容用于构建最终快照。非 Error 输入仍提供兼容的 Error 参数；仅为过滤器创建的
栈不会成为上报的原始栈。过滤器抛错时沿用旧版继续采集的行为。

每次观测保留独立 `occurrenceId`；同一运行时对象通过 `errorObjectId` 关联。包含此协议的错误绕过
捕获和上传的按内容去重，因此重复次数由实际记录体现。对象身份不是根因身份，也不表示业务恢复。
相比旧版，错误事件量可能增加；限流仍由 SafeGuard 和用户策略决定。不要用 captureStack 聚合业务事故。

跨 realm Error 和普通拒绝对象、DOMException、冻结对象、primitive rejection 和有界 cause/errors 均可规范化。
主 message、原始 stack 和结构化原始 `stacktrace.frames` 的全部帧保留，由已有 PayloadSanitize 拆分或拒绝。
定位、分类、采集时间和设备元数据也独立于诊断大小/数量预算；快照仍防御读取异常、循环和过深嵌套。
console 捕获保留 `tags.source = 'console'` 和 `context.consoleArgs` 全部参数，其中被选中的 Error
使用捕获快照；其他上下文沿用现有载荷清洗规则。诊断图和扩展字段共享 8 KiB 字符串
UTF-8 预算、128 节点、4 层、数组 8 项、对象 32 项限制（根扩展最多 40 项）。预算不是最终 JSON
载荷大小，额外结构开销仍由 PayloadSanitize 处理。截断、循环和读取失败写入
`evidence.normalization.issues`，不调用任意 toJSON/toString，不遍历 DOM/Bridge 实例字段。
脱敏仍需通过 beforeSend 设置，并覆盖新增 evidence/cause/errors 字段。

`[circular]`、`[truncated]`、`[unreadable]` 是结构性诊断标记，不占采集字符串内容预算，
重复规范化时保持完整。键名只能完整保留或整项省略并标记，不能裁短；SDK 元数据不占根扩展名额。
明确的早期/global/rejection/resource 来源优先决定类别；wrapped 和 console 观测使用 `manual`。
manual/未知渠道为兼容保留旧分类规则，业务显式设置的 `tags.errorCategory` 仍优先。

缺少字符串 message/value 的对象拒绝原因统一从 `error.reason` 读取，`error.value` 由这份快照生成；
其诊断字段不再重复复制到 error 根层，避免同一输入被遍历和计费两次。SDK 元数据仍单独保留。
Error 实例（包括其他 realm 的 Error 子类）的自有扩展字段继续保留在 error 根层。

`getCaptureDiagnostics()` 返回当前模块实例的采集失败累计数和最后失败渠道；不递归写 logger 或 console。
这是进程内诊断，不会自动上传。已有显式 `_isAemeathInternalError` 标记仍可排除内部事件，普通消息
包含 SDK 前缀或栈经过 aemeath 不再被自动丢弃。

后台升级时先兼容 evidence 和无 stack 的合法错误，再接入新版 SDK。已有缓存可继续上报；缺少证据的
历史记录不自动认定为原始栈。Promise 的后续处理保持浏览器原行为；本版本没有自动业务恢复推断，
也没有 beginOperation 或 rejectionhandled 状态上报 API。

### 手动处理 unknown：normalizeCapturedError

自动捕获以及 `logger.error(..., { error: new Error(...) })` 已执行规范化，无需再调用。
当自己的 `catch` 收到 `unknown`，或自定义采集器需要安全的 `ErrorInfo` 时，使用
`normalizeCapturedError(input, options?)`。它只创建快照，不主动上报，也不修改输入。
返回的 `ErrorInfo` 可直接交给 `logger.error`；字符串或普通对象没有原始栈时，不会补造业务栈。

```typescript
import { normalizeCapturedError, type AemeathInterface } from 'aemeath-js';

export function reportCaughtError(logger: AemeathInterface, reason: unknown) {
  const error = normalizeCapturedError(reason, { channel: 'manual' });
  logger.error('Operation failed', { error });
  return error;
}
```

`ErrorEvidenceOptions` 与 `ErrorEvidence` 类型均可从 `aemeath-js` 导入：

| 选项 | 用法 |
| --- | --- |
| `channel` | 捕获来源，如 `manual`、`global`、`unhandledrejection`、`wrapped`、`console`、`resource`；原始输入默认 `manual`。 |
| `phase` | `runtime` 或 `early`；原始输入默认 `runtime`。 |
| `message` | 没有字符串 `value`/`message` 时的兜底消息，不覆盖已有消息。 |
| `synthetic` | 仅当调用方知道输入栈是人为补造的采集栈时设为 `true`；该栈进入 `evidence.captureStack`，不作为 `error.stack`。 |
| `source` / `line` / `column` | 保存浏览器报告的位置；不能代替原始堆栈，也不会生成可映射的栈帧。 |

已有规范化快照再次传入时，默认沿用来源/阶段和 `occurrenceId`；显式选项可以覆盖来源/阶段。
同一个原始对象重新捕获会共享 `errorObjectId`，但各次观测有独立 `occurrenceId`。
对象原因的业务字段从 `error.reason` 读取；`error.value` 是便于展示的摘要。

### 读取采集状态：getCaptureDiagnostics

```typescript
import { getCaptureDiagnostics } from 'aemeath-js';

export function readCaptureHealth() {
  const { failures, lastChannel } = getCaptureDiagnostics();
  return { failures, lastChannel };
}
```

返回 `Readonly<{ failures: number; lastChannel?: string }>`。`failures` 是当前加载的 SDK
模块内、被采集隔离层拦住的异常累计数，**不是业务报错次数**；还没有失败时为 0，
`lastChannel` 为 `undefined`。读取不会清零，也不会发送网络请求；不同 SDK 副本的计数不合并。
单个字段读取失败可能只写入 `error.evidence.normalization.issues`，不一定增加此计数。
初始化前的脚本诊断单独查看 `window.__AEMEATH_EARLY_CAPTURE_FAILURES__`。

可复制示例：[with-evidence.ts](https://github.com/TieriaSail/aemeath-js/blob/main/examples/1-error-capture/with-evidence.ts)。
