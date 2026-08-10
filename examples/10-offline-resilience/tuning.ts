/**
 * 完整调优 —— 每个可调项都在这里，附带调整它的理由
 *
 * 直接抄下来按需删减即可；所有配置都有合理默认值，删掉就是用默认值。
 */

import { initAemeath, classifyHttpUploadResponse } from 'aemeath-js';

initAemeath({
  upload: async (log) => {
    const res = await fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
    return classifyHttpUploadResponse(res.status, res.headers.get('Retry-After'));
  },

  queue: {
    maxSize: 200,
    uploadInterval: 30_000,

    // 单条日志反复被服务端拒绝时的重试上限。链路整体断掉不走这里
    maxRetries: 3,

    // 'pause'（默认）：判定离线后暂停队列，等网络恢复
    // 'legacy'：保持 v2.4 及以前的行为（失败即消耗预算、不暂停）
    offlinePolicy: 'pause',

    // 重试间隔按 2 的幂增长：1s → 2s → 4s …… 封顶 30s
    // 传 false 可关闭退避（不推荐，会在弱网下形成请求风暴）
    retryBackoff: { baseMs: 1000, maxMs: 30_000 },

    // 连续失败几次后判定"疑似离线"。navigator.onLine 在很多环境下不可靠
    //（企业网关、连上 WiFi 但没有公网），所以还要靠连续失败兜底
    suspectedOfflineThreshold: 3,
  },

  cache: {
    enabled: true,
    // 只解决页面重载，不是断网续传。TTL 从写入时刻算起
    ttl: 60 * 60 * 1000,
  },

  // 载荷清洗（默认启用）。默认 60000 字节是按 MySQL TEXT 列（65535）
  // 留出信封余量倒推的；后端用 MEDIUMTEXT / MongoDB 可以放心调高
  payloadSanitize: { maxBytes: 60_000 },

  offlinePersistence: {
    // 'auto'：IndexedDB → localStorage → noop。指定具体后端时仍会降级
    storage: 'auto',

    ttl: 7 * 24 * 60 * 60 * 1000,

    // 容量上限。IndexedDB 默认 500 条 / 2MB；localStorage 后端默认 100 条 / 512KB
    // 超出按落盘时间淘汰最旧的，并以 'storage-quota' 走 onDrop
    maxEntries: 500,
    maxTotalBytes: 2_000_000,

    // 网络恢复瞬间不要把攒了一天的日志一次性打向服务端
    replayBatchSize: 10,

    // 单条补传失败几次后放弃（走 onDrop，reason: 'offline-give-up'）
    maxReplayAttempts: 3,

    debug: false,
  },

  // 落盘发生在 beforeSend 之后，所以这里脱敏掉的内容不会被写进 IndexedDB
  beforeSend: (entry) => {
    if (entry.context?.['authorization']) {
      return { ...entry, context: { ...entry.context, authorization: '[REDACTED]' } };
    }
    return entry;
  },
});
