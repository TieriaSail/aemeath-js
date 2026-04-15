<p align="center">
  <h1 align="center">aemeath-js</h1>
  <p align="center">A pure frontend logging & monitoring SDK. The frontend does the heavy lifting — your backend just stores and cleans up.</p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/aemeath-js"><img src="https://img.shields.io/npm/v/aemeath-js.svg?style=flat-square" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/aemeath-js"><img src="https://img.shields.io/npm/dm/aemeath-js.svg?style=flat-square" alt="npm downloads"></a>
  <a href="https://img.shields.io/bundlephobia/minzip/aemeath-js"><img src="https://img.shields.io/bundlephobia/minzip/aemeath-js?style=flat-square&label=minzip" alt="bundle size"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.0+-blue.svg?style=flat-square" alt="TypeScript"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/aemeath-js.svg?style=flat-square" alt="license"></a>
</p>

<p align="center">
  <b>English</b> | <a href="./README.zh_CN.md">中文</a>
</p>

---

## What it does

Error tracking, log management, and performance monitoring — all handled in the browser. Your backend only needs to receive and store the data.

- **🌲 Tree-shakable** — Import what you need. Unused code is never bundled.
- **🔓 Frontend-driven** — Queuing, retry, caching, and deduplication run client-side.
- **🌐 Framework support** — React, Vue, vanilla JS, jQuery.
- **🔧 Build tool support** — Vite, Webpack 4+, Rsbuild.

## Multi-Platform Support

aemeath-js v2.0 supports **browsers** and **miniapps** through a `PlatformAdapter` pattern. Platform detection is automatic — browser users experience zero changes.

| Platform | Support | Notes |
|----------|---------|-------|
| **Browser** | ✅ Auto-detected | Zero config, works out of the box |
| **MiniApps** | ✅ Via adapter | WeChat, Douyin/TikTok, Baidu pass global directly; **Alipay is auto-wrapped** |
| **Taro / uni-app** | ✅ Via adapter | Pass the appropriate adapter to `initAemeath` |
| **Node.js** | ❌ Not supported | Architecture is extensible for future support |

**New exports:** `createBrowserAdapter`, `createMiniAppAdapter`, `createNoopAdapter`, `detectPlatform`, `setPlatform`, `resetPlatform`  
**New types:** `PlatformAdapter`, `PlatformType`, `MiniAppVendor`

`initAemeath()` accepts an optional `platform` option. `PerformancePlugin` is browser-only and not enabled by default.

```typescript
// MiniApp usage (e.g. WeChat)
import { initAemeath, createMiniAppAdapter } from 'aemeath-js';

initAemeath({
  platform: createMiniAppAdapter('wechat', wx),
  upload: async (log) => { /* ... */ return { success: true }; },
});
```

## Installation

```bash
npm install aemeath-js
```

<details>
<summary>yarn / pnpm</summary>

```bash
yarn add aemeath-js
# or
pnpm add aemeath-js
```
</details>

## Quick Start

```typescript
// Initialize once (e.g. in main.ts)
import { initAemeath } from 'aemeath-js';

initAemeath({
  upload: async (log) => {
    const res = await fetch('/api/logs', {
      method: 'POST',
      body: JSON.stringify(log),
    });
    const data = await res.json();
    return data.code === 200
      ? { success: true }
      : { success: false, shouldRetry: true, error: data.message };
  },
  context: {
    userId: '12345',
    appVersion: '1.0.0',
  },
});
```

```typescript
// Use anywhere
import { getAemeath } from 'aemeath-js';

const logger = getAemeath();
logger.info('User logged in');
logger.error('Something went wrong', { error });
logger.updateContext('userId', '67890');
```

**What's included by default?** `initAemeath()` automatically enables the following plugins. No extra `.use()` needed:

| Plugin | Default | How to disable |
|--------|---------|----------------|
| `ErrorCapturePlugin` | ✅ Enabled | `errorCapture: false` |
| `SafeGuardPlugin` | ✅ Enabled | `safeGuard: { enabled: false }` |
| `NetworkPlugin` | ✅ Enabled | `network: { enabled: false }` |
| `UploadPlugin` | When `upload` is provided | Don't pass `upload` |
| `EarlyErrorCapturePlugin` | When build plugin is configured | — |

