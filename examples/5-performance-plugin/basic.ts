/**
 * PerformancePlugin - 基础使用示例
 */

import { AemeathLogger, PerformancePlugin } from 'aemeath-js';

// 创建 Logger
const logger = new AemeathLogger();

// 安装性能监控插件
logger.use(
  new PerformancePlugin({
    // 监控 Web Vitals（Google 核心性能指标）
    monitorWebVitals: true,

    // 监控慢资源（默认 >1000ms）
    monitorResources: true,
    slowResourceThreshold: 1000,

    // 监控长任务（阻塞主线程）
    monitorLongTasks: true,
    longTaskThreshold: 50, // >50ms 的任务

    // 采样率（100% = 所有用户），不影响手动 mark/measure
    sampleRate: 1,
  }),
);

// 插件会自动记录以下指标（在页面隐藏时上报最终值）：
// 1. LCP (Largest Contentful Paint) - 最大内容绘制
// 2. INP (Interaction to Next Paint) - 交互到下一帧绘制（2024 年起替代 FID）
// 3. CLS (Cumulative Layout Shift) - 累积布局偏移（Session Window 算法）
// 4. FCP (First Contentful Paint) - 首次内容绘制（立即上报）
// 5. TTFB (Time to First Byte) - 首字节时间（立即上报）

// 日志示例：
// {
//   level: 'info',
//   message: '[performance] web-vital',
//   tags: { category: 'performance', metric: 'INP', rating: 'good' },
//   context: {
//     metric: {
//       name: 'INP',
//       value: 120,
//       rating: 'good'
//     }
//   }
// }

export { logger };
