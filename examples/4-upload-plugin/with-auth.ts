/**
 * Upload Plugin - With Authentication
 *
 * 带认证的上传示例
 */

import { AemeathLogger, UploadPlugin } from 'aemeath-js';

// 模拟获取 token 的函数
function getAuthToken(): string {
  return localStorage.getItem('auth_token') || '';
}

const logger = new AemeathLogger();

logger.use(
  new UploadPlugin({
    onUpload: async (log) => {
      try {
        const token = getAuthToken();

        const response = await fetch('https://api.example.com/logs', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-App-Version': '1.0.0',
          },
          body: JSON.stringify(log),
        });

        const data = await response.json();

        if (data.code === 200) {
          return { success: true };
        } else {
          return {
            success: false,
            shouldRetry: true,
            error: data.message,
          };
        }
      } catch (error) {
        return {
          success: false,
          shouldRetry: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    // 自定义优先级
    getPriority: (log) => {
      if (log.level === 'error') return 100;
      if (log.level === 'warn') return 50;
      return 10;
    },

    // 队列配置
    queue: {
      maxSize: 100,
      maxRetries: 3,
      uploadInterval: 30000, // 30秒
    },

    // 缓存配置
    cache: {
      enabled: true,
      key: 'app_logs_queue',
    },
  }),
);

// 使用示例
logger.error('Payment failed', {
  error: new Error('Network timeout'),
  tags: { action: 'payment', status: 'failed' },
  context: {
    orderId: '12345',
    userId: '67890',
  },
});

logger.warn('API slow', {
  tags: { performance: 'slow-api' },
  context: {
    endpoint: '/api/data',
    duration: 5000,
  },
});
