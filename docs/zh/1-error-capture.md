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

## 📖 更多

- [早期错误捕获](./2-early-error-capture.md)
- [Source Map 解析](./3-sourcemap-parser.md)
- [上传插件](./4-upload-plugin.md)
