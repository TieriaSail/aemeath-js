<p align="center">
  <h1 align="center">aemeath-js</h1>
  <p align="center">纯前端日志 & 监控 SDK。前端独立完成大部分工作，后端只需记录和销毁。</p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/aemeath-js"><img src="https://img.shields.io/npm/v/aemeath-js.svg?style=flat-square" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/aemeath-js"><img src="https://img.shields.io/npm/dm/aemeath-js.svg?style=flat-square" alt="npm downloads"></a>
  <a href="https://img.shields.io/bundlephobia/minzip/aemeath-js"><img src="https://img.shields.io/bundlephobia/minzip/aemeath-js?style=flat-square&label=minzip" alt="bundle size"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.0+-blue.svg?style=flat-square" alt="TypeScript"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/aemeath-js.svg?style=flat-square" alt="license"></a>
</p>

<p align="center">
  <a href="./README.md">English</a> | <b>中文</b>
</p>

---

## 为什么选择 aemeath-js？

大多数前端监控方案需要前端、后端、运维多方配合——无论是使用第三方 SaaS 还是自建服务。**aemeath-js** 不一样：前端尽可能独立完成所有工作——错误追踪、性能监控、日志管理、队列调度、重试和缓存全部在浏览器端处理。后端只需负责数据的记录和处理即可。

- **🌲 Tree-shakable** — 按需引入，未使用的代码不会被打包
- **🔓 前端驱动** — 浏览器承担核心工作，后端只需记录和处理数据
- **🌐 框架支持** — 支持 React、Vue、原生 JS、jQuery 等
- **🔧 构建工具支持** — 支持 Vite、Webpack 4+、Rsbuild

## 安装

```bash
npm install aemeath-js
```

<details>
<summary>yarn / pnpm</summary>

```bash
yarn add aemeath-js
# 或
pnpm add aemeath-js
```
</details>

## 快速开始

```typescript
// 初始化一次（如在 main.ts 中）
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
// 任何地方使用
import { getAemeath } from 'aemeath-js';

const logger = getAemeath();
logger.info('用户已登录');
logger.error('出错了', { error });
logger.updateContext('userId', '67890');
```

**默认已启用哪些插件？** `initAemeath()` 会自动启用以下插件，无需额外 `.use()`：

| 插件 | 默认状态 | 如何关闭 |
|------|---------|---------|
| `ErrorCapturePlugin` | ✅ 默认启用 | `errorCapture: false` |
| `SafeGuardPlugin` | ✅ 默认启用 | `safeGuard: { enabled: false }` |
| `NetworkPlugin` | ✅ 默认启用 | `network: { enabled: false }` |
| `UploadPlugin` | 传入 `upload` 时启用 | 不传 `upload` 即可 |
| `EarlyErrorCapturePlugin` | 配置了构建插件时自动启用 | — |

> 💡 **需要更多能力？** 你可以随时通过 `.use()` 追加插件。重复调用 `.use()` 是安全的——已安装的插件不会被重复添加。

### 浏览器直接使用（无需构建工具）

适用于 jQuery、原生 JS、静态 HTML 页面 — 无需 npm：

```html
<script src="https://unpkg.com/aemeath-js/dist/browser.global.js"></script>
<script>
  AemeathJs.init({
    upload: function(log) {
      fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
    }
  });

  var logger = AemeathJs.getAemeath();
  logger.info('页面加载完成');
</script>
```

## 插件

所有插件均为可选。只导入你需要的 — 未使用的插件会被 tree-shaking 移除。

| 插件 | 说明 | 体积 |
|------|------|------|
| `ErrorCapturePlugin` | 自动捕获全局错误、未处理的 Promise 拒绝、资源加载失败 | ~3KB |
| `EarlyErrorCapturePlugin` | 捕获 React/Vue 挂载前的错误（需配合构建插件） | ~3KB |
| `UploadPlugin` | 带优先级队列、重试和本地缓存的日志上报 | ~5KB |
| `PerformancePlugin` | 🧪 Web Vitals 性能监控（[了解更多](./docs/zh/6-performance-monitoring.md)） | ~4KB |
| `NetworkPlugin` | 监控 fetch/XHR 请求（错误、慢请求） | ~3KB |
| `SafeGuardPlugin` | 频率限制、递归保护、错误预算 | ~3KB |

