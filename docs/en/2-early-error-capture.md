# Module 2: Early Error Capture

## 🚀 Quick Start

### Step 1: Build Configuration

Choose the plugin for your build tool:

**Rsbuild:**

```typescript
// rsbuild.config.ts
import { defineConfig } from '@rsbuild/core';
import { ameathEarlyErrorPlugin } from 'aemeath-js/build-plugins/rsbuild';

export default defineConfig({
  plugins: [
    ameathEarlyErrorPlugin({
      enabled: process.env.NODE_ENV === 'production',
    }),
  ],
});
```

**Vite:**

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
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
      // mode: 'auto' (default) - auto inject if html-webpack-plugin exists, else output file
      // mode: 'inject' - force inject (requires html-webpack-plugin 4+)
      // mode: 'file' - force output standalone JS file (no html-webpack-plugin needed)
    }),
  ],
};
```

**Mode options:**

| Mode | html-webpack-plugin | Behavior |
|------|---------------------|----------|
| `'auto'` (default) | Optional | Inject if available, else output `aemeath-early-error.js` |
| `'inject'` | Required (4+) | Force inject into HTML |
| `'file'` | Not needed | Output standalone file |

If using `file` mode, manually add to your HTML:
```html
<head>
  <script src="aemeath-early-error.js"></script> <!-- Must be first -->
</head>
```

> ⚠️ **Note**: Webpack 3 is not supported (requires Webpack 4+ hooks API).

### Step 2: Runtime Configuration

#### Singleton Pattern (Recommended)

`initAemeath()` automatically registers `EarlyErrorCapturePlugin` when build-time early errors are detected:

```typescript
import { initAemeath, getAemeath } from 'aemeath-js';

initAemeath({
  upload: async (log) => {
    const response = await fetch('/api/logs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getToken()}`,
      },
      body: JSON.stringify(log),
    });

    if (!response.ok) {
      return { success: false, shouldRetry: true, error: `Upload failed: ${response.status}` };
    }
    return { success: true };
  },
});

const logger = getAemeath();
```

#### Manual Assembly

```typescript
import { AemeathLogger, EarlyErrorCapturePlugin, UploadPlugin } from 'aemeath-js';

const logger = new AemeathLogger();

logger.use(new EarlyErrorCapturePlugin());

logger.use(
  new UploadPlugin({
    onUpload: async (log) => {
      const response = await fetch('/api/logs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify(log),
      });

      if (!response.ok) {
        return { success: false, shouldRetry: true, error: `Upload failed: ${response.status}` };
      }
      return { success: true };
    },
  }),
);
```

✅ Now captures:

- JS errors before React/Vue mounts
- Resource loading failures
- Chunk loading failures
- Browser compatibility issues

---

## 📚 API

```typescript
interface EarlyErrorCaptureOptions {
  /** Enable (default: true) */
  enabled?: boolean;

  /** Max errors to cache (default: 50) */
  maxErrors?: number;

  /** Auto refresh on chunk error (default: true) */
  autoRefreshOnChunkError?: boolean;

  /** Check browser compatibility (default: true) */
  checkCompatibility?: boolean;

  /** Fallback endpoint (optional) */
  fallbackEndpoint?: string;

  /** Fallback timeout (default: 30000ms) */
  fallbackTimeout?: number;

  /** Plugin-level route matching (narrows the global routeMatch scope) */
  routeMatch?: RouteMatchConfig;
}
```

> **routeMatch rules**: The build-time script captures all errors regardless of route. Route filtering only applies when the SDK flushes early errors at runtime. `excludeRoutes` takes precedence over `includeRoutes`. The global `routeMatch` set via `initAemeath` is automatically composed with this plugin-level setting.

---

## 🔧 Build Plugin Compatibility

| Build Tool | Version Support | Import Path | html-webpack-plugin |
|------------|-----------------|-------------|---------------------|
| **Vite** | 2.0+ ✅ | `aemeath-js/build-plugins/vite` | - |
| **Webpack** | 4.0+ ✅ | `aemeath-js/build-plugins/webpack` | Optional |
| **Webpack** | 3.x ❌ | Not supported | - |
| **Rsbuild** | 1.0+ ✅ | `aemeath-js/build-plugins/rsbuild` | - |

### Vite

```typescript
import { ameathEarlyErrorPlugin } from 'aemeath-js/build-plugins/vite';

export default defineConfig({
  plugins: [
    ameathEarlyErrorPlugin({
      enabled: process.env.NODE_ENV === 'production',
    }),
  ],
});
```

### Webpack

```javascript
const { AemeathEarlyErrorWebpackPlugin } = require('aemeath-js/build-plugins/webpack');

module.exports = {
  plugins: [
    new AemeathEarlyErrorWebpackPlugin({
      enabled: process.env.NODE_ENV === 'production',
      mode: 'auto', // 'auto' | 'inject' | 'file'
    }),
  ],
};
```

> 💡 `html-webpack-plugin` is optional. If not available, outputs `aemeath-early-error.js` file automatically.

### Rsbuild

```typescript
import { ameathEarlyErrorPlugin } from 'aemeath-js/build-plugins/rsbuild';

export default defineConfig({
  plugins: [
    ameathEarlyErrorPlugin({
      enabled: process.env.NODE_ENV === 'production',
    }),
  ],
});
```

---

## 💡 Features

### Auto Refresh on Chunk Error

Auto refresh page when chunk loading fails (once only), prevents white screen.

```typescript
new EarlyErrorCapturePlugin({
  autoRefreshOnChunkError: true, // Enabled by default
});
```

### Browser Compatibility Check

Auto detect if browser supports Promise, fetch, Array.includes, etc.

```typescript
new EarlyErrorCapturePlugin({
  checkCompatibility: true, // Enabled by default
});
```

### Fallback Upload (Optional)

If worried about AemeathLogger initialization failure, configure fallback endpoint:

```typescript
// Build config
rsbuildPlugin({
  enabled: true,
  fallbackEndpoint: '/api/logs/fallback',
});

// Runtime config
new EarlyErrorCapturePlugin({
  fallbackEndpoint: '/api/logs/fallback',
  fallbackTimeout: 30000, // Use fallback after 30s
});
```

---

## 📖 More

- [Error Capture](./1-error-capture.md)
- [Source Map Parser](./3-sourcemap-parser.md)
- [Upload Plugin](./4-upload-plugin.md)
