# Module 1: Error Capture

## 🚀 Quick Start

### Singleton Pattern (Recommended)

`initAemeath()` enables `ErrorCapturePlugin` by default — no extra setup needed:

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

### Manual Assembly

```typescript
import { AemeathLogger, ErrorCapturePlugin } from 'aemeath-js';

const logger = new AemeathLogger();
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
  /** Capture unhandled Promise rejections @default true */
  captureUnhandledRejection?: boolean;
  /** Capture resource loading errors @default true */
  captureResourceError?: boolean;
  /** Capture console.error calls @default false */
  captureConsoleError?: boolean;
  /** Custom error filter (return false to skip) */
  errorFilter?: (error: Error) => boolean;
  /** Plugin-level route matching (narrows the global routeMatch scope) */
  routeMatch?: RouteMatchConfig;
  /** Debug mode @default false */
  debug?: boolean;
}
```

> **routeMatch rules**: `excludeRoutes` takes precedence over `includeRoutes`. When a global `routeMatch` is set via `initAemeath`, this plugin-level `routeMatch` further narrows the scope (both must match).

When using `initAemeath`, `errorCapture` accepts a boolean or an object:

```typescript
// Boolean (default: true)
initAemeath({ errorCapture: true });

// Object with plugin-level routeMatch
initAemeath({
  errorCapture: {
    enabled: true,
    routeMatch: { excludeRoutes: ['/debug'] },
  },
});
```

---

## 💡 Examples

### React Integration

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

### Vue Integration

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

### Manual Capture

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

## 📖 More

- [Early Error Capture](./2-early-error-capture.md)
- [Source Map Parser](./3-sourcemap-parser.md)
- [Upload Plugin](./4-upload-plugin.md)
