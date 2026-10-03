import { afterEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { UploadPlugin } from '../src/plugins/UploadPlugin';
import { OfflinePersistencePlugin } from '../src/plugins/OfflinePersistencePlugin';
import { LogLevel, type AemeathPlugin } from '../src/types';

const loggers: AemeathLogger[] = [];
function makeLogger() { const logger = new AemeathLogger({ enableConsole: false }); loggers.push(logger); return logger; }
afterEach(() => { loggers.splice(0).forEach(logger => logger.destroy()); vi.useRealTimers(); });
const plugin = (name: string): AemeathPlugin => ({ name, install() {} });

describe('Logger registry ownership is committed before external teardown', () => {
  it.each([false, true])('recursive uninstall cannot remove a neighbour (neighbour first=%s)', first => {
    const logger = makeLogger(), neighbour = plugin('neighbour');
    let nested: boolean | undefined, entered = false;
    const cleanup = vi.fn(() => {
      if (entered) return; entered = true;
      nested = logger.uninstall('target');
    });
    const target = { ...plugin('target'), uninstall: cleanup };
    if (first) logger.use(neighbour);
    logger.use(target); if (!first) logger.use(neighbour);
    logger.uninstall('target');
    expect(logger.getPluginInstance('neighbour')).toBe(neighbour);
    expect(logger.getPlugins().map(p => p.name)).toEqual(['neighbour']);
    expect(nested).toBe(false); expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('removing an earlier plugin during cleanup cannot shift the final removal onto a survivor', () => {
    const logger = makeLogger(), survivor = plugin('survivor');
    logger.use(plugin('earlier'));
    logger.use({ ...plugin('target'), uninstall: () => { logger.uninstall('earlier'); } });
    logger.use(survivor); logger.uninstall('target');
    expect(logger.getPluginInstance('target')).toBeUndefined();
    expect(logger.getPlugins().map(p => p.name)).toEqual(['survivor']);
    expect(logger.getPluginInstance('survivor')).toBe(survivor);
  });

  it.each([false, true])('a replacement installed during cleanup retains its registration (throw=%s)', fail => {
    const logger = makeLogger(), installed = vi.fn(), replacement = { ...plugin('target'), install: installed };
    logger.use({ ...plugin('target'), uninstall: () => {
      logger.use(replacement); if (fail) throw Error('old cleanup failed');
    } });
    logger.uninstall('target');
    expect(installed).toHaveBeenCalledTimes(1);
    expect(logger.hasPlugin('target')).toBe(true);
    expect(logger.getPluginInstance('target')).toBe(replacement);
    expect(logger.getPlugins().map(p => p.name)).toEqual(['target']);
  });

  it('uninstall observers see a consistent registry and can install a replacement', () => {
    const logger = makeLogger(), replacement = plugin('target');
    let observed: unknown;
    logger.on('plugin:uninstall', name => {
      if (name !== 'target') return;
      observed = [logger.hasPlugin('target'), logger.getPluginInstance('target')];
      logger.use(replacement);
    });
    logger.use(plugin('target')); logger.uninstall('target');
    expect(observed).toEqual([false, undefined]);
    expect(logger.getPluginInstance('target')).toBe(replacement);
    expect(logger.hasPlugin('target')).toBe(true);
  });

  it('destroy cannot leave newly installed resources outside its cleanup snapshot', () => {
    const logger = makeLogger(), installed = vi.fn(), late = { ...plugin('late'), install: installed };
    logger.use({ ...plugin('target'), uninstall: () => { logger.use(late); } });
    logger.destroy(); logger.use(late);
    expect(installed).not.toHaveBeenCalled();
    expect(logger.getPlugins()).toEqual([]); expect(logger.hasPlugin('late')).toBe(false);
  });

  it.each([false, true])('destroy during install cleans the unregistered plugin (throw=%s)', fail => {
    const logger = makeLogger(), cleanup = vi.fn(), listener = vi.fn();
    logger.use({ name: 'install-destroy', install(host) {
      host.destroy(); host.on('log', listener);
      if (fail) throw Error('install failed after destroy');
    }, uninstall(host) { cleanup(); host.off('log', listener); } });
    expect(logger.hasPlugin('install-destroy')).toBe(false);
    expect(logger.getPlugins()).toEqual([]); expect(cleanup).toHaveBeenCalledTimes(1);
    logger.destroy(); expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('destroy during metadata inspection cannot commit a stale registration', () => {
    const logger = makeLogger(), cleanup = vi.fn();
    logger.use({ name: 'metadata-destroy', install() {}, uninstall: cleanup,
      get version() { logger.destroy(); return '1.0.0'; } });
    expect(logger.getPlugins()).toEqual([]);
    expect(logger.hasPlugin('metadata-destroy')).toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('destroy in the installed event uses normal teardown exactly once', () => {
    const logger = makeLogger(), cleanup = vi.fn();
    logger.on('plugin:install', () => { logger.destroy(); });
    logger.use({ ...plugin('installed'), uninstall: cleanup });
    expect(logger.getPlugins()).toEqual([]); expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('destroy from a real Upload cache callback leaves no plugin or timers installed', () => {
    vi.useFakeTimers();
    const logger = makeLogger(), key = 'registry-install-destroy';
    localStorage.setItem(key, JSON.stringify([{ log: { logId: 'expired', level: LogLevel.ERROR,
      message: 'expired', timestamp: Date.now() - 10000 }, timestamp: Date.now() - 10000,
      cachedAt: Date.now() - 10000, retryCount: 0, priority: 1 }]));
    const cleanup = vi.fn(() => { logger.destroy(); });
    const upload = new UploadPlugin({ onDrop: cleanup, onUpload: async () => ({ success: true }),
      cache: { enabled: true, key, ttl: 1 }, saveOnUnload: true });
    logger.use(upload);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(logger.getPlugins()).toEqual([]); expect(logger.hasPlugin('upload')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    upload.uninstall(); localStorage.removeItem(key);
  });

  it('nested Upload teardown retains the actual offline plugin', async () => {
    vi.useFakeTimers();
    const logger = makeLogger(), offline = new OfflinePersistencePlugin({ storage: 'localstorage', key: 'registry-audit' });
    logger.use(offline); await offline.whenReady();
    const upload = new UploadPlugin({ onUpload: async () => ({ success: true }), cache: { enabled: false }, saveOnUnload: false });
    logger.use(upload);
    let nested: boolean | undefined;
    logger.on('upload:drop', () => { nested = logger.uninstall('upload'); });
    upload.requeue({ logId: 'fragment', message: 'fragment', level: LogLevel.ERROR, timestamp: Date.now(),
      tags: { splitId: 'group', splitIndex: 1, splitTotal: 2 } });
    logger.uninstall('upload');
    expect(nested).toBe(false); expect(logger.hasPlugin('offline-persistence')).toBe(true);
    expect(logger.getPluginInstance('offline-persistence')).toBe(offline);
    expect(logger.hasPlugin('upload')).toBe(false);
  });
});
