# 快速开始

> [English](./QUICK_START.md)

## 选择你的项目类型

---

### 📄 非工程化项目（jQuery / 原生 JS / 静态页面）

**无需 npm、无需构建工具，直接用 `<script>` 标签引入：**

```html
<!DOCTYPE html>
<html>
<head>
  <!-- 1. 早期错误捕获（可选，放最前面） -->
  <script src="https://unpkg.com/aemeath-js/scripts/early-error.js"></script>

  <!-- 2. 核心库 (~24KB) -->
  <script src="https://unpkg.com/aemeath-js/dist/browser.global.js"></script>
</head>
<body>
  <script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
  <script>
    // 3. 初始化
    AemeathJs.init({
      upload: function(log) {
        // 上报到服务器
        $.post('/api/logs', log);
        // 或者用原生 fetch
        // fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
      }
    });

    // 4. 使用
    var logger = AemeathJs.getAemeath();
    logger.info('页面加载完成');

    // jQuery 示例
    $('#myButton').click(function() {
      logger.info('按钮被点击', { buttonId: 'myButton' });
    });

    // 捕获错误
    try {
      riskyOperation();
    } catch (e) {
      logger.error('操作失败', { error: e.message });
    }
  </script>
</body>
</html>
```

**浏览器 API：**

```javascript
// 初始化
AemeathJs.init({
  upload: function(log) { /* ... */ },  // 上报函数
  errorCapture: true,                    // 自动捕获错误（默认 true）
  safeGuard: true,                       // 安全保护（默认 true）
  enableConsole: true,                   // 控制台输出（默认 true）
  level: 'info'                          // 日志级别：debug/info/warn/error
});

// 获取 Logger 实例
var logger = AemeathJs.getAemeath();

// 记录日志
logger.debug('调试信息');
logger.info('普通信息');
logger.warn('警告信息');
logger.error('错误信息');
```

**CDN 地址：**

| CDN | URL |
|-----|-----|
| unpkg | `https://unpkg.com/aemeath-js/dist/browser.global.js` |
| jsDelivr | `https://cdn.jsdelivr.net/npm/aemeath-js/dist/browser.global.js` |

---

### 📦 工程化项目（Vite / Webpack / Rsbuild）

**安装：**

```bash
npm install aemeath-js
```

#### 方式一：单例模式（推荐）⭐

**初始化一次，全局使用**

```typescript
// src/main.ts - 初始化一次
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
// src/anywhere.ts - 任何地方使用
import { getAemeath } from 'aemeath-js';

const logger = getAemeath();
logger.info('Hello World'); // context 自动附加

// 动态更新上下文
logger.updateContext({ userId: '67890' });
```

✅ 优点：
- 初始化一次，全局使用
- 按需配置，不强制捆绑
- 最简单

---

#### 方式二：手动组装（完全自定义）

**自己组装，完全控制**

```typescript
import { AemeathLogger, ErrorCapturePlugin, UploadPlugin } from 'aemeath-js';

const logger = new AemeathLogger();

// 只需要错误捕获？只加这个
logger.use(new ErrorCapturePlugin());

// 需要上报？再加这个
logger.use(new UploadPlugin({
  onUpload: async (log) => {
    await fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
    return { success: true };
  },
}));
```

✅ 优点：
- 完全自定义
- 按需加载，体积最小

---

## 📦 插件概览

| 插件 | 说明 | 体积 | 是否必需 |
|------|------|------|----------|
| **ErrorCapturePlugin** | 捕获全局错误 | ~3KB | 推荐 |
| **EarlyErrorCapturePlugin** | React/Vue 挂载前的错误 | +3KB | 可选 |
| **UploadPlugin** | 发送到服务器 | +5KB | 可选 |
| **SourceMap Parser** | 解析混淆堆栈 | +6KB | 可选 |
| **PerformancePlugin** | Web Vitals 监控 | +4KB | 可选 |
| **SafeGuardPlugin** | 防止 Logger 崩溃 | +3KB | 生产推荐 |

**按需加载示例：**

```typescript
// 只要错误捕获（3KB）
initAemeath({ errorCapture: true });

// 错误 + 上报（8KB）
initAemeath({
  errorCapture: true,
  upload: async (log) => { /* ... */ },
});

// 错误 + 性能监控（7KB）
import { getAemeath } from 'aemeath-js';
import { PerformancePlugin } from 'aemeath-js';

initAemeath({ errorCapture: true });
getAemeath().use(new PerformancePlugin({
  monitorWebVitals: true,
  sampleRate: 0.1,
}));
```

