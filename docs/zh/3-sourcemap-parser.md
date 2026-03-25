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
   * 最大缓存数量（LRU 淘汰策略）
   * @default 50
   */
  maxCacheSize?: number;

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
    functionName?: string;
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

## 代码混淆

使用代码混淆（如 `javascript-obfuscator` / `webpack-obfuscator`）时，SourceMap 链路需要额外配置。

**压缩 vs. 混淆**

| | 压缩（Minification） | 混淆（Obfuscation） |
|---|---|---|
| 目的 | 减小体积 | 保护代码逻辑 |
| 手段 | 缩短变量名、去空格 | 控制流扁平化、死代码注入 |
| 工具 | Terser / SWC / esbuild | javascript-obfuscator / webpack-obfuscator |
| SourceMap | 构建工具自动生成 | 需要额外配置以合并上游 SourceMap |

aemeath-js 的 SourceMap 解析器同时支持两种场景——只要最终产物有正确的 SourceMap，就能还原到原始源码。

### 多层 SourceMap 合并

同时使用压缩 + 混淆时：

```
TypeScript 源码
    ↓ [tsc / SWC / Babel]
JavaScript
    ↓ [Terser / SWC 压缩]       → SourceMap A
压缩后的代码
    ↓ [javascript-obfuscator]   → SourceMap B（合并 A）
最终产物 + 最终 SourceMap
```

混淆器必须正确合并上游 SourceMap，否则最终的 `.map` 文件无法映射回原始源码。

### 构建配置

#### Rsbuild + webpack-obfuscator

```typescript
// rsbuild.config.ts
import WebpackObfuscator from 'webpack-obfuscator';

// 在 tools.rspack 回调中（仅生产环境）：
config.plugins?.push(
  new WebpackObfuscator(
    {
      rotateStringArray: true,
      stringArray: true,
      stringArrayThreshold: 0.75,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 0.3,
      deadCodeInjection: true,
      deadCodeInjectionThreshold: 0.1,
      identifierNamesGenerator: 'hexadecimal',
      sourceMap: true,           // 必须开启
      sourceMapMode: 'separate', // 必须开启
    },
    ['**/lib-logger*'],          // 排除 aemeath-js chunk
  ),
);
```

> **Rspack SourceMap Chain 断裂问题**：Rspack 的 native `SourceMapDevToolPlugin` 可能会覆盖 `webpack-obfuscator` 合并后的 SourceMap，导致 SourceMap 解析完全失效。如果你遇到此问题（错误位置返回 `null`），请安装 [obfuscator-sourcemap-rspack-plugin](https://github.com/TieriaSail/obfuscator-sourcemap-rspack-plugin)：
>
> ```bash
> npm install obfuscator-sourcemap-rspack-plugin --save-dev
> ```
>
> 在 `webpack-obfuscator` **之后**添加：
>
> ```typescript
> import { ObfuscatorSourceMapRspackPlugin } from 'obfuscator-sourcemap-rspack-plugin';
>
> config.plugins?.push(
>   new WebpackObfuscator({ sourceMap: true, sourceMapMode: 'separate', /* ... */ }, excludes),
>   new ObfuscatorSourceMapRspackPlugin(),
> );
> ```
>
> 此问题**不影响**传统 webpack 或 Vite，仅在 Rspack/Rsbuild 中出现。

#### Webpack + webpack-obfuscator

```javascript
// webpack.config.js
new WebpackObfuscator(
  {
    rotateStringArray: true,
    stringArray: true,
    controlFlowFlattening: true,
    deadCodeInjection: true,
    identifierNamesGenerator: 'hexadecimal',
    sourceMap: true,
    sourceMapMode: 'separate',
  },
  ['**/lib-logger*'],
);
```

#### Vite + rollup-obfuscator

```typescript
// vite.config.ts
import obfuscatorPlugin from 'rollup-obfuscator';

export default defineConfig({
  build: { sourcemap: 'hidden' },
  plugins: [
    obfuscatorPlugin({
      rotateStringArray: true,
      stringArray: true,
      controlFlowFlattening: true,
      deadCodeInjection: true,
      identifierNamesGenerator: 'hexadecimal',
      sourceMap: true,
      sourceMapMode: 'separate',
    }),
  ],
});
```

### 排除 aemeath-js 不被混淆

aemeath-js 不应被混淆——混淆会破坏其基于正则的堆栈解析和插件系统。将其打包为独立 chunk 并排除：

```typescript
// splitChunks 配置
optimization: {
  splitChunks: {
    cacheGroups: {
      logger: {
        test: /[\\/](node_modules[\\/]aemeath-js[\\/]|src[\\/]utils[\\/](logger-config|sourcemap-helper|logger\.ts))/,
        name: 'lib-logger',
        chunks: 'all',
        priority: 30,
      },
    },
  },
}

// 然后在混淆器中排除
new WebpackObfuscator({ /* ... */ }, ['**/lib-logger*']);
```

### 混淆强度与性能平衡

| 配置 | 体积增幅 | 性能影响 |
|---|---|---|
| 仅标识符重命名 | ~5% | 几乎无 |
| + 字符串数组 | ~15-20% | 轻微 |
| + 控制流扁平化（0.3） | ~30-40% | 中等 |
| + 死代码注入（0.1） | ~10-15% | 轻微 |
| 全部开满 | ~80-100% | 显著 |

### 构建后验证 SourceMap

```bash
# 检查 .map 文件是否存在
ls dist/static/js/*.map

# 验证 sources 字段
cat dist/static/js/main.*.js.map | python3 -m json.tool | head -20
# 应包含类似 "src/utils/cart.ts" 的路径
```

或使用解析器编程验证：

```typescript
import { createParser } from 'aemeath-js/parser';

const parser = createParser({
  sourceMapBaseUrl: 'http://localhost:8080/sourcemaps/dist/1.0.0',
  debug: true,
});

const result = await parser.parse(capturedErrorStack);
result.frames.forEach((frame) => {
  if (frame.resolved && frame.original) {
    console.log(`✅ ${frame.original.fileName}:${frame.original.line}`);
  } else {
    console.log(`❌ 解析失败: ${frame.raw}`);
  }
});
```

---

## 📖 更多

- [错误捕获](./1-error-capture.md)
- [早期错误捕获](./2-early-error-capture.md)
- [上传插件](./4-upload-plugin.md)
