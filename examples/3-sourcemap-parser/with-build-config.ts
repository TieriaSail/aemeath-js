/**
 * 模块3：Source Map 解析 - 构建配置
 *
 * 生成和管理 Source Map（含代码混淆场景）
 */

// ==================== 步骤1：构建配置 ====================

/*
// rsbuild.config.ts
import { defineConfig } from '@rsbuild/core';

export default defineConfig({
  output: {
    // 生产环境生成 hidden source map
    // hidden: 不在代码中添加 //# sourceMappingURL
    // 这样浏览器不会自动加载 source map
    sourceMap: process.env.NODE_ENV === 'production'
      ? { js: 'hidden-source-map', css: false }
      : { js: 'cheap-module-source-map', css: true }
  }
});
*/

// ==================== 步骤2：保存 Source Map ====================

/*
构建后的文件结构：

dist/
├── index.html
├── static/
│   ├── js/
│   │   ├── main.abc123.js          # 混淆后的代码
│   │   └── main.abc123.js.map      # Source Map
│   └── css/
│       └── main.abc123.css

⚠️ 重要：
- main.abc123.js 部署到 CDN
- main.abc123.js.map 保存到安全位置（不部署）
*/

// 自动化脚本：scripts/save-sourcemaps.sh
/*
#!/bin/bash

# 获取版本号
VERSION=$(node -p "require('./package.json').version")

# 创建版本目录
SOURCEMAP_DIR="./sourcemaps/$VERSION"
mkdir -p "$SOURCEMAP_DIR"

# 复制 source map 文件
find dist/static -name "*.map" -exec cp {} "$SOURCEMAP_DIR/" \;

# 从 dist 中删除（不部署到 CDN）
find dist -name "*.map" -delete

echo "✅ Source maps saved to $SOURCEMAP_DIR"
echo "❌ Source maps removed from dist/"
*/

// package.json
/*
{
  "scripts": {
    "build": "rsbuild build",
    "postbuild": "bash scripts/save-sourcemaps.sh"
  }
}
*/

// ==================== 步骤3：提供 Source Map 访问（开发环境）====================

/*
方式1：本地静态服务器

# 启动一个简单的静态服务器
npx serve sourcemaps -p 8080

# 然后在分析器中使用
sourceMaps: 'http://localhost:8080/1.0.0'
*/

/*
方式2：集成到开发服务器

// rsbuild.config.ts
export default defineConfig({
  dev: {
    setupMiddlewares: [
      (middlewares, server) => {
        middlewares.push({
          name: 'sourcemaps',
          path: '/sourcemaps',
          middleware: (req, res, next) => {
            const fs = require('fs');
            const path = require('path');
            
            const filePath = path.join(__dirname, 'sourcemaps', req.url);
            
            if (fs.existsSync(filePath)) {
              res.setHeader('Content-Type', 'application/json');
              res.end(fs.readFileSync(filePath));
            } else {
              res.status(404).end('Not found');
            }
          }
        });
        
        return middlewares;
      }
    ]
  }
});

// 然后使用
sourceMaps: '/sourcemaps/1.0.0'
*/

// ==================== 步骤4：开发环境使用 ====================

// src/utils/sourcemap-helper.ts
import { createParser } from 'aemeath-js/parser';
import type { SourceMapParser } from 'aemeath-js/parser';

const RESOURCE_BASE_URL =
  process.env['PUBLIC_RESOURCE_URL'] || 'https://example.com';
const SOURCEMAP_DIR = `${RESOURCE_BASE_URL}/sourcemaps`;

const parserCache = new Map<string, SourceMapParser>();

function getParser(env: string, version: string): SourceMapParser {
  const cacheKey = `${env}/${version}`;
  if (!parserCache.has(cacheKey)) {
    parserCache.set(
      cacheKey,
      createParser({
        sourceMapBaseUrl: `${SOURCEMAP_DIR}/${env}/${version}`,
        debug: process.env.NODE_ENV === 'development',
      }),
    );
  }
  return parserCache.get(cacheKey)!;
}

export async function parseErrorStack(
  stack: string,
  environment: 'test' | 'production',
  version: string,
) {
  const env = environment === 'production' ? 'dist' : 'dist-test';
  const parser = getParser(env, version);
  const result = await parser.parse(stack);

  result.frames.forEach((frame) => {
    if (frame.resolved && frame.original) {
      console.log(`${frame.original.fileName}:${frame.original.line}`);
      if (frame.original.source) {
        console.log(frame.original.source);
      }
    }
  });

  return result;
}

// ==================== 目录结构 ====================

