/**
 * SafeGuardPlugin - 生产环境配置
 */

import {
  AemeathLogger,
  SafeGuardPlugin,
  ErrorCapturePlugin,
  UploadPlugin,
} from 'aemeath-js';

const logger = new AemeathLogger();

// ==================== 配置1: 安全保护（第一个） ====================

logger.use(
  new SafeGuardPlugin({
    maxErrors: 50, // 生产环境更严格
    resetInterval: 60000, // 60 秒重置
    rateLimit: 50, // 每秒最多 50 条
    enableRecursionGuard: true,
  }),
);

// ==================== 配置2: 错误捕获 ====================

logger.use(
  new ErrorCapturePlugin({
    captureUnhandledRejection: true,
    captureResourceError: true,
  }),
);

// ==================== 配置3: 上传 ====================

logger.use(
  new UploadPlugin({
    onUpload: async (log) => {
      const response = await fetch('/api/logs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getAuthToken()}`,
        },
        body: JSON.stringify(log),
      });

      if (!response.ok) {
        return { success: false, shouldRetry: true, error: `Upload failed: ${response.status}` };
      }
      return { success: true };
    },

    queue: {
      maxSize: 100,
      uploadInterval: 5000,
      concurrency: 1,
      maxRetries: 3,
    },
  }),
);

// ==================== 健康监控 ====================

// 定期检查健康状态
setInterval(() => {
  const health = logger.getHealth?.();

  if (!health) return;

  // 发送健康指标到监控系统
  sendMetrics({
    logger_error_count: health.errorCount,
    logger_log_count: health.logCount,
    logger_is_healthy: health.isHealthy ? 1 : 0,
    logger_is_paused: health.isPaused ? 1 : 0,
    logger_uptime: health.uptime,
  });

  // 错误率超过 80% 时告警
  if (health.errorCount > 40) {
    sendAlert({
      level: 'warning',
      message: 'Logger error rate high',
      details: health,
    });
  }
}, 30000); // 每 30 秒检查一次

// ==================== 事件监听 ====================

// Logger 暂停时发送告警
logger.on('paused', () => {
  console.error('[SafeGuard] Logger 已暂停');

  sendAlert({
    level: 'critical',
    message: 'Logger paused due to too many errors or high rate',
    details: logger.getHealth?.(),
  });
});

// Logger 恢复时记录
logger.on('resumed', () => {
  console.info('[SafeGuard] Logger 已恢复');

  sendAlert({
    level: 'info',
    message: 'Logger resumed',
    details: logger.getHealth?.(),
  });
});

// ==================== 工具函数 ====================

function getAuthToken(): string {
  return localStorage.getItem('auth_token') || '';
}

function sendMetrics(metrics: Record<string, number>) {
  // 发送到监控系统（Prometheus、DataDog 等）
  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    navigator.sendBeacon('/api/metrics', JSON.stringify(metrics));
  }
}

function sendAlert(alert: {
  level: 'info' | 'warning' | 'critical';
  message: string;
  details?: any;
}) {
  // 发送告警（PagerDuty、Slack 等）
  fetch('/api/alerts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(alert),
  }).catch(console.error);
}

export { logger };
