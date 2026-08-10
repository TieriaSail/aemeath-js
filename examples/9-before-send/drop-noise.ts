/**
 * `beforeSend` - 业务过滤：丢弃噪音日志
 *
 * 演示通过返回 `null` 完全丢弃日志：
 * - 401 / 403 网络日志：业务上属于"用户未登录"，不需要上报
 * - 离线产生的网络错误（按 networkErrorType 语义化过滤）
 * - 业务标记为 noise 的日志
 * - 来自 chrome-extension:// 的资源加载错误
 *
 * NetworkPlugin 标签：
 *   tags.errorCategory === 'http'
 *   tags.httpStatus（仅当 status 存在时）
 *   tags.networkErrorType（仅网络层失败时存在，低基数枚举）
 *   context.status（HTTP status code）
 *
 * 💡 主动取消（network.aborted）默认就不会被捕获，无需在 beforeSend 处理。
 *    如果业务需要观测主动取消，初始化时设置 network: { captureAborted: true }。
 *    比 beforeSend 更省的捕获层过滤：network: { ignoreErrorTypes: [...] }。
 */

import { initAemeath, classifyHttpUploadResponse } from 'aemeath-js';

const IGNORED_NETWORK_STATUSES = new Set([401, 403]);

initAemeath({
  upload: async (log) => {
    const res = await fetch('/api/logs', {
      method: 'POST',
      body: JSON.stringify(log),
    });
    return classifyHttpUploadResponse(res.status, res.headers.get('Retry-After'));
  },

  // 也可以直接在捕获层过滤（不记录、不产生 console 输出）：
  // network: { ignoreErrorTypes: ['network.offline'] },

  beforeSend: (entry) => {
    if (entry.tags?.errorCategory === 'noise') return null;

    if (
      entry.tags?.errorCategory === 'http'
      && IGNORED_NETWORK_STATUSES.has(entry.context?.['status'] as number)
    ) {
      return null;
    }

    // 离线噪音：按低基数 networkErrorType 过滤，而不是对错误文案做字符串匹配
    if (entry.tags?.['networkErrorType'] === 'network.offline') {
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
