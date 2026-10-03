import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin } from '../src/plugins/UploadPlugin';
import { OfflinePersistencePlugin } from '../src/plugins/OfflinePersistencePlugin';
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

describe('terminal events survive preceding host callbacks', () => {
  for (const boundary of ['resume-success', 'resume-drop', 'onDrop', 'split-onDrop'] as const) {
    it.each(['uninstall', 'remount', 'other-host', 'none'] as const)(`${boundary} preserves durable cleanup after %s`, async action => {
      const logger = createLogger(), other = createLogger();
      const key = 'terminal-target';
      const offline = new OfflinePersistencePlugin({ storage: 'localstorage', key });
      logger.use(offline); await offline.whenReady();
      let armed = false, acted = false, calls = 0;
      const events: string[] = [], otherEvents: string[] = [];
      const act = () => {
        if (!armed || acted || action === 'none') return;
        acted = true; logger.uninstall('upload');
        // Isolate terminal notification from a new installation's independent retries.
        if (action !== 'uninstall') {
          upload.setOnUpload(null); (action === 'other-host' ? other : logger).use(upload);
        }
      };
      const upload = new UploadPlugin({
        onUpload: async () => {
          calls++;
          if (calls === 1) return { success: false, shouldRetry: true, retryReason: 'network' as const };
          return boundary === 'resume-success' ? { success: true } : { success: false, shouldRetry: false };
        },
        onDrop: () => { if (boundary.includes('onDrop')) act(); },
        cache: { enabled: false }, saveOnUnload: false,
        queue: { suspectedOfflineThreshold: 1, deduplicationDelay: 100, uploadInterval: 100000 },
      });
      logger.on('upload:resumed', () => {
        if (!armed) return;
        events.push('resumed'); if (boundary.startsWith('resume')) act();
      });
      logger.on('upload:success', value => events.push(`success:${(value as { log: LogEntry }).log.logId}`));
      logger.on('upload:drop', value => events.push(`drop:${(value as { log: LogEntry }).log.logId}`));
      other.on('upload:success', () => otherEvents.push('success'));
      other.on('upload:drop', () => otherEvents.push('drop'));
      logger.use(upload);
      const ids = boundary === 'split-onDrop' ? ['first', 'second'] : ['first'];
      const entries: LogEntry[] = ids.map((logId, i) => ({
        logId, message: logId, level: LogLevel.ERROR, timestamp: Date.now(),
        ...(ids.length === 2 ? { tags: { splitId: 'group', splitIndex: i + 1, splitTotal: 2 } } : {}),
      }));
      upload.requeue(entries);
      const initial = upload.flush(); await vi.advanceTimersByTimeAsync(500); await initial;
      await offline.whenReady();
      expect(upload.getQueueStatus().paused).toBe(true);
      for (const id of ids) expect(localStorage.getItem(`${key}:r:${id}`)).not.toBeNull();
      armed = true;
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(500); await offline.whenReady();
      const prefix = boundary === 'resume-success' ? 'success' : 'drop';
      expect(events[0]).toBe('resumed');
      expect.soft(events.slice(1).sort()).toEqual(ids.map(id => `${prefix}:${id}`).sort());
      expect.soft(otherEvents).toEqual([]);
      for (const id of ids) expect.soft(localStorage.getItem(`${key}:r:${id}`)).toBeNull();
      expect(offline.getStatus()).toMatchObject({ pending: 0, buffered: 0, replaying: 0 });
      expect(calls).toBe(2);
    });
  }
});
