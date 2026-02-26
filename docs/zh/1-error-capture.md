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

```typescript
interface ErrorCapturePluginOptions {
  // 暂无配置项，使用默认配置
}
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
