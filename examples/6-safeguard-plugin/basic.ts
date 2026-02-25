/**
 * SafeGuardPlugin - 基础使用示例
 */

import { Logger, SafeGuardPlugin, ErrorCapturePlugin } from 'aemeath-js';

// 创建 Logger
const logger = new Logger();

// ⚠️ 重要：SafeGuard 应该第一个安装
logger.use(
  new SafeGuardPlugin({
    // 最大错误数（超过后暂停）
    maxErrors: 100,

    // 重置间隔（ms）
    resetInterval: 60000, // 60 秒

    // 频率限制（每秒最多记录多少条）
    rateLimit: 100,

    // 启用递归保护
    enableRecursionGuard: true,
  }),
);

// 然后安装其他插件
logger.use(new ErrorCapturePlugin());

// 现在 Logger 是安全的，不会：
// 1. 陷入无限递归
// 2. 产生日志风暴
// 3. 因为错误过多而拖垮应用

// 使用示例
logger.info('App started');
logger.error('Something went wrong');

export { logger };
