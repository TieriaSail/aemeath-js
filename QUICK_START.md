# Quick Start

> [中文版](./QUICK_START.zh_CN.md)

## Choose Your Project Type

---

### 📄 No Build Tools (jQuery / Vanilla JS / Static HTML)

**No npm, no bundler — just add `<script>` tags:**

```html
<!DOCTYPE html>
<html>
<head>
  <!-- 1. Early error capture (optional, must be first) -->
  <script src="https://unpkg.com/aemeath-js/scripts/early-error.js"></script>

  <!-- 2. Core (~24KB) -->
  <script src="https://unpkg.com/aemeath-js/dist/aemeath-js.global.js"></script>
</head>
<body>
  <script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
  <script>
    // 3. Initialize
    AemeathJs.init({
      upload: function(log) {
        $.post('/api/logs', log);
        // or use native fetch:
        // fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
      }
    });

    // 4. Use
    var logger = AemeathJs.getAemeath();
    logger.info('Page loaded');

    // jQuery example
    $('#myButton').click(function() {
      logger.info('Button clicked', { context: { buttonId: 'myButton' } });
    });

    // Catch errors
    try {
      riskyOperation();
    } catch (e) {
      logger.error('Operation failed', { error: e });
    }
  </script>
</body>
</html>
```

**Browser API:**

```javascript
// Initialize
AemeathJs.init({
  upload: function(log) { /* ... */ },  // Upload function
  errorCapture: true,                    // Auto capture errors (default: true)
  browserApiErrors: true,                // Enhanced capture in WebView (default: true)
  safeGuard: true,                       // Safety guard (default: true)
  enableConsole: true,                   // Console output (default: true)
  level: 'info'                          // Log level: debug/info/track/warn/error
});

// Get logger instance
var logger = AemeathJs.getAemeath();

// Log messages
logger.debug('Debug message');
logger.info('Info message');
logger.track('Button clicked', { tags: { page: '/home', action: 'click' } });
logger.warn('Warning message');
logger.error('Error message');
```

> `track()` shares the same priority as `info()` and is designed for simple business tracking (e.g. page views, button clicks). It keeps tracking data separate from general informational logs.

**CDN URLs:**

| CDN | URL |
|-----|-----|
| unpkg | `https://unpkg.com/aemeath-js/dist/aemeath-js.global.js` |
| jsDelivr | `https://cdn.jsdelivr.net/npm/aemeath-js/dist/aemeath-js.global.js` |

---

### 📦 Bundled Projects (Vite / Webpack / Rsbuild)

**Install:**

```bash
npm install aemeath-js
```

**Initialize once, use everywhere.**

```typescript
// src/main.ts - Initialize once
import { initAemeath } from 'aemeath-js';

initAemeath({
  upload: async (log) => {
    const res = await fetch('/api/logs', {
      method: 'POST',
      body: JSON.stringify(log),
    });
    return { success: res.ok };
  },
  context: {
    userId: '12345',
    deviceId: 'abc-def',
    appVersion: '1.0.0',
    platform: 'iOS',
  },
});
```

```typescript
// src/anywhere.ts - Use anywhere
import { getAemeath } from 'aemeath-js';

const logger = getAemeath();
logger.info('Hello World'); // context is automatically attached

// Update context dynamically
logger.updateContext('userId', '67890');
```

**What's included by default?** `initAemeath()` automatically enables these plugins:

| Plugin | Default | How to disable |
|--------|---------|----------------|
| `BrowserApiErrorsPlugin` | ✅ Enabled | `browserApiErrors: false` |
| `ErrorCapturePlugin` | ✅ Enabled | `errorCapture: false` |
| `SafeGuardPlugin` | ✅ Enabled | `safeGuard: { enabled: false }` |
| `NetworkPlugin` | ✅ Enabled | `network: { enabled: false }` |
| `UploadPlugin` | When `upload` is provided | Don't pass `upload` |
| `EarlyErrorCapturePlugin` | When build plugin is configured | — |

> 💡 **Need more capabilities?** You can `.use()` additional plugins at any time. Duplicate `.use()` calls are safely ignored.

---

## 📦 Plugins Overview

| Plugin | Description | Size | Required? |
|--------|-------------|------|-----------|
| **BrowserApiErrorsPlugin** | Enhanced error capture in WebView / cross-origin | ~2KB | Recommended |
| **ErrorCapturePlugin** | Capture global errors | ~3KB | Recommended |
| **EarlyErrorCapturePlugin** | Errors before React/Vue mount | +3KB | Optional |
| **UploadPlugin** | Upload to server | +5KB | Optional |
| **SourceMap Parser** | Parse obfuscated stacks | +6KB | Optional |
| **PerformancePlugin** | 🌐🧪 Web Vitals monitoring — **browser only**, experimental ([learn more](./docs/en/6-performance-monitoring.md)) | +4KB | Optional |
| **SafeGuardPlugin** | Prevent logger crashes | +3KB | Recommended for production |

