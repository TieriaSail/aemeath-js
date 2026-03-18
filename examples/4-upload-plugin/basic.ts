/**
 * Upload Plugin - Basic Example
 *
 * 最简单的使用方式
 */

import { AemeathLogger, UploadPlugin } from 'aemeath-js';

const logger = new AemeathLogger();

// 添加 Upload Plugin
logger.use(
  new UploadPlugin({
    // 上传回调（必需）- 返回 UploadResult
    onUpload: async (log) => {
      try {
        // 完全控制如何上传日志
        const response = await fetch('/api/logs', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(log),
        });

        const data = await response.json();

        // 检查业务返回码
        if (data.code === 200) {
          return { success: true };
        } else {
          return {
            success: false,
            shouldRetry: true, // 业务错误，需要重试
            error: data.message,
          };
        }
      } catch (error) {
        // 网络错误
        return {
          success: false,
          shouldRetry: true, // 网络错误，需要重试
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  }),
);

// 使用 logger
logger.info('Application started', {
  tags: { action: 'app-start' },
});
logger.track('page_view', {
  tags: { page: '/home' },
});
logger.error('Something went wrong', {
  error: new Error('Test error'),
  tags: { severity: 'high' },
});

// 日志会自动进入队列，并串行上传
// track 和 info 同优先级，但后端可通过 level=track 独立筛选埋点数据
