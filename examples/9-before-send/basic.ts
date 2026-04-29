/**
 * `beforeSend` - 基础示例
 *
 * 演示：
 * - 通过 message 字段做基础脱敏
 * - 屏蔽 NetworkPlugin 自动捕获的网络日志请求体里的 token / password
 *
 * 注意 NetworkPlugin 的字段路径与类型：
 *   tags.errorCategory === 'http'
 *   context.url / context.method / context.status / context.statusText
 *   context.requestData / context.responseData
 *
 * ⚠️ requestData / responseData 在 fetch / XHR 拦截层会用 safeParseJSON 解析，
 *    所以多数 JSON API 拿到的是 **object**，纯文本 / FormData / Blob 才是 string。
 *    本示例同时兼容两种类型。
 *
 *   context.error（仅当请求出错时）
 */

import { initAemeath, type LogEntry } from 'aemeath-js';

const SENSITIVE_KEYS = new Set(['password', 'token']);

function redactSensitiveString(s: string): string {
  return s
    .replace(/"(password|token)"\s*:\s*"[^"]*"/gi, '"$1":"***"')
    .replace(/(password|token|sk-[a-z0-9]+)\s*[:=]\s*\S+/gi, '$1=***');
}

function redactSensitiveObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...obj };
  for (const k of Object.keys(out)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) out[k] = '***';
  }
  return out;
}

function redactRequestData(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveString(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return redactSensitiveObject(value as Record<string, unknown>);
  }
  return value;
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
    let next = entry;

    if (typeof next.message === 'string' && /password|token|sk-[a-z0-9]+/i.test(next.message)) {
      next = { ...next, message: redactSensitiveString(next.message) };
    }

    if (next.tags?.errorCategory === 'http' && next.context && 'requestData' in next.context) {
      next = {
        ...next,
        context: {
          ...next.context,
          requestData: redactRequestData(next.context['requestData']),
        },
      };
    }

    return next;
  },
});
