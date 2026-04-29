/**
 * Webpack 早期错误捕获插件
 *
 * 支持两种模式：
 * 1. 自动模式：如果项目有 html-webpack-plugin，自动注入脚本到 HTML
 * 2. 独立模式：输出独立的 JS 文件，用户手动在 HTML 中引入
 */

import type { Compiler, Compilation } from 'webpack';
import { getEarlyErrorCaptureScript, type EarlyErrorScriptOptions } from './early-error-script';

// R14.5: re-export EarlyErrorScriptOptions 让用户可从子路径直接 import，
// 避免依赖内部路径 './early-error-script'。
export type { EarlyErrorScriptOptions } from './early-error-script';

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

export interface AemeathEarlyErrorWebpackPluginOptions extends EarlyErrorScriptOptions {
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
 * // 启用 fallback 上报
 * new AemeathEarlyErrorWebpackPlugin({
 *   fallbackEndpoint: 'https://example.com/api/logs',
 *   fallbackTimeout: 10000,
 *   fallbackTransport: 'xhr',
 * })
 *
 * // 如果使用 file 模式，需要手动在 HTML 中添加：
 * // <script src="aemeath-early-error.js"></script>  <!-- 放在 <head> 最前面 -->
 * ```
 */
export class AemeathEarlyErrorWebpackPlugin {
  private readonly pluginOptions: { enabled: boolean; mode: 'auto' | 'inject' | 'file'; filename: string };
  private readonly scriptOptions: EarlyErrorScriptOptions;

  constructor(options: AemeathEarlyErrorWebpackPluginOptions = {}) {
    const { enabled, mode, filename, ...scriptOpts } = options;
    this.pluginOptions = {
      enabled: enabled ?? true,
      mode: mode ?? 'auto',
      filename: filename ?? 'aemeath-early-error.js',
    };
    this.scriptOptions = scriptOpts;
  }

  apply(compiler: Compiler) {
    if (!this.pluginOptions.enabled) return;

    const pluginName = 'AemeathEarlyErrorWebpackPlugin';

    if (this.pluginOptions.mode === 'file') {
      this.emitScriptFile(compiler, pluginName);
      return;
    }

    compiler.hooks.compilation.tap(pluginName, (compilation) => {
      let HtmlWebpackPlugin: HtmlWebpackPluginStatic | undefined;

      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        HtmlWebpackPlugin = require('html-webpack-plugin');
      } catch {
        // html-webpack-plugin 不存在
      }

      if (HtmlWebpackPlugin && typeof HtmlWebpackPlugin.getHooks === 'function') {
        this.injectViaHtmlPlugin(compilation, HtmlWebpackPlugin, pluginName);
      } else if (this.pluginOptions.mode === 'inject') {
        console.error(
          `[${pluginName}] mode='inject' requires html-webpack-plugin 4+, but it was not found.`,
        );
      } else {
        console.info(
          `[${pluginName}] html-webpack-plugin not found, falling back to file mode.`,
          `\n  Output: ${this.pluginOptions.filename}`,
          `\n  Please add <script src="${this.pluginOptions.filename}"></script> to your HTML <head>.`,
        );
      }
    });

    if (this.pluginOptions.mode === 'auto') {
      this.emitScriptFileIfNeeded(compiler, pluginName);
    }
  }

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
          innerHTML: getEarlyErrorCaptureScript(this.scriptOptions),
          voidTag: false,
        };

        data.headTags.unshift(scriptTag);
        callback(null, data);
      },
    );
  }

  private emitScriptFile(compiler: Compiler, pluginName: string) {
    compiler.hooks.emit.tapAsync(pluginName, (compilation, callback) => {
      const scriptContent = getEarlyErrorCaptureScript(this.scriptOptions);
      
      compilation.assets[this.pluginOptions.filename] = {
        source: () => scriptContent,
        size: () => scriptContent.length,
      } as never;

      console.info(
        `[${pluginName}] Emitted ${this.pluginOptions.filename}`,
        `\n  Please add <script src="${this.pluginOptions.filename}"></script> to your HTML <head>.`,
      );

      callback();
    });
  }

  private emitScriptFileIfNeeded(compiler: Compiler, pluginName: string) {
    let hasHtmlPlugin = false;

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

    compiler.hooks.emit.tapAsync(pluginName, (compilation, callback) => {
      if (!hasHtmlPlugin) {
        const scriptContent = getEarlyErrorCaptureScript(this.scriptOptions);
        
        compilation.assets[this.pluginOptions.filename] = {
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
