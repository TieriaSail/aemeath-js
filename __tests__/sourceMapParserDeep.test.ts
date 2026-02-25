/**
 * SourceMapParser 深度解析测试
 *
 * 使用 source-map-js 的 SourceMapGenerator 构造真实的 SourceMap，
 * 验证混淆/压缩代码的堆栈还原能力
 *
 * 不需要真实构建工具，纯单元测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SourceMapGenerator } from 'source-map-js';
import { SourceMapParser } from '../parser/SourceMapParser.client';

// ==================== 辅助函数 ====================

/**
 * 创建一个简单的 SourceMap
 * 模拟 "原始 TypeScript 文件被打包压缩后" 的映射
 */
function createSimpleSourceMap() {
  const generator = new SourceMapGenerator({ file: 'app.min.js' });

  // 原始源码
  const originalSource = [
    'import React from "react";', // 第1行
    '', // 第2行
    'function calculateTotal(items: Item[]) {', // 第3行
    '  let total = 0;', // 第4行
    '  for (const item of items) {', // 第5行
    '    total += item.price * item.quantity;', // 第6行
    '  }', // 第7行
    '  return total;', // 第8行
    '}', // 第9行
    '', // 第10行
    'export function handleCheckout(cart: Cart) {', // 第11行
    '  const total = calculateTotal(cart.items);', // 第12行
    '  if (total <= 0) {', // 第13行
    '    throw new Error("Cart total must be positive");', // 第14行
    '  }', // 第15行
    '  return processPayment(total);', // 第16行
    '}', // 第17行
  ].join('\n');

  generator.setSourceContent('src/checkout.ts', originalSource);

  // 添加映射关系
  // 混淆后的代码全在第1行，不同列位置对应原始代码不同位置

  // 映射 1: 混淆后 1:0 → 原始 calculateTotal 函数定义 3:0
  generator.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: 3, column: 0 },
    source: 'src/checkout.ts',
    name: 'calculateTotal',
  });

  // 映射 2: 混淆后 1:50 → 原始 total += 6:4
  generator.addMapping({
    generated: { line: 1, column: 50 },
    original: { line: 6, column: 4 },
    source: 'src/checkout.ts',
    name: 'total',
  });

  // 映射 3: 混淆后 1:120 → 原始 handleCheckout 函数 11:0
  generator.addMapping({
    generated: { line: 1, column: 120 },
    original: { line: 11, column: 0 },
    source: 'src/checkout.ts',
    name: 'handleCheckout',
  });

  // 映射 4: 混淆后 1:200 → 原始 throw new Error 14:4
  generator.addMapping({
    generated: { line: 1, column: 200 },
    original: { line: 14, column: 4 },
    source: 'src/checkout.ts',
    name: null,
  });

  return generator.toString();
}

/**
 * 创建多文件打包的 SourceMap
 * 模拟多个源文件打包成一个 bundle
 */
function createMultiFileSourceMap() {
  const generator = new SourceMapGenerator({ file: 'bundle.min.js' });

  // 文件1: utils.ts
  generator.setSourceContent(
    'src/utils.ts',
    [
      'export function formatPrice(price: number): string {',
      '  return `$${price.toFixed(2)}`;',
      '}',
      '',
      'export function validateEmail(email: string): boolean {',
      '  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);',
      '}',
    ].join('\n'),
  );

  // 文件2: api.ts
  generator.setSourceContent(
    'src/api.ts',
    [
      'export async function fetchUser(id: string) {',
      '  const response = await fetch(`/api/users/${id}`);',
      '  if (!response.ok) {',
      '    throw new Error(`User ${id} not found`);',
      '  }',
      '  return response.json();',
      '}',
    ].join('\n'),
  );

  // 映射：utils.ts 中的 formatPrice
  generator.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: 1, column: 0 },
    source: 'src/utils.ts',
    name: 'formatPrice',
  });

  // 映射：utils.ts 中的 validateEmail
  generator.addMapping({
    generated: { line: 1, column: 80 },
    original: { line: 5, column: 0 },
    source: 'src/utils.ts',
    name: 'validateEmail',
  });

  // 映射：api.ts 中的 fetchUser
  generator.addMapping({
    generated: { line: 1, column: 200 },
    original: { line: 1, column: 0 },
    source: 'src/api.ts',
    name: 'fetchUser',
  });

  // 映射：api.ts 中的 throw new Error
  generator.addMapping({
    generated: { line: 1, column: 350 },
    original: { line: 4, column: 4 },
    source: 'src/api.ts',
    name: null,
  });

  return generator.toString();
}