> 💡 **Need more capabilities?** You can still `.use()` additional plugins on the singleton at any time. Duplicate `.use()` calls are safely ignored — if a plugin is already installed, it won't be added again.

### Browser (No Build Tools)

For jQuery, vanilla JS, or static HTML pages — no npm required:

```html
<script src="https://unpkg.com/aemeath-js/dist/aemeath-js.global.js"></script>
<script>
  AemeathJs.init({
    upload: function(log) {
      fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
    }
  });

  var logger = AemeathJs.getAemeath();
  logger.info('Page loaded');
</script>
```

## Plugins

All plugins are optional. Only import what you need — unused plugins are tree-shaken away.

| Plugin | Description | Size |
|--------|-------------|------|
| `ErrorCapturePlugin` | Auto-capture global errors, unhandled rejections, resource failures | ~3KB |
| `EarlyErrorCapturePlugin` | Capture errors before React/Vue mounts (requires build plugin) | ~3KB |
| `UploadPlugin` | Upload logs with priority queue, retry, and local cache | ~5KB |
| `PerformancePlugin` | 🌐🧪 Web Vitals performance monitoring — **browser only** ([learn more](./docs/en/6-performance-monitoring.md)) | ~4KB |
| `NetworkPlugin` | Monitor fetch/XHR requests (errors, slow requests) | ~3KB |
| `SafeGuardPlugin` | Rate limiting, recursion guard, error budget | ~3KB |

## Framework Integrations

> ⚠️ **Important:** Always call `initAemeath()` first in your app entry (e.g. `main.ts`). The framework integrations below do **not** replace initialization — they simply provide convenient ways to access the same singleton instance within your components.

| Framework | Import Path | Key Exports |
|-----------|-------------|-------------|
| **React** 16.8+ | `aemeath-js/react` | `AemeathErrorBoundary`, `useAemeath()`, `useErrorCapture()`, `withErrorBoundary()` |
| **Vue** 3+ | `aemeath-js/vue` | `createAemeathPlugin()`, `useAemeath()`, `useErrorCapture()` |
| **Vanilla JS / jQuery** | `aemeath-js` | Core API (no extra import needed) |

<details>
<summary><b>React Example</b></summary>

```tsx
// main.tsx — Step 1: Initialize (same as Quick Start)
import { initAemeath } from 'aemeath-js';

initAemeath({
  upload: async (log) => { /* ... */ return { success: true }; },
});
```

```tsx
// App.tsx — Step 2: Use framework integration
import { AemeathErrorBoundary, useAemeath } from 'aemeath-js/react';

function App() {
  return (
    <AemeathErrorBoundary
      fallback={(error, reset) => (
        <div>
          <p>Error: {error.message}</p>
          <button onClick={reset}>Retry</button>
        </div>
      )}
    >
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
</details>

<details>
<summary><b>Vue 3 Example</b></summary>

```ts
// main.ts — Step 1: Initialize (same as Quick Start)
import { createApp } from 'vue';
import { initAemeath } from 'aemeath-js';
import { createAemeathPlugin } from 'aemeath-js/vue';

initAemeath({
  upload: async (log) => { /* ... */ return { success: true }; },
});

const app = createApp(App);
app.use(createAemeathPlugin({ captureWarnings: true }));
app.mount('#app');
```

```vue
<!-- MyComponent.vue — Step 2: useAemeath() returns the same singleton -->
<script setup>
import { inject } from 'vue';
import { useAemeath } from 'aemeath-js/vue';

