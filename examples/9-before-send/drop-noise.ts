/**
 * `beforeSend` - 业务过滤：丢弃噪音日志
 *
 * 演示通过返回 `null` 完全丢弃日志：
 * - 401 / 403 网络日志：业务上属于"用户未登录"，不需要上报
 * - 业务标记为 noise 的日志
 * - 来自 chrome-extension:// 的资源加载错误
 *
 * NetworkPlugin 标签：
 *   tags.errorCategory === 'http'
 *   tags.httpStatus（仅当 status 存在时）
 *   context.status（HTTP status code）
 */

import { initAemeath } from 'aemeath-js';

const IGNORED_NETWORK_STATUSES = new Set([401, 403]);

initAemeath({
  upload: async (log) => {
    const res = await fetch('/api/logs', {
      method: 'POST',
      body: JSON.stringify(log),
    });
    return { success: res.ok };
  },

  beforeSend: (entry) => {
    if (entry.tags?.errorCategory === 'noise') return null;

    if (
      entry.tags?.errorCategory === 'http'
      && IGNORED_NETWORK_STATUSES.has(entry.context?.['status'] as number)
    ) {
      return null;
    }

    if (
      entry.tags?.errorCategory === 'resource'
      && typeof entry.error?.value === 'string'
      && entry.error.value.includes('chrome-extension://')
    ) {
      return null;
    }

    return entry;
  },
});
