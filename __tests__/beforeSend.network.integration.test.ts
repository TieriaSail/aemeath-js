/**
 * end-to-end integration: NetworkPlugin → BeforeSendPlugin
 *
 * 这组测试是 docs/{zh,en}/9-before-send.md 与 examples/9-before-send/*.ts 中
 * 字段路径与 errorCategory 的实战回归。任何一项断言失败 = 用户照文档写的
 * beforeSend 钩子在生产里也会失效。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { NetworkPlugin } from '../src/plugins/NetworkPlugin';
import { BeforeSendPlugin } from '../src/plugins/BeforeSendPlugin';
import { _resetFetchInstrumentation } from '../src/instrumentation/fetch';
import { _resetXHRInstrumentation } from '../src/instrumentation/xhr';
import type { LogEntry } from '../src/types';

function makeResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, { status: 200, statusText: 'OK', ...init });
}

/**
 * 顺序非常关键：
 *   1. 先重置 instrumentation 单例（释放上一次 patch）
 *   2. 把 window.fetch 替换成本次 mock
 *   3. **再** new NetworkPlugin / use（这样 monkey-patch 包装的是本次的 mock）
 */
async function emitNetworkEntry(opts: {
  url: string;
  response: Response;
  body?: BodyInit;
}): Promise<{ logger: AemeathLogger; entry: LogEntry }> {
  _resetFetchInstrumentation();
  _resetXHRInstrumentation();

  window.fetch = vi.fn().mockResolvedValue(opts.response);

  const logger = new AemeathLogger({ enableConsole: false });
  logger.use(new NetworkPlugin({ slowThreshold: 99999 }));

  const captured: LogEntry[] = [];
  logger.on('log', (e) => captured.push(e as LogEntry));

  await window.fetch(opts.url, opts.body ? { method: 'POST', body: opts.body } : undefined);
  await new Promise((r) => setTimeout(r, 0));

  expect(captured.length).toBeGreaterThanOrEqual(1);
  return { logger, entry: captured[0]! };
}

