import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin, type UploadResult } from '../src/plugins/UploadPlugin';
import { shouldIgnoreNetworkCapture, _resetIgnoreNetworkCapture } from '../src/utils/ignoreNetworkCapture';

const loggers: AemeathLogger[] = [];
beforeEach(() => { vi.useFakeTimers(); _resetIgnoreNetworkCapture(); });
afterEach(() => { loggers.splice(0).forEach(l => l.destroy()); vi.restoreAllMocks(); vi.useRealTimers(); _resetIgnoreNetworkCapture(); });
async function flush(upload: UploadPlugin) { const done = upload.flush(); await vi.advanceTimersByTimeAsync(500); await done; }
function setup(first: () => unknown, debug = false) {
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  let calls = 0; const success: unknown[] = []; const drops: string[] = [];
  const upload = new UploadPlugin({ debug, onUpload: async () => {
    calls++; return (calls === 1 ? first() : { success: true }) as UploadResult;
  }, onDrop: (_log, info) => drops.push(info.reason), cache: { enabled: false }, saveOnUnload: false,
    queue: { maxRetries: 1, offlinePolicy: 'legacy', retryBackoff: { baseMs: 5000 }, deduplicationDelay: 100 } });
  logger.use(upload); logger.on('upload:success', event => success.push(event));
  logger.error('must remain owned');
  return { logger, upload, success, drops, calls: () => calls };
}

const unreadable = (key: string) => Object.defineProperty({}, key, { get() { throw Error(`unreadable ${key}`); } });
describe('upload callback boundary', () => {
  it.each([
    ['undefined rejection', () => { throw undefined; }],
    ['null-prototype rejection', () => { throw Object.create(null); }],
    ['throwing message', () => { throw unreadable('message'); }],
    ['throwing response', () => { throw unreadable('response'); }],
    ['revoked proxy rejection', () => { const p = Proxy.revocable({}, {}); p.revoke(); throw p.proxy; }],
    ['throwing success', () => unreadable('success')],
    ['truthy string success', () => ({ success: 'false' })],
    ['numeric success', () => ({ success: 1 })],
    ['invalid retry reason', () => ({ success: false, shouldRetry: true, retryReason: Object.create(null) })],
    ['throwing retry intent', () => Object.assign(unreadable('shouldRetry'), { success: false })],
  ] as Array<[string, () => unknown]>)('retains and retries %s without false success', async (_name, first) => {
    const run = setup(first); await flush(run.upload);
    expect(run.calls()).toBe(1); expect(run.success).toHaveLength(0); expect(run.drops).toEqual([]);
    expect(run.upload.getQueueStatus()).toMatchObject({ length: 1, inFlight: 0 });
    expect(shouldIgnoreNetworkCapture()).toBe(false);
    await flush(run.upload);
    expect(run.calls()).toBe(2); expect(run.success).toHaveLength(1);
    expect(run.upload.getQueueStatus()).toMatchObject({ length: 0, inFlight: 0 });
  });

  it('reads result accessors once and retains their initial failure decision', async () => {
    let reads = 0;
    const run = setup(() => ({ success: false, get shouldRetry() { return ++reads === 1; }, retryReason: 'server' }));
    await flush(run.upload);
    expect(reads).toBe(1); expect(run.drops).toEqual([]);
    expect(run.upload.getQueueStatus().length).toBe(1);
    await flush(run.upload); expect(run.success).toHaveLength(1);
  });

  it('keeps a known permanent HTTP failure even if error text or response headers are unreadable', async () => {
    const error = unreadable('message');
    Object.assign(error, { response: Object.assign(unreadable('headers'), { status: 400 }) });
    const run = setup(() => { throw error; }); await flush(run.upload);
    expect(run.calls()).toBe(1); expect(run.success).toHaveLength(0); expect(run.drops).toEqual(['no-retry']);
    expect(run.upload.getQueueStatus().length).toBe(0);
  });

  it.each([undefined, {}, { success: false }])('preserves the legacy no-retry result %j', async result => {
    const run = setup(() => result); await flush(run.upload);
    expect(run.drops).toEqual(['no-retry']); expect(run.calls()).toBe(1);
  });

  it('does not inspect irrelevant failure fields on a successful response', async () => {
    const run = setup(() => Object.assign(unreadable('shouldRetry'), { success: true })); await flush(run.upload);
    expect(run.success).toHaveLength(1); expect(run.drops).toEqual([]);
  });

  it('does not lose queued work when debug console methods throw', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => { throw Error('console bridge failed'); });
    vi.spyOn(console, 'warn').mockImplementation(() => { throw Error('console bridge failed'); });
    const run = setup(() => { throw Error('callback failure'); }, true); await flush(run.upload);
    expect(run.upload.getQueueStatus().length).toBe(1); expect(run.success).toHaveLength(0);
    await flush(run.upload); expect(run.success).toHaveLength(1);
  });
  it('handles an unreadable late result after uninstall/remount without losing ownership', async () => {
    const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
    let resolveFirst!: (value: UploadResult) => void; let calls = 0;
    const success: unknown[] = []; logger.on('upload:success', value => success.push(value));
    const upload = new UploadPlugin({ onUpload: async () => {
      calls++; if (calls === 1) return new Promise<UploadResult>(resolve => { resolveFirst = resolve; });
      return { success: true };
    }, cache: { enabled: false }, saveOnUnload: false, queue: { deduplicationDelay: 100, maxRetries: 1 } });
    logger.use(upload); logger.error('remount');
    const pending = upload.flush(); await vi.advanceTimersByTimeAsync(1);
    logger.uninstall('upload'); logger.use(upload);
    resolveFirst(unreadable('success') as unknown as UploadResult);
    await vi.advanceTimersByTimeAsync(1000); await pending; await flush(upload);
    expect(calls).toBe(2); expect(success).toHaveLength(1);
    expect(upload.getQueueStatus()).toMatchObject({ length: 0, inFlight: 0 });
    expect(shouldIgnoreNetworkCapture()).toBe(false);
  });

});
