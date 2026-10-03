import { afterEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin } from '../src/plugins/UploadPlugin';
import { isConsoleCaptureSuppressed } from '../src/utils/consoleCaptureGuard';
import type { AemeathPlugin, LogEntry } from '../src/types';

const loggers: AemeathLogger[] = [];
function setup(options = {}) {
  const logger = new AemeathLogger(options);
  loggers.push(logger);
  return logger;
}
function host(overrides: Record<string, unknown> = {}): Console {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), ...overrides } as unknown as Console;
}
function withConsole<T>(value: Console, fn: () => T): T {
  const previous = globalThis.console;
  try { globalThis.console = value; return fn(); }
  finally { globalThis.console = previous; }
}
const broken = () => { throw new Error('native console bridge unavailable'); };
afterEach(() => { loggers.splice(0).forEach(logger => logger.destroy()); vi.useRealTimers(); });

describe('Logger console boundary', () => {
  it.each(['debug', 'info', 'track', 'warn', 'error'] as const)('delivers %s even if the console bridge throws', level => {
    const logger = setup();
    const received = vi.fn(); logger.on('log', received);
    const target = level === 'track' ? 'info' : level;
    expect(() => withConsole(host({ [target]: broken }), () => logger[level]('keep this log'))).not.toThrow();
    expect(received).toHaveBeenCalledTimes(1);
    expect(received.mock.calls[0]![0].message).toBe('keep this log');
    expect(isConsoleCaptureSuppressed()).toBe(false);
  });

  it('does not read unrelated console methods', () => {
    const logger = setup(); const target = host(); const getter = vi.fn(broken);
    Object.defineProperty(target, 'error', { get: getter });
    expect(() => withConsole(target, () => logger.info('info only'))).not.toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(target.info).toHaveBeenCalledOnce();
  });

  it('isolates a throwing getter on the selected console method', () => {
    const logger = setup(); const received = vi.fn(); logger.on('log', received);
    const target = host(); Object.defineProperty(target, 'error', { get: broken });
    expect(() => withConsole(target, () => logger.error('preserve'))).not.toThrow();
    expect(received).toHaveBeenCalledOnce(); expect(isConsoleCaptureSuppressed()).toBe(false);
  });

  it('preserves console receiver and formatting for all lines', () => {
    const logger = setup(); const receivers: unknown[] = []; const lines: unknown[][] = [];
    const target = host({ error: function(this: unknown, ...args: unknown[]) { receivers.push(this); lines.push(args); } });
    withConsole(target, () => logger.error('failure', { error: new Error('cause'), tags: { area: 'test' } }));
    expect(receivers).toEqual([target, target, target]);
    expect(lines[0]![0]).toMatch(/\[ERROR\]$/); expect(lines[0]![1]).toBe('failure');
    expect(lines[1]![0]).toBe('Error:'); expect(lines[2]![0]).toBe('Tags:');
  });

  it('works when console is absent or its selected method is not callable', () => {
    const logger = setup(); const received = vi.fn(); logger.on('log', received);
    for (const target of [undefined, host({ error: 42 })]) {
      expect(() => withConsole(target as Console, () => logger.error('preserve'))).not.toThrow();
    }
    expect(received).toHaveBeenCalledTimes(2);
  });

  it('continues log and delivery event listeners when debug warning fails', () => {
    const logger = setup({ enableConsole: false, debug: true });
    const logs = vi.fn(); const events = vi.fn(); const aliases = vi.fn();
    logger.on('log', broken); logger.on('log', logs);
    logger.on('upload:success', broken); logger.on('upload:success', events); logger.on('delivery:delivered', aliases);
    expect(() => withConsole(host({ warn: broken }), () => {
      logger.info('preserve'); logger.emit('upload:success', { log: { logId: 'x' } });
    })).not.toThrow();
    expect(logs).toHaveBeenCalledOnce(); expect(events).toHaveBeenCalledOnce(); expect(aliases).toHaveBeenCalledOnce();
  });

  it('continues plugin hooks and context fallbacks when debug warning fails', () => {
    const logger = setup({ enableConsole: false, debug: true }); const received = vi.fn();
    withConsole(host(), () => logger.use({ name: 'broken-hooks', install() {}, beforeLog: broken, afterLog: broken }));
    logger.updateContext('bad', broken); logger.updateContext('good', () => ({ ok: true })); logger.on('log', received);
    expect(() => withConsole(host({ warn: broken }), () => logger.info('preserve'))).not.toThrow();
    expect(received).toHaveBeenCalledOnce(); expect(received.mock.calls[0]![0].context).toEqual({ ok: true });
  });

  it('finishes plugin install notifications and uninstall cleanup despite debug failure', () => {
    const logger = setup({ enableConsole: false, debug: true }); const installed = vi.fn(); const removed = vi.fn();
    logger.on('plugin:install', installed); logger.on('plugin:uninstall', removed);
    expect(() => withConsole(host({ log: broken, warn: broken }), () => {
      logger.use({ name: 'broken-cleanup', install() {}, uninstall: broken });
      expect(logger.hasPlugin('broken-cleanup')).toBe(true);
      expect(logger.uninstall('broken-cleanup')).toBe(true);
    })).not.toThrow();
    expect(installed).toHaveBeenCalledWith('broken-cleanup'); expect(removed).toHaveBeenCalledWith('broken-cleanup');
    expect(logger.getPlugins()).toEqual([]);
  });

  it('finishes destruction of every plugin despite diagnostic failures', () => {
    const logger = setup({ enableConsole: false, debug: true }); const cleanup = vi.fn();
    withConsole(host(), () => {
      logger.use({ name: 'first', install() {}, uninstall: cleanup });
      logger.use({ name: 'second', install() {}, uninstall: broken });
    });
    expect(() => withConsole(host({ log: broken, warn: broken }), () => logger.destroy())).not.toThrow();
    expect(cleanup).toHaveBeenCalledOnce(); expect(logger.getPlugins()).toEqual([]);
  });

  it.each(['invalid-result', 'fanout', 'async-context'] as const)('does not drop logs when the %s warning fails', kind => {
    const logger = setup({ enableConsole: false }); const received = vi.fn(); logger.on('log', received);
    if (kind === 'async-context') logger.updateContext('async', (() => Promise.resolve({ ignored: true })) as never);
    else {
      const plugin: AemeathPlugin = { name: kind, install() {}, afterLog: entry => kind === 'invalid-result'
        ? {} as LogEntry : Array.from({ length: 65 }, (_, i) => ({ ...entry, logId: String(i) })) };
      logger.use(plugin);
    }
    expect(() => withConsole(host({ warn: broken }), () => logger.info('preserve'))).not.toThrow();
    expect(received).toHaveBeenCalledTimes(kind === 'fanout' ? 64 : 1);
  });

  it('suppresses diagnostic capture and restores the guard after a bridge failure', () => {
    const logger = setup({ enableConsole: false, debug: true }); const states: boolean[] = [];
    const target = host({ warn: () => { states.push(isConsoleCaptureSuppressed()); broken(); } });
    logger.on('log', broken);
    expect(() => withConsole(target, () => logger.info('first'))).not.toThrow();
    expect(states).toEqual([true]); expect(isConsoleCaptureSuppressed()).toBe(false);
  });

  it('reaches the real upload callback despite a broken default console', async () => {
    vi.useFakeTimers(); const logger = setup(); const onUpload = vi.fn(async (_log: LogEntry) => ({ success: true }));
    const upload = new UploadPlugin({ onUpload, cache: { enabled: false }, saveOnUnload: false }); logger.use(upload);
    expect(() => withConsole(host({ error: broken }), () => logger.error('deliver me'))).not.toThrow();
    const done = upload.flush(); await vi.advanceTimersByTimeAsync(300); await done;
    expect(onUpload).toHaveBeenCalledOnce(); expect(onUpload.mock.calls[0]![0]).toMatchObject({ message: 'deliver me' });
    expect(upload.getQueueStatus().length).toBe(0);
  });
});
