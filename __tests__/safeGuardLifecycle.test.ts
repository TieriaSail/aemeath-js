import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { SafeGuardPlugin } from '../src/plugins/SafeGuardPlugin';
import type { LogEntry } from '../src/types';

const loggers: AemeathLogger[] = [];
let idle: Array<() => void>;
function setup(mode: 'standard' | 'cautious' | 'strict' = 'cautious') {
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  const guard = new SafeGuardPlugin({ mode, maxErrors: 1, cooldownPeriod: 3000 }); logger.use(guard);
  const logs: LogEntry[] = []; logger.on('log', log => logs.push(log as LogEntry));
  const api = ((logger as unknown as { extensions?: unknown }).extensions ?? logger) as { pause(): void; resume(): void };
  return { logger, guard, logs, api };
}
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); idle = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('requestIdleCallback', (callback: () => void) => { idle.push(callback); return idle.length; });
  vi.stubGlobal('cancelIdleCallback', vi.fn());
});
afterEach(() => { loggers.splice(0).forEach(l => l.destroy()); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('SafeGuard lifecycle and replay ownership', () => {
  it.each([1000, 4000])('restores the remaining cooldown after remount (elapsed=%s)', elapsed => {
    const { logger, guard, logs } = setup('standard');
    logger.emit('error'); logger.emit('error');
    expect(guard.getHealth().state).toBe('open');
    logger.uninstall('safe-guard'); vi.advanceTimersByTime(elapsed); logger.use(guard);
    if (elapsed < 3000) {
      vi.advanceTimersByTime(1999); expect(guard.getHealth().state).toBe('open');
    }
    vi.advanceTimersByTime(1);
    expect(guard.getHealth().state).toBe('half-open');
    logger.info('accepted'); expect(logs.map(log => log.message)).toEqual(['accepted']);
    expect(guard.getHealth().state).toBe('closed');
  });

  it('reschedules parked logs when an old idle callback ran while uninstalled', () => {
    const { logger, guard, logs, api } = setup();
    api.pause(); logger.info('parked'); const stale = idle[0]!;
    logger.uninstall('safe-guard'); stale(); vi.advanceTimersByTime(4000);
    logger.use(guard); vi.advanceTimersByTime(1);
    expect(idle).toHaveLength(2); idle[1]!();
    expect(logs.map(log => log.message)).toEqual(['parked']);
    expect(guard.getHealth().parkingLotSize).toBe(0);
  });

  it('ignores an old idle callback after remount without changing the new schedule', () => {
    const { logger, guard, api } = setup();
    api.pause(); logger.info('parked'); const stale = idle[0]!;
    logger.uninstall('safe-guard'); logger.use(guard);
    const scheduled = idle.length; stale();
    expect(idle.length).toBe(scheduled);
    expect(guard.getHealth().parkingLotSize).toBe(1);
  });

  it.each(['cautious', 'strict'] as const)('stops %s replay at a renewed circuit break and retains the rest', mode => {
    const { logger, guard, logs, api } = setup(mode);
    // Error notifications may arrive synchronously from another log subscriber.
    logger.on('log', () => logger.emit('error'));
    api.pause(); for (let i = 0; i < 6; i++) logger.error(`parked-${i}`);
    api.resume();
    expect(logs.map(log => log.message)).toEqual(['parked-0', 'parked-1']);
    expect(guard.getHealth()).toMatchObject({ state: 'open', parkingLotSize: 4 });
    api.resume(); api.resume();
    expect(logs.map(log => log.message)).toEqual(Array.from({ length: 6 }, (_, i) => `parked-${i}`));
    expect(guard.getHealth().parkingLotSize).toBe(0);
  });

  it.each(['cautious', 'strict'] as const)('retains pending %s entries if a replay listener uninstalls the plugin', mode => {
    const { logger, guard, logs, api } = setup(mode);
    api.pause(); for (let i = 0; i < 4; i++) logger.info(`parked-${i}`);
    const uninstall = () => { logger.off('log', uninstall); logger.uninstall('safe-guard'); };
    logger.on('log', uninstall); api.resume();
    expect(logs.map(log => log.message)).toEqual(['parked-0']);
    expect(guard.getHealth().parkingLotSize).toBe(3);
    logger.use(guard);
    const current = idle[idle.length - 1]!; current();
    expect(logs.map(log => log.message)).toEqual(Array.from({ length: 4 }, (_, i) => `parked-${i}`));
  });

  it('falls back to a timer when the idle scheduler throws', () => {
    vi.stubGlobal('requestIdleCallback', () => { throw Error('idle unavailable'); });
    const { logger, guard, logs, api } = setup();
    api.pause(); logger.info('parked');
    vi.advanceTimersByTime(5001);
    expect(logs.map(log => log.message)).toEqual(['parked']);
    expect(guard.getHealth().parkingLotSize).toBe(0);
  });
  it('skips malformed persisted entries without losing valid replay entries', () => {
    localStorage.setItem('__aemeath_safeguard_parking__', JSON.stringify([
      { level: 'info', message: 'invalid', timestamp: Date.now(), options: null },
      { level: 'info', message: 'valid', timestamp: Date.now(), options: {} },
    ]));
    const { guard, logs } = setup('strict'); idle[0]!();
    expect(logs.map(log => log.message)).toEqual(['valid']);
    expect(guard.getHealth().parkingLotSize).toBe(0);
  });

});
