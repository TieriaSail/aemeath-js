import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { getEarlyErrorCaptureScript } from '../src/build-plugins/early-error-script';
import { AemeathLogger } from '../src/core/Logger';
import { ErrorCapturePlugin } from '../src/plugins/ErrorCapturePlugin';
import type { LogEntry } from '../src/types';

function early(standalone = false, maxErrors = 2) {
  const handlers: Record<string, (event: unknown) => void> = {};
  const win: any = { addEventListener: (name: string, callback: (event: unknown) => void) => { handlers[name] = callback; } };
  const script = standalone ? readFileSync('scripts/early-error.js', 'utf8') :
    getEarlyErrorCaptureScript({ maxErrors, autoRefreshOnChunkError: false, checkCompatibility: false });
  runInNewContext(script, { window: win, navigator: { userAgent: 'test', language: 'en' },
    screen: { width: 800, height: 600 }, location: { href: 'https://app.test/' }, setTimeout, clearTimeout });
  return { win, handlers, fire(error: unknown) { handlers.error({ target: win, message: 'native error', error }); } };
}

describe.each([false, true])('early reentrancy (standalone=%s)', standalone => {
  it('prevents nested capture while preserving later independent errors', () => {
    const { win, fire } = early(standalone);
    let reads = 0;
    const raw = { name: 'Error', get message() { if (++reads <= 20) fire(raw); return 'original'; } };
    fire(raw);
    expect(reads).toBe(1);
    expect(win.__EARLY_ERRORS__).toHaveLength(1);
    fire(new Error('later'));
    expect(win.__EARLY_ERRORS__).toHaveLength(2);
  });

  it('hands off the in-progress observation exactly once when its getter flushes', () => {
    const { win, fire } = early(standalone);
    const batches: any[][] = [];
    fire({ name: 'Error', get message() {
      win.__flushEarlyErrors__((errors: any[]) => batches.push(errors));
      return 'during handoff';
    } });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0][0].error.value).toBe('during handoff');
    expect(win.__EARLY_ERRORS__).toHaveLength(0);
    expect(win.__LOGGER_INITIALIZED__).toBe(true);
    fire(new Error('runtime'));
    expect(win.__EARLY_ERRORS__).toHaveLength(0);
  });

  it('preserves repeated flush callbacks without redelivering the observation', () => {
    const { win, fire } = early(standalone);
    const batches: any[][] = [];
    fire({ name: 'Error', get message() {
      win.__flushEarlyErrors__((errors: any[]) => batches.push(errors));
      win.__flushEarlyErrors__((errors: any[]) => batches.push(errors));
      return 'twice';
    } });
    expect(batches.map(batch => batch.length)).toEqual([1, 0]);
    const callback = vi.fn();
    win.__flushEarlyErrors__(callback);
    expect(callback).toHaveBeenCalledWith([]);
  });

  it('releases capture state after an event getter throws', () => {
    const { win, handlers, fire } = early(standalone);
    expect(() => handlers.error({ get target() { throw Error('target'); } })).not.toThrow();
    fire(new Error('next'));
    expect(win.__EARLY_ERRORS__).toHaveLength(1);
    expect(win.__AEMEATH_EARLY_CAPTURE_FAILURES__).toBe(1);
  });
});

it.each([0, 1, 2])('retains the configured early maxErrors=%s limit', max => {
  const { win, fire } = early(false, max);
  for (let i = 0; i < 5; i++) fire(new Error('error-' + i));
  expect(win.__EARLY_ERRORS__).toHaveLength(max);
});

const loggers: AemeathLogger[] = [];
afterEach(() => { loggers.splice(0).forEach(logger => logger.destroy()); vi.restoreAllMocks(); });
function recording(filter: (error: Error) => boolean) {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  const records: LogEntry[] = []; logger.on('log', entry => records.push(entry as LogEntry));
  logger.use(new ErrorCapturePlugin({ errorFilter: filter, captureConsoleError: true }));
  return records;
}
function trigger(channel: string, error: Error) {
  if (channel === 'global') (window.onerror as Function)('native error', 'app.js', 3, 5, error);
  else if (channel === 'console') console.error(error);
  else {
    const event = new Event('unhandledrejection');
    Object.defineProperty(event, 'reason', { value: error }); window.dispatchEvent(event);
  }
}

describe.each(['global', 'console', 'rejection'])('existing %s errorFilter configurations', channel => {
  it('keeps subtype filtering effective', () => {
    const filter = vi.fn((error: Error) => !(error instanceof TypeError));
    const records = recording(filter); const raw = new TypeError('expected');
    trigger(channel, raw);
    expect(filter).toHaveBeenCalledWith(raw);
    expect(records).toHaveLength(0);
    expect(Object.prototype.hasOwnProperty.call(raw, 'type')).toBe(false);
  });

  it('preserves custom exception identity and private-field methods', () => {
    class DomainError extends Error { #expected = true; isExpected() { return this.#expected; } }
    const raw = new DomainError('expected');
    const filter = vi.fn((error: Error) => error !== raw || !(error as DomainError).isExpected());
    const records = recording(filter); trigger(channel, raw);
    expect(filter).toHaveBeenCalledWith(raw);
    expect(records).toHaveLength(0);
  });

  it('preserves foreign-realm Error predicates', () => {
    const raw = runInNewContext('new TypeError("foreign")');
    const ForeignTypeError = Object.getPrototypeOf(raw).constructor;
    const filter = vi.fn((error: Error) => !(error instanceof ForeignTypeError));
    const records = recording(filter); trigger(channel, raw);
    expect(filter).toHaveBeenCalledWith(raw);
    expect(records).toHaveLength(0);
  });

  it('retains explicit filter redaction before building the captured snapshot', () => {
    const raw = new Error('secret'); raw.stack = 'Error: secret';
    const records = recording(error => { error.message = 'redacted'; error.stack = 'Error: redacted'; return true; });
    trigger(channel, raw);
    expect(records).toHaveLength(1);
    expect(records[0].error?.value).toBe('redacted');
    expect(JSON.stringify(records)).not.toContain('secret');
  });
});


it('keeps the legacy Error filter argument for stackless events without reporting its synthetic stack', () => {
  let received: Error | undefined;
  const filter = vi.fn((error: Error) => { received = error; return true; });
  const records = recording(filter);
  (window.onerror as Function)('Script error.', '', 0, 0, null);
  expect(filter).toHaveBeenCalledTimes(1);
  expect(received).toBeInstanceOf(Error);
  expect(typeof received?.stack).toBe('string');
  expect(records[0].error?.stack).toBeUndefined();
  expect(records[0].error?.evidence?.stackOrigin).toBe('unavailable');
});

it('rechecks the public buffer capacity after reading an application getter', () => {
  const { win, fire } = early();
  fire({ get message() { win.__EARLY_ERRORS__.push({ message: 'one' }, { message: 'two' }); return 'third'; } });
  expect(win.__EARLY_ERRORS__).toHaveLength(2);
});

it('respects a lifecycle change made while reading the error', () => {
  const { win, fire } = early();
  fire({ get message() { win.__LOGGER_INITIALIZED__ = true; return 'late'; } });
  expect(win.__EARLY_ERRORS__).toHaveLength(0);
});
