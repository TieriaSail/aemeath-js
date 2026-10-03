import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin } from '../src/plugins/UploadPlugin';
import { LogLevel, type LogEntry } from '../src/types';

const loggers: AemeathLogger[] = [];
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => {
  loggers.splice(0).forEach(logger => logger.destroy());
  vi.clearAllTimers(); vi.useRealTimers(); localStorage.clear();
});
function createLogger() {
  const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger); return logger;
}
function entry(id: string, index?: number, total = 2): LogEntry {
  return { logId: id, message: id, level: LogLevel.ERROR, timestamp: Date.now(),
    ...(index ? { tags: { splitId: 'group', splitIndex: index, splitTotal: total } } : {}) };
}
const boundaries = ['split-admission', 'capacity-admission', 'capacity-drop', 'incomplete', 'deduplication'] as const;

describe('committed notification batches retain their original host', () => {
  for (const boundary of boundaries) {
    it.each(['uninstall', 'other-host', 'none'] as const)(`${boundary} preserves its complete batch after %s`, async action => {
      const logger = createLogger(), other = createLogger();
      const enqueued: string[] = [], dropped: string[] = [], otherEvents: string[] = [];
      let armed = false, acted = false;
      const act = () => {
        if (!armed || acted || action === 'none') return;
        acted = true; logger.uninstall('upload');
        if (action === 'other-host') { upload.setOnUpload(null); other.use(upload); }
      };
      const onUpload = vi.fn(async () => ({ success: true }));
      const upload = new UploadPlugin({ onUpload, cache: { enabled: false }, saveOnUnload: false,
        getPriority: log => log.logId === 'incoming' ? 10 : 0,
        onDrop: () => { if (!boundary.endsWith('admission')) act(); },
        queue: { maxSize: boundary.startsWith('capacity') ? 2 : 3, deduplicationDelay: 100, uploadInterval: 100000 },
      });
      upload.setOnUpload(null); logger.use(upload);
      logger.on('upload:enqueued', value => {
        enqueued.push((value as { log: LogEntry }).log.logId);
        if (boundary.endsWith('admission')) act();
      });
      logger.on('upload:drop', value => dropped.push((value as { log: LogEntry }).log.logId));
      other.on('upload:enqueued', () => otherEvents.push('enqueued'));
      other.on('upload:drop', () => otherEvents.push('drop'));

      if (boundary === 'split-admission') {
        armed = true; upload.requeue([entry('first', 1), entry('second', 2)]);
      } else if (boundary.startsWith('capacity')) {
        upload.requeue([entry('first', 1), entry('second', 2)]);
        enqueued.length = 0; armed = true; upload.requeue(entry('incoming'));
      } else if (boundary === 'incomplete') {
        upload.requeue([entry('first', 1, 3), entry('second', 2, 3)]);
        armed = true; await vi.advanceTimersByTimeAsync(150);
      } else {
        upload.requeue(['first', 'second', 'third'].map(id => ({ ...entry(id), message: 'duplicate' })));
        armed = true; upload.setOnUpload(onUpload); await vi.advanceTimersByTimeAsync(150);
      }

      expect(otherEvents).toEqual([]);
      if (boundary === 'split-admission') {
        expect(enqueued).toEqual(['first', 'second']); expect(dropped).toEqual([]);
        expect(upload.getQueueStatus()).toMatchObject({ length: 2, admitting: 0 });
      } else if (boundary.startsWith('capacity')) {
        expect(enqueued).toEqual(['incoming']); expect(dropped.sort()).toEqual(['first', 'second']);
        expect(upload.peekQueuedForPersist().map(item => item.log.logId)).toEqual(['incoming']);
      } else if (boundary === 'incomplete') {
        expect(dropped.sort()).toEqual(['first', 'second']);
        expect(upload.getQueueStatus()).toMatchObject({ length: 0, admitting: 0 });
      } else {
        expect(dropped).toHaveLength(2); expect(new Set(dropped).size).toBe(2);
        expect(onUpload).toHaveBeenCalledTimes(action === 'none' ? 1 : 0);
      }
    });
  }

  it.each([false, true])('uninstall admission cleanup keeps all notifications (nested uninstall=%s)', nested => {
    const logger = createLogger(), dropped: string[] = [];
    const upload = new UploadPlugin({ onUpload: async () => ({ success: true }), cache: { enabled: false }, saveOnUnload: false });
    logger.use(upload);
    let acted = false;
    logger.on('upload:drop', value => {
      dropped.push((value as { log: LogEntry }).log.logId);
      if (nested && !acted) { acted = true; upload.uninstall(); }
    });
    upload.requeue([entry('first', 1, 3), entry('second', 2, 3)]);
    logger.uninstall('upload');
    expect(dropped).toEqual(['first', 'second']); expect(vi.getTimerCount()).toBe(0);
  });
});
