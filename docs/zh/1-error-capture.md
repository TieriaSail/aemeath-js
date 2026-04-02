# 模块1：错误捕获

## 🚀 快速开始

### 单例模式（推荐）

`initAemeath()` 默认启用 `ErrorCapturePlugin`，无需额外配置：

```typescript
import { initAemeath, getAemeath } from 'aemeath-js';

initAemeath({
  upload: async (log) => {
    const res = await fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
    return { success: res.ok };
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
- **回调函数内的错误**（通过 `BrowserApiErrorsPlugin` 增强捕获，解决 WebView 中 "Script error." 问题）

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
- 小程序路由使用不同格式（例如 `pages/index/index` 而非 `/index`）。

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

// 方式 2：object，启用并配置插件级 routeMatch
initAemeath({
  errorCapture: {
    enabled: true,
    routeMatch: {
      includeRoutes: ['/checkout', '/payment'],
    },
  },
});
```

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

当 try-catch 捕获到错误后，错误仍会被 re-throw（保持原始行为）。此时 `window.onerror` 也会收到同一个错误。插件内部通过协调机制自动去重，确保同一个错误只被上报一次。

### 注意事项

- 此插件仅在浏览器环境生效，小程序环境自动跳过
- 不影响 `fetch` 请求错误（fetch 错误通过 Promise rejection 捕获，已被 `ErrorCapturePlugin` 覆盖）
- 卸载插件后所有 API 会恢复为原始实现

---

## 📖 更多

- [早期错误捕获](./2-early-error-capture.md)
- [Source Map 解析](./3-sourcemap-parser.md)
- [上传插件](./4-upload-plugin.md)
