# 模块3：早期错误捕获

## 📋 示例列表

### 1. [basic.ts](./basic.ts) - 运行时配置

**在 Logger 初始化时添加插件**

```typescript
import { EarlyErrorCapturePlugin } from 'aemeath-js';

logger.use(
  new EarlyErrorCapturePlugin({
    enabled: true,
  }),
);
```

**功能**：

- ✅ 提取 `window.__EARLY_ERRORS__` 中的早期错误
- ✅ 统一上报到服务器

---

### 2. [with-build-plugin.ts](./with-build-plugin.ts) - 完整配置 ⭐

**构建时注入 + 运行时提取**

#### 步骤1：构建配置

```typescript
// rsbuild.config.ts
import { rsbuildPlugin } from 'aemeath-js/build-plugins';

export default defineConfig({
  plugins: [
    rsbuildPlugin({
      enabled: process.env.NODE_ENV === 'production',
      fallbackEndpoint: '/api/logs/early',
    }),
  ],
});
```

#### 步骤2：运行时配置

```typescript
// src/utils/logger.ts
import { EarlyErrorCapturePlugin } from 'aemeath-js';

logger.use(
  new EarlyErrorCapturePlugin({
    enabled: true,
  }),
);
```

**完成！** 现在可以捕获：

- ✅ 浏览器兼容性错误
- ✅ 资源加载失败
- ✅ Chunk 加载失败
- ✅ React 挂载前的所有错误

---

## 🔄 工作流程

```
页面加载：
  1. HTML 解析开始
  2. 💡 监控脚本注入（<head> 第一个）
  3. 开始监控错误
  4. 错误暂存到 window.__EARLY_ERRORS__

React/Vue 挂载：
  5. Logger 初始化
  6. EarlyErrorCapturePlugin 提取早期错误
  7. 统一上报到服务器

保底机制：
  8. 如果 Logger 10秒内没初始化
  9. 通过 fallbackEndpoint 上报
  10. 确保错误不丢失
```

---

## 🎯 适用场景

### 场景1：老旧浏览器兼容性检测

```javascript
// 捕获：
// - Syntax errors in old browsers
// - Polyfill missing
// - ES6+ features not supported
```

---

### 场景2：资源加载失败

```javascript
// 捕获：
// - CDN 资源加载失败
// - Chunk 加载失败
// - CSS/图片加载失败
```

---

### 场景3：Chunk 加载失败自动刷新

```typescript
// 在 EarlyErrorCapturePlugin 中已内置
// Chunk 加载失败会自动刷新一次页面
```

---

## 🛠️ fallbackEndpoint 后端示例

```javascript
// Node.js + Express
app.post('/api/logs/early', (req, res) => {
  const { errors, type, timestamp } = req.body;

  console.log('Early errors:', errors);

  // 保存到数据库
  await db.insert('early_errors', {
    errors: JSON.stringify(errors),
    type,
    timestamp,
    userAgent: req.headers['user-agent']
  });

  // 发送告警（可选）
  if (errors.some(e => e.type === 'resource-error')) {
    sendAlert('Resource loading failed!', { errors });
  }

  res.json({ success: true });
});
```

---

## 📖 更多文档

- [早期错误捕获-工程化方案](../../../../docs/logger/早期错误捕获-工程化方案.md)
- [fallbackEndpoint 简明指南](../../../../docs/logger/fallbackEndpoint简明指南.md)
- [集成到项目指南](../../../../docs/logger/集成到项目指南.md)
