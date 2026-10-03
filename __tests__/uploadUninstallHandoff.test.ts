import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin } from '../src/plugins/UploadPlugin';
import { LogLevel, type LogEntry } from '../src/types';
import { _resetIgnoreNetworkCapture, shouldIgnoreNetworkCapture } from '../src/utils/ignoreNetworkCapture';

const loggers: AemeathLogger[] = [];
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); _resetIgnoreNetworkCapture(); });
afterEach(() => {
  loggers.splice(0).forEach(logger => logger.destroy());
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear(); _resetIgnoreNetworkCapture();
});
function logger() {
  const host = new AemeathLogger({ enableConsole: false }); loggers.push(host); return host;
}
const entry = (logId: string, index?: number): LogEntry => ({
  logId, message: logId, level: LogLevel.ERROR, timestamp: Date.now(),
  ...(index ? { tags: { splitId: 'unfinished', splitIndex: index, splitTotal: 3 } } : {}),
});

describe('uninstall notification handoff', () => {
  for (const sameHost of [false, true]) {
    it.each([false, true])(`keeps callback-installed resources alive (same host=${sameHost}, cache=%s)`, async cache => {
      const added = vi.spyOn(window, 'addEventListener'), removed = vi.spyOn(window, 'removeEventListener');
      const oldHost = logger(), newHost = sameHost ? oldHost : logger();
      const key = 'uninstall-handoff';
      let release!: () => void;
      const onUpload = vi.fn(() => new Promise<{ success: boolean }>(resolve => {
        release = () => resolve({ success: true });
      }));
      const upload = new UploadPlugin({ onUpload, cache: { enabled: cache, key }, saveOnUnload: true,
        queue: { deduplicationDelay: 100, uploadInterval: 100000 } });
      upload.setOnUpload(null); oldHost.use(upload);
      const dropped: string[] = [], enqueued: string[] = [], succeeded: string[] = [];
      newHost.on('upload:enqueued', value => enqueued.push((value as { log: LogEntry }).log.message));
      newHost.on('upload:success', value => succeeded.push((value as { log: LogEntry }).log.logId));
      let remounted = false;
      oldHost.on('upload:drop', value => {
        dropped.push((value as { log: LogEntry }).log.logId);
        if (remounted) return;
        remounted = true; upload.setOnUpload(onUpload);
        // Direct plugin lifecycle calls keep the same Logger registration in place.
        if (sameHost) upload.install(newHost); else newHost.use(upload);
      });
      upload.requeue([entry('resident'), entry('fragment-1', 1), entry('fragment-2', 2)]);
      enqueued.length = 0;
      if (sameHost) upload.uninstall(); else oldHost.uninstall('upload');
      expect(onUpload).toHaveBeenCalledTimes(1);
      expect.soft(shouldIgnoreNetworkCapture()).toBe(true);
      expect(dropped).toEqual(['fragment-1', 'fragment-2']);
      if (!sameHost) oldHost.error('old-host-must-be-detached');
      newHost.error('new-host-log');
      expect.soft(upload.peekQueuedForPersist().map(item => item.log.message)).toEqual(['new-host-log']);
      expect.soft(enqueued).toEqual(['new-host-log']);
      upload.setOnUpload(null);
      if (cache) {
        window.dispatchEvent(new Event('pagehide'));
        const saved = JSON.parse(localStorage.getItem(key) ?? '[]') as Array<{ log: LogEntry }>;
        expect.soft(saved.some(item => item.log.message === 'new-host-log')).toBe(true);
      }
      release(); await vi.advanceTimersByTimeAsync(500);
      expect.soft(succeeded).toEqual(['resident']);
      expect(shouldIgnoreNetworkCapture()).toBe(false);
      newHost.uninstall('upload');
      for (const [type, listener] of added.mock.calls) {
        if (!['online', 'pagehide', 'beforeunload'].includes(type)) continue;
        expect.soft(removed.mock.calls.some(([removedType, removedListener]) =>
          removedType === type && removedListener === listener)).toBe(true);
      }
      expect(vi.getTimerCount()).toBe(0);
    });
  }

  it.each([false, true])('keeps new-host notifications when no request is already in flight (cache=%s)', async cache => {
    const oldHost = logger(), newHost = logger(), enqueued: string[] = [], succeeded: string[] = [];
    const upload = new UploadPlugin({ onUpload: async () => ({ success: true }),
      cache: { enabled: cache, key: 'idle-handoff' }, saveOnUnload: true,
      queue: { deduplicationDelay: 100, uploadInterval: 100000 } });
    oldHost.use(upload);
    let remounted = false;
    oldHost.on('upload:drop', () => {
      if (remounted) return;
      remounted = true; newHost.use(upload);
    });
    newHost.on('upload:enqueued', value => enqueued.push((value as { log: LogEntry }).log.message));
    newHost.on('upload:success', value => succeeded.push((value as { log: LogEntry }).log.message));
    upload.requeue([entry('fragment-1', 1), entry('fragment-2', 2)]);
    oldHost.uninstall('upload'); newHost.error('new-host-log');
    await vi.advanceTimersByTimeAsync(500);
    expect(enqueued).toEqual(['new-host-log']); expect(succeeded).toEqual(['new-host-log']);
  });

  it.each([false, true])('ordinary uninstall still cleans all resources and reports fragments (cache=%s)', cache => {
    const host = logger(), drops: string[] = [];
    const upload = new UploadPlugin({ onUpload: async () => ({ success: true }),
      cache: { enabled: cache, key: 'ordinary-uninstall' }, saveOnUnload: true });
    host.use(upload); host.on('upload:drop', value => drops.push((value as { log: LogEntry }).log.logId));
    upload.requeue([entry('fragment-1', 1), entry('fragment-2', 2)]);
    host.uninstall('upload'); host.error('after-uninstall');
    expect(drops).toEqual(['fragment-1', 'fragment-2']);
    expect(upload.getQueueStatus()).toMatchObject({ length: 0, admitting: 0 });
    expect(vi.getTimerCount()).toBe(0); expect(shouldIgnoreNetworkCapture()).toBe(false);
  });
});