const logger = useAemeath(inject);
logger.info('Component setup');
</script>
```
</details>

## Build Tool Plugins

| Build Tool | Early Error Capture | SourceMap Upload |
|------------|---------------------|------------------|
| **Vite** 2+ | `aemeath-js/build-plugins/vite` | `aemeath-js/build-plugins/vite-sourcemap` |
| **Webpack** 4+ | `aemeath-js/build-plugins/webpack` | `aemeath-js/build-plugins/webpack-sourcemap` |
| **Rsbuild** 1+ | `aemeath-js/build-plugins/rsbuild` | `aemeath-js/build-plugins/rsbuild-sourcemap` |

<details>
<summary><b>Vite Example</b></summary>

```ts
// vite.config.ts
import { ameathEarlyErrorPlugin } from 'aemeath-js/build-plugins/vite';
import { ameathViteSourceMapPlugin } from 'aemeath-js/build-plugins/vite-sourcemap';

export default defineConfig({
  build: { sourcemap: true },
  plugins: [
    ameathEarlyErrorPlugin({ enabled: true }),
    ameathViteSourceMapPlugin({
      onUpload: async (file) => {
        await fetch('/api/sourcemaps', { method: 'POST', body: file.content });
      },
      deleteAfterUpload: true,
    }),
  ],
});
```
</details>

<details>
<summary><b>Webpack Example</b></summary>

```js
// webpack.config.js
const { AemeathEarlyErrorWebpackPlugin } = require('aemeath-js/build-plugins/webpack');
const { AemeathSourceMapWebpackPlugin } = require('aemeath-js/build-plugins/webpack-sourcemap');

module.exports = {
  devtool: 'source-map',
  plugins: [
    new AemeathEarlyErrorWebpackPlugin({ enabled: true }),
    new AemeathSourceMapWebpackPlugin({
      onUpload: async (file) => {
        await fetch('/api/sourcemaps', { method: 'POST', body: file.content });
      },
    }),
  ],
};
```
</details>

<details>
<summary><b>Rsbuild Example</b></summary>

```ts
// rsbuild.config.ts
import { ameathEarlyErrorPlugin } from 'aemeath-js/build-plugins/rsbuild';
import { ameathSourceMapPlugin } from 'aemeath-js/build-plugins/rsbuild-sourcemap';

export default defineConfig({
  output: { sourceMap: { js: 'source-map' } },
  plugins: [
    ameathEarlyErrorPlugin({ enabled: true }),
    ameathSourceMapPlugin({
      onUpload: async (file) => {
        await fetch('/api/sourcemaps', { method: 'POST', body: file.content });
      },
    }),
  ],
});
```
</details>

## Bundle Size

| Configuration | Size | What's Included |
|---------------|------|-----------------|
| Core only | ~2KB | Logger + event system |
| + Error Capture | ~5KB | + global error handlers |
| + Upload | ~10KB | + queue, retry, cache |
| All plugins | ~15KB | Everything |

## Custom Plugin

```typescript
import type { AemeathPlugin, AemeathInterface } from 'aemeath-js';

class MyPlugin implements AemeathPlugin {
  readonly name = 'my-plugin';
  readonly version = '1.0.0';

  install(logger: AemeathInterface) {
    logger.on('log', (entry) => {
      // your custom logic
    });
  }

  uninstall(logger: AemeathInterface) {
    // cleanup
  }
}

