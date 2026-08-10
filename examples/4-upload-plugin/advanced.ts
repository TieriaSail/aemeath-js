/**
 * Upload Plugin - Advanced Example
 *
 * 高级用法：返回值控制、错误处理、监控
 */

import { AemeathLogger, UploadPlugin, classifyHttpUploadResponse } from 'aemeath-js';
import type { LogEntry, UploadResult } from 'aemeath-js';

// 创建一个完整的上传函数（返回 UploadResult）
async function uploadLog(log: LogEntry): Promise<UploadResult> {
  try {
    const response = await fetch('/api/logs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getAuthToken()}`,
      },
      body: JSON.stringify(log),
      signal: AbortSignal.timeout(5000), // 5秒超时
    });

    // 401 时先刷新凭证；仍失败则交给统一 HTTP 分类器决定是否重试。
    if (!response.ok) {
      if (response.status === 401) {
        await refreshAuthToken();
      }
      return classifyHttpUploadResponse(
        response.status,
        response.headers.get('Retry-After'),
      );
    }

    // 检查业务返回码
    const data = await response.json();
    if (data.code === 200) {
      return { success: true };
    } else {
      return {
        success: false,
        shouldRetry: true,
        error: data.message || 'Business error',
      };
    }
  } catch (error) {
    // 交回 SDK 区分 fetch 网络失败、超时与业务主动取消。
    // UploadPlugin 会把异常收敛成 UploadResult，不会向日志主链路抛出。
    throw error;
  }
}

const logger = new AemeathLogger();

const uploadPlugin = new UploadPlugin({
  onUpload: uploadLog,

  // 复杂的优先级逻辑
  getPriority: (log) => {
    let priority = 10;

    // 基于 level
    if (log.level === 'error') priority = 100;
    else if (log.level === 'warn') priority = 50;
    else if (log.level === 'info') priority = 20;

    // 基于业务模块
    if (log.tags?.module === 'payment') priority += 20;
    if (log.tags?.module === 'auth') priority += 15;

    // 基于用户状态
    if (log.context?.isPremiumUser) priority += 10;

    // 基于紧急标记
    if (log.tags?.urgent) priority += 30;

    return priority;
  },

  // 队列配置
  queue: {
    maxSize: 200,
    concurrency: 1,
    uploadInterval: 5000,
    maxRetries: 5, // UploadPlugin 会自动重试失败的日志
  },

  // 缓存配置
  cache: {
    enabled: true,
    key: 'app_logs_queue',
  },
});

logger.use(uploadPlugin);

// 监控队列状态
setInterval(() => {
  const status = uploadPlugin.getQueueStatus();
  console.log('Queue status:', {
    length: status.length,
    isProcessing: status.isProcessing,
    items: status.items,
  });
}, 10000);

// 使用示例
logger.error('Payment failed', {
  error: new Error('Card declined'),
  tags: { module: 'payment', urgent: true },
  context: { transactionId: 'tx-12345', isPremiumUser: true },
});

logger.warn('API slow', {
  tags: { performance: 'slow-api', module: 'auth' },
  context: { endpoint: '/api/auth', duration: 5000 },
});

logger.info('User action', {
  tags: { action: 'click', component: 'button' },
  context: { userId: '12345', page: '/home' },
});

// 工具函数
function getAuthToken(): string {
  return localStorage.getItem('auth_token') || '';
}

async function refreshAuthToken(): Promise<void> {
  // 刷新 token 的逻辑
  console.log('Refreshing auth token...');
}
