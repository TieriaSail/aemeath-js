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
  <script src="https://unpkg.com/aemeath-js/dist/browser.global.js"></script>
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
      logger.info('Button clicked', { buttonId: 'myButton' });
    });

    // Catch errors
    try {
      riskyOperation();
    } catch (e) {
      logger.error('Operation failed', { error: e.message });
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
  safeGuard: true,                       // Safety guard (default: true)
  enableConsole: true,                   // Console output (default: true)
  level: 'info'                          // Log level: debug/info/warn/error
});

// Get logger instance
var logger = AemeathJs.getAemeath();

// Log messages
logger.debug('Debug message');
logger.info('Info message');
logger.warn('Warning message');
logger.error('Error message');
```

**CDN URLs:**

| CDN | URL |
|-----|-----|
| unpkg | `https://unpkg.com/aemeath-js/dist/browser.global.js` |
| jsDelivr | `https://cdn.jsdelivr.net/npm/aemeath-js/dist/browser.global.js` |

---

### 📦 Bundled Projects (Vite / Webpack / Rsbuild)

**Install:**

```bash
npm install aemeath-js
```

#### Option 1: Singleton (Recommended) ⭐

**Initialize once, use everywhere.**

```typescript
// src/main.ts - Initialize once
import { initAemeath } from 'aemeath-js';

initAemeath({
  errorCapture: true,
  upload: async (log) => {
    await fetch('/api/logs', {
      method: 'POST',
      body: JSON.stringify(log),
    });
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
logger.updateContext({ userId: '67890' });
```

✅ Pros:
- Initialize once, use everywhere
- On-demand configuration, no forced bundling
- Simplest approach

---

#### Option 2: Manual Setup (Full Control)

**Assemble yourself, full control.**

```typescript
import { AemeathLogger, ErrorCapturePlugin, UploadPlugin } from 'aemeath-js';

const logger = new AemeathLogger();

// Only need error capture? Just add this
logger.use(new ErrorCapturePlugin());

// Need upload? Add this too
logger.use(new UploadPlugin({
  onUpload: async (log) => {
    await fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
    return { success: true };
  },
}));
```

✅ Pros:
- Fully customizable
- On-demand loading, smallest bundle size

---

## 📦 Plugins Overview

| Plugin | Description | Size | Required? |
|--------|-------------|------|-----------|
| **ErrorCapturePlugin** | Capture global errors | ~3KB | Recommended |
| **EarlyErrorCapturePlugin** | Errors before React/Vue mount | +3KB | Optional |
| **UploadPlugin** | Upload to server | +5KB | Optional |
| **SourceMap Parser** | Parse obfuscated stacks | +6KB | Optional |
| **PerformancePlugin** | Web Vitals monitoring | +4KB | Optional |
| **SafeGuardPlugin** | Prevent logger crashes | +3KB | Recommended for production |

**On-demand loading examples:**

```typescript
// Error capture only (3KB)
initAemeath({ errorCapture: true });

// Error + Upload (8KB)
initAemeath({
  errorCapture: true,
  upload: async (log) => { /* ... */ },
});

// Error + Performance (7KB)
import { getAemeath } from 'aemeath-js';
import { PerformancePlugin } from 'aemeath-js';

initAemeath({ errorCapture: true });
getAemeath().use(new PerformancePlugin({
  monitorWebVitals: true,
  sampleRate: 0.1,
}));
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

### Performance Monitoring (Optional)

```typescript
import { getAemeath } from 'aemeath-js';
import { PerformancePlugin } from 'aemeath-js';

initAemeath({ errorCapture: true });
getAemeath().use(new PerformancePlugin({
  monitorWebVitals: true,     // Monitor LCP, FID, CLS, FCP, TTFB
  monitorResources: false,    // Monitor slow resources (optional)
  monitorLongTasks: true,     // Monitor long tasks (optional)
  longTaskThreshold: 50,      // Long task threshold (ms)
  sampleRate: 0.1,            // 10% sampling rate (recommended for production)
}));

// Custom performance measurement
const logger = getAemeath();
logger.startMark('data-fetch');
const data = await fetchData();
const duration = logger.endMark('data-fetch');
console.log(`Data fetch took: ${duration}ms`);
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

---

## 🌐 Framework Integrations (Optional)

The core library is framework-agnostic. Optional integrations are provided for popular frameworks.

### React

```tsx
import { initAemeath } from 'aemeath-js/singleton';
import { AemeathErrorBoundary, useAemeath } from 'aemeath-js/react';

initAemeath({ upload: async (log) => { /* ... */ } });

function App() {
  return (
    <AemeathErrorBoundary fallback={<ErrorPage />}>
      <MyApp />
    </AemeathErrorBoundary>
  );
}

function MyComponent() {
  const logger = useAemeath();
  logger.info('Component mounted');
  return <div>...</div>;
}
```

### Vue 3

```typescript
import { createApp } from 'vue';
import { initAemeath } from 'aemeath-js/singleton';
import { createAemeathPlugin, useAemeath } from 'aemeath-js/vue';

initAemeath({ upload: async (log) => { /* ... */ } });

const app = createApp(App);
app.use(createAemeathPlugin({ captureWarnings: true }));
app.mount('#app');
```

```vue
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

initAemeath({ errorCapture: true });

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
initAemeath({
  errorCapture: true,
});
// Size: 3KB
```

### Production: Full Setup

```typescript
initAemeath({
  errorCapture: true,
  upload: async (log) => {
    await fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
    return { success: true };
  },
});
// Size: 8KB
```

---

## 📚 More Documentation

- [Full API Reference](./README.md)
- [Error Capture](./docs/en/1-error-capture.md)
- [Early Error Capture](./docs/en/2-early-error-capture.md)
- [SourceMap Parser](./docs/en/3-sourcemap-parser.md)
- [Upload Plugin](./docs/en/4-upload-plugin.md)
- [Performance Monitoring](./docs/en/6-performance-monitoring.md)
- [Examples](./examples/)
