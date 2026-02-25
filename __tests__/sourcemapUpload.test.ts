/**
 * SourceMap Upload 插件测试
 *
 * 测试内容：
 * - sourcemap-uploader 核心上传逻辑
 * - Vite SourceMap 插件
 * - Webpack SourceMap 插件
 *
 * 关键思路：不需要真实构建，Mock 文件系统和 Compiler hooks
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ==================== sourcemap-uploader 核心逻辑测试 ====================

// 因为 sourcemap-uploader 使用 Node.js 的 fs 模块，我们需要 mock 它
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path');
  return {
    ...actual,
    join: (...args: string[]) => args.join('/'),
    relative: (from: string, to: string) => to.replace(from + '/', ''),
    resolve: (...args: string[]) => args.join('/'),
  };
});

import * as fs from 'fs';
import { uploadSourceMaps } from '../build-plugins/sourcemap-uploader';
import { ameathViteSourceMapPlugin } from '../build-plugins/vite-sourcemap';
import { AemeathSourceMapWebpackPlugin } from '../build-plugins/webpack-sourcemap';

describe('SourceMap Upload', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ==================== uploadSourceMaps 核心 ====================

  describe('uploadSourceMaps', () => {
    it('应扫描目录并上传 .map 文件', async () => {
      const onUpload = vi.fn().mockResolvedValue(undefined);

      // Mock 文件系统：
      // /dist/
      //   assets/
      //     app.js.map
      //     vendor.js.map
      //     app.js
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockImplementation(
        (dir: string) => {
          if (dir === '/dist') return ['assets'];
          if (dir === '/dist/assets')
            return ['app.js.map', 'vendor.js.map', 'app.js'];
          return [];
        },
      );
      (fs.statSync as ReturnType<typeof vi.fn>).mockImplementation(
        (filePath: string) => ({
          isDirectory: () =>
            filePath === '/dist/assets',
        }),
      );
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        '{"version":3,"sources":["src/App.tsx"],"mappings":"AAAA"}',
      );

      await uploadSourceMaps('/dist', {
        onUpload,
        version: '1.0.0',
      });

      // 只上传 .map 文件，不上传 .js
      expect(onUpload).toHaveBeenCalledTimes(2);

      // 验证上传内容
      const firstCall = onUpload.mock.calls[0][0];
      expect(firstCall.filename).toContain('app.js.map');
      expect(firstCall.version).toBe('1.0.0');
      expect(firstCall.content).toContain('"version":3');
    });

    it('无 .map 文件时应正常退出', async () => {
      const onUpload = vi.fn();

      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        'app.js',
        'style.css',
      ]);
      (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({
        isDirectory: () => false,
      });

      await uploadSourceMaps('/dist', {
        onUpload,
        version: '1.0.0',
      });

      expect(onUpload).not.toHaveBeenCalled();
    });

    it('deleteAfterUpload=true 时应删除 .map 文件', async () => {
      const onUpload = vi.fn().mockResolvedValue(undefined);

      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        'app.js.map',
      ]);
      (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({
        isDirectory: () => false,
      });
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('{}');

      await uploadSourceMaps('/dist', {
        onUpload,
        deleteAfterUpload: true,
        version: '1.0.0',
      });

      expect(fs.unlinkSync).toHaveBeenCalledTimes(1);
    });

    it('deleteAfterUpload=false 时不应删除 .map 文件', async () => {
      const onUpload = vi.fn().mockResolvedValue(undefined);

      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        'app.js.map',
      ]);
      (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({
        isDirectory: () => false,
      });
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('{}');

      await uploadSourceMaps('/dist', {
        onUpload,
        deleteAfterUpload: false,
        version: '1.0.0',
      });

      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('未提供 version 时应生成时间戳版本号', async () => {
      const onUpload = vi.fn().mockResolvedValue(undefined);

      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        'app.js.map',
      ]);
      (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({
        isDirectory: () => false,
      });
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('{}');

      await uploadSourceMaps('/dist', {
        onUpload,
        // 不提供 version
      });

      const file = onUpload.mock.calls[0][0];
      // 时间戳格式的版本号：如 2026-02-06T09-30-00-000Z
      expect(file.version).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('单个文件上传失败不应影响其他文件', async () => {
      const onUpload = vi
        .fn()
        .mockRejectedValueOnce(new Error('上传失败'))
        .mockResolvedValueOnce(undefined);

      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        'a.js.map',
        'b.js.map',
      ]);
      (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({
        isDirectory: () => false,
      });
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('{}');

      // 不应抛出异常
      await expect(
        uploadSourceMaps('/dist', {
          onUpload,
          version: '1.0.0',
        }),
      ).resolves.toBeUndefined();

      // 两个文件都尝试了上传
      expect(onUpload).toHaveBeenCalledTimes(2);
    });
  });

  // ==================== Vite SourceMap Plugin ====================

  describe('ameathViteSourceMapPlugin', () => {
    it('应返回 Vite 插件对象', () => {
      const plugin = ameathViteSourceMapPlugin({
        onUpload: vi.fn(),
      });

      expect(plugin.name).toBe('aemeath-sourcemap-upload');
      expect(plugin.apply).toBe('build');
      expect(typeof plugin.configResolved).toBe('function');
      expect(typeof plugin.closeBundle).toBe('function');
    });

    it('enabled=false 时 closeBundle 不应执行', async () => {
      const onUpload = vi.fn();
      const plugin = ameathViteSourceMapPlugin({
        enabled: false,
        onUpload,
      });

      // 模拟 Vite 调用 closeBundle
      await (plugin.closeBundle as Function)();

      expect(onUpload).not.toHaveBeenCalled();
    });

    it('configResolved 应保存配置', () => {
      const plugin = ameathViteSourceMapPlugin({
        onUpload: vi.fn(),
      });

      const mockConfig = {
        root: '/project',
        build: {
          outDir: 'dist',
        },
      };

      // 模拟 Vite 调用 configResolved
      (plugin.configResolved as Function)(mockConfig);

      // 之后 closeBundle 应能使用该配置
      // (不直接验证内部状态，通过后续行为验证)
      expect(plugin.configResolved).toBeDefined();
    });

    it('closeBundle 应使用 configResolved 中的输出路径', async () => {
      const onUpload = vi.fn().mockResolvedValue(undefined);
      const plugin = ameathViteSourceMapPlugin({
        onUpload,
        version: '1.0.0',
      });

      // 先设置配置
      (plugin.configResolved as Function)({
        root: '/project',
        build: { outDir: 'dist' },
      });

      // Mock fs 返回 .map 文件
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        'main.js.map',
      ]);
      (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({
        isDirectory: () => false,
      });
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        '{"version":3}',
      );

      await (plugin.closeBundle as Function)();

      expect(onUpload).toHaveBeenCalledTimes(1);
      expect(onUpload.mock.calls[0][0].version).toBe('1.0.0');
    });
  });

  // ==================== Webpack SourceMap Plugin ====================

  describe('AemeathSourceMapWebpackPlugin', () => {
    it('应正确实例化', () => {
      const plugin = new AemeathSourceMapWebpackPlugin({
        onUpload: vi.fn(),
      });
      expect(plugin).toBeDefined();
    });

    it('enabled=false 时不应注册 hooks', () => {
      const plugin = new AemeathSourceMapWebpackPlugin({
        enabled: false,
        onUpload: vi.fn(),
      });

      const mockCompiler = {
        hooks: {
          afterEmit: {
            tapAsync: vi.fn(),
          },
        },
      };

      plugin.apply(mockCompiler as any);

      expect(mockCompiler.hooks.afterEmit.tapAsync).not.toHaveBeenCalled();
    });

    it('apply 应注册 afterEmit hook', () => {
      const plugin = new AemeathSourceMapWebpackPlugin({
        onUpload: vi.fn(),
      });

      const mockCompiler = {
        hooks: {
          afterEmit: {
            tapAsync: vi.fn(),
          },
        },
      };

      plugin.apply(mockCompiler as any);

      expect(mockCompiler.hooks.afterEmit.tapAsync).toHaveBeenCalledWith(
        'AemeathSourceMapWebpackPlugin',
        expect.any(Function),
      );
    });

    it('afterEmit 回调应扫描并上传 .map 文件', async () => {
      const onUpload = vi.fn().mockResolvedValue(undefined);
      const plugin = new AemeathSourceMapWebpackPlugin({
        onUpload,
        version: '2.0.0',
      });

      const tapAsyncCallback = vi.fn();
      const mockCompiler = {
        hooks: {
          afterEmit: {
            tapAsync: (_name: string, cb: Function) => {
              tapAsyncCallback.mockImplementation(cb);
            },
          },
        },
      };

      plugin.apply(mockCompiler as any);

      // Mock fs
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        'bundle.js.map',
      ]);
      (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({
        isDirectory: () => false,
      });
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        '{"version":3}',
      );

      // 模拟 Webpack 调用 afterEmit
      const mockCompilation = {
        outputOptions: { path: '/project/dist' },
      };
      const callback = vi.fn();

      await tapAsyncCallback(mockCompilation, callback);

      expect(onUpload).toHaveBeenCalledTimes(1);
      expect(onUpload.mock.calls[0][0].version).toBe('2.0.0');
      expect(callback).toHaveBeenCalled();
    });

    it('afterEmit 在无输出路径时应跳过', async () => {
      const onUpload = vi.fn();
      const plugin = new AemeathSourceMapWebpackPlugin({
        onUpload,
      });

      const tapAsyncCallback = vi.fn();
      const mockCompiler = {
        hooks: {
          afterEmit: {
            tapAsync: (_name: string, cb: Function) => {
              tapAsyncCallback.mockImplementation(cb);
            },
          },
        },
      };

      plugin.apply(mockCompiler as any);

      const mockCompilation = {
        outputOptions: { path: undefined },
      };
      const callback = vi.fn();

      await tapAsyncCallback(mockCompilation, callback);

      expect(onUpload).not.toHaveBeenCalled();
      expect(callback).toHaveBeenCalled(); // callback 仍然被调用
    });

    it('afterEmit 上传出错时不应阻塞构建', async () => {
      const onUpload = vi.fn().mockRejectedValue(new Error('网络错误'));
      const plugin = new AemeathSourceMapWebpackPlugin({
        onUpload,
      });

      const tapAsyncCallback = vi.fn();
      const mockCompiler = {
        hooks: {
          afterEmit: {
            tapAsync: (_name: string, cb: Function) => {
              tapAsyncCallback.mockImplementation(cb);
            },
          },
        },
      };

      plugin.apply(mockCompiler as any);

      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        'app.js.map',
      ]);
      (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({
        isDirectory: () => false,
      });
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('{}');

      const mockCompilation = {
        outputOptions: { path: '/dist' },
      };
      const callback = vi.fn();

      // 不应抛出
      await tapAsyncCallback(mockCompilation, callback);

      // callback 仍然被调用，不阻塞构建
      expect(callback).toHaveBeenCalled();
    });

    it('deleteAfterUpload=true 应在上传后删除文件', async () => {
      const onUpload = vi.fn().mockResolvedValue(undefined);
      const plugin = new AemeathSourceMapWebpackPlugin({
        onUpload,
        deleteAfterUpload: true,
      });

      const tapAsyncCallback = vi.fn();
      const mockCompiler = {
        hooks: {
          afterEmit: {
            tapAsync: (_name: string, cb: Function) => {
              tapAsyncCallback.mockImplementation(cb);
            },
          },
        },
      };

      plugin.apply(mockCompiler as any);

      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        'app.js.map',
      ]);
      (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({
        isDirectory: () => false,
      });
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('{}');

      await tapAsyncCallback(
        { outputOptions: { path: '/dist' } },
        vi.fn(),
      );

      expect(fs.unlinkSync).toHaveBeenCalled();
    });
  });
});

