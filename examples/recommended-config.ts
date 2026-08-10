/**
 * 推荐的 Logger 配置
 *
 * 展示如何使用统一的回调设计，保证所有日志使用相同的上报接口
 */

import {
  AemeathLogger,
  EarlyErrorCapturePlugin,
  ErrorCapturePlugin,
  OfflinePersistencePlugin,
  PayloadSanitizePlugin,
  UploadPlugin,
  classifyHttpUploadResponse,
} from 'aemeath-js';

// ==================== 推荐配置：统一接口 ====================

/**
 * 获取认证 token（示例）
 */
function getAuthToken(): string {
  return localStorage.getItem('auth_token') || '';
}

/**
 * 创建 Logger 实例
 */
export function createLogger() {
  const logger = new AemeathLogger({
    enableConsole: process.env.NODE_ENV !== 'production',
    environment: process.env.NODE_ENV,
    context: {
      appName: 'my-app',
      appVersion: '1.0.0',
    },
  });

  // 1. 早期错误捕获（不配置 fallbackEndpoint）
  logger.use(
    new EarlyErrorCapturePlugin({
      enabled: true,
      // fallbackEndpoint 不配置，早期错误统一通过 UploadPlugin 上报 ✅
    }),
  );

  // 2. 错误捕获
  logger.use(
    new ErrorCapturePlugin({
      captureConsoleError: true,
      captureUnhandledRejection: true,
      captureResourceError: true,
    }),
  );

  // 3. 载荷清洗（用 initAemeath 时默认安装，手动装配需自己 use）
  //    Data URL / Blob 换成短占位符，超大日志按字段拆多条，避免撑爆接口和存储
  logger.use(new PayloadSanitizePlugin());

  // 4. 统一上传（早期错误和正常日志都走这里）
  logger.use(
    new UploadPlugin({
      // 自定义上传逻辑 - 返回 UploadResult
      onUpload: async (log) => {
        try {
          const response = await fetch('/api/logs', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${getAuthToken()}`, // 动态获取 token
            },
            body: JSON.stringify(log),
          });

          if (!response.ok) {
            return classifyHttpUploadResponse(
              response.status,
              response.headers.get('Retry-After'),
            );
          }

          const data = await response.json();

          // 检查业务返回码
          if (data.code === 200) {
            return { success: true };
          } else {
            return {
              success: false,
              shouldRetry: true,
              // 服务端明确回了话，是服务端的问题，消耗重试预算
              retryReason: 'server',
              error: data.message,
            };
          }
        } catch (error) {
          return {
            success: false,
            shouldRetry: true,
            // fetch 抛异常 = 根本没连上。标成 'network' 后不消耗重试预算，
            // 队列会暂停等待网络恢复，而不是把预算在几百毫秒内烧光
            retryReason: 'network',
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },

      // 自定义优先级
      getPriority: (log) => {
        // 早期错误优先级更高
        if (log.tags?.earlyError) {
          return 10;
        }

        // 错误日志次之
        if (log.level === 'error') {
          return 5;
        }

        // 其他日志
        return 1;
      },

      // 队列配置
      queue: {
        maxSize: 100,
        concurrency: 1, // 串行上传
        uploadInterval: 5000, // 5秒自动上传
        maxRetries: 3,
      },

      // 本地缓存（只解决页面重载，断网续传见下一个插件）
      cache: {
        enabled: true,
        key: 'my-app-logs',
      },

      // 日志被放弃时通知，不再静默丢失
      onDrop: (log, info) => {
        console.warn('[aemeath] log dropped:', info.reason, log.logId);
      },

      // 页面卸载时上传
      saveOnUnload: true,
    }),
  );

  // 5. 断网续传（必须在 UploadPlugin 之后安装）
  //    断网期间落盘 IndexedDB，网络恢复后自动补传
  logger.use(new OfflinePersistencePlugin());

  return logger;
}

// ==================== 可选配置：带保底机制 ====================

/**
 * 如果应用加载经常失败，可以配置保底机制
 *
 * 注意：这会导致两个接口，需要后端支持
 */
export function createLoggerWithFallback() {
  const logger = new AemeathLogger();

  // 配置保底端点
  logger.use(
    new EarlyErrorCapturePlugin({
      enabled: true,
      fallbackEndpoint: '/api/logs/early-fallback', // 保底端点
      fallbackTimeout: 30000, // 30秒后使用保底端点
    }),
  );

  logger.use(new ErrorCapturePlugin());

  // 正常上传
  logger.use(
    new UploadPlugin({
      onUpload: async (log) => {
        try {
          const response = await fetch('/api/logs', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${getAuthToken()}`,
            },
            body: JSON.stringify(log),
          });

          if (!response.ok) {
            return classifyHttpUploadResponse(
              response.status,
              response.headers.get('Retry-After'),
            );
          }

          const data = await response.json();

          if (data.code === 200) {
            return { success: true };
          } else {
            return {
              success: false,
              shouldRetry: true,
              retryReason: 'server',
              error: data.message,
            };
          }
        } catch (error) {
          return {
            success: false,
            shouldRetry: true,
            retryReason: 'network',
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    }),
  );

  return logger;
}

// ==================== 使用示例 ====================

// 在应用入口初始化
const logger = createLogger();

// 使用
logger.info('App started', {
  tags: { action: 'app-start' },
});
logger.track('page_view', {
  tags: { page: '/dashboard', referrer: '/home' },
});
logger.track('button_click', {
  tags: { buttonId: 'submit-form', page: '/settings' },
});
logger.error('Something went wrong', {
  error: new Error('Test error'),
  tags: { action: 'test', severity: 'high' },
});

// ==================== 效果说明 ====================

/*
所有日志（包括早期错误）都通过统一的接口上报：

POST /api/logs
{
  "level": "error",
  "message": "...",
  "timestamp": 123456,
  "tags": {
    "earlyError": true,  // 标记早期错误
    "type": "error"
  },
  "context": {
    "device": { ... }
  }
}

优势：
✅ 接口统一（只有一个 /api/logs）
✅ 认证统一（都使用动态 token）
✅ 格式统一（都是 LogEntry）
✅ 易于维护（只需要维护一套逻辑）
*/

// ==================== 构建配置 ====================

/*
// Rsbuild: rsbuild.config.ts
import { defineConfig } from '@rsbuild/core';
import { ameathEarlyErrorPlugin } from 'aemeath-js/build-plugins/rsbuild';

export default defineConfig({
  plugins: [
    ameathEarlyErrorPlugin({
      enabled: process.env.NODE_ENV === 'production',
    })
  ]
});

// Vite: vite.config.ts
import { defineConfig } from 'vite';
import { ameathEarlyErrorPlugin } from 'aemeath-js/build-plugins/vite';

export default defineConfig({
  plugins: [
    ameathEarlyErrorPlugin({
      enabled: process.env.NODE_ENV === 'production',
    })
  ]
});

// Webpack: webpack.config.js
const { AemeathEarlyErrorWebpackPlugin } = require('aemeath-js/build-plugins/webpack');

module.exports = {
  plugins: [
    new AemeathEarlyErrorWebpackPlugin({
      enabled: process.env.NODE_ENV === 'production',
      mode: 'auto', // 'auto' | 'inject' | 'file'
    })
  ]
};
*/

// ==================== 对比：不推荐的配置 ====================

/*
❌ 不推荐：配置 fallbackEndpoint

为什么不推荐？

1. 需要维护两个接口：
   - /api/logs（正常日志）
   - /api/logs/early-fallback（早期错误保底）

2. 格式可能不一致：
   - 正常日志：{ level, message, timestamp }
   - 早期错误：{ errors: [...], type: 'early-error-fallback' }

3. 认证可能不一致：
   - 正常日志：使用动态 token
   - 早期错误：无法使用动态 token（脚本注入时就固定了）

4. 实际需求不大：
   - Logger 初始化失败的概率 < 0.1%
   - 即使失败，用户通常会刷新页面
*/
