/**
 * SourceMapParser 客户端解析器测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SourceMapParser, createParser } from '../parser/SourceMapParser.client';

describe('SourceMapParser', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    originalFetch = window.fetch;
  });

  afterEach(() => {
    window.fetch = originalFetch;
    vi.useRealTimers();
  });

  // ==================== 构造与配置 ====================

  describe('构造与配置', () => {
    it('应正确创建实例', () => {
      const parser = new SourceMapParser({
        sourceMapBaseUrl: 'https://cdn.example.com/sourcemaps/dist/1.0.0',
      });
      expect(parser).toBeDefined();
    });

    it('createParser 工厂函数应返回实例', () => {
      const parser = createParser({
        sourceMapBaseUrl: 'https://cdn.example.com/sourcemaps/dist/1.0.0',
      });
      expect(parser).toBeInstanceOf(SourceMapParser);
    });
  });

  // ==================== parse 方法 ====================

  describe('parse', () => {
    it('空堆栈应返回失败', async () => {
      const parser = new SourceMapParser({
        sourceMapBaseUrl: 'https://cdn.example.com/sourcemaps',
      });
      const result = await parser.parse('');
      expect(result.success).toBe(false);
      expect(result.error).toBe('堆栈为空');
      expect(result.frames).toHaveLength(0);
    });

    it('无位置信息的堆栈应返回未解析帧', async () => {
      const parser = new SourceMapParser({
        sourceMapBaseUrl: 'https://cdn.example.com/sourcemaps',
      });
      const result = await parser.parse('Error: something went wrong');
      expect(result.success).toBe(true);
      expect(result.frames).toHaveLength(1);
      expect(result.frames[0]!.resolved).toBe(false);
    });

    it('非本域资源的堆栈行应标记为未解析', async () => {
      const parser = new SourceMapParser({
        sourceMapBaseUrl: 'https://cdn.example.com/sourcemaps',
      });
      const stack =
        'Error: test\n' +
        '    at fn (https://other-domain.com/static/js/app.js:1:100)';
      const result = await parser.parse(stack);
      expect(result.success).toBe(true);
      // 非本域资源，不解析
      expect(result.frames[1]!.resolved).toBe(false);
      expect(result.frames[1]!.minified).toBeDefined();
    });

    it('本域资源应尝试加载 SourceMap', async () => {
      const mockSourceMap = {
        version: 3,
        sources: ['src/App.tsx'],
        sourcesContent: ['const App = () => {};\nexport default App;'],
        names: ['App'],
        mappings: 'AAAA',
        file: 'app.js',
      };

      window.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockSourceMap),
      } as any);

      const parser = new SourceMapParser({
        sourceMapBaseUrl: 'https://cdn.example.com/sourcemaps/dist/1.0.0',
      });

      const stack =
        'Error: test\n' +
        '    at App (https://cdn.example.com/static/js/app.abc123.js:1:100)';
      const result = await parser.parse(stack);

      expect(result.success).toBe(true);
      // fetch 应被调用（加载 SourceMap）
      expect(window.fetch).toHaveBeenCalledWith(
        expect.stringContaining('sourcemaps/dist/1.0.0/static/js/app.abc123.js.map'),
        expect.any(Object),
      );
    });

    it('SourceMap 加载失败应标记为未解析', async () => {
      window.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      } as any);

      const parser = new SourceMapParser({
        sourceMapBaseUrl: 'https://cdn.example.com/sourcemaps/dist/1.0.0',
      });

      const stack =
        'Error: test\n' +
        '    at App (https://cdn.example.com/static/js/app.abc123.js:1:100)';
      const result = await parser.parse(stack);

      expect(result.success).toBe(true);
      expect(result.frames[1]!.resolved).toBe(false);
    });

    it('localhost 资源应被视为本域资源', async () => {
      window.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      } as any);

      const parser = new SourceMapParser({
        sourceMapBaseUrl: 'https://cdn.example.com/sourcemaps/dist/1.0.0',
      });

      const stack =
        'Error: test\n' +
        '    at fn (http://localhost:3000/static/js/main.js:1:50)';
      const result = await parser.parse(stack);

      // 应尝试加载（即使最终失败），说明被当作本域资源
      expect(window.fetch).toHaveBeenCalled();
    });
  });

  // ==================== 缓存 ====================

  describe('缓存', () => {
    it('enableCache=true 时相同 SourceMap 只加载一次', async () => {
      const mockSourceMap = {
        version: 3,
        sources: ['src/App.tsx'],
        sourcesContent: ['const App = () => {};'],
        names: [],
        mappings: 'AAAA',
      };

      window.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockSourceMap),
      } as any);

      const parser = new SourceMapParser({
        sourceMapBaseUrl: 'https://cdn.example.com/sourcemaps/dist/1.0.0',
        enableCache: true,
      });

      const stack =
        'Error: test\n' +
        '    at fn (https://cdn.example.com/static/js/app.abc.js:1:100)';

      await parser.parse(stack);
      await parser.parse(stack);

      // fetch 只调用一次
      expect(window.fetch).toHaveBeenCalledTimes(1);
    });

    it('enableCache=false 时每次都加载', async () => {
      const mockSourceMap = {
        version: 3,
        sources: ['src/App.tsx'],
        sourcesContent: ['const App = () => {};'],
        names: [],
        mappings: 'AAAA',
      };

      window.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockSourceMap),
      } as any);

      const parser = new SourceMapParser({
        sourceMapBaseUrl: 'https://cdn.example.com/sourcemaps/dist/1.0.0',
        enableCache: false,
      });

      const stack =
        'Error: test\n' +
        '    at fn (https://cdn.example.com/static/js/app.abc.js:1:100)';

      await parser.parse(stack);
      await parser.parse(stack);

      // 每次都 fetch
      expect(window.fetch).toHaveBeenCalledTimes(2);
    });

    it('clearCache 应清除所有缓存', async () => {
      const mockSourceMap = {
        version: 3,
        sources: ['src/App.tsx'],
        sourcesContent: ['const App = () => {};'],
        names: [],
        mappings: 'AAAA',
      };

      window.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockSourceMap),
      } as any);

      const parser = new SourceMapParser({
        sourceMapBaseUrl: 'https://cdn.example.com/sourcemaps/dist/1.0.0',
        enableCache: true,
      });

      const stack =
        'Error: test\n' +
        '    at fn (https://cdn.example.com/static/js/app.abc.js:1:100)';

      await parser.parse(stack);
      parser.clearCache();
      await parser.parse(stack);

      // 清除缓存后又 fetch 一次
      expect(window.fetch).toHaveBeenCalledTimes(2);
    });

    it('LRU 缓存应在满时淘汰最久未访问的条目', async () => {
      const createMockSourceMap = (name: string) => ({
        version: 3,
        sources: [name],
        sourcesContent: ['// source'],
        names: [],
        mappings: 'AAAA',
      });

      let callCount = 0;
      window.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(createMockSourceMap(`file${callCount}`)),
        });
      });

      const parser = new SourceMapParser({
        sourceMapBaseUrl: 'https://cdn.example.com/sourcemaps/dist/1.0.0',
        enableCache: true,
        maxCacheSize: 2, // 只缓存 2 个
      });

      // 加载 3 个不同的 SourceMap
      const stack1 =
        'Error\n    at fn (https://cdn.example.com/static/js/a.js:1:1)';
      const stack2 =
        'Error\n    at fn (https://cdn.example.com/static/js/b.js:1:1)';
      const stack3 =
        'Error\n    at fn (https://cdn.example.com/static/js/c.js:1:1)';

      await parser.parse(stack1);
      vi.advanceTimersByTime(100);
      await parser.parse(stack2);
      vi.advanceTimersByTime(100);
      await parser.parse(stack3); // 触发 LRU 淘汰 a.js

      // 重新加载 a.js（已被淘汰，需要重新 fetch）
      await parser.parse(stack1);

      // 总共应有 4 次 fetch（a, b, c, a-again）
      expect(window.fetch).toHaveBeenCalledTimes(4);
    });
  });

  // ==================== 堆栈行解析格式 ====================

  describe('堆栈行格式解析', () => {
    it('应解析 "at fn (url:line:col)" 格式', async () => {
      window.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      } as any);

      const parser = new SourceMapParser({
        sourceMapBaseUrl: 'https://cdn.example.com/sourcemaps/dist/1.0.0',
      });

      const stack =
        'Error: test\n' +
        '    at renderApp (https://cdn.example.com/static/js/main.abc.js:1:2345)';
      const result = await parser.parse(stack);

      const frame = result.frames[1]!;
      expect(frame.minified?.functionName).toBe('renderApp');
      expect(frame.minified?.line).toBe(1);
      expect(frame.minified?.column).toBe(2345);
    });

    it('应解析 "at url:line:col" 格式', async () => {
      window.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      } as any);

      const parser = new SourceMapParser({
        sourceMapBaseUrl: 'https://cdn.example.com/sourcemaps/dist/1.0.0',
      });

      const stack =
        'Error: test\n' +
        '    at https://cdn.example.com/static/js/main.abc.js:1:500';
      const result = await parser.parse(stack);

      const frame = result.frames[1]!;
      expect(frame.minified).toBeDefined();
      expect(frame.minified?.line).toBe(1);
      expect(frame.minified?.column).toBe(500);
    });
  });
});