logger.use(new MyPlugin());
```

## Documentation

| Document | Description |
|----------|-------------|
| **[Quick Start](./QUICK_START.md)** | Step-by-step setup guide |
| **[Error Capture](./docs/en/1-error-capture.md)** | Global error capture plugin |
| **[Early Error Capture](./docs/en/2-early-error-capture.md)** | Pre-mount error capture + build plugins |
| **[SourceMap Parser](./docs/en/3-sourcemap-parser.md)** | Parse obfuscated error stacks |
| **[Upload Plugin](./docs/en/4-upload-plugin.md)** | Log upload with queue & retry |
| **[Global Context](./docs/en/5-global-context.md)** | Attach context to every log |
| **[Performance Monitoring](./docs/en/6-performance-monitoring.md)** | 🌐🧪 Web Vitals performance monitoring — **browser only**, experimental |
| **[Browser Usage](./docs/en/0-browser-usage.md)** | Script tag usage (no build tools) |

> 📖 中文文档：[查看中文 README](./README.zh_CN.md) | [快速开始](./QUICK_START.zh_CN.md) | [模块文档](./docs/zh/)

## Compatibility

### Browser

All packages (ESM, CJS, IIFE) are built with **ES2017** target and can run directly in the following browsers:

| Environment | Minimum Version | Notes |
|-------------|----------------|-------|
| Chrome | 64+ | Full support |
| Firefox | 69+ | Full support |
| Safari | 12+ | Full support |
| Edge | 79+ (Chromium) | Full support |
| iOS Safari | 12+ | Full support |
| Android WebView | 64+ | Full support |
| IE | ❌ Not supported | Use browser bundle with polyfills if needed |

### Supporting Older Browsers (Chrome < 64)

If your `browserslist` includes browsers older than the versions listed above, you need to add aemeath-js to your build tool's transpilation scope:

**Rsbuild / Rspack**

```typescript
// rsbuild.config.ts
export default defineConfig({
  source: {
    include: [/[\\/]node_modules[\\/]aemeath-js[\\/]/],
  },
});
```

**Webpack**

```javascript
// webpack.config.js
module.exports = {
  module: {
    rules: [
      {
        test: /\.m?js$/,
        include: [
          path.resolve(__dirname, 'src'),
          /node_modules[\\/]aemeath-js/,
        ],
        use: {
          loader: 'babel-loader',
          options: {
            presets: [['@babel/preset-env', { targets: '> 0.5%, not dead' }]],
          },
        },
      },
    ],
  },
};
```

**Vite**

Vite uses esbuild which skips `node_modules` by default. For production builds targeting legacy browsers, use `@vitejs/plugin-legacy`:

```typescript
// vite.config.ts
import legacy from '@vitejs/plugin-legacy';

export default defineConfig({
  plugins: [
    legacy({
      targets: ['Chrome >= 49'],
    }),
  ],
});
```

**Next.js**

```javascript
// next.config.js
module.exports = {
  transpilePackages: ['aemeath-js'],
};
```

### Node.js

| Usage | Minimum Version | Notes |
|-------|----------------|-------|
| Build plugins (Vite/Webpack/Rsbuild) | Node 16+ | Runs in build tool process |
| SourceMap Parser | Node 16+ | Server-side stack parsing |
| Core / Plugins | Browser only | Requires `window`, `document` |

### Build Tools

| Tool | Supported Versions | Integration |
|------|-------------------|-------------|
| **Vite** | 2.0+ | First-class plugin support |
| **Webpack** | 4.0+ | Plugin + Loader support |
| **Rsbuild** | 1.0+ | First-class plugin support |
| **Rollup** | 2.0+ | Via Vite plugin |
| **esbuild** | 0.14+ | Works with ESM/CJS output |
| **tsup** | 6.0+ | Works out of the box |

### Frameworks

| Framework | Supported Versions | Integration |
|-----------|-------------------|-------------|
| **React** | 16.8+ (Hooks) | `aemeath-js/react` — ErrorBoundary, hooks |
| **Vue** | 3.0+ | `aemeath-js/vue` — Plugin, composables |
| **Next.js** | 12+ | Works with React integration |
| **Nuxt** | 3+ | Works with Vue integration |
| **Vanilla JS / jQuery** | Any | Core API, no extra imports |

### Module Formats

| Format | File | Target | Usage |
|--------|------|--------|-------|
| **ESM** | `dist/index.js` | ES2017 | `import` — modern bundlers |
| **CJS** | `dist/index.cjs` | ES2017 | `require()` — Node.js, older bundlers |
| **IIFE** | `dist/aemeath-js.global.js` | ES2017 | `<script>` tag — no build tools |

## Also Check Out

If you need **session recording & user behavior replay**, check out [**sigillum-js**](https://github.com/TieriaSail/sigillum-js) — a lightweight session recording library.

Together, **aemeath-js** (logging & monitoring) + **sigillum-js** (session replay) provide a complete frontend observability solution — all data stays on your own servers.

## Contributing

Issues and feature requests are welcome! Feel free to [open an issue](https://github.com/TieriaSail/aemeath-js/issues).

## License

[MIT](./LICENSE) © TieriaSail

---

> Built with AI assistance.
