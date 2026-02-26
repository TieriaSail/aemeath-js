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

    // 监控慢资源（>1s）
    monitorResources: true,

    // 监控长任务（阻塞主线程）
    monitorLongTasks: true,
    longTaskThreshold: 50, // >50ms 的任务

    // 采样率（100% = 所有用户）
    sampleRate: 1,
  }),
);

// 插件会自动记录以下指标：
// 1. LCP (Largest Contentful Paint) - 最大内容绘制
// 2. FID (First Input Delay) - 首次输入延迟
// 3. CLS (Cumulative Layout Shift) - 累积布局偏移
// 4. FCP (First Contentful Paint) - 首次内容绘制
// 5. TTFB (Time to First Byte) - 首字节时间

// 日志示例：
// {
//   level: 'info',
//   message: '性能指标',
//   tags: { category: 'performance', metric: 'LCP', rating: 'good' },
//   context: {
//     metric: {
//       name: 'LCP',
//       value: 2450,
//       rating: 'good'
//     }
//   }
// }

export { logger };
