/**
 * Webpack Source Map 自动上传插件
 */

import type { Compiler } from 'webpack';
import { uploadSourceMaps, type SourceMapFile } from './sourcemap-uploader';

/**
 * Source Map 插件配置
 */
export interface WebpackSourceMapPluginOptions {
  /**
   * 是否启用
   * @default true
   */
  enabled?: boolean;

  /**
   * 版本号（可选，默认使用时间戳）
   */
  version?: string;

  /**
   * 自定义上传函数
   *
   * @example
   * ```javascript
   * onUpload: async (file) => {
   *   await fetch('/api/sourcemaps', {
   *     method: 'POST',
   *     headers: {
   *       'X-File-Path': file.filename,
   *       'X-Version': file.version
   *     },
   *     body: file.content
   *   });
   * }
   * ```
   */
  onUpload: (file: SourceMapFile) => Promise<void>;

  /**
   * 上传后是否删除 Source Map 文件
   * @default true
   */
  deleteAfterUpload?: boolean;
}

/**
 * Aemeath Source Map 自动上传插件（Webpack）
 *
 * 支持 Webpack 4.0+
 *
 * @example
 * ```javascript
 * // webpack.config.js
 * const { AemeathSourceMapWebpackPlugin } = require('aemeath-js/build-plugins/webpack-sourcemap');
 *
 * module.exports = {
 *   devtool: 'source-map',
 *   plugins: [
 *     new AemeathSourceMapWebpackPlugin({
 *       onUpload: async (file) => {
 *         await fetch('/api/sourcemaps', {
 *           method: 'POST',
 *           body: file.content
 *         });
 *       }
 *     })
 *   ]
 * };
 * ```
 */
export class AemeathSourceMapWebpackPlugin {
  private readonly options: Required<WebpackSourceMapPluginOptions>;

  constructor(options: WebpackSourceMapPluginOptions) {
    this.options = {
      enabled: options.enabled ?? true,
      version: options.version ?? '',
      onUpload: options.onUpload,
      deleteAfterUpload: options.deleteAfterUpload ?? true,
    };
  }

  apply(compiler: Compiler) {
    if (!this.options.enabled) return;

    const pluginName = 'AemeathSourceMapWebpackPlugin';

    // Webpack 4+ 使用 afterEmit hook
    // 这个 hook 在所有文件都写入磁盘后触发
    compiler.hooks.afterEmit.tapAsync(
      pluginName,
      async (compilation, callback) => {
        try {
          const outputPath = compilation.outputOptions.path;
          if (!outputPath) {
            console.warn('[Aemeath] Could not determine output path');
            callback();
            return;
          }

          await uploadSourceMaps(outputPath, {
            version: this.options.version || undefined,
            onUpload: this.options.onUpload,
            deleteAfterUpload: this.options.deleteAfterUpload,
          });

          callback();
        } catch (error) {
          console.error('[Aemeath] Source map upload error:', error);
          callback();
        }
      },
    );
  }
}

