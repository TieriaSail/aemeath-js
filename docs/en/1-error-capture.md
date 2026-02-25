# Module 1: Error Capture

## 🚀 Quick Start

```typescript
import { Logger, ErrorCapturePlugin } from 'aemeath-js';

const logger = new Logger();
logger.use(new ErrorCapturePlugin());
```

✅ Auto captures:

- Global JS errors
- Unhandled promise rejections
- Resource loading failures

---

## 📚 API

```typescript
interface ErrorCapturePluginOptions {
  // No config needed, uses defaults
}
```

---

## 💡 Examples

### React Integration

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

### Vue Integration

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

### Manual Capture

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

## 📖 More

- [Early Error Capture](./2-early-error-capture.md)
- [Source Map Parser](./3-sourcemap-parser.md)
- [Upload Plugin](./4-upload-plugin.md)
