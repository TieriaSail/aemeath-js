import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { EarlyErrorCapturePlugin, type EarlyError } from '../src/plugins/EarlyErrorCapturePlugin';
import { init, destroy } from '../src/browser/index';
import type { LogEntry } from '../src/types';

const win = window as unknown as { __flushEarlyErrors__?: (callback: (errors: EarlyError[]) => void) => void };
const loggers: AemeathLogger[] = [];
const plugins: EarlyErrorCapturePlugin[] = [];
const callbacks: ((errors: EarlyError[]) => void)[] = [];
function create(options = {}) { const logger = new AemeathLogger({ enableConsole: false, ...options }); loggers.push(logger); return logger; }
function record(message = 'valid'): EarlyError {
  return { type: 'error', message, stack: null, timestamp: 1, device: { ua: '', lang: '', screen: '', url: '', time: 1 } };
}
function plugin() { const instance = new EarlyErrorCapturePlugin(); plugins.push(instance); return instance; }
function receivedBy(logger: AemeathLogger) { const result: LogEntry[] = []; logger.on('log', value => result.push(value as LogEntry)); return result; }
beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  win.__flushEarlyErrors__ = callback => { callbacks.push(callback); };
});
afterEach(() => {
  plugins.splice(0).forEach(p => p.uninstall()); destroy(); loggers.splice(0).forEach(logger => logger.destroy());
  callbacks.length = 0; delete win.__flushEarlyErrors__;
});

describe.each(['plugin', 'browser'] as const)('early handoff via %s', surface => {
  function start() {
    if (surface === 'browser') return init({ enableConsole: false, errorCapture: false, browserApiErrors: false, safeGuard: false });
    const logger = create(); plugin().install(logger); return logger;
  }
  it.each(['null', 'field', 'index'] as const)('isolates a broken %s record and forwards the next record', kind => {
    const logger = start(); const logs = receivedBy(logger);
    const items = [record('bad'), record('valid')];
    if (kind === 'null') items[0] = null as unknown as EarlyError;
    if (kind === 'field') Object.defineProperty(items[0], 'type', { get() { throw Error('bad field'); } });
    if (kind === 'index') Object.defineProperty(items, '0', { get() { throw Error('bad index'); } });
    expect(() => callbacks[0]!(items)).not.toThrow();
    expect(logs).toHaveLength(1); expect(logs[0]!.error?.value).toBe('valid');
  });

  it('continues after the host logger rejects one record', () => {
    const logger = start(); const logs = receivedBy(logger); const original = logger.error.bind(logger);
    vi.spyOn(logger, 'error').mockImplementationOnce(() => { throw Error('host failure'); }).mockImplementation(original);
    expect(() => callbacks[0]!([record('bad'), record('valid')])).not.toThrow();
    expect(logs).toHaveLength(1); expect(logs[0]!.error?.value).toBe('valid');
  });
});

it.each([false, true])('ignores a stale callback after remount (same logger=%s)', sameLogger => {
  const first = create(); const second = sameLogger ? first : create(); const logs = receivedBy(second); const instance = plugin();
  instance.install(first); instance.uninstall(); instance.install(second);
  callbacks[0]!([record('stale')]); expect(logs).toEqual([]);
  callbacks[1]!([record('current')]); expect(logs).toHaveLength(1); expect(logs[0]!.error?.value).toBe('current');
});

it('does not transfer an old accepted batch into a new logger whose route is excluded', () => {
  const first = create(); const second = create({ routeMatch: { excludeRoutes: [() => true] } }); const logs = receivedBy(second); const instance = plugin();
  instance.install(first); instance.uninstall(); instance.install(second);
  callbacks[0]!([record('stale accepted')]); callbacks[1]!([record('excluded')]); expect(logs).toEqual([]);
});

it('stops an old batch if a subscriber remounts the plugin during forwarding', () => {
  const first = create(); const second = create(); const firstLogs = receivedBy(first); const secondLogs = receivedBy(second); const instance = plugin();
  instance.install(first);
  first.on('log', () => { instance.uninstall(); instance.install(second); });
  callbacks[0]!([record('first'), record('old remainder')]);
  expect(firstLogs).toHaveLength(1); expect(secondLogs).toEqual([]);
  callbacks[1]!([record('new batch')]); expect(secondLogs).toHaveLength(1); expect(secondLogs[0]!.error?.value).toBe('new batch');
});

it('hands off an excluded route even if console diagnostics fail', () => {
  const logger = create({ routeMatch: { excludeRoutes: [() => true] } }); const logs = receivedBy(logger);
  vi.mocked(console.debug).mockImplementation(() => { throw Error('bridge unavailable'); });
  expect(() => plugin().install(logger)).not.toThrow(); expect(callbacks).toHaveLength(1);
  callbacks[0]!([record()]); expect(logs).toEqual([]);
});

it('forwards the accepted batch even if console diagnostics fail', () => {
  const logger = create(); const logs = receivedBy(logger); plugin().install(logger);
  vi.mocked(console.debug).mockImplementation(() => { throw Error('bridge unavailable'); });
  expect(() => callbacks[0]!([record('a'), record('b')])).not.toThrow();
  expect(logs.map(log => log.error?.value)).toEqual(['a', 'b']);
});
