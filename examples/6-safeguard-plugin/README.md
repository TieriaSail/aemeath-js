# SafeGuardPlugin Examples

安全保护插件示例

## 目录

- [为什么需要 SafeGuard](#为什么需要-safeguard)
- [基础使用](#基础使用)
- [生产环境配置](#生产环境配置)
- [健康监控](#健康监控)
- [实际案例](#实际案例)

---

## 为什么需要 SafeGuard

Logger 本身可能成为性能问题或崩溃的来源：

### 问题1: 递归错误循环

```typescript
// ❌ 没有 SafeGuard - 无限循环
function buggyCode() {
  logger.error('Error occurred'); // 触发 logger
  throw new Error('Bug'); // 被 ErrorCapturePlugin 捕获
} // 再次触发 logger.error
// 无限循环！

// ✅ 有 SafeGuard - 自动阻止
// SafeGuard 检测到递归调用并自动停止
```

### 问题2: 日志风暴

```typescript
// ❌ 没有 SafeGuard - 拖垮应用
setInterval(() => {
  logger.info('tick'); // 1000 条/秒
}, 1);

// ✅ 有 SafeGuard - 自动限流
// 超过 100 条/秒时自动暂停
```

### 问题3: 错误过多

```typescript
// ❌ 没有 SafeGuard - 继续记录
while (true) {
  logger.error('Error'); // 无限错误
}

// ✅ 有 SafeGuard - 自动暂停
// 超过 100 个错误后自动暂停
// 60 秒后自动恢复
```

---

## 基础使用

```typescript
import { Logger, SafeGuardPlugin } from 'aemeath-js';

const logger = new Logger();

logger.use(
  new SafeGuardPlugin({
    maxErrors: 100, // 最多 100 个错误
    resetInterval: 60000, // 60 秒重置
    rateLimit: 100, // 每秒最多 100 条
    enableRecursionGuard: true, // 启用递归保护
  }),
);

// 现在 Logger 是安全的
```

---

## 生产环境配置

推荐的生产环境配置：

```typescript
import {
  Logger,
  ErrorCapturePlugin,
  UploadPlugin,
  SafeGuardPlugin,
} from 'aemeath-js';

const logger = new Logger();

// 1. 安全保护（第一个安装）
logger.use(
  new SafeGuardPlugin({
    maxErrors: 50, // 生产环境更严格
    resetInterval: 60000,
    rateLimit: 50, // 生产环境限制更低
    enableRecursionGuard: true,
  }),
);

// 2. 错误捕获
logger.use(new ErrorCapturePlugin());

// 3. 上传
logger.use(
  new UploadPlugin({
    onUpload: async (log) => {
      await fetch('/api/logs', {
        method: 'POST',
        body: JSON.stringify(log),
      });
    },
  }),
);

export { logger };
```

---

## 健康监控

检查 Logger 的健康状态：

```typescript
import { logger } from './logger';

// 获取健康状态
const health = logger.getHealth();

console.log({
  isHealthy: health.isHealthy, // true/false
  isPaused: health.isPaused, // true/false
  errorCount: health.errorCount, // 当前错误数
  logCount: health.logCount, // 当前日志数
  uptime: health.uptime, // 运行时间（ms）
});

// 手动控制
if (!health.isHealthy) {
  logger.pause(); // 手动暂停

  // 处理问题...

  logger.resume(); // 手动恢复
}

// 监听事件
logger.on('paused', () => {
  console.error('[SafeGuard] Logger 已暂停');
  // 发送告警
  sendAlert('Logger paused due to too many errors');
});

logger.on('resumed', () => {
  console.info('[SafeGuard] Logger 已恢复');
});
```

---

## 实际案例

### 案例1: 防止递归错误

```typescript
import { Logger, ErrorCapturePlugin, SafeGuardPlugin } from 'aemeath-js';

const logger = new Logger();

// 必须先安装 SafeGuard
logger.use(new SafeGuardPlugin());
logger.use(new ErrorCapturePlugin());

// 这个函数有 bug，会触发递归错误
function processData(data: any) {
  try {
    // 处理数据时出错
    const result = JSON.parse(data); // 如果 data 不是 JSON 会抛错
    return result;
  } catch (error) {
    logger.error('Parse error', error);
    throw error; // 再次抛出，被 ErrorCapturePlugin 捕获
  }
}

// 调用
try {
  processData('invalid json');
} catch (error) {
  // SafeGuard 检测到递归并阻止
  // 只记录一次，不会无限循环
}
```

### 案例2: 防止日志风暴

```typescript
import { Logger, SafeGuardPlugin } from 'aemeath-js';

const logger = new Logger();
logger.use(
  new SafeGuardPlugin({
    rateLimit: 10, // 每秒最多 10 条
  }),
);

// 场景：WebSocket 消息过多
websocket.on('message', (msg) => {
  logger.info('Message received', { msg });
});

// 如果每秒收到 100 条消息
// SafeGuard 会在超过 10 条后暂停 logger
// 60 秒后自动恢复
```

### 案例3: 监控和告警

```typescript
import { Logger, SafeGuardPlugin, UploadPlugin } from 'aemeath-js';

const logger = new Logger();

logger.use(
  new SafeGuardPlugin({
    maxErrors: 50,
  }),
);

// 监控健康状态
setInterval(() => {
  const health = logger.getHealth();

  // 发送健康指标到监控系统
  sendMetrics({
    logger_errors: health.errorCount,
    logger_logs: health.logCount,
    logger_healthy: health.isHealthy ? 1 : 0,
    logger_paused: health.isPaused ? 1 : 0,
  });

  // 错误率过高时告警
  if (health.errorCount > 30) {
    sendAlert('Warning: High error rate in logger');
  }
}, 10000); // 每 10 秒检查一次

// 暂停时发送告警
logger.on('paused', () => {
  sendAlert('Critical: Logger paused due to too many errors');
});
```

### 案例4: 优雅降级

```typescript
import { Logger, SafeGuardPlugin } from 'aemeath-js';

const logger = new Logger();

logger.use(new SafeGuardPlugin());

// 定期检查健康状态
setInterval(() => {
  const health = logger.getHealth();

  if (!health.isHealthy) {
    // Logger 不健康，切换到备用方案
    useFallbackLogging();
  }
}, 5000);

function useFallbackLogging() {
  // 备用方案：只在控制台记录
  console.warn('Logger is unhealthy, using console fallback');

  // 或者：发送到备用服务
  sendToBackupService({
    message: 'Logger health issue',
    health: logger.getHealth(),
  });
}
```

---

## 配置建议

### 开发环境

```typescript
new SafeGuardPlugin({
  maxErrors: 1000, // 宽松限制
  resetInterval: 10000, // 快速重置
  rateLimit: 1000,
  enableRecursionGuard: true,
});
```

### 生产环境

```typescript
new SafeGuardPlugin({
  maxErrors: 50, // 严格限制
  resetInterval: 60000, // 较长重置时间
  rateLimit: 50,
  enableRecursionGuard: true,
});
```

### 高流量应用

```typescript
new SafeGuardPlugin({
  maxErrors: 100,
  resetInterval: 30000,
  rateLimit: 200, // 更高的限流
  enableRecursionGuard: true,
});
```

---

## 最佳实践

1. **第一个安装**：SafeGuard 应该第一个安装

   ```typescript
   logger.use(new SafeGuardPlugin()); // 第一个
   logger.use(new ErrorCapturePlugin());
   logger.use(new UploadPlugin());
   ```

2. **监控健康状态**：定期检查

   ```typescript
   setInterval(() => {
     const health = logger.getHealth();
     if (!health.isHealthy) {
       sendAlert('Logger unhealthy');
     }
   }, 60000);
   ```

3. **告警集成**：暂停时发送告警

   ```typescript
   logger.on('paused', () => {
     sendAlert('Logger paused');
   });
   ```

4. **根据环境调整**：生产环境更严格

   ```typescript
   const config =
     process.env.NODE_ENV === 'production'
       ? { maxErrors: 50, rateLimit: 50 }
       : { maxErrors: 1000, rateLimit: 1000 };

   logger.use(new SafeGuardPlugin(config));
   ```

5. **与监控系统集成**
   ```typescript
   setInterval(() => {
     const health = logger.getHealth();
     sendToMonitoring({
       'logger.errors': health.errorCount,
       'logger.logs': health.logCount,
       'logger.healthy': health.isHealthy ? 1 : 0,
     });
   }, 10000);
   ```
