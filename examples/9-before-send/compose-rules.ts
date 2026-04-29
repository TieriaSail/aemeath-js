/**
 * `beforeSend` - 多个规则在单个钩子内组合
 *
 * `initAemeath({ beforeSend })` 只能注册一个钩子；
 * 如果需要多个独立规则，可以将它们组合成一条函数管道。
 *
 * 关键：每条规则返回新 entry / null。前一条返回 null 后立即终止。
 */

import { initAemeath, type LogEntry } from 'aemeath-js';

type Rule = (entry: LogEntry) => LogEntry | null;

const rules: Rule[] = [
  (entry) => {
    if (entry.tags?.errorCategory === 'noise') return null;
    return entry;
  },

  (entry) => {
    if (entry.context?.user) {
      const id = (entry.context.user as { id?: string }).id;
      return {
        ...entry,
        context: {
          ...entry.context,
          user: id ? { id } : undefined,
        },
      };
    }
    return entry;
  },

  (entry) => {
    // 网络日志（NetworkPlugin 产出的 errorCategory === 'http'）
    if (entry.tags?.errorCategory !== 'http' || !entry.context) return entry;
    return {
      ...entry,
      context: {
        ...entry.context,
        requestData: '[REDACTED]',
        responseData: '[REDACTED]',
      },
    };
  },

  (entry) => ({
    ...entry,
    context: {
      ...entry.context,
      traceId: getTraceId(),
    },
  }),
];

function compose(rs: Rule[]): (entry: LogEntry) => LogEntry | null {
  return (entry) => {
    let cur: LogEntry | null = entry;
    for (const rule of rs) {
      try {
        cur = rule(cur);
      } catch (err) {
        // 单条规则报错不影响其它规则；这里仅做调试输出
        if (typeof console !== 'undefined' && console.error) {
          console.error('[beforeSend rule]', err);
        }
      }
      if (cur === null) return null;
    }
    return cur;
  };
}

declare function getTraceId(): string;

initAemeath({
  upload: async (log) => {
    const res = await fetch('/api/logs', {
      method: 'POST',
      body: JSON.stringify(log),
    });
    return { success: res.ok };
  },
  beforeSend: compose(rules),
});
