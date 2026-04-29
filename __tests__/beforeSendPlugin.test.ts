/**
 * BeforeSendPlugin 测试
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { BeforeSendPlugin } from '../src/plugins/BeforeSendPlugin';
import { PluginPriority } from '../src/types';
import type { LogEntry } from '../src/types';
import {
  initAemeath,
  resetAemeath,
} from '../src/singleton';
import { setBeforeSend, getAemeath } from '../src';

describe('BeforeSendPlugin — 单元测试', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    logger = new AemeathLogger({ enableConsole: false });
  });

  it('未设置钩子时，日志原样通过', () => {
    const received: LogEntry[] = [];
    logger.use(new BeforeSendPlugin());
    logger.on('log', (e) => received.push(e as LogEntry));
    logger.info('hello');
    expect(received).toHaveLength(1);
    expect(received[0]!.message).toBe('hello');
  });

  it('钩子返回新 entry 时，listener 收到修改后的版本', () => {
    const received: LogEntry[] = [];
    logger.use(
      new BeforeSendPlugin({
        beforeSend: (entry) => ({ ...entry, message: 'REDACTED' }),
      }),
    );
    logger.on('log', (e) => received.push(e as LogEntry));
    logger.info('sensitive data');
    expect(received[0]!.message).toBe('REDACTED');
  });

  it('钩子返回 null 时，listener 不会收到日志', () => {
    const received: LogEntry[] = [];
    logger.use(
      new BeforeSendPlugin({
        beforeSend: () => null,
      }),
    );
    logger.on('log', (e) => received.push(e as LogEntry));
    logger.info('drop me');
    expect(received).toHaveLength(0);
  });

  it('钩子返回 undefined 时，原 entry 通过', () => {
    const received: LogEntry[] = [];
    logger.use(
      new BeforeSendPlugin({
        beforeSend: () => undefined,
      }),
    );
    logger.on('log', (e) => received.push(e as LogEntry));
    logger.info('hello');
    expect(received[0]!.message).toBe('hello');
  });

  it('钩子返回非法值（数字）时，回退到原 entry（fail-safe）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received: LogEntry[] = [];
    logger.use(
      new BeforeSendPlugin({
        beforeSend: (() => 42) as never,
      }),
    );
    logger.on('log', (e) => received.push(e as LogEntry));
    logger.info('hello');
    expect(received[0]!.message).toBe('hello');
    const msg = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(msg).toMatch(/invalid value/i);
    warnSpy.mockRestore();
  });

  it('async 钩子返回 Promise 时，回退到原 entry 并 console.warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received: LogEntry[] = [];
    logger.use(
      new BeforeSendPlugin({
        // 故意用 async 模拟用户误用；真实 API 为同步
        beforeSend: (async (entry: LogEntry) => ({ ...entry, message: 'SHOULD_NOT_APPLY' })) as never,
      }),
    );
    logger.on('log', (e) => received.push(e as LogEntry));
    logger.info('hello');
    expect(received[0]!.message).toBe('hello');
    const messages = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(messages).toMatch(/Promise|thenable/i);
    warnSpy.mockRestore();
  });

  it('钩子返回缺 level 的对象时，回退到原 entry（与 Logger 的 afterLog 校验对齐）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received: LogEntry[] = [];
    logger.use(
      new BeforeSendPlugin({
        beforeSend: (() => ({ logId: 'forged' })) as never,
      }),
    );
    logger.on('log', (e) => received.push(e as LogEntry));
    logger.info('hello');
    expect(received[0]!.message).toBe('hello');
    expect(received[0]!.logId).not.toBe('forged');
    expect(
      warnSpy.mock.calls.map((c) => c.join(' ')).join('\n'),
    ).toMatch(/invalid value/i);
    warnSpy.mockRestore();
  });

  it('钩子返回缺 logId 的对象时，回退到原 entry', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received: LogEntry[] = [];
    logger.use(
      new BeforeSendPlugin({
        beforeSend: (() => ({ level: 'info', message: 'noLogId' })) as never,
      }),
    );
    logger.on('log', (e) => received.push(e as LogEntry));
    logger.info('hello');
    expect(received[0]!.message).toBe('hello');
    expect(
      warnSpy.mock.calls.map((c) => c.join(' ')).join('\n'),
    ).toMatch(/invalid value/i);
    warnSpy.mockRestore();
  });

  it('钩子抛出异常时，原 entry 通过（fail-safe）', () => {
    const received: LogEntry[] = [];
    logger.use(
      new BeforeSendPlugin({
        beforeSend: () => {
          throw new Error('boom');
        },
      }),
    );
    logger.on('log', (e) => received.push(e as LogEntry));
    expect(() => logger.info('hello')).not.toThrow();
    expect(received[0]!.message).toBe('hello');
  });

  it('debug=true 时，钩子异常会打印 console.warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logger.use(
      new BeforeSendPlugin({
        debug: true,
        beforeSend: () => {
          throw new Error('boom');
        },
      }),
    );
    logger.info('hello');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('priority 必须是 PluginPriority.LATEST', () => {
    const plugin = new BeforeSendPlugin();
    expect(plugin.priority).toBe(PluginPriority.LATEST);
  });

  it('setHook / clearHook 可在运行时切换钩子', () => {
    const received: LogEntry[] = [];
    const plugin = new BeforeSendPlugin();
    logger.use(plugin);
    logger.on('log', (e) => received.push(e as LogEntry));

    logger.info('a');
    expect(received[0]!.message).toBe('a');

    plugin.setHook((entry) => ({ ...entry, message: 'B' }));
    logger.info('a');
    expect(received[1]!.message).toBe('B');

    plugin.clearHook();
    logger.info('c');
    expect(received[2]!.message).toBe('c');
  });

  it('在所有插件 afterLog 之后执行（priority: LATEST）', () => {
    const order: string[] = [];
    logger.use({
      name: 'p1',
      install() {},
      afterLog(entry) {
        order.push('p1');
        return entry;
      },
    });
    logger.use({
      name: 'p2',
      install() {},
      afterLog(entry) {
        order.push('p2');
        return entry;
      },
    });
    logger.use(
      new BeforeSendPlugin({
        beforeSend: (entry) => {
          order.push('beforeSend');
          return entry;
        },
      }),
    );
    logger.info('hello');
    expect(order).toEqual(['p1', 'p2', 'beforeSend']);
  });

  it('uninstall 后钩子失效', () => {
    const received: LogEntry[] = [];
    const plugin = new BeforeSendPlugin({
      beforeSend: () => null,
    });
    logger.use(plugin);
    logger.on('log', (e) => received.push(e as LogEntry));

    logger.info('first');
    expect(received).toHaveLength(0);

    logger.uninstall('before-send');
    logger.info('second');
    expect(received).toHaveLength(1);
  });
});

describe('BeforeSendPlugin — 集成测试（initAemeath + setBeforeSend）', () => {
  beforeEach(() => {
    resetAemeath();
  });

  afterEach(() => {
    resetAemeath();
  });

  it('initAemeath 不传 beforeSend 也会注入插件，可后续动态启用', () => {
    const logger = initAemeath({});
    const plugin = logger.getPluginInstance('before-send');
    expect(plugin).toBeDefined();
    expect(plugin?.priority).toBe(PluginPriority.LATEST);
  });

  it('initAemeath 传入 beforeSend 时，钩子立即生效', () => {
    const received: LogEntry[] = [];
    const logger = initAemeath({
      beforeSend: (entry) => ({ ...entry, message: 'INIT_REDACTED' }),
    });
    logger.on('log', (e) => received.push(e as LogEntry));
    logger.info('original');
    expect(received[0]!.message).toBe('INIT_REDACTED');
  });

  it('setBeforeSend 可在运行时替换钩子', () => {
    const received: LogEntry[] = [];
    initAemeath({});
    const logger = getAemeath();
    logger.on('log', (e) => received.push(e as LogEntry));

    logger.info('one');
    expect(received[0]!.message).toBe('one');

    setBeforeSend((entry) => ({ ...entry, message: 'TWO' }));
    logger.info('two');
    expect(received[1]!.message).toBe('TWO');

    setBeforeSend(null);
    logger.info('three');
    expect(received[2]!.message).toBe('three');
  });

  it('setBeforeSend 在任何 Aemeath 实例存在前调用：不抛错，并 warn 提醒被丢弃', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => setBeforeSend(() => null)).not.toThrow();
    const messages = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(messages).toContain('setBeforeSend');
    expect(messages).toMatch(/dropped|drop/i);
    warnSpy.mockRestore();
  });

  it('用户先调 getAemeath() 再 initAemeath({ beforeSend }) 时，beforeSend 仍能生效', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const received: LogEntry[] = [];
    const logger = getAemeath();
    logger.on('log', (e) => received.push(e as LogEntry));

    initAemeath({
      beforeSend: (entry) => ({ ...entry, message: 'INIT_HOOK' }),
    });

    logger.info('original');
    expect(received).toHaveLength(1);
    expect(received[0]!.message).toBe('INIT_HOOK');

    warnSpy.mockRestore();
  });

  it('用户先调 getAemeath() 再 initAemeath({ upload, ... }) 时，会 warn 提示 options 被忽略', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    getAemeath();
    initAemeath({
      upload: async () => ({ success: true }),
      tags: { service: 'web' },
    });

    const messages = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(messages).toContain('options were ignored');
    expect(messages).toContain('upload');
    expect(messages).toContain('tags');

    warnSpy.mockRestore();
  });

  it('用户先调 getAemeath() 再 setBeforeSend(...) 也能生效（兜底分支已注入 BeforeSendPlugin）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const received: LogEntry[] = [];
    const logger = getAemeath();
    logger.on('log', (e) => received.push(e as LogEntry));

    setBeforeSend((entry) => ({ ...entry, message: 'PATCHED' }));
    logger.info('plain');

    expect(received).toHaveLength(1);
    expect(received[0]!.message).toBe('PATCHED');

    warnSpy.mockRestore();
  });

  it('beforeSend 返回 null 时，UploadPlugin 不会被调用', async () => {
    const uploadSpy = vi.fn(async () => ({ success: true }));
    initAemeath({
      upload: uploadSpy,
      beforeSend: () => null,
      queue: { uploadInterval: 50, maxSize: 10 },
    });
    const logger = getAemeath();
    logger.error('drop me');
    await new Promise((r) => setTimeout(r, 200));
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('beforeSend 修改的字段会被 UploadPlugin 看到', async () => {
    const uploaded: LogEntry[] = [];
    const uploadSpy = vi.fn(async (entry: LogEntry) => {
      uploaded.push(entry);
      return { success: true };
    });
    initAemeath({
      upload: uploadSpy,
      beforeSend: (entry) => ({
        ...entry,
        context: { ...entry.context, redacted: true },
      }),
      queue: { uploadInterval: 50, maxSize: 10 },
    });
    const logger = getAemeath();
    logger.error('upload me');
    await new Promise((r) => setTimeout(r, 200));
    expect(uploadSpy).toHaveBeenCalled();
    expect(uploaded[0]?.context).toMatchObject({ redacted: true });
  });
});
