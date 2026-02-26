/**
 * 模块3：早期错误捕获 - 构建插件配置
 *
 * 在构建时自动注入早期错误监控脚本
 */

// ==================== Rsbuild 配置 ====================

/*
// rsbuild.config.ts
import { defineConfig } from '@rsbuild/core';
import { ameathEarlyErrorPlugin } from 'aemeath-js/build-plugins/rsbuild';

export default defineConfig({
  plugins: [
    // 添加早期错误捕获插件
    ameathEarlyErrorPlugin({
      enabled: process.env.NODE_ENV === 'production',
    })
  ],
  
  output: {
    // 生成 hidden source map（不泄露）
    sourceMap: process.env.NODE_ENV === 'production'
      ? { js: 'hidden-source-map', css: false }
      : { js: 'cheap-module-source-map', css: true }
  }
});
*/

// ==================== Webpack 配置 ====================

/*
// webpack.config.js
const { AemeathEarlyErrorWebpackPlugin } = require('aemeath-js/build-plugins/webpack');

module.exports = {
  plugins: [
    new AemeathEarlyErrorWebpackPlugin({
      enabled: process.env.NODE_ENV === 'production',
      // mode: 'auto' - 自动检测，有 html-webpack-plugin 则注入，否则输出文件
      // mode: 'inject' - 强制注入（需要 html-webpack-plugin 4+）
      // mode: 'file' - 强制输出独立 JS 文件
    })
  ]
};
*/

// ==================== Vite 配置 ====================

/*
// vite.config.ts
import { defineConfig } from 'vite';
import { ameathEarlyErrorPlugin } from 'aemeath-js/build-plugins/vite';

export default defineConfig({
  plugins: [
    ameathEarlyErrorPlugin({
      enabled: process.env.NODE_ENV === 'production',
    })
  ]
});
*/

// ==================== 运行时配置 ====================

// src/utils/logger.ts
import { AemeathLogger } from 'aemeath-js';
import { EarlyErrorCapturePlugin } from 'aemeath-js';

const logger = new AemeathLogger();

// 添加运行时插件（提取早期错误）
logger.use(
  new EarlyErrorCapturePlugin({
    enabled: true,
  }),
);

export default logger;

// ==================== 工作流程 ====================

/*
1. 构建时：
   - 构建插件在 HTML 的 <head> 中注入监控脚本
   - 监控脚本在页面加载第一时间开始监控
   - 捕获的错误暂存在 window.__EARLY_ERRORS__

2. 运行时：
   - React/Vue 挂载后，Logger 初始化
   - EarlyErrorCapturePlugin 提取 window.__EARLY_ERRORS__
   - 统一上报到服务器

3. 保底机制：
   - 如果 Logger 10秒内没有初始化
   - 早期错误会通过 fallbackEndpoint 上报
   - 确保错误不丢失
*/

// ==================== fallbackEndpoint 后端示例 ====================

/*
// Node.js + Express
app.post('/api/logs/early', (req, res) => {
  const { errors, type, timestamp } = req.body;
  
  // 保存早期错误
  console.log('Early errors:', errors);
  
  // 可以发送告警
  if (errors.some(e => e.type === 'resource-error')) {
    sendAlert('Resource loading failed!');
  }
  
  res.json({ success: true });
});
*/

console.log('✅ Build plugin configuration ready!');
console.log('📝 See comments above for configuration examples');
