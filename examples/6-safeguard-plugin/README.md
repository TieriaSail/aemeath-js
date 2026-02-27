# SafeGuardPlugin v2 Examples

安全保护插件示例

## 目录

- [为什么需要 SafeGuard](#为什么需要-safeguard)
- [三种模式](#三种模式)
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

// ✅ 有 SafeGuard - 递归硬阻断
// SafeGuard 通过 beforeLog hook 在日志进入管道前直接拦截递归调用
```

### 问题2: 日志风暴

```typescript
// ❌ 没有 SafeGuard - 拖垮应用
setInterval(() => {
  logger.info('tick'); // 1000 条/秒
}, 1);

// ✅ 有 SafeGuard - 智能处理
// 1. 滑动窗口精确限流
// 2. 重复日志自动合并（tags.repeatedCount）
// 3. 超限后高频采样 + console.warn 提示
// 4. 熔断器打开后直接拦截
```

### 问题3: 错误过多

```typescript
// ❌ 没有 SafeGuard - 继续记录
while (true) {
  logger.error('Error'); // 无限错误
}

// ✅ 有 SafeGuard - 熔断器保护
// 超过 maxErrors 后熔断器从 closed → open
// cooldownPeriod 后进入 half-open 尝试恢复
// 成功则回到 closed，失败则重新 open
```

---

## 三种模式

SafeGuard v2 提供三种运行模式，适用于不同场景：

### Standard 模式（默认）

超限日志直接丢弃，最轻量。

```typescript
new SafeGuardPlugin({ mode: 'standard' });
```

### Cautious 模式

超限日志暂存到内存 parking lot，空闲时自动回放，避免丢失重要日志。

```typescript
new SafeGuardPlugin({
  mode: 'cautious',
  parkingLotSize: 200, // parking lot 最大容量
  parkingLotTTL: 300000, // 条目 5 分钟过期
});
```

### Strict 模式

持久化 parking lot（localStorage），即使页面刷新也不会丢失日志。

```typescript
new SafeGuardPlugin({
  mode: 'strict',
  parkingLotSize: 200,
  parkingLotTTL: 300000,
  storageKey: '__aemeath_safeguard_parking__', // 持久化存储 key
});
```

---

## 基础使用

```typescript
import { AemeathLogger, SafeGuardPlugin } from 'aemeath-js';

const logger = new AemeathLogger();

logger.use(
  new SafeGuardPlugin({
    mode: 'standard', // 运行模式
    rateLimit: 100, // 每秒最多 100 条（滑动窗口）
    maxErrors: 100, // 最多 100 个错误后熔断
    cooldownPeriod: 30000, // 熔断冷却 30 秒
    mergeWindow: 2000, // 2 秒内重复日志合并
    sampleRate: 10, // 高频采样：每 10 条取 1 条
    enableRecursionGuard: true, // 启用递归硬阻断
  }),
);

// 现在 Logger 是安全的
```

---

## 生产环境配置

推荐的生产环境配置：

```typescript
import {
  AemeathLogger,
  ErrorCapturePlugin,
  UploadPlugin,
  SafeGuardPlugin,
} from 'aemeath-js';

const logger = new AemeathLogger();

// 1. 安全保护（第一个安装 - 通过 beforeLog hook 在管道前拦截）
logger.use(
  new SafeGuardPlugin({
    mode: 'cautious', // 生产推荐 cautious，超限暂存不丢失
    maxErrors: 50, // 生产环境更严格
    cooldownPeriod: 30000, // 30 秒冷却
    rateLimit: 50, // 生产环境限制更低
    mergeWindow: 2000,
    sampleRate: 10,
    enableRecursionGuard: true,
    parkingLotSize: 200,
    parkingLotTTL: 300000,
  }),
);

// 2. 错误捕获
logger.use(new ErrorCapturePlugin());

// 3. 上传
logger.use(
  new UploadPlugin({
    onUpload: async (log) => {
      const res = await fetch('/api/logs', {
        method: 'POST',
        body: JSON.stringify(log),
      });
      return { success: res.ok };
    },
  }),
);

export { logger };
```

---

## 健康监控

检查 Logger 的健康状态：

```typescript
import { getAemeath } from 'aemeath-js';

const logger = getAemeath();

// 获取健康状态
const health = logger.getHealth();

console.log({
  state: health.state, // 'closed' | 'open' | 'half-open'（熔断器状态）
  mode: health.mode, // 'standard' | 'cautious' | 'strict'
  isHealthy: health.isHealthy, // true/false
  currentRate: health.currentRate, // 当前每秒日志速率
  errorCount: health.errorCount, // 当前错误数
  droppedCount: health.droppedCount, // 已丢弃日志数
  mergedCount: health.mergedCount, // 已合并日志数
  sampledCount: health.sampledCount, // 已采样日志数
  parkingLotSize: health.parkingLotSize, // parking lot 当前大小
  uptime: health.uptime, // 运行时间（ms）
});

// 手动控制
if (!health.isHealthy) {
  logger.pause(); // 手动暂停

  // 处理问题...

  logger.resume(); // 手动恢复
}

// 监听熔断器状态变更
logger.on('safeguard:stateChange', ({ from, to }) => {
  if (to === 'open') {
    console.error(`[SafeGuard] 熔断器打开: ${from} → ${to}`);
    sendAlert('SafeGuard circuit breaker opened');
  }

  if (to === 'half-open') {
    console.warn(`[SafeGuard] 熔断器半开尝试恢复: ${from} → ${to}`);
  }

  if (to === 'closed') {
    console.info(`[SafeGuard] 熔断器关闭（恢复正常）: ${from} → ${to}`);
  }
});
```

---

## 实际案例

### 案例1: 防止递归错误

```typescript
import { AemeathLogger, ErrorCapturePlugin, SafeGuardPlugin } from 'aemeath-js';

const logger = new AemeathLogger();

// 必须先安装 SafeGuard（beforeLog hook 在管道入口拦截）
logger.use(new SafeGuardPlugin());
logger.use(new ErrorCapturePlugin());

// 这个函数有 bug，会触发递归错误
function processData(data: any) {
  try {
    // 处理数据时出错
    const result = JSON.parse(data); // 如果 data 不是 JSON 会抛错
    return result;
  } catch (error) {
    logger.error('Parse error', { error });
    throw error; // 再次抛出，被 ErrorCapturePlugin 捕获
  }
}

// 调用
try {
  processData('invalid json');
} catch (error) {
  // SafeGuard 检测到递归并硬阻断
  // 只记录一次，不会无限循环
}
```

### 案例2: 防止日志风暴（智能处理）

```typescript
import { AemeathLogger, SafeGuardPlugin } from 'aemeath-js';

const logger = new AemeathLogger();
logger.use(
  new SafeGuardPlugin({
    rateLimit: 10, // 每秒最多 10 条
    mergeWindow: 2000, // 2 秒内重复日志合并
    sampleRate: 5, // 超限后每 5 条取 1 条
  }),
);

// 场景：WebSocket 消息过多
websocket.on('message', (msg) => {
  logger.info('Message received', { context: { msg } });
});

// 如果每秒收到 100 条消息：
// 1. 连续相同日志 → 合并为 1 条（tags.repeatedCount = N）
// 2. 超过 10 条/秒 → 每 5 条采样 1 条 + console.warn 提示
// 3. 错误过多 → 熔断器打开，cooldownPeriod 后尝试恢复
```

### 案例3: 监控和告警

```typescript
import { AemeathLogger, SafeGuardPlugin, UploadPlugin } from 'aemeath-js';

const logger = new AemeathLogger();

logger.use(
  new SafeGuardPlugin({
    mode: 'cautious',
    maxErrors: 50,
  }),
);

// 监控健康状态
setInterval(() => {
  const health = logger.getHealth();

  // 发送健康指标到监控系统
  sendMetrics({
    logger_state: health.state,
    logger_errors: health.errorCount,
    logger_dropped: health.droppedCount,
    logger_merged: health.mergedCount,
    logger_sampled: health.sampledCount,
    logger_healthy: health.isHealthy ? 1 : 0,
    logger_parking_lot: health.parkingLotSize,
  });

  // 熔断器打开时告警
  if (health.state === 'open') {
    sendAlert('Critical: SafeGuard circuit breaker OPEN');
  }

  // 错误率过高时告警
  if (health.errorCount > 30) {
    sendAlert('Warning: High error rate in logger');
  }
}, 10000); // 每 10 秒检查一次

// 熔断器状态变更时发送告警
logger.on('safeguard:stateChange', ({ from, to }) => {
  sendAlert(`SafeGuard state change: ${from} → ${to}`);
});
```

### 案例4: 优雅降级

```typescript
import { AemeathLogger, SafeGuardPlugin } from 'aemeath-js';

const logger = new AemeathLogger();

logger.use(new SafeGuardPlugin({ mode: 'cautious' }));

// 定期检查健康状态
setInterval(() => {
  const health = logger.getHealth();

  if (health.state === 'open') {
    // 熔断器打开，切换到备用方案
    useFallbackLogging();
  }
}, 5000);

function useFallbackLogging() {
  // 备用方案：只在控制台记录
  console.warn('SafeGuard circuit breaker is open, using console fallback');

  // 或者：发送到备用服务
  sendToBackupService({
    message: 'Logger circuit breaker open',
    health: logger.getHealth(),
  });
}
```

---

## 配置建议

### 开发环境

```typescript
new SafeGuardPlugin({
  mode: 'standard', // 直接丢弃，快速开发
  maxErrors: 1000, // 宽松限制
  cooldownPeriod: 5000, // 快速恢复
  rateLimit: 1000,
  mergeWindow: 1000,
  sampleRate: 5,
  enableRecursionGuard: true,
});
```

### 生产环境

```typescript
new SafeGuardPlugin({
  mode: 'cautious', // 暂存不丢失
  maxErrors: 50, // 严格限制
  cooldownPeriod: 30000, // 较长冷却期
  rateLimit: 50,
  mergeWindow: 2000,
  sampleRate: 10,
  enableRecursionGuard: true,
  parkingLotSize: 200,
  parkingLotTTL: 300000,
});
```

### 高流量应用

```typescript
new SafeGuardPlugin({
  mode: 'strict', // 持久化，不丢失任何日志
  maxErrors: 100,
  cooldownPeriod: 15000, // 较短冷却，快速恢复
  rateLimit: 200, // 更高的限流
  mergeWindow: 3000, // 更大的合并窗口
  sampleRate: 20, // 更积极的采样
  enableRecursionGuard: true,
  parkingLotSize: 500, // 更大的 parking lot
  parkingLotTTL: 600000, // 10 分钟过期
  storageKey: '__aemeath_safeguard_parking__',
});
```

---

## 最佳实践

1. **第一个安装**：SafeGuard 应该第一个安装（beforeLog hook 在管道入口拦截）

   ```typescript
   logger.use(new SafeGuardPlugin()); // 第一个
   logger.use(new ErrorCapturePlugin());
   logger.use(new UploadPlugin());
   ```

2. **监控健康状态**：定期检查熔断器状态

   ```typescript
   setInterval(() => {
     const health = logger.getHealth();
     if (health.state === 'open') {
       sendAlert('SafeGuard circuit breaker open');
     }
   }, 60000);
   ```

3. **告警集成**：监听熔断器状态变更

   ```typescript
   logger.on('safeguard:stateChange', ({ from, to }) => {
     sendAlert(`SafeGuard: ${from} → ${to}`);
   });
   ```

4. **根据环境选择模式**

   ```typescript
   const config =
     process.env.NODE_ENV === 'production'
       ? { mode: 'cautious' as const, maxErrors: 50, rateLimit: 50 }
       : { mode: 'standard' as const, maxErrors: 1000, rateLimit: 1000 };

   logger.use(new SafeGuardPlugin(config));
   ```

5. **与监控系统集成**

   ```typescript
   setInterval(() => {
     const health = logger.getHealth();
     sendToMonitoring({
       'logger.state': health.state,
       'logger.errors': health.errorCount,
       'logger.dropped': health.droppedCount,
       'logger.merged': health.mergedCount,
       'logger.healthy': health.isHealthy ? 1 : 0,
     });
   }, 10000);
   ```
