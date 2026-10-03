import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import type { AfterLogResult, LogEntry } from '../src/types';

const loggers: AemeathLogger[] = [];
function setup(hook: (entry: LogEntry) => AfterLogResult) {
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  logger.use({ name: 'subject', install() {}, afterLog: hook });
  const received: LogEntry[] = [];
  // A later transformation must still run after a failed result is rolled back.
  logger.use({ name: 'later', install() {}, afterLog: entry => ({ ...entry, message: entry.message + ':later' }) });
  logger.on('log', value => received.push(value as LogEntry));
  return { logger, received };
}
const broken = () => { throw new Error('unreadable plugin result'); };
beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => loggers.splice(0).forEach(logger => logger.destroy()));

describe('afterLog return-value boundary', () => {
  it.each(['logId', 'level'] as const)('keeps the original entry when returned %s cannot be read', key => {
    const { logger, received } = setup(entry => Object.defineProperty({ ...entry }, key, { get: broken }));
    expect(() => logger.info('original')).not.toThrow();
    expect(received).toHaveLength(1); expect(received[0]!.message).toBe('original:later');
  });

  it('keeps the original entry when the returned Proxy is revoked', () => {
    const { proxy, revoke } = Proxy.revocable({}, {}); revoke();
    const { logger, received } = setup(() => proxy as LogEntry);
    expect(() => logger.info('original')).not.toThrow();
    expect(received).toHaveLength(1); expect(received[0]!.message).toBe('original:later');
  });

  it.each(['iterator', 'member', 'length'] as const)('rolls back partial output when the array %s fails', kind => {
    const { logger, received } = setup(entry => {
      const result = [{ ...entry, message: 'partial output' }];
      if (kind === 'iterator') Object.defineProperty(result, Symbol.iterator, { value: function* () { yield result[0]!; broken(); } });
      if (kind === 'member') result.push(Object.defineProperty({ ...entry }, 'level', { get: broken }));
      if (kind === 'length') return new Proxy(result, { get(target, key, receiver) { if (key === 'length') return broken(); return Reflect.get(target, key, receiver); } });
      return result;
    });
    expect(() => logger.info('original')).not.toThrow();
    expect(received.map(entry => entry.message)).toEqual(['original:later']);
  });

  it('rolls back only the failing input while preserving earlier sibling output', () => {
    const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
    logger.use({ name: 'fanout', install() {}, afterLog: entry => ['a', 'b'].map(message => ({ ...entry, message, logId: message })) });
    logger.use({ name: 'fails-on-b', install() {}, afterLog: entry => {
      if (entry.message === 'a') return { ...entry, message: 'a:kept' };
      const out = [{ ...entry, message: 'b:partial' }];
      Object.defineProperty(out, Symbol.iterator, { value: function* () { yield out[0]!; broken(); } });
      return out;
    } });
    const received: LogEntry[] = []; logger.on('log', value => received.push(value as LogEntry));
    expect(() => logger.info('original')).not.toThrow();
    expect(received.map(entry => entry.message)).toEqual(['a:kept', 'b']);
  });

  it.each(['first', 'last'] as const)('treats an empty result on the %s split as a whole-group filter', which => {
    const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
    logger.use({ name: 'split', install() {}, afterLog: entry => [1, 2].flatMap(index => ['blocked', 'kept'].map(group => ({
      ...entry, logId: `${group}-${index}`, tags: { splitId: group, splitIndex: index, splitTotal: 2 },
    }))) });
    logger.use({ name: 'filter', install() {}, afterLog: entry => entry.tags?.splitId === 'blocked'
      && entry.tags?.splitIndex === (which === 'first' ? 1 : 2) ? [] : entry });
    const received: LogEntry[] = []; logger.on('log', value => received.push(value as LogEntry));
    logger.info('original');
    expect(received.map(entry => entry.logId)).toEqual(['kept-1', 'kept-2']);
  });

  it('keeps ordinary business splitId tags independent when filtering with an empty result', () => {
    const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
    logger.use({ name: 'business-fanout', install() {}, afterLog: entry => [1, 2].map(index => ({ ...entry, logId: String(index), tags: { splitId: 'business' } })) });
    logger.use({ name: 'filter', install() {}, afterLog: entry => entry.logId === '1' ? [] : entry });
    const received: LogEntry[] = []; logger.on('log', value => received.push(value as LogEntry));
    logger.info('original'); expect(received.map(entry => entry.logId)).toEqual(['2']);
  });


  it.each([false, []] as const)('does not restore explicitly filtered input when split metadata is unreadable (%j)', result => {
    const { logger, received } = setup(entry => {
      Object.defineProperty(entry, 'tags', { get: broken });
      return result as AfterLogResult;
    });
    expect(() => logger.info('must remain filtered')).not.toThrow();
    expect(received).toEqual([]);
  });

  it('retains the established meanings of false, empty, void and invalid arrays', () => {
    for (const [result, count] of [[false, 0], [[], 0], [undefined, 1], [[{}], 1]] as const) {
      const { logger, received } = setup(() => result as AfterLogResult);
      logger.info('original'); expect(received).toHaveLength(count);
    }
  });
});
