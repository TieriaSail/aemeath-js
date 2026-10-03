import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { BeforeSendPlugin } from '../src/plugins/BeforeSendPlugin';
import type { LogEntry } from '../src/types';

const loggers: AemeathLogger[] = [];
const noop = () => {};
function setup(surface: 'beforeSend' | 'context', factory: (entry?: LogEntry) => unknown) {
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  if (surface === 'beforeSend') logger.use(new BeforeSendPlugin({ beforeSend: factory as never }));
  else logger.updateContext('ignored', (() => factory()) as never);
  const received: LogEntry[] = []; logger.on('log', value => received.push(value as LogEntry));
  return { logger, received };
}
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(noop); });
afterEach(() => loggers.splice(0).forEach(logger => logger.destroy()));

describe.each(['beforeSend', 'context'] as const)('ignored async %s results', surface => {
  it('observes rejection on every ignored Promise, including after the warning is suppressed', () => {
    const result = Promise.reject(new Error('invalid async hook'));
    const then = vi.spyOn(result, 'then'); const { logger, received } = setup(surface, () => result);
    try {
      logger.info('one'); logger.info('two');
      expect(then).toHaveBeenCalledTimes(2);
      for (const call of then.mock.calls) expect(call[1]).toBeTypeOf('function');
      expect(received.map(entry => entry.message)).toEqual(['one', 'two']);
    } finally {
      // Keep the pre-fix reproduction from leaking an unhandled rejection into Vitest.
      Promise.prototype.then.call(result, noop, noop);
    }
  });

  it('handles thenables with their original receiver and rejection callback', () => {
    let handled = 0; const receivers: unknown[] = [];
    const result = { then(this: unknown, _resolve: unknown, reject: (error: Error) => void) {
      receivers.push(this); reject(new Error('thenable rejection')); handled++;
    } };
    const { logger, received } = setup(surface, () => result);
    expect(() => logger.info('original')).not.toThrow();
    expect(receivers).toEqual([result]); expect(handled).toBe(1); expect(received).toHaveLength(1);
  });

  it('reads then once when attaching the rejection observer', () => {
    let reads = 0, handled = 0;
    const result = { get then() {
      if (++reads > 1) throw new Error('then was read twice');
      return (_resolve: unknown, reject: (error: Error) => void) => { reject(new Error('rejected')); handled++; };
    } };
    const { logger } = setup(surface, () => result); logger.info('original');
    expect(reads).toBe(1); expect(handled).toBe(1);
  });

  it('contains synchronous failure while attaching a thenable observer', () => {
    const then = vi.fn(() => { throw new Error('broken then'); });
    const { logger, received } = setup(surface, () => ({ then }));
    expect(() => logger.info('original')).not.toThrow();
    expect(then).toHaveBeenCalledOnce(); expect(received[0]!.message).toBe('original');
  });

  it('does not await or apply late fulfilled values', async () => {
    let resolve!: (value: unknown) => void;
    const result = new Promise<unknown>(done => { resolve = done; });
    const { logger, received } = setup(surface, () => result);
    logger.info('original'); expect(received).toHaveLength(1);
    resolve({ message: 'late modification', secret: 'late context' }); await result; await Promise.resolve();
    expect(received).toHaveLength(1); expect(received[0]!.message).toBe('original'); expect(received[0]!.context).toBeUndefined();
  });

  it('observes rejection even when warning output throws', () => {
    vi.mocked(console.warn).mockImplementation(() => { throw new Error('console unavailable'); });
    const result = Promise.reject(new Error('invalid async hook')); const then = vi.spyOn(result, 'then');
    const { logger, received } = setup(surface, () => result);
    try {
      expect(() => logger.info('original')).not.toThrow();
      expect(then).toHaveBeenCalledOnce(); expect(received).toHaveLength(1);
    } finally { Promise.prototype.then.call(result, noop, noop); }
  });

  it('keeps ordinary objects whose then field is not callable', () => {
    const { logger, received } = setup(surface, entry => ({ ...entry, then: 'metadata', marker: true }));
    logger.info('original');
    const value = surface === 'context' ? received[0]!.context : received[0];
    expect(value).toMatchObject({ then: 'metadata', marker: true });
  });
});
