/**
 * Rsbuild Source Map 自动上传插件
 */

import type { RsbuildPlugin } from '@rsbuild/core';
import { uploadSourceMaps, type SourceMapFile } from './sourcemap-uploader';

/**
 * Source Map 插件配置
 */
export interface SourceMapPluginOptions {
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
 * Aemeath Source Map 自动上传插件（Rsbuild）
 *
 * @example
 * ```javascript
 * import { ameathSourceMapPlugin } from 'aemeath-js/build-plugins/rsbuild-sourcemap';
 *
 * export default {
 *   plugins: [
 *     ameathSourceMapPlugin({
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
export function ameathSourceMapPlugin(
  options: SourceMapPluginOptions,
): RsbuildPlugin {
  const {
    enabled = true,
    version,
    onUpload,
    deleteAfterUpload = true,
  } = options;

  return {
    name: 'aemeath-sourcemap-upload',

    setup(api) {
      if (!enabled) return;

      api.onAfterBuild(async ({ stats }) => {
        const outputPath = stats?.toJson({})?.outputPath;
        if (!outputPath) {
          console.warn('[Aemeath] Could not determine output path');
          return;
        }

        await uploadSourceMaps(outputPath, {
          version,
          onUpload,
          deleteAfterUpload,
        });
      });
    },
  };
}
