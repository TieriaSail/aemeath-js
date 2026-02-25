# 模块1：错误捕获

## 📋 示例列表

### 1. [basic.ts](./basic.ts) - 基础使用

**最简单的配置，3行代码**

```typescript
import { Logger, ErrorCapturePlugin } from 'aemeath-js';

const logger = new Logger();
logger.use(new ErrorCapturePlugin());
```

**自动捕获**：

- ✅ 全局 JS 错误
- ✅ Promise 未处理错误
- ✅ 资源加载失败

---

### 2. [with-react.tsx](./with-react.tsx) - React ErrorBoundary

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
- [错误捕获最佳实践](../../../docs/logger/日志策略最佳实践.md)
