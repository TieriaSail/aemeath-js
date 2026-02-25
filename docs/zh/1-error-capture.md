# 模块1：错误捕获

## 🚀 快速开始

```typescript
import { Logger, ErrorCapturePlugin } from 'aemeath-js';

const logger = new Logger();
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
import { logger } from './utils/logger';

class ErrorBoundary extends Component {
  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    logger.error('React error', error, {
      componentStack: errorInfo.componentStack,
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
import { logger } from './utils/logger';

const app = createApp(App);

app.config.errorHandler = (err, instance, info) => {
  logger.error('Vue error', err, {
    componentName: instance?.$options.name,
    info,
  });
};
```

### 手动捕获

```typescript
try {
  dangerousOperation();
} catch (error) {
  logger.error('Operation failed', error, {
    operation: 'dangerousOperation',
  });
}
```

---

## 📖 更多

- [早期错误捕获](./2-early-error-capture.md)
- [Source Map 解析](./3-sourcemap-parser.md)
- [上传插件](./4-upload-plugin.md)
