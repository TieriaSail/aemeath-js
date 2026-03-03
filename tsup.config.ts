import { defineConfig } from 'tsup';

export default defineConfig([
  // 主构建：ESM + CJS（用于 npm 包）
  {
    entry: {
      index: 'index.ts',
      'core/Logger': 'core/Logger.ts',
      'plugins/ErrorCapturePlugin': 'plugins/ErrorCapturePlugin.ts',
      'plugins/EarlyErrorCapturePlugin': 'plugins/EarlyErrorCapturePlugin.ts',
      'plugins/UploadPlugin': 'plugins/UploadPlugin.ts',
      'plugins/PerformancePlugin': 'plugins/PerformancePlugin.ts',
      'plugins/SafeGuardPlugin': 'plugins/SafeGuardPlugin.ts',
      'plugins/NetworkPlugin': 'plugins/NetworkPlugin.ts',
      parser: 'parser/index.ts',
      'parser/SourceMapParser.client': 'parser/SourceMapParser.client.ts',
      singleton: 'singleton/index.ts',
      // 构建插件（按构建工具分离）
      'build-plugins': 'build-plugins/index.ts',
      'build-plugins/vite': 'build-plugins/vite.ts',
      'build-plugins/vite-sourcemap': 'build-plugins/vite-sourcemap.ts',
      'build-plugins/webpack': 'build-plugins/webpack.ts',
      'build-plugins/webpack-sourcemap': 'build-plugins/webpack-sourcemap.ts',
      'build-plugins/rsbuild': 'build-plugins/rsbuild.ts',
      'build-plugins/rsbuild-sourcemap': 'build-plugins/rsbuild-sourcemap.ts',
      // 框架集成
      react: 'integrations/react.tsx',
      vue: 'integrations/vue.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    splitting: true,
    sourcemap: false,
    clean: true,
    minify: false,
    treeshake: true,
    external: [
      'source-map-js',
      'react',
      'react-dom',
      'vue',
      'vite',
      'webpack',
      '@rsbuild/core',
      'html-webpack-plugin',
    ],
    target: 'es2020',
    outDir: 'dist',
  },

  // 浏览器构建：IIFE（用于 <script> 直接引入）
  {
    entry: {
      'aemeath-js': 'browser/index.ts',
    },
    format: ['iife'],
    globalName: 'AemeathJs',
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: false, // 不清理，因为主构建已经清理了
    minify: true, // 压缩
    treeshake: true,
    // 不 external，全部打包进去
    external: [],
    target: 'es2017', // 兼容更多浏览器
    outDir: 'dist',
    // 添加 banner
    banner: {
      js: '/* aemeath-js - Browser Bundle */',
    },
  },
]);
