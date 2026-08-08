/**
 * 观测丢弃 —— 日志再也不会静默消失
 *
 * 演示三种拿到"哪条日志没送到、为什么"的方式：
 * 1. `onDrop` 回调（最简单）
 * 2. `upload:drop` 事件（与回调等价，适合插件化组织代码）
 * 3. `getQueueStatus()` 轮询累计计数（适合面板 / 自监控）
 */

import { initAemeath, getAemeath, type UploadPlugin } from 'aemeath-js';

initAemeath({
  upload: async (log) => {
    const res = await fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
    return { success: res.ok, retryReason: res.ok ? undefined : 'server' };
  },

  offlinePersistence: true,

  // 1. 回调：在日志被放弃**之前**调用，你还有机会自救
  onDrop: (log, info) => {
    switch (info.reason) {
      case 'queue-overflow':
        // 队列满了，低优先级的被挤掉 —— 说明产生速度超过了上报速度
        break;
      case 'max-retries':
        // 重试预算耗尽。注意这只发生在"链路正常、单条日志反复被拒"的情况；
        // 整体断网时队列会暂停，根本不消耗预算
        break;
      case 'payload-too-large':
        // 单字段体积超限，PayloadSanitizePlugin 拒绝了整条
        break;
      case 'storage-quota':
        // 离线存储写满了
        break;
      case 'offline-give-up':
        // 补传反复失败，放弃
        break;
      case 'cache-expired':
        // 本地缓存超过 TTL
        break;
      case 'no-retry':
        // 服务端明确表示不必重试
        break;
    }
    console.warn('[log dropped]', info.reason, log.logId, info.error);
  },
});

const logger = getAemeath();

// 2. 事件：与 onDrop 等价，按喜好二选一
logger.on('upload:drop', ({ log, reason }) => {
  console.warn('[event] dropped', reason, log.logId);
});

// 队列暂停 / 恢复，可用来在 UI 上显示"日志上报暂停中"
logger.on('upload:paused', ({ reason, queued }) => {
  console.log(`[upload] paused (${reason}), ${queued} logs held`);
});
logger.on('upload:resumed', ({ queued }) => {
  console.log(`[upload] resumed, flushing ${queued} logs`);
});

// 载荷清洗的两个事件
logger.on('payload:split', ({ splitId, chunks }) => {
  console.log(`[payload] entry ${splitId} split into ${chunks} chunks`);
});
logger.on('payload:rejected', ({ logId, field, fieldBytes }) => {
  console.error(`[payload] ${logId} rejected: ${field} is ${fieldBytes} bytes`);
});

// 3. 轮询累计计数
setInterval(() => {
  const upload = logger.getPluginInstance('upload') as UploadPlugin | undefined;
  const offline = logger.getPluginInstance('offline-persistence') as
    | { getStatus(): Record<string, unknown> }
    | undefined;

  console.table({
    queue: upload?.getQueueStatus(),
    // { length, isProcessing, paused, consecutiveFailures, drops: { total, byReason }, items }
    offline: offline?.getStatus(),
    // { backend, pending, bytes, replaying, quotaDrops, giveUps, replayed }
  });
}, 60_000);