**On-demand loading examples:**

```typescript
// Error capture only (3KB)
initAemeath({ errorCapture: true });

// Error + Upload (8KB)
initAemeath({
  errorCapture: true,
  upload: async (log) => { /* ... */ return { success: true }; },
});

```

---

## 🔧 Build Configuration (Optional)

### Early Error Capture (Requires Build Plugin)

Choose the plugin for your build tool:

**Vite:**

```typescript
// vite.config.ts
import { ameathEarlyErrorPlugin } from 'aemeath-js/build-plugins/vite';

export default defineConfig({
  plugins: [
    ameathEarlyErrorPlugin({
      enabled: process.env.NODE_ENV === 'production',
    }),
  ],
});
```

**Webpack (4.0+):**

```javascript
// webpack.config.js
const { AemeathEarlyErrorWebpackPlugin } = require('aemeath-js/build-plugins/webpack');

module.exports = {
  plugins: [
    new AemeathEarlyErrorWebpackPlugin({
      enabled: process.env.NODE_ENV === 'production',
      // mode: 'auto' - auto-detect: inject if html-webpack-plugin exists, else output file
      // mode: 'file' - force output standalone file (no html-webpack-plugin needed)
    }),
  ],
};
```

> 💡 **Tip**: Default `mode: 'auto'`. Without html-webpack-plugin, it outputs `aemeath-early-error.js`.

**Rsbuild:**

```typescript
// rsbuild.config.ts
import { ameathEarlyErrorPlugin } from 'aemeath-js/build-plugins/rsbuild';

export default defineConfig({
  plugins: [
    ameathEarlyErrorPlugin({
      enabled: process.env.NODE_ENV === 'production',
    }),
  ],
});
```

> ⚠️ **Note**: Webpack 3 is not supported. Webpack 4+ with html-webpack-plugin 4+ is required for inject mode.

### SourceMap Upload (Optional)

**Vite:**

```typescript
import { ameathViteSourceMapPlugin } from 'aemeath-js/build-plugins/vite-sourcemap';

export default defineConfig({
  build: { sourcemap: true },
  plugins: [
    ameathViteSourceMapPlugin({
      onUpload: async (file) => {
        await fetch('/api/sourcemaps', { method: 'POST', body: file.content });
      },
    }),
  ],
});
```

**Webpack:**

```javascript
const { AemeathSourceMapWebpackPlugin } = require('aemeath-js/build-plugins/webpack-sourcemap');

module.exports = {
  devtool: 'source-map',
  plugins: [
    new AemeathSourceMapWebpackPlugin({
      onUpload: async (file) => {
        await fetch('/api/sourcemaps', { method: 'POST', body: file.content });
      },
    }),
  ],
};
```

**Rsbuild:**

```typescript
import { ameathSourceMapPlugin } from 'aemeath-js/build-plugins/rsbuild-sourcemap';

export default defineConfig({
  output: { sourceMap: { js: 'source-map' } },
  plugins: [
    ameathSourceMapPlugin({
      onUpload: async (file) => {
        await fetch('/api/sourcemaps', { method: 'POST', body: file.content });
      },
    }),
  ],
});
```

### SourceMap Parser (Optional)

```typescript
import { createParser } from 'aemeath-js/parser';

const parser = createParser({
  sourceMapBaseUrl: 'https://cdn.example.com/sourcemaps/dist/1.0.0',
});

const result = await parser.parse(errorStack);
```

### Network Monitoring (Enabled by Default)

Automatically monitors fetch and XMLHttpRequest. Large resources (mp3/mp4/png/jpg, etc.) are excluded from slow request detection by default.

```typescript
initAemeath({
  network: {
    logTypes: ['error', 'slow'],  // Only log errors and slow requests
    slowThreshold: 5000,          // Slow request threshold: 5s
  },
});

// Custom exclusion list
initAemeath({
  network: {
    slowRequestExcludePatterns: ['.mp3', '.wav', '.ogg', '.m4a', '.mp4'],
  },
});

// Monitor all resources (including large files)
initAemeath({
  network: {
    monitorAllSlowRequests: true,
  },
});
```

### Route Scope (Optional)

Not every page needs monitoring. Use `routeMatch` to control which routes are monitored — applies to **all** capabilities (error capture, network monitoring, performance monitoring).

```typescript
initAemeath({
  routeMatch: {
    excludeRoutes: ['/admin', '/debug', '/logger-viewer'],
  },
  upload: async (log) => { /* ... */ return { success: true }; },
});
```

`excludeRoutes` takes priority over `includeRoutes`. Example: monitor `/app/*` except `/app/debug`:

