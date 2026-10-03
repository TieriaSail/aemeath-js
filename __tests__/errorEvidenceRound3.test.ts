import { afterEach, describe, expect, it } from 'vitest';
import { normalizeCapturedError } from '../src/utils/errorEvidence';
import { forwardEarlyError } from '../src/utils/forwardEarlyError';
import { wrap } from '../src/utils/wrap';
import { AemeathLogger } from '../src/core/Logger';
import type { LogEntry } from '../src/types';

const loggers: AemeathLogger[] = [];
function recordingLogger() {
  const logger = new AemeathLogger({ enableConsole: false });
  loggers.push(logger);
  const records: LogEntry[] = [];
  logger.on('log', entry => records.push(entry as LogEntry));
  return { logger, records };
}
afterEach(() => loggers.splice(0).forEach(logger => logger.destroy()));

describe('third error evidence review', () => {
  it.each([8170, 8180, 8192])('preserves a boundary snapshot with %s detail bytes through Logger and JSON', size => {
    const reason: Record<string, unknown> = { detail: 'x'.repeat(size) };
    reason.self = reason;
    reason.status = 503;
    const first = normalizeCapturedError(reason, { channel: 'unhandledrejection' });
    const { logger, records } = recordingLogger();
    logger.error('Unhandled promise rejection', { error: first });
    let next = records[0].error!;
    for (let i = 0; i < 3; i++) {
      expect(next).toEqual(first);
      expect(next.reason).toEqual(JSON.parse(next.value));
      next = normalizeCapturedError(JSON.parse(JSON.stringify(next)));
    }
  });

  it('retains all 35 extensions through actual early handoff', () => {
    const raw = new Error('early fields');
    const fields = Object.fromEntries(Array.from({ length: 35 }, (_, i) => ['field' + i, i]));
    Object.assign(raw, fields);
    const first = normalizeCapturedError(raw, { phase: 'early', channel: 'global' });
    const { logger, records } = recordingLogger();
    forwardEarlyError(logger, { type: 'error', message: raw.message, stack: raw.stack || null, error: first,
      filename: 'app.js', lineno: 42, colno: 7, timestamp: 123,
      device: { ua: 'x', lang: 'en', screen: '800x600', url: 'https://app.test/', time: 123 } });
    expect(records[0].error).toMatchObject(fields);
    expect(records[0].error?.evidence?.normalization.issues).toEqual([]);
    expect(records[0].tags?.errorCategory).toBe('early');
    expect(normalizeCapturedError(JSON.parse(JSON.stringify(records[0].error)))).toEqual(records[0].error);
  });

  it.each(['status', '状态码'])('never truncates the property name %s', key => {
    const input = { detail: 'x'.repeat(8184), [key]: 503 };
    const output = normalizeCapturedError(input);
    const keys = Object.keys(output.reason as object);
    expect(keys.every(k => Object.prototype.hasOwnProperty.call(input, k))).toBe(true);
    expect(keys).toContain('detail');
    expect(output.evidence?.normalization.issues.length).toBeGreaterThan(0);
    expect(normalizeCapturedError(JSON.parse(JSON.stringify(output)))).toEqual(output);
  });

  it('keeps node-limited diagnostic arrays stable on repeated normalization', () => {
    const reason = { list: Array.from({ length: 8 }, () => Array.from({ length: 8 }, () =>
      Array.from({ length: 8 }, () => ({ deep: { value: 42 } })))) };
    const first = normalizeCapturedError(reason);
    expect(first.evidence?.normalization.issues.length).toBeGreaterThan(0);
    expect(normalizeCapturedError(JSON.parse(JSON.stringify(first)))).toEqual(first);
  });

  it('classifies wrapped synchronous objects without changing the thrown value', () => {
    const { logger, records } = recordingLogger();
    const reason = { status: 503 };
    const callback = wrap(() => { throw reason; }, error => logger.error('Caught error in wrapped callback', {
      error: normalizeCapturedError(error, { channel: 'wrapped' }),
    }));
    try { callback(); } catch (error) { expect(error).toBe(reason); }
    expect(records).toHaveLength(1);
    expect(records[0].tags?.errorCategory).toBe('manual');
    expect(records[0].error?.evidence?.captureChannel).toBe('wrapped');
  });

  it.each([
    ['unhandledrejection', 'promise'], ['resource', 'resource'], ['global', 'global'],
    ['wrapped', 'manual'], ['console', 'manual'],
  ])('prefers explicit %s capture over reason/location heuristics', (channel, category) => {
    const { logger, records } = recordingLogger();
    logger.error('captured', { error: normalizeCapturedError({ source: 'app.js', lineno: 42, status: 503 }, { channel }) });
    expect(records[0].tags?.errorCategory).toBe(category);
  });

  it('keeps legacy manual ErrorInfo reason classification compatible', () => {
    const { logger, records } = recordingLogger();
    logger.error('legacy', { error: { type: 'Error', value: 'legacy rejection', reason: 'failed' } });
    expect(records[0].tags?.errorCategory).toBe('promise');
  });
});
