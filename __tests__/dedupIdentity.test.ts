import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { SafeGuardPlugin } from '../src/plugins/SafeGuardPlugin';
import { UploadPlugin } from '../src/plugins/UploadPlugin';
import { ErrorCapturePlugin } from '../src/plugins/ErrorCapturePlugin';
import { normalizeCapturedError } from '../src/utils/errorEvidence';
import { runInNewContext } from 'node:vm';
import { LogLevel, type ErrorInfo, type LogEntry } from '../src/types';

const loggers: AemeathLogger[] = [];
function logger() {
  const l = new AemeathLogger({ enableConsole: false }); loggers.push(l); return l;
}
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { loggers.splice(0).forEach(l => l.destroy()); vi.useRealTimers(); vi.restoreAllMocks(); });

const cases: Array<[string, ErrorInfo, ErrorInfo]> = [
  ['custom stack format', { type: 'Error', value: 'failed', stack: 'custom trace A' }, { type: 'Error', value: 'failed', stack: 'custom trace B' }],
  ['browser source', { type: 'global', value: 'failed', source: '/a.js', lineno: 10, colno: 2 }, { type: 'global', value: 'failed', source: '/b.js', lineno: 10, colno: 2 }],
  ['browser line', { type: 'global', value: 'failed', source: '/a.js', lineno: 10, colno: 2 }, { type: 'global', value: 'failed', source: '/a.js', lineno: 20, colno: 2 }],
  ['browser column', { type: 'global', value: 'failed', filename: '/a.js', lineno: 10, colno: 2 }, { type: 'global', value: 'failed', filename: '/a.js', lineno: 10, colno: 4 }],
  ['resource URL', { type: 'resource', value: 'Resource load failed', src: '/a.png' }, { type: 'resource', value: 'Resource load failed', src: '/b.png' }],
  ['error message at one site', { type: 'Error', value: 'first', stack: 'Error: first\n at work (/app.js:10:2)' }, { type: 'Error', value: 'second', stack: 'Error: second\n at work (/app.js:10:2)' }],
  ['error type at one site', { type: 'TypeError', value: 'failed', stack: 'TypeError: failed\n at work (/app.js:10:2)' }, { type: 'RangeError', value: 'failed', stack: 'RangeError: failed\n at work (/app.js:10:2)' }],
  ['Firefox location after a header', { type: 'Error', value: 'failed', stack: 'Error: failed\nwork@https://app.test/a.js:10:2' }, { type: 'Error', value: 'failed', stack: 'Error: failed\nwork@https://app.test/b.js:10:2' }],
];

describe('error identity across guard and legacy upload deduplication', () => {
  it.each(cases)('SafeGuard preserves distinct %s and merges a true repeat', (_label, first, second) => {
    const l = logger();
    const guard = new SafeGuardPlugin({ rateLimit: 1, maxErrors: 100, mergeWindow: 60000 }); l.use(guard);
    const received: LogEntry[] = []; l.on('log', log => received.push(log as LogEntry));
    l.info('warmup'); received.length = 0;
    for (const error of [first, second, second]) l.error('same log category', { error });
    expect(received).toHaveLength(2);
    expect(guard.getHealth().mergedCount).toBe(1);
  });

  it.each(cases)('Upload preserves distinct %s in legacy requeue entries and merges a true repeat', async (_label, first, second) => {
    const l = logger(); const received: LogEntry[] = []; const drops: string[] = [];
    const upload = new UploadPlugin({ onUpload: async log => { received.push(log); return { success: true }; },
      onDrop: (_log, info) => drops.push(info.reason), cache: { enabled: false }, saveOnUnload: false,
      queue: { deduplicationDelay: 100, maxRetries: 0 } }); l.use(upload);
    upload.requeue([first, second, second].map((error, index) => ({ logId: `legacy-${index}`, level: LogLevel.ERROR,
      message: 'same log category', timestamp: 1, error })));
    const pending = upload.flush();
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(received).toHaveLength(2);
    expect(drops).toEqual(['deduplicated']);
  });

  it.each([
    ['Aa', 'B@', undefined, undefined],
    ['same', 'same', { type: 'a|b', value: 'c' }, { type: 'a', value: 'b|c' }],
  ] as const)('SafeGuard does not merge colliding message/field keys (%s/%s)', (a, b, first, second) => {
    const l = logger(); l.use(new SafeGuardPlugin({ rateLimit: 1, maxErrors: 100, mergeWindow: 60000 }));
    const received: LogEntry[] = []; l.on('log', log => received.push(log as LogEntry));
    l.info('warmup'); received.length = 0;
    l.info(a, { error: first }); l.info(b, { error: second }); l.info(b, { error: second });
    expect(received).toHaveLength(2);
  });

  it('retains browser-only evidence locations through capture → SafeGuard', () => {
    const l = logger(); const guard = new SafeGuardPlugin({ rateLimit: 1, maxErrors: 100, mergeWindow: 60000 });
    l.use(guard); l.use(new ErrorCapturePlugin());
    const received: LogEntry[] = []; l.on('log', log => received.push(log as LogEntry));
    l.info('warmup'); received.length = 0;
    for (const source of ['/a.js', '/b.js', '/b.js']) window.onerror?.('failed', source, 10, 2, undefined);
    expect(received).toHaveLength(2);
    expect(received.map(log => log.error?.evidence?.browserLocation?.source)).toEqual(['/a.js', '/b.js']);
    expect(guard.getHealth().mergedCount).toBe(1);
  });
  it('uses evidence-only locations and ignores per-occurrence IDs', () => {
    const l = logger(); const guard = new SafeGuardPlugin({ rateLimit: 1, maxErrors: 100, mergeWindow: 60000 }); l.use(guard);
    const received: LogEntry[] = []; l.on('log', log => received.push(log as LogEntry));
    l.info('warmup'); received.length = 0;
    for (const source of ['/a.js', '/b.js', '/b.js']) {
      const error = normalizeCapturedError(undefined, { channel: 'global', message: 'failed', source, line: 10, column: 2 });
      l.error('category', { error });
    }
    expect(received).toHaveLength(2);
    expect(guard.getHealth().mergedCount).toBe(1);
  });

  it('keeps distinct foreign-realm Error messages at the same call site', () => {
    const l = logger(); l.use(new SafeGuardPlugin({ rateLimit: 1, maxErrors: 100, mergeWindow: 60000 }));
    const received: LogEntry[] = []; l.on('log', log => received.push(log as LogEntry));
    l.info('warmup'); received.length = 0;
    for (const message of ['first', 'second', 'second']) {
      const error = runInNewContext('new Error(message)', { message }) as Error;
      error.stack = `Error: ${message}\n at work (/app.js:10:2)`;
      l.error('category', { error });
    }
    expect(received).toHaveLength(2);
  });

  it('does not use a throwing error accessor as proof of duplicate identity', async () => {
    const l = logger(); const received: LogEntry[] = [];
    const upload = new UploadPlugin({ onUpload: async log => { received.push(log); return { success: true }; },
      cache: { enabled: false }, saveOnUnload: false, queue: { deduplicationDelay: 100, maxRetries: 0 } }); l.use(upload);
    const error = { type: 'Error', value: 'failed', get stack(): string { throw Error('unreadable'); } };
    upload.requeue([0, 1].map(index => ({ logId: `unreadable-${index}`, level: LogLevel.ERROR, message: 'category', timestamp: 1, error })));
    const pending = upload.flush();
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(received).toHaveLength(2);
  });

});
