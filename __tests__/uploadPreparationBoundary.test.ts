import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin } from '../src/plugins/UploadPlugin';
import { generateId } from '../src/utils/generateId';
import { _resetIgnoreNetworkCapture, shouldIgnoreNetworkCapture } from '../src/utils/ignoreNetworkCapture';
import type { LogEntry } from '../src/types';
const loggers: AemeathLogger[] = [];
beforeEach(() => { vi.useFakeTimers(); _resetIgnoreNetworkCapture(); });
afterEach(() => { vi.unstubAllGlobals(); loggers.splice(0).forEach(logger => logger.destroy()); vi.useRealTimers(); _resetIgnoreNetworkCapture(); });
async function flush(upload: UploadPlugin) { const done = upload.flush(); await vi.advanceTimersByTimeAsync(300); await done; }
function setup(field: 'context' | 'tag', permanent: boolean, policy: 'legacy' | 'pause' = 'legacy') {
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  const onUpload = vi.fn(async (_entry: LogEntry) => ({ success: true })); const onDrop = vi.fn(); const delivered = vi.fn();
  const upload = new UploadPlugin({ onUpload, onDrop, cache: { enabled: false }, saveOnUnload: false,
    queue: { deduplicationDelay: 100, maxRetries: 1, offlinePolicy: policy, retryBackoff: { baseMs: 5000 } } });
  let reads = 0; let originalId = '';
  logger.on('upload:success', delivered);
  logger.on('upload:attempt', value => {
    const log = (value as { log: LogEntry }).log; originalId = log.logId;
    // Public subscribers can enrich entries after queue admission. The property
    // fails only when the request copy is materialized, not during admission.
    if (field === 'tag') log.tags ??= {};
    Object.defineProperty(field === 'tag' ? log.tags : log, field === 'tag' ? 'lateField' : 'context', {
      enumerable: true, configurable: true, get() {
        if (++reads === 1 || permanent) throw new Error('payload field unavailable');
        return field === 'tag' ? 'ready' : { ready: true };
      },
    });
  });
  logger.use(upload); logger.error('retain ownership');
  return { logger, upload, onUpload, onDrop, delivered, originalId: () => originalId };
}

describe('upload preparation boundary', () => {
  it.each(['context', 'tag'] as const)('retries a transient %s preparation failure without losing the log', async field => {
    const run = setup(field, false); await flush(run.upload);
    expect(run.onUpload).not.toHaveBeenCalled(); expect(run.delivered).not.toHaveBeenCalled(); expect(run.onDrop).not.toHaveBeenCalled();
    expect(run.upload.getQueueStatus()).toMatchObject({ length: 1, inFlight: 0 }); expect(shouldIgnoreNetworkCapture()).toBe(false);
    await flush(run.upload); expect(run.onUpload).toHaveBeenCalledOnce(); expect(run.delivered).toHaveBeenCalledOnce();
    expect(run.onUpload.mock.calls[0]![0]).toMatchObject({ logId: run.originalId(), requestId: expect.any(String) });
    expect(run.upload.getQueueStatus()).toMatchObject({ length: 0, inFlight: 0 }); expect(shouldIgnoreNetworkCapture()).toBe(false);
  });

  it.each(['context', 'tag'] as const)('reports a terminal drop when persistent %s preparation failure exhausts legacy retries', async field => {
    const run = setup(field, true); await flush(run.upload); await flush(run.upload);
    expect(run.onUpload).not.toHaveBeenCalled(); expect(run.onDrop).toHaveBeenCalledOnce();
    expect(run.onDrop.mock.calls[0]![1]).toMatchObject({ reason: 'max-retries', retryCount: 1 });
    expect(run.upload.getQueueStatus()).toMatchObject({ length: 0, inFlight: 0 }); expect(shouldIgnoreNetworkCapture()).toBe(false);
  });

  it('uses the established parked state when pause-mode preparation retries run out', async () => {
    const run = setup('context', true, 'pause'); await flush(run.upload); await flush(run.upload);
    expect(run.onUpload).not.toHaveBeenCalled(); expect(run.onDrop).not.toHaveBeenCalled();
    expect(run.upload.getQueueStatus()).toMatchObject({ length: 0, inFlight: 0, parked: 1 }); expect(shouldIgnoreNetworkCapture()).toBe(false);
  });

  it.each(['getter', 'call'] as const)('falls back when randomUUID %s fails, for both log and request IDs', async failure => {
    const provider = failure === 'getter'
      ? Object.defineProperty({}, 'randomUUID', { get() { throw Error('crypto bridge unavailable'); } })
      : { randomUUID() { throw Error('crypto bridge unavailable'); } };
    vi.stubGlobal('crypto', provider);
    const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
    const onUpload = vi.fn(async (_entry: LogEntry) => ({ success: true }));
    const upload = new UploadPlugin({ onUpload, cache: { enabled: false }, saveOnUnload: false }); logger.use(upload);
    expect(() => logger.error('fallback IDs')).not.toThrow(); await flush(upload);
    expect(onUpload).toHaveBeenCalledOnce(); const log = onUpload.mock.calls[0]![0];
    expect(log.logId).toMatch(/^\d+-[a-z0-9]+$/); expect(log.requestId).toMatch(/^\d+-[a-z0-9]+$/);
  });

  it('reads randomUUID once and preserves its receiver', () => {
    let reads = 0; const provider = { get randomUUID() {
      if (++reads > 1) throw Error('read twice');
      return function(this: unknown) { expect(this).toBe(provider); return 'native-id'; };
    } };
    vi.stubGlobal('crypto', provider); expect(generateId()).toBe('native-id'); expect(reads).toBe(1);
  });

  it('preserves the existing fallback when crypto is absent', () => {
    vi.stubGlobal('crypto', undefined); expect(generateId()).toMatch(/^\d+-[a-z0-9]+$/);
  });
});
