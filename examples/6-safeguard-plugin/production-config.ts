/**
 * SafeGuardPlugin v2 - 生产环境配置
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
    mode: 'cautious', // 生产环境推荐 cautious：超限日志暂存到内存 parking lot，空闲时回放
    maxErrors: 50, // 生产环境更严格
    cooldownPeriod: 30000, // 熔断器冷却 30 秒
    rateLimit: 50, // 每秒最多 50 条（滑动窗口）
    mergeWindow: 2000, // 2 秒内重复日志合并
    sampleRate: 10, // 高频采样：每 10 条取 1 条
    enableRecursionGuard: true,
    parkingLotSize: 200, // parking lot 最大容量
    parkingLotTTL: 300000, // parking lot 条目 5 分钟过期
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
    logger_state: health.state, // 'closed' | 'open' | 'half-open'
    logger_mode: health.mode, // 'standard' | 'cautious' | 'strict'
    logger_is_healthy: health.isHealthy ? 1 : 0,
    logger_current_rate: health.currentRate,
    logger_error_count: health.errorCount,
    logger_dropped_count: health.droppedCount,
    logger_merged_count: health.mergedCount,
    logger_sampled_count: health.sampledCount,
    logger_parking_lot_size: health.parkingLotSize,
    logger_uptime: health.uptime,
  });

  // 熔断器打开时告警
  if (health.state === 'open') {
    sendAlert({
      level: 'critical',
      message: 'SafeGuard circuit breaker is OPEN - logs are being blocked',
      details: health,
    });
  }

  // 错误率过高时告警
  if (health.errorCount > 40) {
    sendAlert({
      level: 'warning',
      message: 'Logger error rate high',
      details: health,
    });
  }
}, 30000); // 每 30 秒检查一次

// ==================== 事件监听 ====================

// 熔断器状态变更时发送告警
logger.on('safeguard:stateChange', ({ from, to }: { from: string; to: string }) => {
  if (to === 'open') {
    console.error(`[SafeGuard] 熔断器打开: ${from} → ${to}`);
    sendAlert({
      level: 'critical',
      message: `SafeGuard circuit breaker opened (${from} → ${to})`,
      details: logger.getHealth?.(),
    });
  }

  if (to === 'half-open') {
    console.warn(`[SafeGuard] 熔断器半开: ${from} → ${to}`);
    sendAlert({
      level: 'warning',
      message: `SafeGuard circuit breaker half-open (${from} → ${to})`,
      details: logger.getHealth?.(),
    });
  }

  if (to === 'closed') {
    console.info(`[SafeGuard] 熔断器关闭（恢复正常）: ${from} → ${to}`);
    sendAlert({
      level: 'info',
      message: `SafeGuard circuit breaker closed (${from} → ${to})`,
      details: logger.getHealth?.(),
    });
  }
});

// ==================== 工具函数 ====================

function getAuthToken(): string {
  return localStorage.getItem('auth_token') || '';
}

function sendMetrics(metrics: Record<string, number | string>) {
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