---

## 🔧 构建配置（可选）

### 早期错误捕获（需要构建插件）

根据你的构建工具选择对应的插件：

**Vite：**

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

**Webpack (4.0+)：**

```javascript
// webpack.config.js
const { AemeathEarlyErrorWebpackPlugin } = require('aemeath-js/build-plugins/webpack');

module.exports = {
  plugins: [
    new AemeathEarlyErrorWebpackPlugin({
      enabled: process.env.NODE_ENV === 'production',
      // mode: 'auto' - 自动检测，有 html-webpack-plugin 则注入，否则输出文件
      // mode: 'file' - 强制输出独立文件（不需要 html-webpack-plugin）
    }),
  ],
};
```

> 💡 **提示**：默认 `mode: 'auto'`，如果没有 html-webpack-plugin，会输出 `aemeath-early-error.js` 文件。

**Rsbuild：**

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

> ⚠️ **注意**：Webpack 3 不支持。Webpack 4+ 需要配合 html-webpack-plugin 4+ 使用 inject 模式。

### SourceMap 上传（可选）

**Vite：**

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

**Webpack：**

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

**Rsbuild：**

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

### SourceMap 解析（可选）

```typescript
import { createParser } from 'aemeath-js/parser';

const parser = createParser({
  sourceMapBaseUrl: 'https://cdn.example.com/sourcemaps/dist/1.0.0',
});

const result = await parser.parse(errorStack);
```

### 性能监控（可选）

```typescript
import { getAemeath } from 'aemeath-js';
import { PerformancePlugin } from 'aemeath-js';

initAemeath({ errorCapture: true });
getAemeath().use(new PerformancePlugin({
  monitorWebVitals: true,     // 监控 LCP, FID, CLS, FCP, TTFB
  monitorResources: false,    // 监控慢资源（可选）
  monitorLongTasks: true,     // 监控长任务（可选）
  longTaskThreshold: 50,      // 长任务阈值（ms）
  sampleRate: 0.1,            // 10% 采样率（生产环境推荐）
}));

// 自定义性能测量
const logger = getAemeath();
logger.startMark('data-fetch');
const data = await fetchData();
const duration = logger.endMark('data-fetch');
console.log(`数据获取耗时: ${duration}ms`);
```

### 网络监控（默认启用）

自动监控 fetch 和 XMLHttpRequest 请求，默认排除大资源文件（mp3/mp4/png/jpg等）的慢请求检测。

```typescript
initAemeath({
  network: {
    logTypes: ['error', 'slow'],  // 只记录错误和慢请求
    slowThreshold: 5000,          // 慢请求阈值：5秒
  },
});

// 自定义排除列表：只排除音频，监控图片
initAemeath({
  network: {
    slowRequestExcludePatterns: ['.mp3', '.wav', '.ogg', '.m4a', '.mp4'],
  },
});

// 监控所有资源（包括大文件）
initAemeath({
  network: {
    monitorAllSlowRequests: true,
  },
});
```

---

## 🌐 框架集成（可选）

核心库与框架无关，可在任何 JavaScript 环境中使用。针对特定框架提供了可选的集成包。

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
  logger.info('组件已挂载');
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
logger.info('组件初始化');
</script>
```

### 原生 JS / jQuery（工程化项目）

```javascript
import { initAemeath, getAemeath } from 'aemeath-js';

initAemeath({ errorCapture: true });

const logger = getAemeath();
logger.info('页面加载完成');

// jQuery 中使用
$('#btn').click(() => logger.info('按钮被点击'));
```

> 💡 **非工程化项目？** 请查看本文档开头的 `<script>` 标签引入方式。

---

## 🎯 不同场景的推荐配置

### 开发环境：只捕获错误

```typescript
initAemeath({
  errorCapture: true,
});
// 体积：3KB
```

### 生产环境：完整配置

```typescript
initAemeath({
  errorCapture: true,
  upload: async (log) => {
    await fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
    return { success: true };
  },
});
// 体积：8KB
```

---

## 📚 更多文档

- [完整 API 文档](./README.zh_CN.md)
- [错误捕获](./docs/zh/1-error-capture.md)
- [早期错误捕获](./docs/zh/2-early-error-capture.md)
- [SourceMap 解析](./docs/zh/3-sourcemap-parser.md)
- [上报插件](./docs/zh/4-upload-plugin.md)
- [性能监控](./docs/zh/6-performance-monitoring.md)
- [示例代码](./examples/)

