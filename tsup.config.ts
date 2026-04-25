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
      'platform/browser': 'src/platform/browser.ts',
      'platform/miniapp': 'src/platform/miniapp.ts',
      'platform/noop': 'src/platform/noop.ts',
      'platform/detect': 'src/platform/detect.ts',
      platform: 'src/platform/index.ts',
      'instrumentation/types': 'src/instrumentation/types.ts',
      'instrumentation/helpers': 'src/instrumentation/helpers.ts',
      'instrumentation/fetch': 'src/instrumentation/fetch.ts',
      'instrumentation/xhr': 'src/instrumentation/xhr.ts',
      'instrumentation/miniapp-request': 'src/instrumentation/miniapp-request.ts',
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

  // 微信小程序构建：单文件 CJS（dist-miniprogram/index.js）
  //
  // 微信开发者工具 的 npm 构建器会读取 package.json 的 `miniprogram` 字段，
  // 将该目录原样拷贝到 `miniprogram_npm/aemeath-js/` 下。该构建器对 ESM、
  // 动态 import、文件后缀 `.cjs`、代码分片（chunk）均不友好，因此此构建：
  // - 强制 CJS 单文件（splitting: false）
  // - 强制 `.js` 后缀（outExtension）
  // - 目标 ES2017（小程序基础库普遍支持）
  // - 不生成 d.ts（小程序侧不需要）
  // - 不做 external（source-map-js 在小程序侧不会被引用到，但保留 external
  //   避免动态 require 穿透到 miniprogram_npm 外部）
  {
    entry: {
      index: 'src/miniprogram.ts',
    },
    format: ['cjs'],
    dts: false,
    splitting: false,
    bundle: true,
    sourcemap: false,
    clean: false, // 主构建已清理根 dist，不动 dist-miniprogram
    minify: true,
    treeshake: true,
    external: ['source-map-js'],
    target: 'es2017',
    outDir: 'dist-miniprogram',
    outExtension: () => ({ js: '.js' }),
    platform: 'neutral',
    banner: {
      js: '/* aemeath-js - WeChat Miniprogram Bundle */',
    },
    // 根 package.json 声明了 "type": "module"，该产物为 CJS，
    // 写入一个本地 package.json 覆盖 type 字段，避免 Node 误解析
    // （微信开发者工具不读此文件，仅影响 Node 侧 require）。
    onSuccess: async () => {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      mkdirSync('dist-miniprogram', { recursive: true });
      writeFileSync(
        'dist-miniprogram/package.json',
        `${JSON.stringify({ type: 'commonjs', main: 'index.js' }, null, 2)}\n`,
      );
    },
  },
]);