```typescript
initAemeath({
  routeMatch: {
    includeRoutes: [/^\/app/],
    excludeRoutes: ['/app/debug'],
  },
});
```

**Advanced: per-plugin route override** — each plugin (`errorCapture`, `network`, `performance`) supports its own `routeMatch` to further narrow scope within the global rules. See the corresponding module documentation for details.

```typescript
initAemeath({
  routeMatch: {
    includeRoutes: [/^\/app/],
  },
  network: {
    routeMatch: { excludeRoutes: ['/app/internal'] },
  },
  errorCapture: {
    routeMatch: { excludeRoutes: ['/app/test'] },
  },
});
```

**MiniApp routes** use a different format (e.g. `pages/index/index` instead of `/index`):

```typescript
initAemeath({
  platform: createMiniAppAdapter('wechat', wx),
  routeMatch: {
    excludeRoutes: ['pages/admin/index', 'pages/debug/index'],
  },
});
```

---

## 🌐 Framework Integrations (Optional)

> ⚠️ **Important:** Always call `initAemeath()` first in your app entry. The framework integrations below do **not** replace initialization — `useAemeath()` simply returns the same singleton instance you already created.

### React

```tsx
// main.tsx — Step 1: Initialize (same as above)
import { initAemeath } from 'aemeath-js';
initAemeath({ upload: async (log) => { /* ... */ return { success: true }; } });
```

```tsx
// App.tsx — Step 2: Use framework integration
import { AemeathErrorBoundary, useAemeath } from 'aemeath-js/react';

function App() {
  return (
    <AemeathErrorBoundary fallback={<ErrorPage />}>
      <MyApp />
    </AemeathErrorBoundary>
  );
}

// useAemeath() returns the same instance created by initAemeath()
function MyComponent() {
  const logger = useAemeath();
  logger.info('Component mounted');
  return <div>...</div>;
}
```

### Vue 3

```typescript
// main.ts — Step 1: Initialize (same as above)
import { createApp } from 'vue';
import { initAemeath } from 'aemeath-js';
import { createAemeathPlugin } from 'aemeath-js/vue';

initAemeath({ upload: async (log) => { /* ... */ return { success: true }; } });

const app = createApp(App);
app.use(createAemeathPlugin({ captureWarnings: true }));
app.mount('#app');
```

```vue
<!-- MyComponent.vue — useAemeath() returns the same singleton -->
<script setup>
import { inject } from 'vue';
import { useAemeath } from 'aemeath-js/vue';

const logger = useAemeath(inject);
logger.info('Component setup');
</script>
```

### Vanilla JS / jQuery (Bundled Projects)

```javascript
import { initAemeath, getAemeath } from 'aemeath-js';

initAemeath();

const logger = getAemeath();
logger.info('Page loaded');

// Works with jQuery
$('#btn').click(() => logger.info('Clicked'));
```

> 💡 **No build tools?** See the script tag approach at the top of this document.

---

## 🎯 Recommended Configurations

### Development: Error Capture Only

```typescript
initAemeath({});
// Error capture, safe guard, and network monitoring are enabled by default
// Size: ~8KB
```

### Production: Full Setup

```typescript
initAemeath({
  upload: async (log) => {
    await fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
    return { success: true };
  },
});
// All defaults + upload plugin
// Size: ~13KB
```

---

## MiniApp

For WeChat, Alipay, Douyin, Baidu miniapps, or cross-platform frameworks (Taro, uni-app), pass a `PlatformAdapter` to `initAemeath`:

```typescript
import { initAemeath, createMiniAppAdapter, getAemeath } from 'aemeath-js';

// WeChat miniapp
initAemeath({
  platform: createMiniAppAdapter('wechat', wx),
  upload: async (log) => {
    // Use your backend API to receive logs
    return { success: true };
  },
});

const logger = getAemeath();
logger.info('MiniApp initialized');
```

For Taro or uni-app, pass the framework API as the second argument (e.g. `createMiniAppAdapter('wechat', Taro)` or `createMiniAppAdapter('wechat', uni)`).

> **Alipay MiniApp**: Alipay's storage API signatures differ from other vendors. `createMiniAppAdapter('alipay', my)` automatically wraps these differences — no manual handling needed.

---

## 📚 More Documentation

- [Full API Reference](./README.md)
- [Error Capture](./docs/en/1-error-capture.md)
- [Early Error Capture](./docs/en/2-early-error-capture.md)
- [SourceMap Parser](./docs/en/3-sourcemap-parser.md)
- [Upload Plugin](./docs/en/4-upload-plugin.md)
- [Performance Monitoring](./docs/en/6-performance-monitoring.md) (🌐🧪 browser only, experimental)
- [Examples](./examples/)
