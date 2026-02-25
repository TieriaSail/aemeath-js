# 模块3：Source Map 解析

## 💡 核心理念

**将混淆的错误堆栈还原成可读的源代码位置**

```
混淆：at _0x3a2b (cdn.com/main.abc123.js:1:2345)
      ↓
还原：at calculateTotal (src/utils/cart.ts:23:15)
      > 23 |   return sum + item.price;
```

---

## 📋 示例列表

### 1. [basic.ts](./basic.ts) - 基础用法

**直接使用 SourceMap 解析器**

```typescript
import { createParser } from 'aemeath-js/parser';

// 业务层负责拼接完整路径
const parser = createParser({
  sourceMapBaseUrl: 'https://example.com/sourcemaps/dist-test/1.1.1',
  debug: true,
});

// 解析错误堆栈
const result = await parser.parse(errorStack);

result.frames.forEach((frame) => {
  if (frame.resolved && frame.original) {
    console.log(`${frame.original.fileName}:${frame.original.line}`);
    console.log(frame.original.source); // 源代码片段
  }
});
```

---

### 2. [with-build-config.ts](./with-build-config.ts) - 完整配置 ⭐

**从构建到使用的完整流程**

#### 步骤1：配置 SourceMap 生成

```typescript
// rsbuild.config.ts
export default defineConfig({
  output: {
    sourceMap:
      process.env.NODE_ENV === 'production'
        ? { js: 'hidden-source-map' } // 生产环境：隐藏 SourceMap
        : { js: 'cheap-module-source-map' }, // 开发环境
  },
});
```

#### 步骤2：上传 SourceMap 到私有目录

```typescript
// scripts/upload-sourcemaps.js
// 将 SourceMap 文件上传到 /sourcemaps/{env}/{version}/ 目录
```

#### 步骤3：业务层封装

```typescript
// src/utils/sourcemap-helper.ts
import { createParser } from 'aemeath-js/parser';

const SOURCEMAP_DIR = `${process.env.PUBLIC_RESOURCE_URL}/sourcemaps`;

export async function parseStack(stack, environment, version) {
  const env = environment === 'production' ? 'dist' : 'dist-test';
  const parser = createParser({
    sourceMapBaseUrl: `${SOURCEMAP_DIR}/${env}/${version}`,
  });
  return parser.parse(stack);
}
```

---

## 🎯 实际效果

### 解析前（无法定位）❌

```
Error: Cannot read property 'price' of undefined
    at _0x3a2b (https://cdn.example.com/main.abc123.js:1:2345)
    at _0x4b3c (https://cdn.example.com/main.abc123.js:1:5678)
```

### 解析后（清晰可见）✅

```
Error: Cannot read property 'price' of undefined
    at calculateTotal (src/utils/cart.ts:23:15)
    at updateCart (src/components/Cart.tsx:45:10)

Source code:
     21 | function calculateTotal(items) {
     22 |   return items.reduce((sum, item) => {
  >  23 |     return sum + item.price;  // ← 错误位置
     24 |   }, 0);
     25 | }
```

---

## 🔒 安全性

### ✅ 正确做法

1. SourceMap 上传到私有目录（不暴露在公开 CDN）
2. 只在内部管理系统中访问 SourceMap
3. 使用 `hidden-source-map`（不在代码中添加注释）

### ❌ 错误做法

1. 上传 SourceMap 到公开 CDN
2. 允许公开访问 \*.map 文件
3. 在代码中添加 sourceMappingURL 注释

---

## 📖 更多文档

- [Logger 完整文档](../../README.md)
- [UploadPlugin 文档](../../docs/zh/4-upload-plugin.md)