## 框架集成

> ⚠️ **重要：** 无论使用哪个框架，都需要先在应用入口（如 `main.ts`）调用 `initAemeath()` 进行初始化。下面的框架集成**不是**替代初始化，而是在组件中便捷地获取同一个单例实例。

| 框架 | 导入路径 | 主要导出 |
|------|----------|----------|
| **React** 16.8+ | `aemeath-js/react` | `AemeathErrorBoundary`, `useAemeath()`, `useErrorCapture()`, `withErrorBoundary()` |
| **Vue** 3+ | `aemeath-js/vue` | `createAemeathPlugin()`, `useAemeath()`, `useErrorCapture()` |
| **原生 JS / jQuery** | `aemeath-js` | 核心 API（无需额外导入） |

<details>
<summary><b>React 示例</b></summary>

```tsx
// main.tsx — 第一步：初始化（和快速开始一样）
import { initAemeath } from 'aemeath-js';

initAemeath({
  upload: async (log) => { /* ... */ return { success: true }; },
});
```

```tsx
// App.tsx — 第二步：使用框架集成
import { AemeathErrorBoundary, useAemeath } from 'aemeath-js/react';

function App() {
  return (
    <AemeathErrorBoundary
      fallback={(error, reset) => (
        <div>
          <p>出错了：{error.message}</p>
          <button onClick={reset}>重试</button>
        </div>
      )}
    >
      <MyApp />
    </AemeathErrorBoundary>
  );
}

// useAemeath() 返回的就是 initAemeath() 创建的同一个实例
function MyComponent() {
  const logger = useAemeath();
  logger.info('组件已挂载');
  return <div>...</div>;
}
```
</details>

<details>
<summary><b>Vue 3 示例</b></summary>

```ts
// main.ts — 第一步：初始化（和快速开始一样）
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
<!-- MyComponent.vue — 第二步：useAemeath() 返回的是同一个单例 -->
<script setup>
import { inject } from 'vue';
import { useAemeath } from 'aemeath-js/vue';

const logger = useAemeath(inject);
logger.info('组件初始化');
</script>
```
</details>

## 构建工具插件

| 构建工具 | 早期错误捕获 | SourceMap 上传 |
|----------|-------------|---------------|
| **Vite** 2+ | `aemeath-js/build-plugins/vite` | `aemeath-js/build-plugins/vite-sourcemap` |
| **Webpack** 4+ | `aemeath-js/build-plugins/webpack` | `aemeath-js/build-plugins/webpack-sourcemap` |
| **Rsbuild** 1+ | `aemeath-js/build-plugins/rsbuild` | `aemeath-js/build-plugins/rsbuild-sourcemap` |

<details>
<summary><b>Vite 配置示例</b></summary>

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
<summary><b>Webpack 配置示例</b></summary>

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
<summary><b>Rsbuild 配置示例</b></summary>

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

## 打包体积

| 配置 | 体积 | 包含内容 |
|------|------|----------|
| 仅核心 | ~2KB | Logger + 事件系统 |
| + 错误捕获 | ~5KB | + 全局错误处理 |
| + 上报 | ~10KB | + 队列、重试、缓存 |
| 全部插件 | ~15KB | 所有功能 |

## 自定义插件

```typescript
import type { AemeathPlugin, AemeathInterface } from 'aemeath-js';

class MyPlugin implements AemeathPlugin {
  readonly name = 'my-plugin';
  readonly version = '1.0.0';

  install(logger: AemeathInterface) {
    logger.on('log', (entry) => {
      // 你的自定义逻辑
    });
  }

  uninstall(logger: AemeathInterface) {
    // 清理
  }
}

logger.use(new MyPlugin());
```

## 文档

