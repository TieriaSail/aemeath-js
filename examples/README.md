# Logger 示例代码

## 📚 按模块浏览

### [模块0：浏览器直接使用](./0-browser-usage/) 🌐

**无需构建工具**，适用于 jQuery、原生 JS、静态页面

**示例**：

- [basic.html](./0-browser-usage/basic.html) - 基础用法
- [jquery.html](./0-browser-usage/jquery.html) - jQuery 集成

**快速开始**：

```html
<script src="https://unpkg.com/aemeath-js/scripts/early-error.js"></script>
<script src="https://unpkg.com/aemeath-js/dist/aemeath-js.global.js"></script>
<script>
  AemeathJs.init({
    upload: function(log) {
      fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
    }
  });
  
  var logger = AemeathJs.getAemeath();
  logger.info('Hello World');
</script>
```

---

### [模块1：错误捕获](./1-error-capture/) 🐛

捕获全局错误、Promise错误、资源加载失败

**示例**：

- [basic.ts](./1-error-capture/basic.ts) - 基础使用（3行代码）
- [with-react.tsx](./1-error-capture/with-react.tsx) - React ErrorBoundary

**快速开始**：

```typescript
import { AemeathLogger, ErrorCapturePlugin } from 'aemeath-js';

const logger = new AemeathLogger();
logger.use(new ErrorCapturePlugin());
```

---

### [模块2：早期错误捕获](./2-early-error-capture/) ⚡

在 React/Vue 挂载前捕获错误

**示例**：

- [basic.ts](./2-early-error-capture/basic.ts) - 运行时配置
- [with-build-plugin.ts](./2-early-error-capture/with-build-plugin.ts) - 完整配置 ⭐

**快速开始**：

```typescript
// Vite: vite.config.ts
import { ameathEarlyErrorPlugin } from 'aemeath-js/build-plugins/vite';
plugins: [ameathEarlyErrorPlugin({ enabled: true })];

// Webpack: webpack.config.js
const { AemeathEarlyErrorWebpackPlugin } = require('aemeath-js/build-plugins/webpack');
plugins: [new AemeathEarlyErrorWebpackPlugin({ enabled: true })];

// Rsbuild: rsbuild.config.ts
import { ameathEarlyErrorPlugin } from 'aemeath-js/build-plugins/rsbuild';
plugins: [ameathEarlyErrorPlugin({ enabled: true })];

// 运行时配置
import { EarlyErrorCapturePlugin } from 'aemeath-js';
logger.use(new EarlyErrorCapturePlugin());
```

---

### [模块3：Source Map 解析](./3-sourcemap-parser/) 🔐

解析混淆的错误堆栈

**示例**：

- [basic.ts](./3-sourcemap-parser/basic.ts) - 浏览器控制台使用
- [with-build-config.ts](./3-sourcemap-parser/with-build-config.ts) - 完整配置 ⭐

**快速开始**：

```typescript
import { createParser } from 'aemeath-js/parser';

const parser = createParser({
  sourceMapBaseUrl: 'https://example.com/sourcemaps/dist/1.0.0',
});

const result = await parser.parse(
  `Error: Cannot read property 'price' of undefined
    at _0x3a2b (https://example.com/static/js/main.abc123.js:1:2345)`
);

result.frames.forEach((frame) => {
  if (frame.resolved && frame.original) {
    console.log(`${frame.original.fileName}:${frame.original.line}`);
  }
});
```

---

### [模块4：上传插件](./4-upload-plugin/) 📤

上传日志到服务器

**示例**：

- [basic.ts](./4-upload-plugin/basic.ts) - 基础上传
- [with-auth.ts](./4-upload-plugin/with-auth.ts) - 带认证
- [with-axios.ts](./4-upload-plugin/with-axios.ts) - 使用 Axios
- [advanced.ts](./4-upload-plugin/advanced.ts) - 高级配置 ⭐

**快速开始**：

```typescript
import { UploadPlugin } from 'aemeath-js';

logger.use(
  new UploadPlugin({
    onUpload: async (log) => {
      const res = await fetch('/api/logs', {
        method: 'POST',
        body: JSON.stringify(log),
      });
      return { success: res.ok };
    },
  }),
);
```

---

### [模块5：性能监控](./5-performance-plugin/) 🧪

> 实验性功能 — 详见 [性能监控插件文档](../docs/zh/6-performance-monitoring.md)

- [basic.ts](./5-performance-plugin/basic.ts) - 基础使用
- [custom-measurement.ts](./5-performance-plugin/custom-measurement.ts) - 自定义测量

---

### [模块6：安全保护](./6-safeguard-plugin/) 🛡️

防止 Logger 崩溃应用

**示例**：

- [basic.ts](./6-safeguard-plugin/basic.ts) - 基础使用
- [production-config.ts](./6-safeguard-plugin/production-config.ts) - 生产配置 ⭐

**快速开始**：

```typescript
import { SafeGuardPlugin } from 'aemeath-js';

logger.use(
  new SafeGuardPlugin({
    maxErrors: 100,
    rateLimit: 100,
  }),
);
```

---

### [模块7：多平台](./7-multi-platform/) 📱

支持浏览器、微信/支付宝小程序、Taro、uni-app 及自定义适配器

**快速开始**：

```typescript
// 浏览器（默认）
import { initAemeath, getAemeath } from 'aemeath-js';
initAemeath({ upload: async (log) => ({ success: true }) });
const logger = getAemeath();

// 微信小程序
import { createMiniAppAdapter } from 'aemeath-js/platform/miniapp';
const platform = createMiniAppAdapter('wechat', wx);
initAemeath({ platform, upload: async (log) => ({ success: true }) });
```

---

### [推荐配置](./recommended-config.ts) ⭐

完整的生产环境配置示例

---

### [全局上下文示例](./context-demo.ts) 🎯

如何配置全局上下文（userId, deviceId, appVersion 等）

**示例**：

- [context-demo.ts](./context-demo.ts) - 完整的全局上下文使用示例

**快速开始**：

```typescript
import { initAemeath, getAemeath } from 'aemeath-js';

// 初始化时配置全局上下文
initAemeath({
  context: {
    userId: '12345',
    deviceId: 'abc-def',
    appVersion: '1.0.0',
    platform: 'iOS',
  },
});

// 使用时自动附加
const logger = getAemeath();
logger.info('User action'); // context 自动附加

// 动态更新
logger.updateContext('userId', '67890');
```

---

## 🎯 按场景选择

### 我只想捕获错误

→ [模块1](./1-error-capture/)

### 我想上报到服务器

→ [模块1](./1-error-capture/) + [模块4](./4-upload-plugin/)

### 我想捕获页面加载时的错误

→ [模块2](./2-early-error-capture/)

### 我想解析混淆的错误

→ [模块3](./3-sourcemap-parser/)

### 我想要完整的生产环境方案

→ [推荐配置](./recommended-config.ts) ⭐

### 我需要在小程序 / Taro / uni-app 中使用

→ [模块7：多平台](./7-multi-platform/)

---

## 💡 推荐配置

### 单例模式（最简单）

```typescript
// src/main.ts
import { initAemeath } from 'aemeath-js';

initAemeath({
  errorCapture: true,
  upload: async (log) => {
    const res = await fetch('/api/logs', {
      method: 'POST',
      body: JSON.stringify(log),
    });
    return { success: res.ok };
  },
});

// src/anywhere.ts
import { getAemeath } from 'aemeath-js';

const logger = getAemeath();
logger.info('Hello World');
```

---

## 📖 更多文档

- [快速开始](../QUICK_START.md)
- [完整 API 文档](../README.md)
