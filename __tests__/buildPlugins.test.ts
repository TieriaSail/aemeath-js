/**
 * Build Plugins 构建工具插件测试
 *
 * 测试 Vite / Webpack / Rsbuild 插件的基本逻辑
 * 注意：不实际运行构建，只测试插件的函数逻辑
 */
import { describe, it, expect, vi } from 'vitest';

// ==================== Vite Plugin ====================

describe('Vite Plugin', () => {
  it('应返回正确的插件结构', async () => {
    const { ameathEarlyErrorPlugin } = await import('../src/build-plugins/vite');
    const plugin = ameathEarlyErrorPlugin();

    expect(plugin.name).toBe('aemeath-early-error-capture');
    expect(plugin.transformIndexHtml).toBeTypeOf('function');
  });

  it('enabled=true 时应注入脚本到 head', async () => {
    const { ameathEarlyErrorPlugin } = await import('../src/build-plugins/vite');
    const plugin = ameathEarlyErrorPlugin({ enabled: true });

    const html = '<html><head><title>Test</title></head><body></body></html>';
    const result = (plugin.transformIndexHtml as Function)(html);

    expect(result).toContain('<script>');
    expect(result).toContain('__EARLY_ERRORS__');
    expect(result).toContain('__flushEarlyErrors__');
  });

  it('enabled=false 时不应修改 HTML', async () => {
    const { ameathEarlyErrorPlugin } = await import('../src/build-plugins/vite');
    const plugin = ameathEarlyErrorPlugin({ enabled: false });

    const html = '<html><head><title>Test</title></head><body></body></html>';
    const result = (plugin.transformIndexHtml as Function)(html);

    expect(result).toBe(html);
  });

  it('脚本应注入到 <head> 最前面', async () => {
    const { ameathEarlyErrorPlugin } = await import('../src/build-plugins/vite');
    const plugin = ameathEarlyErrorPlugin();

    const html = '<html><head><meta charset="UTF-8"></head><body></body></html>';
    const result = (plugin.transformIndexHtml as Function)(html);

    // 脚本应在 <head> 后面紧跟着
    const headIndex = result.indexOf('<head>');
    const scriptIndex = result.indexOf('<script>');
    expect(scriptIndex).toBeGreaterThan(headIndex);
    expect(scriptIndex).toBeLessThan(result.indexOf('<meta'));
  });
});

// ==================== Webpack Plugin ====================

