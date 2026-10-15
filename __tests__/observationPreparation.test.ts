import { afterEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { observationMetadata, observationPreparation } from '../src/core/observation';
import { BeforeSendPlugin } from '../src/plugins/BeforeSendPlugin';
import { SafeGuardPlugin } from '../src/plugins/SafeGuardPlugin';
import { PayloadSanitizePlugin } from '../src/plugins/PayloadSanitizePlugin';
import * as payloadSanitize from '../src/utils/payloadSanitize';
import { LogLevel, type AemeathPlugin, type BeforeSendHook, type LogEntry } from '../src/types';
const loggers: AemeathLogger[] = [];
function setup() {
  const logger = new AemeathLogger({ enableConsole: false, release: 'current-release', context: { user: { id: 'new-user' }, private: 'secret' } });
  loggers.push(logger);
  const owner: AemeathPlugin = { name: 'producer', install() {} }; logger.use(owner);
  return { logger, owner, input: { logId: 'original-id', timestamp: 123, level: LogLevel.WARN, message: 'old-page', release: 'old-release', options: { context: { original: true } } } };
}
afterEach(() => { loggers.splice(0).forEach(logger => logger.destroy()); vi.restoreAllMocks(); });
describe('durable observation preparation', () => {
  it('uses original identity without current user merge or listener/network publication', () => {
    const { logger, owner, input } = setup(); const listener = vi.fn(); logger.on('log', listener);
    const before = vi.fn(); logger.use({ name: 'pipeline', install() {}, beforeLog: before });
    const result = logger[observationPreparation](owner, input);
    expect(before).toHaveBeenCalledTimes(1); expect(listener).not.toHaveBeenCalled();
    expect(result).toEqual({ state: 'prepared', entries: [{ logId: 'original-id', timestamp: 123, level: LogLevel.WARN, message: 'old-page', release: 'old-release', context: { original: true } }] });
    expect(logger[observationMetadata](owner)).toEqual({ release: 'current-release', environment: undefined });
    logger.uninstall('producer'); expect(logger[observationPreparation](owner, input).state).toBe('unavailable');
  });
  it('runs sanitizing and final beforeSend once and detaches the final snapshot', () => {
    const { logger, owner, input } = setup();
    const hook = vi.fn(entry => ({ ...entry, message: 'redacted' }));
    logger.use(new PayloadSanitizePlugin()); logger.use(new BeforeSendPlugin({ beforeSend: hook }));
    const result = logger[observationPreparation](owner, input);
    expect(result.state).toBe('prepared'); expect(hook).toHaveBeenCalledTimes(1);
    if (result.state !== 'prepared') throw Error('missing prepared result');
    expect(result.entries[0]!.message).toBe('redacted'); input.options.context.original = false;
    expect(result.entries[0]!.context).toEqual({ original: true });
  });
  it('distinguishes deliberate filtering from unsafe hook failures while preserving ordinary fail-open behavior', () => {
    const { logger, owner, input } = setup(); const listener = vi.fn(); logger.on('log', listener);
    const plugin = new BeforeSendPlugin({ beforeSend: () => null }); logger.use(plugin);
    expect(logger[observationPreparation](owner, input).state).toBe('filtered');
    plugin.setHook(() => { throw Error('sanitizer unavailable'); });
    expect(logger[observationPreparation](owner, input).state).toBe('rejected');
    logger.warn('ordinary'); expect(listener).toHaveBeenCalledTimes(1);
    plugin.setHook((async (entry: LogEntry) => entry) as unknown as BeforeSendHook);
    expect(logger[observationPreparation](owner, input).state).toBe('rejected');
  });
  it('rejects invalid fanout, throwing custom hooks and unsafe serialization', () => {
    const { logger, owner, input } = setup();
    logger.use({ name: 'bad', install() {}, afterLog: () => ({ broken: true }) as never });
    expect(logger[observationPreparation](owner, input).state).toBe('rejected'); logger.uninstall('bad');
    logger.use({ name: 'throw', install() {}, beforeLog: () => { throw Error('unsafe'); } });
    expect(logger[observationPreparation](owner, input).state).toBe('rejected'); logger.uninstall('throw');
    const circular: Record<string, unknown> = {}; circular.self = circular;
    expect(logger[observationPreparation](owner, { ...input, options: { context: circular } }).state).toBe('rejected');
  });
  it('rejects durable observations when payload sanitizing fails while preserving ordinary logging', () => {
    const { logger, owner, input } = setup(); const listener = vi.fn(); logger.on('log', listener);
    logger.use(new PayloadSanitizePlugin());
    vi.spyOn(payloadSanitize, 'sanitizeLogEntry').mockImplementation(() => { throw Error('sanitizer unavailable'); });
    expect(logger[observationPreparation](owner, input).state).toBe('rejected');
    expect(listener).not.toHaveBeenCalled();
    logger.warn('ordinary'); expect(listener).toHaveBeenCalledTimes(1);
  });
  it('SafeGuard cannot park or merge observations into an ordinary replay', () => {
    const { logger, owner, input } = setup(); const listener = vi.fn(); logger.on('log', listener);
    const guard = new SafeGuardPlugin({ rateLimit: 1, mode: 'cautious' }); logger.use(guard);
    logger.info('normal');
    expect(logger[observationPreparation](owner, input).state).toBe('filtered');
    expect(guard.getHealth().parkingLotSize).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['rejected', false], ['entry-shaped', false], ['rejected', true], ['entry-shaped', true],
  ] as const)('rejects and observes an unsupported %s async afterLog result (fanout=%s)', async (kind, fanout) => {
    const { logger, owner, input } = setup();
    const entry: LogEntry = { logId: 'unsafe', timestamp: 123, level: LogLevel.WARN, message: 'unsanitized' };
    const result = kind === 'rejected' ? Promise.reject(new Error('async privacy failure')) : Object.assign(Promise.resolve(entry), entry);
    const then = vi.spyOn(result, 'then');
    const listener = vi.fn(); logger.on('log', listener);
    logger.use({ name: 'async-after', install() {}, afterLog: () => (fanout ? [result] : result) as never });
    try {
      expect(logger[observationPreparation](owner, input).state).toBe('rejected');
      expect(then).toHaveBeenCalledTimes(1);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      // Keep the deliberately rejected fixture handled even when the regression
      // assertion fails; the spy above proves the pipeline attached its handler.
      await result.catch(() => undefined);
      logger.uninstall('async-after');
    }
    logger.info('ordinary still works'); expect(listener).toHaveBeenCalledTimes(1);
  });
});
