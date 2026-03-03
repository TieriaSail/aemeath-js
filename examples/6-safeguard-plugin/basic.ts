/**
 * SafeGuardPlugin v2 - 基础使用示例
 */

import { AemeathLogger, SafeGuardPlugin, ErrorCapturePlugin } from 'aemeath-js';

// 创建 Logger
const logger = new AemeathLogger();

// ⚠️ 重要：SafeGuard 应该第一个安装（它通过 beforeLog hook 在日志进入管道前拦截）
logger.use(
  new SafeGuardPlugin({
    // 运行模式：'standard' | 'cautious' | 'strict'
    // - standard: 超限直接丢弃
    // - cautious: 暂存到内存 parking lot，空闲时回放
    // - strict: 持久化 parking lot（localStorage）
    mode: 'standard',

    // 频率限制（每秒最多记录多少条，滑动窗口）
    rateLimit: 100,

    // 最大错误数（超过后熔断器打开）
    maxErrors: 100,

    // 熔断器冷却期（ms），从 open → half-open 的等待时间
    cooldownPeriod: 30000, // 30 秒

    // 重复日志合并窗口（ms），同一条日志在此窗口内合并为 tags.repeatedCount
    mergeWindow: 2000,

    // 启用递归保护（硬阻断）
    enableRecursionGuard: true,
  }),
);

// 然后安装其他插件
logger.use(new ErrorCapturePlugin());

// 现在 Logger 是安全的，不会：
// 1. 陷入无限递归（递归硬阻断）
// 2. 产生日志风暴（滑动窗口限流 + 合并）
// 3. 因为错误过多而拖垮应用（熔断器: closed → open → half-open）

// 使用示例
logger.info('App started');
logger.error('Something went wrong');

export { logger };
