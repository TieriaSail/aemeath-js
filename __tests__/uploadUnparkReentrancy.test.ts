import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin } from '../src/plugins/UploadPlugin';
import { LogLevel } from '../src/types';

const loggers: AemeathLogger[] = [];
const key = 'unpark-reentrancy';
const ids = ['parked-first', 'parked-second', 'parked-third'];
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => { loggers.splice(0).forEach(logger => logger.destroy()); vi.useRealTimers(); });
function setup(serverDeadline = false) {
  const now = Date.now();
  localStorage.setItem(key, JSON.stringify(ids.map(logId => ({
    log: { logId, message: logId, timestamp: now, level: LogLevel.ERROR }, priority: 0,
    retryCount: 0, timestamp: now, parkedUntil: now + 5000,
    serverNotBefore: serverDeadline ? now + 5000 : undefined, source: 'offline-replay',
  }))));
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  const sent: string[] = [], unparked: string[] = [];
  logger.on('upload:unparked', value => unparked.push((value as { log: { logId: string } }).log.logId));
  const upload = new UploadPlugin({ onUpload: async log => { sent.push(log.logId); return { success: true }; },
    cache: { enabled: true, key }, saveOnUnload: false,
    queue: { concurrency: 1, deduplicationDelay: 100, uploadInterval: 100000 } });
  logger.use(upload);
  expect(upload.getQueueStatus().parked).toBe(3);
  return { logger, upload, sent, unparked };
}
async function flush(upload: UploadPlugin) {
  const done = upload.flush(); await vi.advanceTimersByTimeAsync(500); await done;
}

describe('upload parked queue synchronous reentrancy', () => {
  it.each(['uninstall', 'reinstall'] as const)('stops old unpark iteration after %s in the first event', async action => {
    const run = setup(); let acted = false;
    run.logger.on('upload:unparked', () => {
      if (acted) return; acted = true;
      run.logger.uninstall('upload');
      if (action === 'reinstall') run.logger.use(run.upload);
    });
    await flush(run.upload);
    expect(run.unparked).toEqual(ids.slice(0, 1));
    if (action === 'uninstall') {
      expect(run.sent).toEqual([]);
      expect(run.upload.getQueueStatus()).toMatchObject({ length: 1, parked: 2 });
      run.logger.use(run.upload); await vi.advanceTimersByTimeAsync(500);
    }
    expect(run.sent).toEqual(ids.slice(0, 1));
    expect(run.upload.getQueueStatus()).toMatchObject({ length: 0, parked: 2 });
    await vi.advanceTimersByTimeAsync(5500);
    expect(run.sent).toEqual(ids); expect(run.unparked).toEqual(ids);
    expect(run.upload.getQueueStatus()).toMatchObject({ length: 0, parked: 0, inFlight: 0 });
  });

  it('does not enqueue records again after a nested flush already unparked them', async () => {
    const run = setup(); let nested: Promise<void> | undefined;
    let acted = false;
    run.logger.on('upload:unparked', () => {
      if (acted) return; acted = true; nested = run.upload.flush();
    });
    await flush(run.upload); await nested;
    expect(run.sent).toEqual(ids); expect(run.unparked).toEqual(ids);
    expect(run.upload.getQueueStatus()).toMatchObject({ length: 0, parked: 0, inFlight: 0 });
  });

  it('still force-unparks each current local cooldown record once', async () => {
    const run = setup(); await flush(run.upload);
    expect(run.sent).toEqual(ids); expect(run.unparked).toEqual(ids);
    expect(run.upload.getQueueStatus()).toMatchObject({ length: 0, parked: 0, inFlight: 0 });
  });

  it('still respects server deadlines during an explicit flush', async () => {
    const run = setup(true); await flush(run.upload);
    expect(run.sent).toEqual([]); expect(run.unparked).toEqual([]);
    expect(run.upload.getQueueStatus().parked).toBe(3);
    await vi.advanceTimersByTimeAsync(5500);
    expect(run.sent).toEqual(ids); expect(run.unparked).toEqual(ids);
  });
});
