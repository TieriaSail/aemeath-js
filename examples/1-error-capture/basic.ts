/**
 * 模块1：错误捕获 - 基础示例
 *
 * 最简单的错误捕获配置
 */

import { Logger, ErrorCapturePlugin } from 'aemeath-js';

// 创建 logger
const logger = new Logger();

// 添加错误捕获插件
logger.use(new ErrorCapturePlugin());

// ✅ 现在会自动捕获：
// - 全局 JS 错误 (window.onerror)
// - Promise 未处理错误 (unhandledrejection)
// - 资源加载失败 (script, img, link 等)

// 测试
setTimeout(() => {
  throw new Error('This will be captured automatically!');
}, 1000);

console.log('✅ Error capture plugin is ready!');

export default logger;
