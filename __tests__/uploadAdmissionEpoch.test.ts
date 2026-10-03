import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin } from '../src/plugins/UploadPlugin';
import { LogLevel, type LogEntry } from '../src/types';

const loggers: AemeathLogger[] = [];
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => { loggers.splice(0).forEach(logger => logger.destroy()); vi.useRealTimers(); });
const entry = (id: string, split = false): LogEntry => ({ logId: id, message: id, timestamp: Date.now(), level: LogLevel.ERROR,
  ...(split ? { tags: { splitId: 'admission-group', splitIndex: 1, splitTotal: 2 } } : {}) });
async function flush(upload: UploadPlugin) { const done = upload.flush(); await vi.advanceTimersByTimeAsync(500); await done; }
function setup(getPriority?: (log: LogEntry) => number) {
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger);
  const sent: string[] = [], announced: string[] = [], dropped: string[] = [];
  const upload = new UploadPlugin({ onUpload: async log => { sent.push(log.logId); return { success: true }; },
    getPriority, cache: { enabled: false }, saveOnUnload: false,
    queue: { concurrency: 3, deduplicationDelay: 100, uploadInterval: 100000 } });
  logger.on('upload:enqueued', value => announced.push((value as { log: LogEntry }).log.logId));
  logger.on('upload:drop', value => dropped.push((value as { log: LogEntry }).log.logId));
  logger.use(upload);
  return { logger, upload, sent, announced, dropped };
}

describe('upload admission belongs to its starting installation', () => {
  for (const action of ['uninstall', 'reinstall'] as const) {
    it.each([false, true])(`stops an old requeue batch after ${action} in its first event (split=%s)`, async split => {
      const run = setup(); let acted = false;
      run.logger.on('upload:enqueued', () => {
        if (acted) return; acted = true; run.logger.uninstall('upload');
        if (action === 'reinstall') run.logger.use(run.upload);
      });
      run.upload.requeue([entry('first'), entry('old-remainder', split)]);
      expect(run.upload.getQueueStatus().admitting).toBe(0);
      expect(run.announced).toEqual(['first']);
      if (action === 'uninstall') {
        expect(vi.getTimerCount()).toBe(0);
        run.logger.use(run.upload);
      }
      await flush(run.upload);
      expect(run.sent).toEqual(['first']); expect(run.dropped).toEqual([]);
      run.upload.requeue(entry('new-call')); await flush(run.upload);
      expect(run.sent).toEqual(['first', 'new-call']);
    });

    it.each(['log', 'requeue'] as const)(`does not admit the old record after ${action} from getPriority (%s)`, async source => {
      let run!: ReturnType<typeof setup>, acted = false;
      run = setup(() => {
        if (!acted) {
          acted = true; run.logger.uninstall('upload');
          if (action === 'reinstall') run.logger.use(run.upload);
        }
        return 10;
      });
      const log = entry('old-priority', true);
      if (source === 'log') run.logger.error(log.message, { tags: log.tags }); else run.upload.requeue(log);
      expect(run.upload.getQueueStatus()).toMatchObject({ length: 0, admitting: 0, parked: 0 });
      expect(run.announced).toEqual([]);
      if (action === 'uninstall') { expect(vi.getTimerCount()).toBe(0); run.logger.use(run.upload); }
      await flush(run.upload); expect(run.sent).toEqual([]); expect(run.dropped).toEqual([]);
      run.upload.requeue(entry('new-priority')); await flush(run.upload);
      expect(run.sent).toEqual(['new-priority']);
    });
  }

  it('preserves ordinary batch admission, complete splits and priority fallback', async () => {
    const run = setup(() => { throw Error('priority unavailable'); });
    const first = entry('split-1', true), second = { ...entry('split-2'), tags: { ...first.tags, splitIndex: 2 } };
    run.upload.requeue([entry('plain'), first, second]); await flush(run.upload);
    expect(run.sent).toEqual(['plain', 'split-1', 'split-2']);
    expect(run.dropped).toEqual([]);
    expect(run.upload.getQueueStatus()).toMatchObject({ length: 0, admitting: 0, inFlight: 0 });
  });
});
