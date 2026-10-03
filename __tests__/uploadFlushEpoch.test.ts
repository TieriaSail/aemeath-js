import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin } from '../src/plugins/UploadPlugin';
import { LogLevel, type LogEntry } from '../src/types';

const loggers: AemeathLogger[] = [];
const key = 'flush-epoch';
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => { loggers.splice(0).forEach(logger => logger.destroy()); vi.useRealTimers(); });
const entry = (logId: string): LogEntry => ({ logId, message: logId, level: LogLevel.ERROR, timestamp: Date.now() });

async function setup(waiting: boolean) {
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sent: string[] = [];
  const upload = new UploadPlugin({ onUpload: async log => {
    sent.push(log.logId); if (log.logId === 'old') await gate; return { success: true };
  }, cache: { enabled: true, key }, saveOnUnload: false,
  queue: { concurrency: 1, deduplicationDelay: 100, uploadInterval: 100000 } });
  logger.use(upload); upload.requeue(entry('old'));
  if (waiting) await vi.advanceTimersByTimeAsync(100);
  const oldFlush = upload.flush(); await vi.advanceTimersByTimeAsync(0);
  expect(sent).toEqual(['old']);
  logger.uninstall('upload');
  const deadline = Date.now() + 5000;
  localStorage.setItem(key, JSON.stringify([{ log: entry('new'), priority: 0, retryCount: 0,
    timestamp: Date.now(), nextAttemptAt: deadline }]));
  logger.use(upload);
  return { logger, upload, oldFlush, release, sent, deadline };
}

describe('upload flush installation boundary', () => {
  for (const waiting of [false, true]) {
    it.each(['automatic', 'explicit'] as const)(`old flush cannot force the new installation (waiting=${waiting}, resume=%s)`, async resume => {
      const run = await setup(waiting); await vi.advanceTimersByTimeAsync(0);
      expect(run.sent).toEqual(['old']);
      run.release(); await vi.advanceTimersByTimeAsync(0); await run.oldFlush;
      expect(run.sent).toEqual(['old']);
      if (resume === 'explicit') {
        const done = run.upload.flush();
        await vi.advanceTimersByTimeAsync(500); await done;
      } else {
        await vi.advanceTimersByTimeAsync(run.deadline - Date.now() - 1);
        expect(run.sent).toEqual(['old']);
        await vi.advanceTimersByTimeAsync(201);
      }
      expect(run.sent).toEqual(['old', 'new']);
      expect(run.upload.getQueueStatus()).toMatchObject({ length: 0, inFlight: 0 });
    });
  }

  it('does not release the new flush force state when the old request completes', async () => {
    const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
    let releaseOld!: () => void, releaseNew!: () => void;
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
    const newGate = new Promise<void>(resolve => { releaseNew = resolve; });
    const sent: string[] = [];
    const upload = new UploadPlugin({ onUpload: async log => {
      sent.push(log.logId);
      if (log.logId === 'old') await oldGate;
      if (log.logId === 'new-first') await newGate;
      return { success: true };
    }, cache: { enabled: false }, saveOnUnload: false,
    queue: { concurrency: 1, deduplicationDelay: 100, uploadInterval: 100000 } });
    logger.use(upload); upload.requeue(entry('old'));
    const oldFlush = upload.flush(); await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(['old']);
    logger.uninstall('upload');
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    logger.use(upload); upload.requeue([entry('new-first'), entry('new-second')]);
    const newFlush = upload.flush(); await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(['old', 'new-first']);
    releaseOld(); await vi.advanceTimersByTimeAsync(0); await oldFlush;
    releaseNew(); await vi.advanceTimersByTimeAsync(500); await newFlush;
    expect(sent).toEqual(['old', 'new-first', 'new-second']);
    expect(upload.getQueueStatus()).toMatchObject({ length: 0, inFlight: 0 });
  });

  it('keeps overlapping flush calls in one installation functional', async () => {
    const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sent: string[] = [];
    const upload = new UploadPlugin({ onUpload: async log => {
      sent.push(log.logId); if (log.logId === 'first') await gate; return { success: true };
    }, cache: { enabled: false }, saveOnUnload: false,
    queue: { concurrency: 1, deduplicationDelay: 100, uploadInterval: 100000 } });
    logger.use(upload); upload.requeue([entry('first'), entry('second')]);
    const first = upload.flush(); await vi.advanceTimersByTimeAsync(0);
    const second = upload.flush(); release();
    await vi.advanceTimersByTimeAsync(500); await Promise.all([first, second]);
    expect(sent).toEqual(['first', 'second']);
    expect(upload.getQueueStatus()).toMatchObject({ length: 0, inFlight: 0 });
  });
});
