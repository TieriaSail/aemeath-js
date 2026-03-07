/**
 * Vite Source Map 自动上传插件
 */

import type { Plugin, ResolvedConfig } from 'vite';
import { uploadSourceMaps, type SourceMapFile } from './sourcemap-uploader';

/**
 * Source Map 插件配置
 */
export interface ViteSourceMapPluginOptions {
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
 * Aemeath Source Map 自动上传插件（Vite）
 *
 * 支持 Vite 2.0+
 *
 * @example
 * ```javascript
 * // vite.config.ts
 * import { ameathViteSourceMapPlugin } from 'aemeath-js/build-plugins/vite-sourcemap';
 *
 * export default defineConfig({
 *   build: {
 *     sourcemap: true,
 *   },
 *   plugins: [
 *     ameathViteSourceMapPlugin({
 *       onUpload: async (file) => {
 *         await fetch('/api/sourcemaps', {
 *           method: 'POST',
 *           body: file.content
 *         });
 *       }
 *     })
 *   ]
 * });
 * ```
 */
export function ameathViteSourceMapPlugin(
  options: ViteSourceMapPluginOptions,
): Plugin {
  const {
    enabled = true,
    version,
    onUpload,
    deleteAfterUpload = true,
  } = options;

  let config: ResolvedConfig;

  return {
    name: 'aemeath-sourcemap-upload',
    apply: 'build', // 只在构建时运行

    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },

    async closeBundle() {
      if (!enabled) return;

      // 获取输出目录
      const outputPath = config.build.outDir;
      if (!outputPath) {
        console.warn('[Aemeath] Could not determine output path');
        return;
      }

      // 确保使用绝对路径
      const { resolve } = await import('path');
      const absoluteOutputPath = resolve(config.root, outputPath);

      await uploadSourceMaps(absoluteOutputPath, {
        version,
        onUpload,
        deleteAfterUpload,
      });
    },
  };
}