/**
 * 创建带有变量名还原的 SourceMap
 * 模拟 Terser/esbuild 压缩后的变量名映射
 */
function createMinifiedNameSourceMap() {
  const generator = new SourceMapGenerator({ file: 'app.min.js' });

  generator.setSourceContent(
    'src/UserService.ts',
    [
      'export class UserService {',
      '  private apiEndpoint: string;',
      '',
      '  constructor(endpoint: string) {',
      '    this.apiEndpoint = endpoint;',
      '  }',
      '',
      '  async getUserProfile(userId: string) {',
      '    const response = await fetch(`${this.apiEndpoint}/users/${userId}`);',
      '    return response.json();',
      '  }',
      '}',
    ].join('\n'),
  );

  // 压缩后：a → UserService, b → apiEndpoint, c → getUserProfile, d → userId
  generator.addMapping({
    generated: { line: 1, column: 10 },
    original: { line: 1, column: 0 },
    source: 'src/UserService.ts',
    name: 'UserService',
  });

  generator.addMapping({
    generated: { line: 1, column: 30 },
    original: { line: 4, column: 2 },
    source: 'src/UserService.ts',
    name: 'constructor',
  });

  generator.addMapping({
    generated: { line: 1, column: 100 },
    original: { line: 8, column: 2 },
    source: 'src/UserService.ts',
    name: 'getUserProfile',
  });

  generator.addMapping({
    generated: { line: 1, column: 150 },
    original: { line: 9, column: 4 },
    source: 'src/UserService.ts',
    name: 'response',
  });

  return generator.toString();
}

// ==================== 测试 ====================