describe('beforeSend × NetworkPlugin — 字段路径 / errorCategory 实战回归', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = window.fetch;
    _resetFetchInstrumentation();
    _resetXHRInstrumentation();
  });

  afterEach(() => {
    _resetFetchInstrumentation();
    _resetXHRInstrumentation();
    window.fetch = originalFetch;
  });

  it('NetworkPlugin 写出的 entry 必须满足文档约定的字段路径', async () => {
    const { logger, entry } = await emitNetworkEntry({
      url: 'https://api.example.com/user?token=abc&phone=13800138000',
      response: makeResponse('{"id":1}'),
      body: '{"password":"secret"}',
    });

    // tags
    expect(entry.tags?.['errorCategory']).toBe('http');
    expect(entry.tags?.['type']).toBe('fetch');
    expect(entry.tags?.['method']).toBe('POST');
    expect(entry.tags?.['httpStatus']).toBe(200);

    // context
    expect(typeof entry.context?.['url']).toBe('string');
    expect(entry.context?.['url']).toContain('token=abc');
    expect(entry.context?.['method']).toBe('POST');
    expect(entry.context?.['status']).toBe(200);
    expect(entry.context?.['statusText']).toBe('OK');
    expect(entry.context?.['type']).toBe('HTTP_REQUEST');
    expect(typeof entry.context?.['duration']).toBe('number');

    // ⚠️ JSON body 会被 safeParseJSON 解析为对象 —— 文档/示例需要兼容
    expect(entry.context?.['requestData']).toEqual({ password: 'secret' });
    expect(entry.context?.['responseData']).toEqual({ id: 1 });

    // 文档反复强调：网络日志的 entry.error 不存在
    expect(entry.error).toBeUndefined();

    logger.destroy();
  });

  it('错误请求 (403) 时 status / context.error 的位置符合文档', async () => {
    const { logger, entry } = await emitNetworkEntry({
      url: '/api/forbidden',
      response: makeResponse('Forbidden', { status: 403, statusText: 'Forbidden' }),
    });
    expect(entry.tags?.['errorCategory']).toBe('http');
    expect(entry.tags?.['httpStatus']).toBe(403);
    expect(entry.context?.['status']).toBe(403);
    expect(entry.context?.['type']).toBe('HTTP_ERROR');
    logger.destroy();
  });

  // === 下面 4 个用例直接复用 examples/9-before-send/*.ts 的 hook 模式 ===

  it('basic.ts 的脱敏模式能正确名中 NetworkPlugin entry（object body）', async () => {
    const { logger, entry } = await emitNetworkEntry({
      url: '/api/login',
      response: makeResponse('{"ok":true}'),
      body: '{"password":"secret"}',
    });

    const SENSITIVE_KEYS = new Set(['password', 'token']);
    function redactObj(o: Record<string, unknown>): Record<string, unknown> {
      const out: Record<string, unknown> = { ...o };
      for (const k of Object.keys(out)) if (SENSITIVE_KEYS.has(k.toLowerCase())) out[k] = '***';
      return out;
    }
    const hook = (e: LogEntry): LogEntry => {
      if (e.tags?.errorCategory === 'http' && e.context && 'requestData' in e.context) {
        const v = e.context['requestData'];
        const redacted = (v && typeof v === 'object' && !Array.isArray(v))
          ? redactObj(v as Record<string, unknown>)
          : (typeof v === 'string'
            ? v.replace(/"(password|token)"\s*:\s*"[^"]*"/gi, '"$1":"***"')
            : v);
        return { ...e, context: { ...e.context, requestData: redacted } };
      }
      return e;
    };

    const out = hook(entry);
    expect(out.context?.['requestData']).toEqual({ password: '***' });
    logger.destroy();
  });

  it('basic.ts 的脱敏模式也能名中 string body（如 text/plain）', async () => {
    const { logger, entry } = await emitNetworkEntry({
      url: '/api/raw',
      response: makeResponse('{"ok":true}'),
      // 故意传非 JSON 字符串，让 safeParseJSON 失败 → 保留 string
      body: 'token=abc123 password=hunter2',
    });

    expect(typeof entry.context?.['requestData']).toBe('string');

    const hook = (e: LogEntry): LogEntry => {
      if (e.tags?.errorCategory === 'http' && e.context && 'requestData' in e.context) {
        const v = e.context['requestData'];
        if (typeof v === 'string') {
          return {
            ...e,
            context: {
              ...e.context,
              requestData: v.replace(/(password|token|sk-[a-z0-9]+)\s*[:=]\s*\S+/gi, '$1=***'),
            },
          };
        }
      }
      return e;
    };

    const out = hook(entry);
    expect(out.context?.['requestData']).toBe('token=*** password=***');
    logger.destroy();
  });

  it('redact-network.ts 的全字段脱敏模式生效（兼容 string / object）', async () => {
    const { logger, entry } = await emitNetworkEntry({
      url: '/api/sensitive?token=abc&phone=13800138000',
      response: makeResponse('{"secret":"x"}'),
      body: '{"password":"secret"}',
    });

    const hook = (e: LogEntry): LogEntry => {
      if (e.tags?.errorCategory !== 'http') return e;
      const ctx = e.context;
      if (!ctx) return e;

      const next: Record<string, unknown> = { ...ctx };
      if (typeof ctx['url'] === 'string') {
        next['url'] = (ctx['url'] as string).replace(/(token|phone)=[^&#]+/gi, '$1=***');
      }
      if (ctx['requestData'] !== undefined) next['requestData'] = '[REDACTED]';
      if (ctx['responseData'] !== undefined) next['responseData'] = '[REDACTED]';

      return { ...e, context: next };
    };

    const out = hook(entry);
    expect(out.context?.['url']).toContain('token=***');
    expect(out.context?.['url']).toContain('phone=***');
    expect(out.context?.['requestData']).toBe('[REDACTED]');
    expect(out.context?.['responseData']).toBe('[REDACTED]');
    logger.destroy();
  });

  it('drop-noise.ts 能基于 context.status 丢弃 401/403', async () => {
    const ok = await emitNetworkEntry({
      url: '/api/ok',
      response: makeResponse('ok', { status: 200 }),
    });
    const forbidden = await emitNetworkEntry({
      url: '/api/forbidden',
      response: makeResponse('no', { status: 403, statusText: 'Forbidden' }),
    });

    const IGNORED = new Set([401, 403]);
    const hook = (e: LogEntry): LogEntry | null => {
      if (
        e.tags?.errorCategory === 'http'
        && IGNORED.has(e.context?.['status'] as number)
      ) {
        return null;
      }
      return e;
    };

    expect(hook(ok.entry)).not.toBeNull();
    expect(hook(forbidden.entry)).toBeNull();

    ok.logger.destroy();
    forbidden.logger.destroy();
  });

  it('整条管道：NetworkPlugin → BeforeSendPlugin 的 hook 能修改最终 entry', async () => {
    window.fetch = vi.fn().mockResolvedValue(makeResponse('{"ok":true}'));
    const logger = new AemeathLogger({ enableConsole: false });
    logger.use(new NetworkPlugin({ slowThreshold: 99999 }));
    logger.use(
      new BeforeSendPlugin({
        beforeSend: (e) => {
          if (e.tags?.errorCategory === 'http' && e.context) {
            return {
              ...e,
              context: {
                ...e.context,
                requestData: '[REDACTED]',
                responseData: '[REDACTED]',
              },
            };
          }
          return e;
        },
      }),
    );

    const captured: LogEntry[] = [];
    logger.on('log', (e) => captured.push(e as LogEntry));

    await window.fetch('/api/x', { method: 'POST', body: 'sensitive' });
    await new Promise((r) => setTimeout(r, 0));

    expect(captured.length).toBeGreaterThanOrEqual(1);
    const last = captured[captured.length - 1]!;
    expect(last.context?.['requestData']).toBe('[REDACTED]');
    expect(last.context?.['responseData']).toBe('[REDACTED]');
    logger.destroy();
  });
});