| 文档 | 说明 |
|------|------|
| **[快速开始](./QUICK_START.zh_CN.md)** | 分步骤的安装使用指南 |
| **[错误捕获](./docs/zh/1-error-capture.md)** | 全局错误捕获插件 |
| **[早期错误捕获](./docs/zh/2-early-error-capture.md)** | 挂载前错误捕获 + 构建插件 |
| **[SourceMap 解析](./docs/zh/3-sourcemap-parser.md)** | 解析混淆的错误堆栈 |
| **[上报插件](./docs/zh/4-upload-plugin.md)** | 带队列和重试的日志上报 |
| **[全局上下文](./docs/zh/5-global-context.md)** | 自动附加上下文到每条日志 |
| **[性能监控](./docs/zh/6-performance-monitoring.md)** | 🧪 Web Vitals 性能监控（实验性） |
| **[浏览器直接使用](./docs/zh/0-browser-usage.md)** | Script 标签引入（无需构建工具） |

> 📖 English docs: [README](./README.md) | [Quick Start](./QUICK_START.md) | [Module Docs](./docs/en/)

## 兼容性

### 浏览器

| 环境 | 最低版本 | 说明 |
|------|---------|------|
| Chrome | 64+ | 完整支持 |
| Firefox | 69+ | 完整支持 |
| Safari | 12+ | 完整支持 |
| Edge | 79+（Chromium） | 完整支持 |
| iOS Safari | 12+ | 完整支持 |
| Android WebView | 64+ | 完整支持 |
| IE | ❌ 不支持 | 如需兼容可使用浏览器 IIFE 包 + polyfill |

> npm 包构建目标为 **ES2020**。浏览器 IIFE 包（`browser.global.js`）构建目标为 **ES2017**，兼容性更广。

### Node.js

| 用途 | 最低版本 | 说明 |
|------|---------|------|
| 构建插件（Vite/Webpack/Rsbuild） | Node 16+ | 在构建工具进程中运行 |
| SourceMap 解析器 | Node 16+ | 服务端堆栈解析 |
| 核心 / 插件 | 仅浏览器 | 依赖 `window`、`document` |

### 构建工具

| 工具 | 支持版本 | 集成方式 |
|------|---------|----------|
| **Vite** | 2.0+ | 一等公民插件支持 |
| **Webpack** | 4.0+ | Plugin + Loader |
| **Rsbuild** | 1.0+ | 一等公民插件支持 |
| **Rollup** | 2.0+ | 通过 Vite 插件 |
| **esbuild** | 0.14+ | 兼容 ESM/CJS 输出 |
| **tsup** | 6.0+ | 开箱即用 |

### 框架

| 框架 | 支持版本 | 集成方式 |
|------|---------|----------|
| **React** | 16.8+（Hooks） | `aemeath-js/react` — ErrorBoundary、Hooks |
| **Vue** | 3.0+ | `aemeath-js/vue` — Plugin、Composables |
| **Next.js** | 12+ | 通过 React 集成 |
| **Nuxt** | 3+ | 通过 Vue 集成 |
| **原生 JS / jQuery** | 任意 | 核心 API，无需额外导入 |

### 模块格式

| 格式 | 文件 | 用途 |
|------|------|------|
| **ESM** | `dist/index.js` | `import` — 现代打包工具 |
| **CJS** | `dist/index.cjs` | `require()` — Node.js、旧版打包工具 |
| **IIFE** | `dist/browser.global.js` | `<script>` 标签 — 无需构建工具 |

## 推荐搭配

如果你还需要 **会话录制和用户行为回放**，可以看看 [**sigillum-js**](https://github.com/TieriaSail/sigillum-js) —— 基于 rrweb 的轻量级会话录制库。

**aemeath-js**（日志 & 监控）+ **sigillum-js**（会话录制）= 完整的前端可观测性方案，所有数据都在你自己的服务器上。

## 反馈

欢迎提交 Issue 和功能建议！请到 [Issues](https://github.com/TieriaSail/aemeath-js/issues) 页面反馈。

## 许可证

[MIT](./LICENSE) © TieriaSail

