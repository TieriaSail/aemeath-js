/**
 * 模块3：早期错误捕获 - 基础示例
 *
 * 在 React/Vue 挂载前就开始捕获错误
 */

import { Logger, EarlyErrorCapturePlugin } from 'aemeath-js';

// 创建 logger
const logger = new Logger();

// 添加早期错误捕获插件
logger.use(
  new EarlyErrorCapturePlugin({
    enabled: true,
  }),
);

// ✅ 现在会捕获：
// 1. 浏览器兼容性错误
// 2. 资源加载失败（CSS、JS、图片等）
// 3. Chunk 加载失败
// 4. 在 window.__EARLY_ERRORS__ 中缓存的早期错误

// 早期错误会自动被提取并上报
console.log('✅ Early error capture plugin is ready!');

// 检查是否有早期错误
if (window.__EARLY_ERRORS__ && window.__EARLY_ERRORS__.length > 0) {
  console.log(`📊 Captured ${window.__EARLY_ERRORS__.length} early errors`);
}

export default logger;
