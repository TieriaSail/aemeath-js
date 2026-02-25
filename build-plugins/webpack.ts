/**
 * Webpack 早期错误捕获插件
 *
 * 支持两种模式：
 * 1. 自动模式：如果项目有 html-webpack-plugin，自动注入脚本到 HTML
 * 2. 独立模式：输出独立的 JS 文件，用户手动在 HTML 中引入
 */

import type { Compiler, Compilation } from 'webpack';
import { getEarlyErrorCaptureScript } from './early-error-script';

// html-webpack-plugin 的类型（避免直接依赖）
interface HtmlWebpackPluginData {
  headTags: Array<{
    tagName: string;
    innerHTML?: string;
    voidTag: boolean;
    attributes?: Record<string, string | boolean>;
  }>;
  bodyTags: Array<unknown>;
  outputName: string;
  publicPath: string;
  plugin: unknown;
}

interface HtmlWebpackPluginHooks {
  alterAssetTagGroups: {
    tapAsync: (
      name: string,
      callback: (
        data: HtmlWebpackPluginData,
        cb: (err: Error | null, data: HtmlWebpackPluginData) => void,
      ) => void,
    ) => void;
  };
}

interface HtmlWebpackPluginStatic {
  getHooks: (compilation: Compilation) => HtmlWebpackPluginHooks;
}

export interface AemeathEarlyErrorWebpackPluginOptions {
  /**
   * 是否启用
   * @default true
   */
  enabled?: boolean;

  /**
   * 注入模式
   * - 'auto': 自动检测，有 html-webpack-plugin 则注入，否则输出独立文件
   * - 'inject': 强制注入模式（需要 html-webpack-plugin）
   * - 'file': 强制输出独立文件模式
   * @default 'auto'
   */
  mode?: 'auto' | 'inject' | 'file';

  /**
   * 独立文件的输出文件名（仅 mode='file' 或 auto 回退时生效）
   * @default 'aemeath-early-error.js'
   */
  filename?: string;
}

/**
 * Aemeath 早期错误捕获插件（Webpack 4+）
 *
 * @example
 * ```javascript
 * // 自动模式（推荐）- 有 html-webpack-plugin 自动注入，否则输出文件
 * new AemeathEarlyErrorWebpackPlugin()
 *
 * // 强制输出独立文件（不依赖 html-webpack-plugin）
 * new AemeathEarlyErrorWebpackPlugin({ mode: 'file' })
 *
 * // 如果使用 file 模式，需要手动在 HTML 中添加：
 * // <script src="aemeath-early-error.js"></script>  <!-- 放在 <head> 最前面 -->
 * ```
 */
export class AemeathEarlyErrorWebpackPlugin {
  private readonly options: Required<AemeathEarlyErrorWebpackPluginOptions>;

  constructor(options: AemeathEarlyErrorWebpackPluginOptions = {}) {
    this.options = {
      enabled: options.enabled ?? true,
      mode: options.mode ?? 'auto',
      filename: options.filename ?? 'aemeath-early-error.js',
    };
  }

  apply(compiler: Compiler) {
    if (!this.options.enabled) return;

    const pluginName = 'AemeathEarlyErrorWebpackPlugin';

    if (this.options.mode === 'file') {
      // 强制文件模式
      this.emitScriptFile(compiler, pluginName);
      return;
    }

    // 尝试注入模式
    compiler.hooks.compilation.tap(pluginName, (compilation) => {
      let HtmlWebpackPlugin: HtmlWebpackPluginStatic | undefined;

      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        HtmlWebpackPlugin = require('html-webpack-plugin');
      } catch {
        // html-webpack-plugin 不存在
      }

      if (HtmlWebpackPlugin && typeof HtmlWebpackPlugin.getHooks === 'function') {
        // html-webpack-plugin 4+ 存在，使用注入模式
        this.injectViaHtmlPlugin(compilation, HtmlWebpackPlugin, pluginName);
      } else if (this.options.mode === 'inject') {
        // 强制注入模式但没有 html-webpack-plugin
        console.error(
          `[${pluginName}] mode='inject' requires html-webpack-plugin 4+, but it was not found.`,
        );
      } else {
        // auto 模式回退到文件模式
        console.info(
          `[${pluginName}] html-webpack-plugin not found, falling back to file mode.`,
          `\n  Output: ${this.options.filename}`,
          `\n  Please add <script src="${this.options.filename}"></script> to your HTML <head>.`,
        );
      }
    });

    // auto 模式：同时注册文件输出（作为回退）
    if (this.options.mode === 'auto') {
      this.emitScriptFileIfNeeded(compiler, pluginName);
    }
  }

  /**
   * 通过 html-webpack-plugin 注入脚本
   */
  private injectViaHtmlPlugin(
    compilation: Compilation,
    HtmlWebpackPlugin: HtmlWebpackPluginStatic,
    pluginName: string,
  ) {
    const hooks = HtmlWebpackPlugin.getHooks(compilation);

    hooks.alterAssetTagGroups.tapAsync(
      pluginName,
      (
        data: HtmlWebpackPluginData,
        callback: (err: Error | null, data: HtmlWebpackPluginData) => void,
      ) => {
        const scriptTag = {
          tagName: 'script',
          innerHTML: getEarlyErrorCaptureScript(),
          voidTag: false,
        };

        data.headTags.unshift(scriptTag);
        callback(null, data);
      },
    );
  }

  /**
   * 输出独立的脚本文件
   */
  private emitScriptFile(compiler: Compiler, pluginName: string) {
    compiler.hooks.emit.tapAsync(pluginName, (compilation, callback) => {
      const scriptContent = getEarlyErrorCaptureScript();
      
      // 添加到 assets
      compilation.assets[this.options.filename] = {
        source: () => scriptContent,
        size: () => scriptContent.length,
      } as never;

      console.info(
        `[${pluginName}] Emitted ${this.options.filename}`,
        `\n  Please add <script src="${this.options.filename}"></script> to your HTML <head>.`,
      );

      callback();
    });
  }

  /**
   * 如果没有 html-webpack-plugin，输出独立文件
   */
  private emitScriptFileIfNeeded(compiler: Compiler, pluginName: string) {
    let hasHtmlPlugin = false;

    // 第一次 compilation 时检测
    compiler.hooks.compilation.tap(`${pluginName}-detect`, () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const HtmlWebpackPlugin = require('html-webpack-plugin');
        if (HtmlWebpackPlugin && typeof HtmlWebpackPlugin.getHooks === 'function') {
          hasHtmlPlugin = true;
        }
      } catch {
        // 忽略
      }
    });

    // emit 时决定是否输出文件
    compiler.hooks.emit.tapAsync(pluginName, (compilation, callback) => {
      if (!hasHtmlPlugin) {
        const scriptContent = getEarlyErrorCaptureScript();
        
        compilation.assets[this.options.filename] = {
          source: () => scriptContent,
          size: () => scriptContent.length,
        } as never;
      }

      callback();
    });
  }
}

/**
 * 重新导出脚本内容（供其他工具使用）
 */
export { getEarlyErrorCaptureScript } from './early-error-script';