describe('Webpack Plugin', () => {
  it('应正确创建实例', async () => {
    const { AemeathEarlyErrorWebpackPlugin } = await import(
      '../src/build-plugins/webpack'
    );
    const plugin = new AemeathEarlyErrorWebpackPlugin();
    expect(plugin).toBeDefined();
  });

  it('应支持 mode 配置', async () => {
    const { AemeathEarlyErrorWebpackPlugin } = await import(
      '../src/build-plugins/webpack'
    );

    const autoPlugin = new AemeathEarlyErrorWebpackPlugin({ mode: 'auto' });
    const filePlugin = new AemeathEarlyErrorWebpackPlugin({ mode: 'file' });
    const injectPlugin = new AemeathEarlyErrorWebpackPlugin({ mode: 'inject' });

    expect(autoPlugin).toBeDefined();
    expect(filePlugin).toBeDefined();
    expect(injectPlugin).toBeDefined();
  });

  it('应有 apply 方法', async () => {
    const { AemeathEarlyErrorWebpackPlugin } = await import(
      '../src/build-plugins/webpack'
    );
    const plugin = new AemeathEarlyErrorWebpackPlugin();
    expect(plugin.apply).toBeTypeOf('function');
  });

  it('enabled=false 时 apply 不应注册 hooks', async () => {
    const { AemeathEarlyErrorWebpackPlugin } = await import(
      '../src/build-plugins/webpack'
    );
    const plugin = new AemeathEarlyErrorWebpackPlugin({ enabled: false });

    const mockCompiler = {
      hooks: {
        compilation: { tap: vi.fn() },
        emit: { tapAsync: vi.fn() },
      },
    };

    plugin.apply(mockCompiler as any);

    expect(mockCompiler.hooks.compilation.tap).not.toHaveBeenCalled();
    expect(mockCompiler.hooks.emit.tapAsync).not.toHaveBeenCalled();
  });

  it("mode='file' 时应注册 emit hook", async () => {
    const { AemeathEarlyErrorWebpackPlugin } = await import(
      '../src/build-plugins/webpack'
    );
    const plugin = new AemeathEarlyErrorWebpackPlugin({ mode: 'file' });

    const mockCompiler = {
      hooks: {
        compilation: { tap: vi.fn() },
        emit: { tapAsync: vi.fn() },
      },
    };

    plugin.apply(mockCompiler as any);

    expect(mockCompiler.hooks.emit.tapAsync).toHaveBeenCalledWith(
      'AemeathEarlyErrorWebpackPlugin',
      expect.any(Function),
    );
  });

  it('自定义 filename 应传递', async () => {
    const { AemeathEarlyErrorWebpackPlugin } = await import(
      '../src/build-plugins/webpack'
    );
    const plugin = new AemeathEarlyErrorWebpackPlugin({
      mode: 'file',
      filename: 'custom-early-error.js',
    });

    const assets: Record<string, any> = {};
    const mockCompiler = {
      hooks: {
        compilation: { tap: vi.fn() },
        emit: {
          tapAsync: vi.fn((name: string, cb: Function) => {
            cb({ assets }, () => {});
          }),
        },
      },
    };

    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    plugin.apply(mockCompiler as any);

    expect(assets['custom-early-error.js']).toBeDefined();
    expect(assets['custom-early-error.js'].source()).toContain('__EARLY_ERRORS__');
    infoSpy.mockRestore();
  });

  it('导出的 getEarlyErrorCaptureScript 应返回脚本', async () => {
    const { getEarlyErrorCaptureScript } = await import(
      '../src/build-plugins/webpack'
    );
    const script = getEarlyErrorCaptureScript();
    expect(script).toContain('__EARLY_ERRORS__');
  });
});

// ==================== Rsbuild Plugin ====================

describe('Rsbuild Plugin', () => {
  it('应返回正确的插件结构', async () => {
    const { ameathEarlyErrorPlugin } = await import('../src/build-plugins/rsbuild');
    const plugin = ameathEarlyErrorPlugin();

    expect(plugin.name).toBe('aemeath-early-error-capture');
    expect(plugin.setup).toBeTypeOf('function');
  });

  it('enabled=false 时 setup 不应注册 hooks', async () => {
    const { ameathEarlyErrorPlugin } = await import('../src/build-plugins/rsbuild');
    const plugin = ameathEarlyErrorPlugin({ enabled: false });

    const mockApi = {
      modifyHTMLTags: vi.fn(),
    };

    plugin.setup(mockApi as any);
    expect(mockApi.modifyHTMLTags).not.toHaveBeenCalled();
  });

  it('enabled=true 时应注册 modifyHTMLTags', async () => {
    const { ameathEarlyErrorPlugin } = await import('../src/build-plugins/rsbuild');
    const plugin = ameathEarlyErrorPlugin({ enabled: true });

    const mockApi = {
      modifyHTMLTags: vi.fn(),
    };

    plugin.setup(mockApi as any);
    expect(mockApi.modifyHTMLTags).toHaveBeenCalled();
  });

  it('modifyHTMLTags 回调应在 headTags 最前面插入脚本', async () => {
    const { ameathEarlyErrorPlugin } = await import('../src/build-plugins/rsbuild');
    const plugin = ameathEarlyErrorPlugin();

    let modifyCallback: Function | null = null;
    const mockApi = {
      modifyHTMLTags: vi.fn((cb: Function) => {
        modifyCallback = cb;
      }),
    };

    plugin.setup(mockApi as any);

    const existingHeadTag = { tag: 'meta', attrs: { charset: 'UTF-8' } };
    const result = modifyCallback!({
      headTags: [existingHeadTag],
      bodyTags: [],
    });

    expect(result.headTags).toHaveLength(2);
    expect(result.headTags[0].tag).toBe('script');
    expect(result.headTags[0].children).toContain('__EARLY_ERRORS__');
    expect(result.headTags[1]).toBe(existingHeadTag);
  });
});

