/**
 * `beforeSend` - 网络日志全字段脱敏
 *
 * 演示对 NetworkPlugin 自动捕获的网络日志做：
 * - URL 参数脱敏（token / phone / idCard / sessionId）
 * - 请求 / 响应 body 替换为 [REDACTED]
 *
 * 注意 NetworkPlugin 实际把字段写在 `entry.context` 上：
 *   context.url            ← 完整 URL（含 query）
 *   context.requestData    ← 请求 body（不是 requestBody）
 *   context.responseData   ← 响应 body（不是 responseBody）
 *   context.error          ← 网络错误对象（仅当有错误时）
 *
 * NetworkPlugin 当前不抓 request/response headers，因此无需脱敏 headers。
 */

import { initAemeath, type LogEntry } from 'aemeath-js';

const SENSITIVE_PARAMS = ['token', 'phone', 'idCard', 'sessionId'];

function redactUrlParams(url: string): string {
  const re = new RegExp(`(${SENSITIVE_PARAMS.join('|')})=[^&#]+`, 'gi');
  return url.replace(re, '$1=***');
}

initAemeath({
  upload: async (log) => {
    const res = await fetch('/api/logs', {
      method: 'POST',
      body: JSON.stringify(log),
    });
    return { success: res.ok };
  },

  beforeSend: (entry: LogEntry) => {
    if (entry.tags?.errorCategory !== 'http') return entry;

    const ctx = entry.context;
    if (!ctx) return entry;

    const next: Record<string, unknown> = { ...ctx };

    if (typeof ctx['url'] === 'string') {
      next['url'] = redactUrlParams(ctx['url']);
    }

    // requestData / responseData 可能是 string / FormData / Blob / 对象等，
    // 一律替换为占位符；如想保留 schema 可改成自定义浅拷贝。
    if (ctx['requestData'] !== undefined) {
      next['requestData'] = '[REDACTED]';
    }
    if (ctx['responseData'] !== undefined) {
      next['responseData'] = '[REDACTED]';
    }

    return { ...entry, context: next };
  },
});
