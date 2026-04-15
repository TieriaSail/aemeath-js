import { defineConfig } from 'tsup';

export default defineConfig([
  // 主构建：ESM + CJS（用于 npm 包）
  {
    entry: {
      index: 'src/index.ts',
      'core/Logger': 'src/core/Logger.ts',
      'plugins/ErrorCapturePlugin': 'src/plugins/ErrorCapturePlugin.ts',
      'plugins/EarlyErrorCapturePlugin': 'src/plugins/EarlyErrorCapturePlugin.ts',
      'plugins/UploadPlugin': 'src/plugins/UploadPlugin.ts',
      'plugins/PerformancePlugin': 'src/plugins/PerformancePlugin.ts',
      'plugins/SafeGuardPlugin': 'src/plugins/SafeGuardPlugin.ts',
      'plugins/NetworkPlugin': 'src/plugins/NetworkPlugin.ts',
      parser: 'src/parser/index.ts',
      'parser/SourceMapParser.client': 'src/parser/SourceMapParser.client.ts',
      singleton: 'src/singleton/index.ts',
      'build-plugins': 'src/build-plugins/index.ts',
      'build-plugins/vite': 'src/build-plugins/vite.ts',
      'build-plugins/vite-sourcemap': 'src/build-plugins/vite-sourcemap.ts',
      'build-plugins/webpack': 'src/build-plugins/webpack.ts',
      'build-plugins/webpack-sourcemap': 'src/build-plugins/webpack-sourcemap.ts',
      'build-plugins/rsbuild': 'src/build-plugins/rsbuild.ts',
      'build-plugins/rsbuild-sourcemap': 'src/build-plugins/rsbuild-sourcemap.ts',
      react: 'src/integrations/react.tsx',
      vue: 'src/integrations/vue.ts',
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
    target: 'es2017',
    outDir: 'dist',
  },

  // 浏览器构建：IIFE（用于 <script> 直接引入）
  {
    entry: {
      'aemeath-js': 'src/browser/index.ts',
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
