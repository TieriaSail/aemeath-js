# WeChat Miniprogram Native Support

Starting from `2.3.0-beta.0`, `aemeath-js` ships a dedicated slim bundle at `dist-miniprogram/` that is natively understood by the WeChat DevTools "Build npm" step — no compatibility shim or polyfill required.

This guide targets three audiences:

1. **Native WeChat miniprograms** (`.js` projects, no bundler)
2. **Cross-platform frameworks** such as Taro / uni-app (Node-side bundler, targeting WeChat)
3. Existing users evaluating whether they need to migrate

---

## 1. Why a dedicated bundle is needed

The WeChat DevTools "Build npm" resolver has the following constraints that clash with a typical ESM-first npm package layout:

| Constraint | Main entry `dist/` | Dedicated `dist-miniprogram/` |
|------------|-------------------|-------------------------------|
| File extension must be `.js` | CJS uses `.cjs` ❌ | `.js` ✅ |
| No code splitting / chunks | `index.cjs` depends on `chunk-*.cjs` ❌ | Single-file bundle ✅ |
| Does not honor `exports` subpaths | Subpath imports unresolved ❌ | Plain `require('aemeath-js')` works ✅ |
| Requires ES2017-compatible syntax | ES2017 ✅ | ES2017 ✅ |

With the `miniprogram` field in `package.json`, DevTools copies the entire `dist-miniprogram/` directory to `miniprogram_npm/aemeath-js/`, after which `require('aemeath-js')` works natively.

---

## 2. Slim API surface

The miniprogram bundle exports **only APIs that make sense inside a miniprogram runtime** (current minified size ~50KB):

### Available exports

```javascript
const {
  AemeathLogger,

  ErrorCapturePlugin,
  UploadPlugin,
  SafeGuardPlugin,
  NetworkPlugin,

  createMiniAppAdapter,

  instrumentMiniAppRequest,

  initAemeath,
  getAemeath,
  isAemeathInitialized,
  resetAemeath,

  LogLevelEnum,
  ErrorCategory,
} = require('aemeath-js');
```

### Intentionally excluded APIs

| Missing export | Reason |
|---------------|--------|
| `BrowserApiErrorsPlugin` | Relies on `window` / `XMLHttpRequest`, not available in miniprograms |
| `PerformancePlugin` | Relies on `PerformanceObserver` / Web Vitals |
| `EarlyErrorCapturePlugin` | Inline-script early-error capture is browser-only |
| `createBrowserAdapter` / `detectPlatform` | Auto-detection would reference `wx` as an implicit global, breaking bundlers |
| `instrumentFetch` / `instrumentXHR` | No `fetch` / `XMLHttpRequest` in miniprograms |
| `SourceMapParser` / `createParser` | Depend on `source-map-js`; resolve stacks on the server instead |
| React / Vue integrations | Not applicable |

If your monorepo ships both a browser subpackage and a miniprogram subpackage, keep using the full `aemeath-js` main entry for browser and this slim entry for miniprograms. The switch happens automatically via `main` vs. `miniprogram` — **no application code change needed**.

---

## 3. Native WeChat miniprogram setup

### 3.1 Install

From your miniprogram project root (same level as `project.config.json`):

```bash
npm install aemeath-js
```

### 3.2 Build npm in DevTools

Open WeChat DevTools, then **Tools → Build npm**. On success, `miniprogram_npm/aemeath-js/index.js` will be generated.

