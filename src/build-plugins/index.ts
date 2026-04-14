/**
 * AemeathJs 构建插件 - 入口文件
 *
 * 所有插件都采用按需导入的方式，避免加载不需要的依赖
 *
 * 版本兼容性：
 * - Vite: 2.0+ ✅
 * - Webpack: 4.0+ ✅ (需要 html-webpack-plugin 4+)
 * - Rsbuild: 1.0+ ✅
 *
 * 使用方式：
 * ```javascript
 * // Vite
 * import { ameathEarlyErrorPlugin } from 'aemeath-js/build-plugins/vite';
 * import { ameathViteSourceMapPlugin } from 'aemeath-js/build-plugins/vite-sourcemap';
 *
 * // Webpack
 * import { AemeathEarlyErrorWebpackPlugin } from 'aemeath-js/build-plugins/webpack';
 * import { AemeathSourceMapWebpackPlugin } from 'aemeath-js/build-plugins/webpack-sourcemap';
 *
 * // Rsbuild
 * import { ameathEarlyErrorPlugin } from 'aemeath-js/build-plugins/rsbuild';
 * import { ameathSourceMapPlugin } from 'aemeath-js/build-plugins/rsbuild-sourcemap';
 * ```
 */

// ==================== 类型导出 ====================

export type { EarlyErrorCaptureOptions, EarlyErrorScriptOptions } from '../plugins/EarlyErrorCapturePlugin';
export type { SourceMapPluginOptions } from './rsbuild-sourcemap';
export type { SourceMapUploadConfig, SourceMapFile } from './sourcemap-uploader';
export type { ViteSourceMapPluginOptions } from './vite-sourcemap';
export type { WebpackSourceMapPluginOptions } from './webpack-sourcemap';

// ==================== 工具函数 ====================

// Source Map 上传核心（不依赖构建工具）
export { uploadSourceMaps } from './sourcemap-uploader';
