/**
 * `beforeSend` - 运行时通过 setBeforeSend 动态切换
 *
 * 适用场景：
 * - 用户登录后才能拿到完整的脱敏规则（如 currentUserId）
 * - 不同业务页面切换不同的过滤规则
 * - 用户登出 / 切换账号时需要清除钩子
 */

import { initAemeath, setBeforeSend, type LogEntry } from 'aemeath-js';

initAemeath({
  upload: async (log) => {
    const res = await fetch('/api/logs', {
      method: 'POST',
      body: JSON.stringify(log),
    });
    return { success: res.ok };
  },
});

declare function getCurrentUserId(): string | null;
declare function getRedactionRules(): { masks: string[] };

export function onUserLogin(): void {
  const userId = getCurrentUserId();
  if (!userId) return;

  const rules = getRedactionRules();
  const maskRe = new RegExp(rules.masks.join('|'), 'gi');

  setBeforeSend((entry: LogEntry) => {
    let next: LogEntry = {
      ...entry,
      context: {
        ...entry.context,
        user: { id: userId },
      },
    };

    if (typeof next.message === 'string') {
      next = { ...next, message: next.message.replace(maskRe, '***') };
    }

    return next;
  });
}

export function onUserLogout(): void {
  setBeforeSend(null);
}
