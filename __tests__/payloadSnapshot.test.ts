import { describe, expect, it } from 'vitest';
import { sanitizeLogEntry, jsonBytes } from '../src/utils/payloadSanitize';
import { LogLevel, type LogEntry } from '../src/types';

const largeData = 'data:image/png;base64,' + 'A'.repeat(5000);
function entry(context: unknown): LogEntry {
  return { logId: 'snapshot', level: LogLevel.ERROR, message: 'failure', timestamp: 1, context: context as LogEntry['context'] };
}
function output(input: LogEntry) {
  const result = sanitizeLogEntry(input, { maxBytes: 2048 });
  expect(result.status).toBe('ok');
  const log = result.entries[0]!;
  expect(JSON.stringify(log)).not.toContain(largeData);
  expect(jsonBytes(log)).toBe(result.bytes);
  return log;
}

describe('payload serialization snapshots', () => {
  it.each(['object', 'array', 'inherited-array'] as const)('reads a %s accessor only once through upload', (kind) => {
    let reads = 0;
    const value = kind === 'object' ? {} : new Array(1);
    const owner = kind === 'inherited-array' ? Object.create(Array.prototype) : value;
    Object.defineProperty(owner, kind === 'object' ? 'value' : '0', {
      enumerable: true, get() { return ++reads === 1 ? 'checked' : largeData; },
    });
    if (kind === 'inherited-array') Object.setPrototypeOf(value, owner);
    const log = output(entry({ value }));
    expect(JSON.stringify(log)).toContain('checked');
    expect(reads).toBe(1);
  });

  it('snapshots a top-level context getter without changing its receiver', () => {
    let reads = 0;
    const input = entry(undefined);
    Object.defineProperty(input, 'context', { enumerable: true, get() {
      expect(this).toBe(input);
      return ++reads === 1 ? { value: 'checked' } : { value: largeData };
    } });
    expect(output(input).context).toEqual({ value: 'checked' });
    expect(reads).toBe(1);
  });

  it('isolates a throwing top-level field and keeps other fields', () => {
    const input = entry(undefined);
    Object.defineProperty(input, 'context', { enumerable: true, get() { throw Error('lazy field failed'); } });
    const log = output(input);
    expect(log.message).toBe('failure');
    expect(log.context).toBe('[omitted:unserializable]');
  });

  it.each([false, true])('reads a non-callable toJSON getter once (inherited=%s)', (inherited) => {
    let reads = 0;
    const owner = {};
    Object.defineProperty(owner, 'toJSON', { enumerable: true, get() {
      reads++;
      return reads === 1 ? undefined : () => largeData;
    } });
    const value = inherited ? Object.create(owner) : owner;
    output(entry({ value }));
    expect(reads).toBe(1);
  });

  it('stabilizes Date primitive conversion before sizing and upload', () => {
    let reads = 0;
    const date = new Date('2026-09-28T00:00:00.000Z');
    Object.defineProperty(date, 'valueOf', { value() {
      if (++reads > 1) throw Error('second conversion');
      return 0;
    } });
    const log = output(entry({ date }));
    expect(log.context).toEqual({ date: '2026-09-28T00:00:00.000Z' });
    expect(reads).toBe(1);
  });

  it('cleans a Date with a customized ISO serializer', () => {
    const date = new Date();
    date.toISOString = () => largeData;
    const result = sanitizeLogEntry(entry({ date }));
    expect(result.status).toBe('ok');
    expect(result.strips).toContainEqual({ path: 'context.date', kind: 'data-url', bytes: largeData.length });
    expect(JSON.stringify(result.entries)).not.toContain(largeData);
  });

  it('preserves clean data-only references and input accessors', () => {
    const input = entry({ nested: { value: 'checked' }, array: [1, 2] });
    expect(sanitizeLogEntry(input).entries[0]).toBe(input);
    const get = () => 'checked';
    const value = Object.defineProperty({}, 'value', { enumerable: true, get });
    output(entry({ value }));
    expect(Object.getOwnPropertyDescriptor(value, 'value')?.get).toBe(get);
  });
});
