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

  /**
   * Transport preference (default: 'auto')
   * - 'auto': sendBeacon first, fallback to XHR
   * - 'xhr': XHR only (use when custom headers are needed)
   * - 'beacon': sendBeacon only
   */
  fallbackTransport?: 'auto' | 'xhr' | 'beacon';

  /**
   * Custom request headers (XHR mode only)
   * Content-Type defaults to application/json.
   * WARNING: Values are serialized into inline script, must be literals.
   */
  fallbackHeaders?: Record<string, string>;

  /**
   * Custom payload formatter
   * - Return a single object → one request (batch endpoint)
   * - Return an array → one request per element (single-entry endpoint)
   * WARNING: This function is serialized via .toString() into the inline script.
   *          It must not reference external variables, closures, or modules.
   *          The function body must be pure ES5 syntax.
   */
  formatPayload?: (errors: unknown[], meta: unknown) => unknown;

  /** Plugin-level route matching (narrows the global routeMatch scope) */
  routeMatch?: RouteMatchConfig;
}
```

### Route Matching

EarlyErrorCapturePlugin inherits the global `routeMatch` config from `initAemeath()`. You can also set a plugin-level `routeMatch` to further narrow the scope.

**Rules:**
- `excludeRoutes` takes priority over `includeRoutes`.
- Routes support three matching patterns: exact string, RegExp, and function `(path: string) => boolean`.
- If only `excludeRoutes` is set, all routes except excluded ones are monitored.
- If only `includeRoutes` is set, only those routes are monitored.
- MiniApp routes use a different format (e.g. `pages/index/index` instead of `/index`).

> **Note**: The build-time early error script captures ALL errors regardless of route. Route filtering only applies at runtime when the cached errors are flushed to the logger.

---

## ⚠️ Compatibility Notice

The **inline early error capture script** uses pure **ES5** syntax and runs in any browser.

However, the aemeath-js **npm package** (including `EarlyErrorCapturePlugin` and `initAemeath()`) is built with **ES2017** target. If the npm package fails to load due to syntax incompatibility (e.g., in very old WebViews):

1. `initAemeath()` will never execute
2. `__flushEarlyErrors__` will never be called
3. Captured early errors will remain in memory and never be reported through the normal pipeline

**Recommendations:**

- If your `browserslist` includes browsers older than Chrome 64 / Safari 12, add aemeath-js to your build tool's transpilation scope (see [Compatibility — Supporting Older Browsers](../../README.md#supporting-older-browsers-chrome--64))
- Configure `fallbackEndpoint` as a safety net — even if the SDK itself fails to load, early errors will be sent to your fallback endpoint after the timeout

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

### Fallback Upload

If worried about AemeathLogger initialization failure (e.g. JS bundle fails to load), configure a fallback endpoint. After timeout, the script will independently send errors to the specified URL.

#### Basic Usage

```typescript
// Build config (Vite/Rsbuild/Webpack all supported)
ameathEarlyErrorPlugin({
  enabled: true,
  fallbackEndpoint: '/api/logs/fallback',
  fallbackTimeout: 10000, // Use fallback after 10s
});
```

#### Custom Payload Format (adapt to existing backend API)

```typescript
ameathEarlyErrorPlugin({
  enabled: true,
  fallbackEndpoint: 'https://example.com/api/error/log/add',
  fallbackTimeout: 10000,
  fallbackTransport: 'xhr',
  formatPayload: function(errors, meta) {
    // Return array → send one request per entry
    return errors.map(function(e) {
      return {
        timestamp: e.timestamp,
        systemName: meta.ua.indexOf('iPhone') !== -1 ? 'IOS' : 'WEB',
        tip: 'early',
        content: JSON.stringify({
          level: 'error',
          message: e.message,
          error: e.stack ? { stack: e.stack } : null,
          tags: { errorType: e.type },
          context: { device: meta },
        }),
      };
    });
  },
});
```

#### Custom Request Headers

```typescript
ameathEarlyErrorPlugin({
  enabled: true,
  fallbackEndpoint: 'https://example.com/api/logs',
  fallbackTransport: 'xhr', // Must use xhr for custom headers
  fallbackHeaders: {
    'X-App-Name': 'my-app',
    'X-Log-Source': 'early-error',
  },
});
```

#### Transport Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| `'auto'` (default) | sendBeacon first, fallback to XHR | General purpose |
| `'xhr'` | XHR only | Custom headers or guaranteed Content-Type |
| `'beacon'` | sendBeacon only | Page unload scenarios |

> **Note**: When `fallbackHeaders` is configured without specifying `fallbackTransport`, it automatically switches to `'xhr'` mode (sendBeacon does not support custom headers).

---

## 📖 More

- [Error Capture](./1-error-capture.md)
- [Source Map Parser](./3-sourcemap-parser.md)
- [Upload Plugin](./4-upload-plugin.md)
