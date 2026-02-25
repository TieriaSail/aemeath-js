/**
 * Upload Plugin - With Axios
 *
 * 使用 Axios 作为 HTTP 客户端
 */

import { Logger, UploadPlugin } from 'aemeath-js';
// import axios from 'axios';

// 模拟 axios（实际使用时需要安装 axios）
const axios = {
  post: async (url: string, data: unknown, config?: unknown) => {
    console.log('Axios POST:', url, data, config);
    return { data: { success: true } };
  },
};

const logger = new Logger();

logger.use(
  new UploadPlugin({
    onUpload: async (log) => {
      try {
        // 使用 axios 上传
        const response = await axios.post('/api/logs', log, {
          headers: {
            Authorization: `Bearer ${getToken()}`,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
          withCredentials: true,
        });

        // 检查业务返回码
        if (response.data?.code === 200) {
          return { success: true };
        } else {
          return {
            success: false,
            shouldRetry: true,
            error: response.data?.message || 'Upload failed',
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

    getPriority: (log) => {
      // 业务优先级逻辑
      if (log.level === 'error') {
        // 支付相关错误最高优先级
        if (log.extra?.module === 'payment') return 100;
        return 80;
      }

      if (log.level === 'warn') return 50;
      return 10;
    },
  }),
);

function getToken(): string {
  return 'mock-token';
}

// 使用
logger.error('Payment error', {
  error: new Error('Card declined'),
  tags: { module: 'payment' }, // 会有最高优先级
  context: { transactionId: 'tx-12345' },
});

logger.warn('Cache miss', {
  tags: { cache: 'miss' },
  context: { key: 'user-123' },
});
