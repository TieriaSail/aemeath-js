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
- **Errors inside callbacks** (enhanced capture via `BrowserApiErrorsPlugin`, solving "Script error." in WebView)

---

## 📚 API

### Route-Based Filtering (routeMatch)

`routeMatch` is a **global** config in `initAemeath()` that controls all plugins (error capture, network, performance). Each plugin can also have its own `routeMatch` to further narrow the scope.

```typescript
initAemeath({
  upload: async (log) => { /* ... */ return { success: true }; },

  // Global routeMatch — applies to ALL plugins
  routeMatch: {
    includeRoutes: ['/home', '/product', /^\/user\/.+/],
    excludeRoutes: ['/debug'],
  },

  // Plugin-level routeMatch — narrows scope for error capture only
  errorCapture: {
    routeMatch: {
      includeRoutes: ['/checkout'],
    },
  },
});
```

**Rules:**
- `excludeRoutes` takes priority over `includeRoutes`.
- Routes support three matching patterns: exact string, RegExp, and function `(path: string) => boolean`.
- If only `excludeRoutes` is set, all routes except excluded ones are monitored.
- If only `includeRoutes` is set, only those routes are monitored.
- MiniApp routes use a different format (e.g. `pages/index/index` instead of `/index`).

### ErrorCapturePluginOptions

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

### Singleton Pattern — errorCapture option

When using `initAemeath()`, `errorCapture` accepts a union type:

```typescript
// Option 1: boolean (default: true)
initAemeath({
  errorCapture: true,
});

// Option 2: object with plugin-level routeMatch
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

## 🛡️ Browser API Enhanced Capture (BrowserApiErrorsPlugin)

### What problem does it solve?

In restricted cross-origin environments such as iOS WKWebView and Android WebView, `window.onerror` only returns `"Script error."` without any useful stack trace. `BrowserApiErrorsPlugin` wraps browser API callbacks with try-catch to capture full error details at the point of origin.

### Default Behavior

`initAemeath()` enables this plugin by default — no extra setup needed:

```typescript
initAemeath({
  upload: async (log) => { /* ... */ return { success: true }; },
});
// BrowserApiErrorsPlugin is enabled automatically
```

### Covered Browser APIs

| API | Description |
|-----|-------------|
| `EventTarget.addEventListener` | Wraps event callbacks with try-catch |
| `EventTarget.removeEventListener` | Recognizes wrapped listeners automatically |
| `setTimeout` / `setInterval` | Wraps timer callbacks with try-catch |
| `requestAnimationFrame` | Wraps animation callbacks with try-catch |
| `XMLHttpRequest.send` | Wraps onload / onerror / onreadystatechange callbacks |

### Configuration

```typescript
initAemeath({
  upload: async (log) => { /* ... */ return { success: true }; },

  // Option 1: disable
  browserApiErrors: false,

  // Option 2: custom config
  browserApiErrors: {
    eventTarget: true,           // Patch addEventListener @default true
    timer: true,                 // Patch setTimeout/setInterval @default true
    requestAnimationFrame: true, // Patch requestAnimationFrame @default true
    xhr: true,                   // Patch XMLHttpRequest.send @default true
  },
});
```

### Manual Assembly

```typescript
import { AemeathLogger, BrowserApiErrorsPlugin, ErrorCapturePlugin } from 'aemeath-js';

const logger = new AemeathLogger();

// ⚠️ BrowserApiErrorsPlugin MUST be installed BEFORE ErrorCapturePlugin
logger.use(new BrowserApiErrorsPlugin());
logger.use(new ErrorCapturePlugin());
```

### Deduplication

When try-catch captures an error, the error is still re-thrown (preserving original behavior). `window.onerror` will also receive the same error. The plugin coordinates internally to ensure each error is reported only once.

### Notes

- This plugin only works in browser environments; it is automatically skipped in MiniApp environments
- Does not affect `fetch` errors (those are captured via Promise rejection, already covered by `ErrorCapturePlugin`)
- Uninstalling the plugin restores all APIs to their original implementations

---

## 📖 More

- [Early Error Capture](./2-early-error-capture.md)
- [Source Map Parser](./3-sourcemap-parser.md)
- [Upload Plugin](./4-upload-plugin.md)