> If you see "No NPM package to build", verify `setting.packNpmManually` / `setting.packNpmRelationList` in `project.config.json`; see the [official docs](https://developers.weixin.qq.com/miniprogram/dev/devtools/npm.html).

### 3.3 Initialize in `app.js`

```javascript
const { initAemeath, createMiniAppAdapter } = require('aemeath-js');

App({
  onLaunch() {
    initAemeath({
      // Explicit platform injection is required in the miniprogram entry.
      platform: createMiniAppAdapter('wechat', wx),

      environment: 'production',
      release: '1.0.0',

      context: {
        appName: 'my-miniprogram',
      },

      upload: (log) => new Promise((resolve) => {
        wx.request({
          url: 'https://your-server.com/api/logs',
          method: 'POST',
          data: log,
          success: () => resolve({ success: true }),
          fail: (err) => resolve({
            success: false,
            shouldRetry: true,
            error: err.errMsg,
          }),
        });
      }),

      network: {
        enabled: true,
        logTypes: ['error', 'slow'],
        slowThreshold: 3000,
      },
    });
  },

  onError(error) {
    // wx.onError is forwarded to ErrorCapturePlugin by the platform adapter.
    // This app-level handler still fires — the SDK never swallows errors.
    console.error('app error:', error);
  },
});
```

### 3.4 Use in pages

```javascript
const { getAemeath } = require('aemeath-js');

Page({
  onLoad() {
    const logger = getAemeath();
    logger.info('home loaded', { tags: { page: 'home' } });
  },

  async onSubmit() {
    const logger = getAemeath();
    try {
      await submitForm();
    } catch (err) {
      logger.error('submit failed', { error: err });
    }
  },
});
```

---

## 4. Cross-platform frameworks (Taro / uni-app)

### 4.1 Taro

Taro's `@tarojs/taro` polyfills `wx` / `my` / `tt` at the call site. Pass `Taro` as the API object:

```javascript
import Taro from '@tarojs/taro';
import { initAemeath, createMiniAppAdapter } from 'aemeath-js';

initAemeath({
  platform: createMiniAppAdapter('wechat', Taro),
  upload: async (log) => {
    const res = await Taro.request({
      url: 'https://your-server.com/api/logs',
      method: 'POST',
      data: log,
    });
    return { success: res.statusCode === 200 };
  },
});
```

> Taro bundles on Node, so it picks the main entry (not the `miniprogram` field). The two entries expose identical public APIs on purpose — application code is portable.

### 4.2 uni-app

```javascript
import { initAemeath, createMiniAppAdapter } from 'aemeath-js';

initAemeath({
  platform: createMiniAppAdapter('wechat', uni),
  upload: (log) => new Promise((resolve) => {
    uni.request({
      url: 'https://your-server.com/api/logs',
      method: 'POST',
      data: log,
      success: () => resolve({ success: true }),
      fail: (err) => resolve({ success: false, shouldRetry: true, error: err.errMsg }),
    });
  }),
});
```

### 4.3 Native vs. cross-platform routing

| Scenario | Resolved entry |
|----------|---------------|
| Native WeChat miniprogram (DevTools Build npm) | `miniprogram` → `dist-miniprogram/index.js` |
| Taro / uni-app (Node pre-compiled) | `main` / `module` → `dist/index.cjs` / `dist/index.js` |
| H5 / browser | `main` / `module` / `browser` |

---

## 5. FAQ

### Q: Why must `platform` be explicitly passed?

The miniprogram bundler treats `aemeath-js` as an immutable static dependency. If the SDK auto-detected `wx` / `my` / `tt` / `swan`, the bundler would resolve those as undeclared globals and crash. Explicit platform injection keeps the runtime zero-overhead and tree-shakes away adapters you don't need.

### Q: Does the miniprogram runtime support `import` / `export`?

No — the runtime is CommonJS. The slim bundle is emitted as CJS and expects `const X = require('aemeath-js')`.

### Q: Is `source-map-js` bundled?

No. Miniprogram-side SDK does not parse sourcemaps (do that on the server instead). `source-map-js` is marked external and excluded from `dist-miniprogram/`.

### Q: Is the miniprogram entry affected by the 1.x "ES2020 syntax crash"?

No. `dist-miniprogram/index.js` is compiled to ES2017 and has been verified to run on WeChat base library 2.0+.

### Q: Can I use `NetworkPlugin` without `UploadPlugin`?

Yes. All plugins are opt-in — omit the relevant option:

```javascript
initAemeath({
  platform: createMiniAppAdapter('wechat', wx),
  // No `upload` → UploadPlugin is not installed
  network: { enabled: true },
});
```

---

## 6. Version compatibility

| `aemeath-js` version | WeChat base library | Notes |
|----------------------|--------------------|-------|
| `< 2.3.0-beta.0`     | All                | Requires manual Taro/uni-app bundler config, or native `npm build` fails |
| `>= 2.3.0-beta.0`    | `>= 2.0`           | Native "Build npm" works out of the box |

---

## 7. See also

- Main entry API docs: [../../README.md](../../README.md)
- Multi-platform examples: [../../examples/7-multi-platform/README.md](../../examples/7-multi-platform/README.md)
- Official WeChat npm docs: <https://developers.weixin.qq.com/miniprogram/dev/devtools/npm.html>
