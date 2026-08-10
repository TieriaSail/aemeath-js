/**
 * 断网续传 - 最小配置
 *
 * 只要配置 `upload`，持久化补传就默认开启：
 * - 断网期间日志写入 IndexedDB（不可用时自动降级到 localStorage）
 * - 网络恢复后自动补传，浏览器关掉再打开也不丢
 * - 补传只进上传队列，不会重放业务侧的 logger.on('log')
 *
 * 唯一需要你配合的是 `retryReason` —— 见下面的注释。
 */

import { initAemeath, getAemeath, classifyHttpUploadResponse } from 'aemeath-js';

initAemeath({
  upload: async (log) => {
    try {
      const res = await fetch('/api/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(log),
      });

      return classifyHttpUploadResponse(res.status, res.headers.get('Retry-After'));
    } catch {
      // fetch 直接抛异常 = 根本没连上。标成 'network' 后不消耗重试预算，
      // 队列会暂停等待网络恢复，而不是把 3 次预算在几百毫秒内烧光。
      return { success: false, retryReason: 'network' };
    }
  },
});

// 后端必须按 logId 幂等去重：补传使用与首次上报相同的 logId
getAemeath().error('checkout failed');
