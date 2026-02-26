/**
 * 模块4：Source Map 解析 - 构建配置
 *
 * 生成和管理 Source Map
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

console.log('✅ Build configuration ready!');
console.log('📝 See comments above for detailed setup');