/*
project-root/
├── dist/                    # 构建产物（部署到 CDN）
│   └── static/
│       └── js/
│           └── main.abc123.js  # 无 .map 文件
│
├── sourcemaps/              # Source Map 存储（本地/内部服务器）
│   ├── 1.0.0/
│   │   ├── main.abc123.js.map
│   │   └── chunk.def456.js.map
│   ├── 1.0.1/
│   │   └── ...
│   └── ...
│
└── scripts/
    └── save-sourcemaps.sh   # 自动化脚本
*/

// ==================== 安全考虑 ====================

/*
✅ 正确做法：
- Source Map 保存在本地或内部服务器
- 只在开发环境提供访问
- 生产环境不暴露 Source Map

❌ 错误做法：
- 上传 Source Map 到 CDN
- 允许公开访问 /static/*.map
- 在代码中添加 sourceMappingURL 注释
*/

// ==================== 步骤5：代码混淆配置 ====================

/*
⚠️ 混淆 ≠ 压缩

压缩（Terser/SWC）：缩短变量名、去空格，构建工具自动生成 SourceMap
混淆（javascript-obfuscator）：控制流扁平化、死代码注入等，需显式配置才能合并上游 SourceMap

多层 SourceMap 合并流程：
  TS 源码 → [tsc/SWC] → JS → [Terser 压缩] → SourceMap A
  压缩后代码 → [obfuscator] → SourceMap B（合并 A）→ 最终 SourceMap
*/

/*
// rsbuild.config.ts - 混淆配置
import WebpackObfuscator from 'webpack-obfuscator';

// 在 tools.rspack 回调中（仅生产环境）：
if (isProd) {
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
        sourceMapMode: 'separate', // 必须设为 separate
      },
      // 排除 aemeath-js chunk 不被混淆
      ['**/lib-logger*'],
    ),

    // Rspack SourceMap chain 修复插件
    // Rspack native SourceMapDevToolPlugin 会覆盖 obfuscator 合并后的 SourceMap
    // 此插件在 obfuscator 之后捕获合并 map，在 Rspack 生成 .map 后替换回去
    new ObfuscatorSourceMapRspackPlugin(),
  );
}

// 需要额外安装：npm install obfuscator-sourcemap-rspack-plugin --save-dev
// import { ObfuscatorSourceMapRspackPlugin } from 'obfuscator-sourcemap-rspack-plugin';
// 仅 Rspack/Rsbuild 需要此插件，传统 webpack 和 Vite 不需要
*/

/*
// splitChunks - 将 aemeath-js 打包为独立 chunk
// aemeath-js 不能被混淆，否则堆栈解析和插件系统会被破坏
performance: {
  chunkSplit: {
    strategy: 'custom',
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
  },
}
*/

/*
// Vite 场景使用 rollup-obfuscator
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
*/

// ==================== 步骤6：混淆后 SourceMap 解析 ====================

import { createParser as createParser2 } from 'aemeath-js/parser';

async function verifyObfuscatedSourceMap() {
  const parser = createParser2({
    sourceMapBaseUrl: 'http://localhost:8080/sourcemaps/dist/1.0.0',
    debug: true,
  });

  const obfuscatedStack = `Error: Cannot read property 'price' of undefined
    at _0x3a2b (https://cdn.example.com/static/js/main.abc123.js:1:2345)
    at _0x4b3c (https://cdn.example.com/static/js/main.abc123.js:1:5678)`;

  const result = await parser.parse(obfuscatedStack);

  result.frames.forEach((frame, i) => {
    if (frame.resolved && frame.original) {
      console.log(
        `✅ Frame ${i + 1}: ${frame.original.fileName}:${frame.original.line}`,
      );
    } else {
      console.log(`❌ Frame ${i + 1}: Unresolved - ${frame.raw}`);
    }
  });
}

/*
混淆后的构建产物目录结构：

dist/static/js/
├── main.abc123.js            # 混淆后的代码
├── main.abc123.js.map        # SourceMap（含合并的混淆映射，构建后移走）
├── lib-logger.xyz789.js      # Logger chunk（未混淆，仅压缩）
└── lib-logger.xyz789.js.map

混淆强度 vs 性能参考：
  仅标识符重命名        → 体积 +5%，几乎无性能影响
  + stringArray         → 体积 +15-20%，轻微
  + controlFlowFlattening(0.3) → 体积 +30-40%，中等
  + deadCodeInjection(0.1)     → 体积 +10-15%，轻微
  全部开满              → 体积 +80-100%，显著
*/

console.log('✅ Build configuration ready!');
console.log('📝 See comments above for detailed setup');

verifyObfuscatedSourceMap().catch(console.error);
