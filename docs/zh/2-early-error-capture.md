# 模块2：早期错误捕获

## 🚀 快速开始

### 步骤1：构建配置

根据你的构建工具选择对应的插件：

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
      // mode: 'auto' (默认) - 有 html-webpack-plugin 则自动注入，否则输出独立文件
      // mode: 'inject' - 强制注入（需要 html-webpack-plugin 4+）
      // mode: 'file' - 强制输出独立 JS 文件（不依赖 html-webpack-plugin）
    }),
  ],
};
```

**模式说明：**

| 模式 | html-webpack-plugin | 行为 |
|------|---------------------|------|
| `'auto'` (默认) | 可选 | 有则注入，无则输出 `aemeath-early-error.js` |
| `'inject'` | 需要 (4+) | 强制注入到 HTML |
| `'file'` | 不需要 | 输出独立文件 |

如果使用 `file` 模式，需手动添加到 HTML：
```html
<head>
  <script src="aemeath-early-error.js"></script> <!-- 必须放在最前面 -->
</head>
```

> ⚠️ **注意**: Webpack 3 不支持（需要 Webpack 4+ 的 hooks API）。

### 步骤2：运行时配置

#### 单例模式（推荐）

`initAemeath()` 在检测到构建时早期错误脚本后，会自动注册 `EarlyErrorCapturePlugin`：

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

#### 手动组装

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

✅ 现在可以捕获：

- React/Vue 挂载前的 JS 错误
- 资源加载失败
- Chunk 加载失败
- 浏览器兼容性问题

---

## 📚 API

```typescript
interface EarlyErrorCaptureOptions {
  /** 是否启用（默认：true） */
  enabled?: boolean;

  /** 最大缓存错误数量（默认：50） */
  maxErrors?: number;

  /** 是否启用 Chunk 自动刷新（默认：true） */
  autoRefreshOnChunkError?: boolean;

  /** 是否检测浏览器兼容性（默认：true） */
  checkCompatibility?: boolean;

  /** 保底端点（可选） */
  fallbackEndpoint?: string;

  /** 保底超时（默认：30000ms） */
  fallbackTimeout?: number;

  /**
   * 发送方式偏好（默认：'auto'）
   * - 'auto'：sendBeacon 优先，失败降级到 XHR
   * - 'xhr'：只用 XHR（需要自定义 header 时使用）
   * - 'beacon'：只用 sendBeacon
   */
  fallbackTransport?: 'auto' | 'xhr' | 'beacon';

  /**
   * 自定义请求头（仅 XHR 模式生效）
   * Content-Type 默认为 application/json，可覆盖。
   * ⚠️ 值会被序列化到内联脚本，必须是字面量。
   */
  fallbackHeaders?: Record<string, string>;

  /**
   * 自定义 payload 格式化函数
   * - 返回单个对象 → 一次请求发送（批量接口）
   * - 返回数组 → 每个元素分别发一次请求（单条接口）
   * ⚠️ 此函数会被 .toString() 序列化注入内联脚本，
   *    不能引用外部变量、闭包或模块，函数体必须是纯 ES5 语法。
   */
  formatPayload?: (errors: unknown[], meta: unknown) => unknown;

