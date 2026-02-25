# 模块3：Source Map 解析

## 🎯 核心功能

**将混淆的错误堆栈还原成可读的源代码位置**

```
混淆：at _0x3a2b (cdn.com/main.abc123.js:1:2345)
      ↓
还原：at calculateTotal (src/utils/cart.ts:23:15)
      > 23 |   return sum + item.price;
```

---

## 🚀 快速开始

### 基本用法

```typescript
import { createParser } from 'aemeath-js/parser';

// 业务层负责拼接完整路径（包含环境和版本）
const parser = createParser({
  sourceMapBaseUrl: 'https://example.com/sourcemaps/dist-test/1.1.1',
  debug: true, // 可选：输出调试日志
});

// 解析错误堆栈
const result = await parser.parse(errorStack);

// 输出解析结果
result.frames.forEach((frame) => {
  if (frame.resolved && frame.original) {
    console.log(`${frame.original.fileName}:${frame.original.line}`);
    if (frame.original.source) {
      console.log(frame.original.source); // 源代码片段
    }
  }
});
```

---

## 📚 API

### createParser(config)

创建 SourceMap 解析器实例。

```typescript
interface SourceMapParserConfig {
  /**
   * SourceMap 基础 URL（完整路径，包含环境和版本）
   *
   * 例如：https://example.com/sourcemaps/dist-test/1.1.3
   *
   * 解析时只拼接相对路径：{sourceMapBaseUrl}/{relativePath}.map
   */
  sourceMapBaseUrl: string;

  /**
   * 请求超时时间（毫秒）
   * @default 10000
   */
  timeout?: number;

  /**
   * 是否启用缓存
   * @default true
   */
  enableCache?: boolean;

  /**
   * 是否启用调试模式（输出详细日志）
   * @default false
   */
  debug?: boolean;
}
```

### parser.parse(stack)

解析错误堆栈字符串。

```typescript
const result = await parser.parse(stack);

interface ParseResult {
  message: string; // 错误消息
  stack: string; // 原始堆栈
  frames: ParsedStackFrame[]; // 解析后的堆栈帧
  success: boolean; // 是否成功
  error?: string; // 错误信息
}

interface ParsedStackFrame {
  raw: string; // 原始行
  minified?: {
    // 混淆后位置
    fileName: string;
    line: number;
    column: number;
  };
  original?: {
    // 原始位置（解析后）
    fileName: string;
    line: number;
    column: number;
    functionName: string | null;
    source?: string; // 源代码片段（带上下文）
  };
  resolved: boolean; // 是否成功解析
}
```

---

## 💡 业务层封装示例

将 SourceMap 解析封装成项目专用的辅助函数：

```typescript
// src/utils/sourcemap-helper.ts
import { createParser, SourceMapParser } from 'aemeath-js/parser';

const RESOURCE_BASE_URL =
  process.env.PUBLIC_RESOURCE_URL || 'https://example.com';
const SOURCEMAP_DIR = `${RESOURCE_BASE_URL}/sourcemaps`;
const DEBUG = process.env.PUBLIC_DEBUG === 'true';

// 按 env + version 缓存解析器
const parserCache = new Map<string, SourceMapParser>();

function getParser(env: string, version: string): SourceMapParser {
  const cacheKey = `${env}/${version}`;

  if (!parserCache.has(cacheKey)) {
    // 业务层拼接完整路径
    const sourceMapBaseUrl = `${SOURCEMAP_DIR}/${env}/${version}`;
    parserCache.set(
      cacheKey,
      createParser({
        sourceMapBaseUrl,
        debug: DEBUG,
      }),
    );
  }

  return parserCache.get(cacheKey)!;
}

/**
 * 解析错误堆栈
 */
export async function parseStack(
  stack: string,
  environment: 'test' | 'production',
  version: string,
) {
  const env = environment === 'production' ? 'dist' : 'dist-test';
  const parser = getParser(env, version);
  return parser.parse(stack);
}
```

---

## 🔍 解析效果

### 解析前（混淆）

```
Error: Cannot read property 'price' of undefined
    at _0x3a2b (https://cdn.example.com/main.abc123.js:1:2345)
    at _0x4b3c (https://cdn.example.com/main.abc123.js:1:5678)
```

### 解析后（清晰）

```
Error: Cannot read property 'price' of undefined
    at calculateTotal (src/utils/cart.ts:23:15)
    at updateCart (src/components/Cart.tsx:45:10)

源代码：
     21 | function calculateTotal(items) {
     22 |   return items.reduce((sum, item) => {
  >  23 |     return sum + item.price;  // ← 错误位置
     24 |   }, 0);
     25 | }
```

---

## 🔒 安全建议

1. **不要将 SourceMap 文件部署到公开 CDN**
2. 将 SourceMap 上传到单独的私有目录
3. 使用 `hidden-source-map` 模式（不在代码中添加注释）
4. 仅在内部管理系统中访问 SourceMap

---

## 📖 更多

- [错误捕获](./1-error-capture.md)
- [早期错误捕获](./2-early-error-capture.md)
- [上传插件](./4-upload-plugin.md)
