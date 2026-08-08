/**
 * 断网续传 - 最小配置
 *
 * 一行 `offlinePersistence: true` 就够了：
 * - 断网期间日志写入 IndexedDB（不可用时自动降级到 localStorage）
 * - 网络恢复后自动补传，浏览器关掉再打开也不丢
 * - 补传只进上传队列，不会重放业务侧的 logger.on('log')
 *
 * 唯一需要你配合的是 `retryReason` —— 见下面的注释。
 */

import { initAemeath, getAemeath } from 'aemeath-js';

initAemeath({
  upload: async (log) => {
    try {
      const res = await fetch('/api/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(log),
      });

      if (res.ok) return { success: true };

      // 4xx（除 408/429）是日志本身的问题，重试永远不会成功
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        return { success: false, retryReason: 'payload' };
      }

      // 5xx / 429：服务端问题，值得重试，消耗重试预算
      return { success: false, retryReason: 'server' };
    } catch {
      // fetch 直接抛异常 = 根本没连上。标成 'network' 后不消耗重试预算，
      // 队列会暂停等待网络恢复，而不是把 3 次预算在几百毫秒内烧光。
      return { success: false, retryReason: 'network' };
    }
  },

  offlinePersistence: true,
});

// 后端必须按 logId 幂等去重：补传使用与首次上报相同的 logId
getAemeath().error('checkout failed');
