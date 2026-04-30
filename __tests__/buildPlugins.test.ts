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

  it('enabled=true 时应返回 head-prepend 的 script tag（vite 标准 API）', async () => {
    const { ameathEarlyErrorPlugin } = await import('../src/build-plugins/vite');
    const plugin = ameathEarlyErrorPlugin({ enabled: true });

    const html = '<html><head><title>Test</title></head><body></body></html>';
    const result = (plugin.transformIndexHtml as Function)(html) as {
      html: string;
      tags: Array<{ tag: string; injectTo: string; children: string }>;
    };

    expect(result.html).toBe(html);
    expect(result.tags).toHaveLength(1);
    expect(result.tags[0].tag).toBe('script');
    expect(result.tags[0].injectTo).toBe('head-prepend');
    expect(result.tags[0].children).toContain('__EARLY_ERRORS__');
    expect(result.tags[0].children).toContain('__flushEarlyErrors__');
  });

  it('enabled=false 时不应注入任何 tag', async () => {
    const { ameathEarlyErrorPlugin } = await import('../src/build-plugins/vite');
    const plugin = ameathEarlyErrorPlugin({ enabled: false });

    const html = '<html><head><title>Test</title></head><body></body></html>';
    const result = (plugin.transformIndexHtml as Function)(html);

    expect(result).toBe(html);
  });

  // R18: CSP nonce 支持。严格 CSP 站点必须给 inline script 加 nonce 属性，
  // 否则浏览器会静默拦截整个早期错误捕获脚本。
  describe('CSP nonce 支持（R18 / 增强 #1）', () => {
    it('未传 nonce：tag.attrs 不应有 nonce 字段（避免空字符串被识别为合法 CSP）', async () => {
      const { ameathEarlyErrorPlugin } = await import('../src/build-plugins/vite');
      const plugin = ameathEarlyErrorPlugin();
      const result = (plugin.transformIndexHtml as Function)('<html></html>') as {
        tags: Array<{ attrs: Record<string, string> }>;
      };
      expect(result.tags[0].attrs).toEqual({});
      expect('nonce' in result.tags[0].attrs).toBe(false);
    });

    it('传入 nonce："abc123" 时 tag 必须带 nonce="abc123"', async () => {
      const { ameathEarlyErrorPlugin } = await import('../src/build-plugins/vite');
      const plugin = ameathEarlyErrorPlugin({ nonce: 'abc123' });
      const result = (plugin.transformIndexHtml as Function)('<html></html>') as {
        tags: Array<{ attrs: Record<string, string> }>;
      };
      expect(result.tags[0].attrs.nonce).toBe('abc123');
    });

    it('空字符串 nonce：等同于未传，不应附加属性（CSP 语义下空 nonce 仍会被拦截）', async () => {
      const { ameathEarlyErrorPlugin } = await import('../src/build-plugins/vite');
      const plugin = ameathEarlyErrorPlugin({ nonce: '' });
      const result = (plugin.transformIndexHtml as Function)('<html></html>') as {
        tags: Array<{ attrs: Record<string, string> }>;
      };
      expect('nonce' in result.tags[0].attrs).toBe(false);
    });

    it('nonce 不应污染脚本内容（应仅作为标签属性）', async () => {
      const { ameathEarlyErrorPlugin } = await import('../src/build-plugins/vite');
      const plugin = ameathEarlyErrorPlugin({ nonce: 'NONCE-VALUE-XYZ' });
      const result = (plugin.transformIndexHtml as Function)('<html></html>') as {
        tags: Array<{ children: string; attrs: Record<string, string> }>;
      };
      expect(result.tags[0].attrs.nonce).toBe('NONCE-VALUE-XYZ');
      expect(result.tags[0].children).not.toContain('NONCE-VALUE-XYZ');
    });
  });

  // 升级回归（Bug E）：旧实现 `html.replace('<head>', ...)` 字面量匹配，对
  // `<HEAD>` / `<head class="x">` 等场景静默失效，整个早期错误捕获机制失能。
  // 新实现走 vite 标准 `injectTo` API，由 vite 内部解析 HTML 树，对任意合法
  // `<head>` 都成立。这里不再依赖字符串匹配，只确认插件返回 head-prepend 的
  // 标准结构（实际注入由 vite 自己负责）。
  it('Bug E: head 含属性 / 大小写差异时也必须返回相同 tag 结构（不依赖字面量 replace）', async () => {
    const { ameathEarlyErrorPlugin } = await import('../src/build-plugins/vite');
    const plugin = ameathEarlyErrorPlugin();

    const cases = [
      '<html><head><title>Test</title></head><body></body></html>',
      '<html><head class="x"><title>Test</title></head><body></body></html>',
      '<html><head lang="en"><title>Test</title></head><body></body></html>',
      '<HTML><HEAD><TITLE>X</TITLE></HEAD><BODY></BODY></HTML>',
    ];
    for (const html of cases) {
      const result = (plugin.transformIndexHtml as Function)(html) as {
        html: string;
        tags: Array<{ injectTo: string }>;
      };
      expect(result.tags).toHaveLength(1);
      expect(result.tags[0].injectTo).toBe('head-prepend');
    }
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
          tapAsync: vi.fn((_name: string, cb: Function) => {
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

  // R18: CSP nonce 支持（仅 inject 模式下生效）
  //
  // 由于 webpack 插件内部 `require('html-webpack-plugin')` 是真实模块加载，
  // 在 vitest 隔离环境里直接 mock 会引入复杂性。这里采用「构造期 wiring」
  // + 「运行期注入路径直接调用 injectViaHtmlPlugin」两种检查覆盖：
  //   - 构造期：确认 nonce 选项被正确解构并存入 pluginOptions
  //   - 运行期：直接调用 (plugin as any).injectViaHtmlPlugin(...) 绕过
  //     compilation hook 的 require('html-webpack-plugin') 加载，
  //     用 mock hooks 验证最终生成的 scriptTag.attributes.nonce
  describe('CSP nonce 支持（R18 / 增强 #1）', () => {
    it('nonce 选项被正确接收并存入 pluginOptions（黑盒构造检查）', async () => {
      const { AemeathEarlyErrorWebpackPlugin } = await import(
        '../src/build-plugins/webpack'
      );
      const plugin = new AemeathEarlyErrorWebpackPlugin({ nonce: 'abc123' });
      // private 字段，但通过 (plugin as any) 访问以验证 wiring
      expect((plugin as any).pluginOptions.nonce).toBe('abc123');
    });

    it('未传 nonce：pluginOptions.nonce 为 undefined（不会写入 attributes）', async () => {
      const { AemeathEarlyErrorWebpackPlugin } = await import(
        '../src/build-plugins/webpack'
      );
      const plugin = new AemeathEarlyErrorWebpackPlugin();
      expect((plugin as any).pluginOptions.nonce).toBeUndefined();
    });

    it('空 nonce：pluginOptions 仍存为 ""，但 injectViaHtmlPlugin 内部 if (nonce) 守卫会跳过', async () => {
      const { AemeathEarlyErrorWebpackPlugin } = await import(
        '../src/build-plugins/webpack'
      );
      const plugin = new AemeathEarlyErrorWebpackPlugin({ nonce: '' });
      expect((plugin as any).pluginOptions.nonce).toBe('');
    });

    // 端到端：直接调 private injectViaHtmlPlugin（绕过真实 require('html-webpack-plugin')），
    // 验证最终 scriptTag 是否带 attributes.nonce
    async function injectAndCapture(
      opts: { nonce?: string },
    ): Promise<{
      tagName: string;
      innerHTML: string;
      attributes?: Record<string, string>;
    }> {
      const { AemeathEarlyErrorWebpackPlugin } = await import(
        '../src/build-plugins/webpack'
      );
      const plugin = new AemeathEarlyErrorWebpackPlugin(opts);
      let captured!: {
        tagName: string;
        innerHTML: string;
        attributes?: Record<string, string>;
      };
      const fakeHWP = {
        getHooks: () => ({
          alterAssetTagGroups: {
            tapAsync: (_name: string, cb: Function) => {
              const data = {
                headTags: [] as Array<typeof captured>,
                bodyTags: [],
              };
              cb(data, () => {});
              captured = data.headTags[0];
            },
          },
        }),
      };
      // private 但通过 (plugin as any) 直接调用
      (plugin as any).injectViaHtmlPlugin({}, fakeHWP, 'test-plugin');
      return captured;
    }

    it('inject 模式 + nonce："NCE-1" 时 scriptTag.attributes.nonce 应被设置', async () => {
      const tag = await injectAndCapture({ nonce: 'NCE-1' });
      expect(tag.tagName).toBe('script');
      expect(tag.innerHTML).toContain('__EARLY_ERRORS__');
      expect(tag.attributes).toEqual({ nonce: 'NCE-1' });
    });

    it('inject 模式未传 nonce 时 scriptTag 不应带 attributes 字段', async () => {
      const tag = await injectAndCapture({});
      expect(tag.tagName).toBe('script');
      expect(tag.attributes).toBeUndefined();
    });

    it('inject 模式 + 空字符串 nonce 时 scriptTag 不应带 attributes 字段', async () => {
      const tag = await injectAndCapture({ nonce: '' });
      expect(tag.attributes).toBeUndefined();
    });

    it('inject 模式：nonce 不污染 innerHTML', async () => {
      const tag = await injectAndCapture({ nonce: 'SECRET-NONCE-VALUE' });
      expect(tag.attributes?.nonce).toBe('SECRET-NONCE-VALUE');
      expect(tag.innerHTML).not.toContain('SECRET-NONCE-VALUE');
    });
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

  // R18: CSP nonce 支持
  describe('CSP nonce 支持（R18 / 增强 #1）', () => {
    async function setupCallback(opts: { nonce?: string }): Promise<{
      attrs: Record<string, string>;
      children: string;
    }> {
      const { ameathEarlyErrorPlugin } = await import('../src/build-plugins/rsbuild');
      const plugin = ameathEarlyErrorPlugin(opts);
      let modifyCallback: Function | null = null;
      const mockApi = {
        modifyHTMLTags: vi.fn((cb: Function) => {
          modifyCallback = cb;
        }),
      };
      plugin.setup(mockApi as any);
      const result = modifyCallback!({ headTags: [], bodyTags: [] });
      return result.headTags[0] as { attrs: Record<string, string>; children: string };
    }

    it('未传 nonce：attrs 仅含 type, 不含 nonce 字段', async () => {
      const tag = await setupCallback({});
      expect(tag.attrs).toEqual({ type: 'text/javascript' });
      expect('nonce' in tag.attrs).toBe(false);
    });

    it('传入 nonce："abc123" 时 attrs 应附带 nonce', async () => {
      const tag = await setupCallback({ nonce: 'abc123' });
      expect(tag.attrs).toEqual({ type: 'text/javascript', nonce: 'abc123' });
    });

    it('空字符串 nonce：等同于未传，attrs 不应附加 nonce', async () => {
      const tag = await setupCallback({ nonce: '' });
      expect('nonce' in tag.attrs).toBe(false);
    });

    it('nonce 不应污染脚本内容', async () => {
      const tag = await setupCallback({ nonce: 'NONCE-VALUE-XYZ' });
      expect(tag.attrs.nonce).toBe('NONCE-VALUE-XYZ');
      expect(tag.children).not.toContain('NONCE-VALUE-XYZ');
    });
  });
});

