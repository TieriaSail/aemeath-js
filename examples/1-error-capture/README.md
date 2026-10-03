# 模块1：错误捕获

## 异常证据 / Error evidence

[with-evidence.ts](./with-evidence.ts) 展示如何将 catch 中的 unknown 交给 `normalizeCapturedError`，
以及读取 `getCaptureDiagnostics()`。自动捕获无需额外调用；文件仅导出函数，不会在导入时初始化 Logger。

[with-evidence.ts](./with-evidence.ts) normalizes unknown caught values and reads capture health.
Automatic capture needs no extra call. The file exports helpers without initializing Logger on import.

[中文 API](../../docs/zh/1-error-capture.md) · [English API](../../docs/en/1-error-capture.md)


## 📋 示例列表

### 1. [basic.ts](./basic.ts) - 基础使用

**最简单的配置，3行代码**

```typescript
import { AemeathLogger, ErrorCapturePlugin } from 'aemeath-js';

const logger = new AemeathLogger();
logger.use(new ErrorCapturePlugin());
```

**自动捕获**：

- ✅ 全局 JS 错误
- ✅ Promise 未处理错误
- ✅ 资源加载失败

---

### 2. [with-webview-enhanced.ts](./with-webview-enhanced.ts) - WebView 增强捕获

**在已覆盖的回调入口捕获原始异常，不保证消除所有 "Script error."**

```typescript
import { initAemeath } from 'aemeath-js';

initAemeath({
  upload: async (log) => { /* ... */ return { success: true }; },
  // browserApiErrors 默认启用
});
```

**覆盖场景**：

- ✅ addEventListener 回调中的错误
- ✅ setTimeout / setInterval 回调中的错误
- ✅ requestAnimationFrame 回调中的错误
- ✅ XMLHttpRequest 回调中的错误

---

### 3. [with-react.tsx](./with-react.tsx) - React ErrorBoundary

**在 React 中捕获组件错误**

```tsx
<ErrorBoundary>
  <YourApp />
</ErrorBoundary>
```

**特性**：

- ✅ 捕获组件渲染错误
- ✅ 自动记录到 logger
- ✅ 显示友好的错误界面

---

## 🚀 快速开始

```bash
# 复制到你的项目
cp examples/1-error-capture/basic.ts src/utils/logger.ts

# 在 App.tsx 中使用
import './utils/logger';
```

---

## 📖 更多文档

- [完整 API 文档](../../README.md)
- [错误捕获使用文档](../../docs/zh/1-error-capture.md)