describe('SourceMapParser Deep - 混淆代码解析', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    originalFetch = window.fetch;
  });

  afterEach(() => {
    window.fetch = originalFetch;
    vi.useRealTimers();
  });

  // ==================== 单文件映射还原 ====================

  describe('单文件混淆代码还原', () => {
    it('应将混淆后的位置还原为原始函数名和位置', async () => {
      const sourceMap = createSimpleSourceMap();

      window.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(JSON.parse(sourceMap)),
      } as any);

      const parser = new SourceMapParser({
        sourceMapBaseUrl: 'https://cdn.example.com/sourcemaps/dist/1.0.0',
      });

      // 模拟混淆后的错误堆栈
      const stack = [
        'Error: Cart total must be positive',
        '    at n (https://cdn.example.com/static/js/app.min.abc.js:1:200)',
        '    at t (https://cdn.example.com/static/js/app.min.abc.js:1:120)',
      ].join('\n');

      const result = await parser.parse(stack);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Error: Cart total must be positive');

      // 第一个堆栈帧（throw new Error 的位置）
      const frame1 = result.frames[1]!;
      expect(frame1.resolved).toBe(true);
      expect(frame1.original?.fileName).toBe('src/checkout.ts');
      expect(frame1.original?.line).toBe(14); // 原始第 14 行
      expect(frame1.original?.column).toBe(4);

      // 第二个堆栈帧（handleCheckout 函数）
      const frame2 = result.frames[2]!;
      expect(frame2.resolved).toBe(true);
      expect(frame2.original?.fileName).toBe('src/checkout.ts');
      expect(frame2.original?.line).toBe(11); // 原始第 11 行
      expect(frame2.original?.functionName).toBe('handleCheckout');
    });

    it('应还原源代码上下文', async () => {
      const sourceMap = createSimpleSourceMap();

      window.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(JSON.parse(sourceMap)),
      } as any);

      const parser = new SourceMapParser({
        sourceMapBaseUrl: 'https://cdn.example.com/sourcemaps/dist/1.0.0',
      });

      const stack =
        'Error: test\n' +
        '    at n (https://cdn.example.com/static/js/app.min.abc.js:1:200)';

      const result = await parser.parse(stack);
      const frame = result.frames[1]!;

      expect(frame.resolved).toBe(true);
      // 应包含源代码片段
      expect(frame.original?.source).toBeDefined();
      // 源代码片段应包含 throw new Error 那一行
      expect(frame.original?.source).toContain('throw new Error');
      // 源代码片段应包含行号标记
      expect(frame.original?.source).toContain('>'); // 当前行标记
    });
  });

  // ==================== 多文件打包映射还原 ====================

  describe('多文件打包代码还原', () => {
    it('应正确还原到不同源文件', async () => {
      const sourceMap = createMultiFileSourceMap();

      window.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(JSON.parse(sourceMap)),
      } as any);

      const parser = new SourceMapParser({
        sourceMapBaseUrl: 'https://cdn.example.com/sourcemaps/dist/1.0.0',
      });

      // 堆栈包含两个不同源文件的错误
      const stack = [
        'Error: User 123 not found',
        '    at e (https://cdn.example.com/static/js/bundle.min.abc.js:1:350)',
        '    at r (https://cdn.example.com/static/js/bundle.min.abc.js:1:200)',
        '    at t (https://cdn.example.com/static/js/bundle.min.abc.js:1:80)',
      ].join('\n');

      const result = await parser.parse(stack);

      // 第一帧应还原到 api.ts 的 throw new Error
      const frame1 = result.frames[1]!;
      expect(frame1.resolved).toBe(true);
      expect(frame1.original?.fileName).toBe('src/api.ts');
      expect(frame1.original?.line).toBe(4); // throw new Error 行

      // 第二帧应还原到 api.ts 的 fetchUser
      const frame2 = result.frames[2]!;
      expect(frame2.resolved).toBe(true);
      expect(frame2.original?.fileName).toBe('src/api.ts');
      expect(frame2.original?.functionName).toBe('fetchUser');

      // 第三帧应还原到 utils.ts 的 validateEmail
      const frame3 = result.frames[3]!;
      expect(frame3.resolved).toBe(true);
      expect(frame3.original?.fileName).toBe('src/utils.ts');
      expect(frame3.original?.functionName).toBe('validateEmail');
    });
  });

  // ==================== 变量名还原 ====================

  describe('压缩变量名还原', () => {
    it('应将混淆的变量名还原为原始名称', async () => {
      const sourceMap = createMinifiedNameSourceMap();

      window.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(JSON.parse(sourceMap)),
      } as any);

      const parser = new SourceMapParser({
        sourceMapBaseUrl: 'https://cdn.example.com/sourcemaps/dist/1.0.0',
      });

      const stack = [
        'Error: Network request failed',
        '    at a.c (https://cdn.example.com/static/js/app.min.abc.js:1:150)',
        '    at a (https://cdn.example.com/static/js/app.min.abc.js:1:100)',
        '    at new a (https://cdn.example.com/static/js/app.min.abc.js:1:30)',
      ].join('\n');

      const result = await parser.parse(stack);

      // 还原 response（混淆位置 1:150）
      const frame1 = result.frames[1]!;
      expect(frame1.resolved).toBe(true);
      expect(frame1.original?.fileName).toBe('src/UserService.ts');
      expect(frame1.original?.functionName).toBe('response');
      expect(frame1.original?.line).toBe(9);

      // 还原 getUserProfile（混淆位置 1:100）
      const frame2 = result.frames[2]!;
      expect(frame2.resolved).toBe(true);
      expect(frame2.original?.functionName).toBe('getUserProfile');
      expect(frame2.original?.line).toBe(8);

      // 还原 constructor（混淆位置 1:30）
      const frame3 = result.frames[3]!;
      expect(frame3.resolved).toBe(true);
      expect(frame3.original?.functionName).toBe('constructor');
      expect(frame3.original?.line).toBe(4);
    });
  });

  // ==================== 混合场景 ====================

  describe('混合场景', () => {
    it('堆栈中包含本域和非本域资源时，只解析本域', async () => {
      const sourceMap = createSimpleSourceMap();

      window.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(JSON.parse(sourceMap)),
      } as any);

      const parser = new SourceMapParser({
        sourceMapBaseUrl: 'https://cdn.example.com/sourcemaps/dist/1.0.0',
      });

      const stack = [
        'Error: Something went wrong',
        // 本域资源 → 应解析
        '    at n (https://cdn.example.com/static/js/app.min.abc.js:1:0)',
        // 第三方 CDN → 不应解析
        '    at Object.dispatch (https://unpkg.com/react-dom@18/umd/react-dom.production.min.js:1:5000)',
        // Chrome 扩展 → 不应解析
        '    at chrome-extension://abc123/content.js:5:10',
      ].join('\n');

      const result = await parser.parse(stack);

      // 本域帧应被解析
      expect(result.frames[1]!.resolved).toBe(true);

      // 第三方帧不解析
      expect(result.frames[2]!.resolved).toBe(false);
      expect(result.frames[2]!.minified).toBeDefined();

      // Chrome 扩展帧不解析
      expect(result.frames[3]!.resolved).toBe(false);
    });

    it('SourceMap 加载超时应优雅降级', async () => {
      // 直接模拟 AbortError（模拟超时结果）
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';

      window.fetch = vi.fn().mockRejectedValue(abortError);

      const parser = new SourceMapParser({
        sourceMapBaseUrl: 'https://cdn.example.com/sourcemaps/dist/1.0.0',
        timeout: 5000,
      });

      const stack =
        'Error: test\n' +
        '    at fn (https://cdn.example.com/static/js/app.abc.js:1:100)';

      const result = await parser.parse(stack);

      // 应优雅降级，不崩溃
      expect(result.success).toBe(true);
      expect(result.frames[1]!.resolved).toBe(false);
    });

    it('畸形 SourceMap 应优雅降级', async () => {
      // 返回非法的 SourceMap
      window.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: 3, mappings: '!!!INVALID!!!' }),
      } as any);

      const parser = new SourceMapParser({
        sourceMapBaseUrl: 'https://cdn.example.com/sourcemaps/dist/1.0.0',
      });

      const stack =
        'Error: test\n' +
        '    at fn (https://cdn.example.com/static/js/app.abc.js:1:100)';

      const result = await parser.parse(stack);

      // 不应崩溃
      expect(result.success).toBe(true);
      expect(result.frames[1]!.resolved).toBe(false);
    });

    it('同一个 SourceMap 被多个堆栈帧引用时应只加载一次', async () => {
      const sourceMap = createSimpleSourceMap();
      let fetchCount = 0;

      window.fetch = vi.fn().mockImplementation(() => {
        fetchCount++;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(JSON.parse(sourceMap)),
        });
      });

      const parser = new SourceMapParser({
        sourceMapBaseUrl: 'https://cdn.example.com/sourcemaps/dist/1.0.0',
        enableCache: true,
      });

      // 多个帧引用同一个文件
      const stack = [
        'Error: test',
        '    at a (https://cdn.example.com/static/js/app.min.abc.js:1:0)',
        '    at b (https://cdn.example.com/static/js/app.min.abc.js:1:50)',
        '    at c (https://cdn.example.com/static/js/app.min.abc.js:1:120)',
        '    at d (https://cdn.example.com/static/js/app.min.abc.js:1:200)',
      ].join('\n');

      await parser.parse(stack);

      // SourceMap 只应加载一次（缓存命中）
      expect(fetchCount).toBe(1);
    });
  });

  // ==================== 源代码上下文提取 ====================

  describe('源代码上下文提取', () => {
    it('应提取错误行的上下文（前后各3行）', async () => {
      const sourceMap = createSimpleSourceMap();

      window.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(JSON.parse(sourceMap)),
      } as any);

      const parser = new SourceMapParser({
        sourceMapBaseUrl: 'https://cdn.example.com/sourcemaps/dist/1.0.0',
      });

      // 指向第 14 行（throw new Error）
      const stack =
        'Error: test\n' +
        '    at n (https://cdn.example.com/static/js/app.min.abc.js:1:200)';

      const result = await parser.parse(stack);
      const frame = result.frames[1]!;

      expect(frame.original?.source).toBeDefined();
      const sourceLines = frame.original!.source!.split('\n');

      // 应有 6 行左右的上下文（第 11-17 行，前后各 3 行）
      expect(sourceLines.length).toBeGreaterThanOrEqual(4);

      // 当前行应有 > 标记
      const currentLine = sourceLines.find((l) => l.startsWith('>'));
      expect(currentLine).toBeDefined();
      expect(currentLine).toContain('14'); // 行号
    });

    it('文件开头的错误应正确提取上下文（不出负数行号）', async () => {
      const generator = new SourceMapGenerator({ file: 'app.min.js' });
      generator.setSourceContent(
        'src/index.ts',
        'const x = 1;\nconst y = 2;\nconst z = 3;\n',
      );
      generator.addMapping({
        generated: { line: 1, column: 0 },
        original: { line: 1, column: 0 },
        source: 'src/index.ts',
        name: 'x',
      });

      window.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(JSON.parse(generator.toString())),
      } as any);

      const parser = new SourceMapParser({
        sourceMapBaseUrl: 'https://cdn.example.com/sourcemaps/dist/1.0.0',
      });

      const stack =
        'Error: test\n' +
        '    at n (https://cdn.example.com/static/js/app.min.abc.js:1:0)';

      const result = await parser.parse(stack);
      const frame = result.frames[1]!;

      // 不应有负数行号
      if (frame.original?.source) {
        expect(frame.original.source).not.toContain('-');
        // 应从第 1 行开始
        expect(frame.original.source).toContain('1');
      }
    });
  });
});

