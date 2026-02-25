/**
 * 模块3：Source Map 解析 - 基础示例
 *
 * 使用 SourceMap 解析混淆后的错误堆栈
 */

import { createParser } from 'aemeath-js/parser';

// ==================== 基本用法 ====================

async function basicExample() {
  // 业务层负责拼接完整路径（包含环境和版本）
  const parser = createParser({
    sourceMapBaseUrl: 'https://example.com/sourcemaps/dist-test/1.1.1',
    debug: true, // 输出调试日志
  });

  // 模拟错误堆栈
  const errorStack = `Error: Cannot read property 'price' of undefined
    at calculateTotal (https://example.com/dist-test/1.1.1/static/js/main.abc123.js:1:2345)
    at updateCart (https://example.com/dist-test/1.1.1/static/js/main.abc123.js:1:5678)`;

  // 解析堆栈
  const result = await parser.parse(errorStack);

  console.log('解析结果:', result);

  // 遍历解析后的帧
  result.frames.forEach((frame, index) => {
    if (frame.resolved && frame.original) {
      console.log(`帧 ${index + 1}:`);
      console.log(`  文件: ${frame.original.fileName}`);
      console.log(`  位置: ${frame.original.line}:${frame.original.column}`);
      console.log(`  函数: ${frame.original.functionName || '(anonymous)'}`);

      if (frame.original.source) {
        console.log(`  源码:\n${frame.original.source}`);
      }
    }
  });
}

// ==================== 业务层封装示例 ====================

/**
 * 推荐的业务层封装方式
 *
 * 将 logger-modular 库的通用能力与业务配置分离
 */

import type { SourceMapParser, ParseResult } from 'aemeath-js/parser';

const RESOURCE_BASE_URL =
  process.env['PUBLIC_RESOURCE_URL'] || 'https://example.com';
const SOURCEMAP_DIR = `${RESOURCE_BASE_URL}/sourcemaps`;
const DEBUG = process.env['PUBLIC_DEBUG'] === 'true';

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
 * 解析错误堆栈（业务层封装）
 */
export async function parseStack(
  stack: string,
  environment: 'test' | 'production',
  version: string,
): Promise<ParseResult> {
  // 业务逻辑：环境映射
  const env = environment === 'production' ? 'dist' : 'dist-test';

  // 获取对应的解析器
  const parser = getParser(env, version);

  // 库层：纯粹解析
  return parser.parse(stack);
}

// ==================== 效果对比 ====================

/*
解析前（混淆）：
  Error: Cannot read property 'price' of undefined
      at _0x3a2b (https://cdn.example.com/main.abc123.js:1:2345)
      at _0x4b3c (https://cdn.example.com/main.abc123.js:1:5678)

解析后（清晰）：
  Error: Cannot read property 'price' of undefined
      at calculateTotal (src/utils/cart.ts:23:15)
      at updateCart (src/components/Cart.tsx:45:10)
      
      21 | function calculateTotal(items) {
      22 |   return items.reduce((sum, item) => {
    > 23 |     return sum + item.price;  // ← 错误位置
      24 |   }, 0);
      25 | }
*/

// 运行示例
basicExample().catch(console.error);