  /** 插件级路由匹配（在全局 routeMatch 基础上进一步缩小范围） */
  routeMatch?: RouteMatchConfig;
}
```

### 路由匹配

EarlyErrorCapturePlugin 会继承 `initAemeath()` 中的全局 `routeMatch` 配置。你也可以设置插件级 `routeMatch` 来进一步缩小范围。

**规则：**
- `excludeRoutes` 优先级高于 `includeRoutes`。
- 路由支持三种匹配模式：精确字符串、正则表达式、函数 `(path: string) => boolean`。
- 如果只设置了 `excludeRoutes`，则排除的路由之外都会被监控。
- 如果只设置了 `includeRoutes`，则只监控这些路由。
- 小程序路由使用不同格式（例如 `pages/index/index` 而非 `/index`）。

> **注意**：构建时注入的早期错误脚本会捕获**所有**错误，不区分路由。路由过滤仅在运行时将缓存的错误 flush 到 logger 时生效。

---

## ⚠️ 兼容性提醒

**内联早期错误捕获脚本**使用纯 **ES5** 语法，可在任何浏览器中运行。

但 aemeath-js 的 **npm 包**（包括 `EarlyErrorCapturePlugin` 和 `initAemeath()`）以 **ES2017** 为构建目标。如果 npm 包因语法不兼容导致加载失败（例如在非常老旧的 WebView 中）：

1. `initAemeath()` 永远不会执行
2. `__flushEarlyErrors__` 永远不会被调用
3. 早期捕获的错误将停留在内存中，永远不会通过正常链路上报

**建议：**

- 如果你的 `browserslist` 包含 Chrome 64 / Safari 12 以下的浏览器，请将 aemeath-js 加入构建工具的转译范围（参见 [兼容性 — 兼容更低版本浏览器](../../README.zh_CN.md#兼容更低版本浏览器chrome--64)）
- 配置 `fallbackEndpoint` 作为兜底方案 — 即使 SDK 自身加载失败，早期错误也会在超时后发送到你的 fallback 端点

---

## 🔧 构建插件兼容性

| 构建工具 | 版本支持 | 导入路径 | html-webpack-plugin |
|---------|---------|---------|---------------------|
| **Vite** | 2.0+ ✅ | `aemeath-js/build-plugins/vite` | - |
| **Webpack** | 4.0+ ✅ | `aemeath-js/build-plugins/webpack` | 可选 |
| **Webpack** | 3.x ❌ | 不支持 | - |
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

> 💡 `html-webpack-plugin` 是可选的。如果没有，会自动输出 `aemeath-early-error.js` 文件。

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

## 💡 功能

### Chunk 自动刷新

Chunk 加载失败时自动刷新页面（只刷新一次），避免白屏。

```typescript
new EarlyErrorCapturePlugin({
  autoRefreshOnChunkError: true, // 默认开启
});
```

### 浏览器兼容性检测

自动检测浏览器是否支持 Promise、fetch、Array.includes 等特性。

```typescript
new EarlyErrorCapturePlugin({
  checkCompatibility: true, // 默认开启
});
```

### 保底上报（Fallback）

如果担心 AemeathLogger 初始化失败（如 JS 加载失败），可以配置保底端点。超时后脚本会独立将错误发送到指定 URL。

#### 基础用法

```typescript
// 构建配置（Vite/Rsbuild/Webpack 均支持）
ameathEarlyErrorPlugin({
  enabled: true,
  fallbackEndpoint: '/api/logs/fallback',
  fallbackTimeout: 10000, // 10秒后使用保底端点
});
```

#### 自定义 payload 格式（适配现有后端接口）

```typescript
ameathEarlyErrorPlugin({
  enabled: true,
  fallbackEndpoint: 'https://example.com/api/error/log/add',
  fallbackTimeout: 10000,
  fallbackTransport: 'xhr',
  formatPayload: function(errors, meta) {
    // 返回数组 → 逐条上报，匹配后端单条接口
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

#### 添加自定义请求头

```typescript
ameathEarlyErrorPlugin({
  enabled: true,
  fallbackEndpoint: 'https://example.com/api/logs',
  fallbackTransport: 'xhr', // 需要自定义 header 时必须用 xhr
  fallbackHeaders: {
    'X-App-Name': 'my-app',
    'X-Log-Source': 'early-error',
  },
});
```

#### 发送方式说明

| 模式 | 说明 | 适用场景 |
|------|------|---------|
| `'auto'` (默认) | sendBeacon 优先，失败降级到 XHR | 通用场景 |
| `'xhr'` | 只用 XHR | 需要自定义 header 或确保 Content-Type |
| `'beacon'` | 只用 sendBeacon | 页面卸载场景（`unload`/`beforeunload`） |

> **注意**：配置了 `fallbackHeaders` 但未指定 `fallbackTransport` 时，会自动切换为 `'xhr'` 模式（sendBeacon 不支持自定义 header）。

---

## 📖 更多

- [错误捕获](./1-error-capture.md)
- [Source Map 解析](./3-sourcemap-parser.md)
- [上传插件](./4-upload-plugin.md)
