import { afterEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { BeforeSendPlugin } from '../src/plugins/BeforeSendPlugin';
import type { AemeathPlugin } from '../src/types';

const hosts: AemeathLogger[] = [];
function host() { const logger = new AemeathLogger({ enableConsole: false }); hosts.push(logger); return logger; }
afterEach(() => { hosts.splice(0).forEach(logger => logger.destroy()); vi.restoreAllMocks(); });

describe('plugin object ownership', () => {
  it('rejects a shared object before install and preserves the first host filter', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = host(), b = host();
    const plugin = new BeforeSendPlugin({ beforeSend: entry => ({ ...entry, message: '[redacted]' }) });
    const seen = vi.fn(); a.on('log', seen);
    a.use(plugin); b.use(plugin);
    expect(b.hasPlugin(plugin.name)).toBe(false);
    b.uninstall(plugin.name);
    a.info('synthetic-private-input');
    expect(seen.mock.calls[0]?.[0].message).toBe('[redacted]');
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('does not change independent plugin objects or same-host name idempotence', () => {
    const a = host(), b = host();
    const one = { name: 'independent', install: vi.fn(), uninstall: vi.fn() };
    const two = { name: 'independent', install: vi.fn(), uninstall: vi.fn() };
    a.use(one); a.use(one); b.use(two); a.uninstall(one.name);
    expect(one.install).toHaveBeenCalledTimes(1);
    expect(two.uninstall).not.toHaveBeenCalled();
    expect(b.hasPlugin(two.name)).toBe(true);
  });

  it('holds ownership during install reentry and during teardown', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = host(), b = host();
    const plugin: AemeathPlugin = {
      name: 'reentrant-owner',
      install: vi.fn(() => { b.use(plugin); }),
      uninstall: vi.fn(() => { b.use(plugin); }),
    };
    a.use(plugin);
    expect(plugin.install).toHaveBeenCalledTimes(1);
    expect(b.hasPlugin(plugin.name)).toBe(false);
    a.uninstall(plugin.name);
    expect(b.hasPlugin(plugin.name)).toBe(false);
    b.use(plugin);
    expect(b.hasPlugin(plugin.name)).toBe(true);
  });

  it('releases an interrupted install only after bounded synchronous cleanup', () => {
    const a = host(), b = host(); let fail = true;
    const plugin = { name: 'failed-owner', install() { if (fail) throw Error('setup'); }, uninstall: vi.fn() };
    a.use(plugin); expect(a.hasPlugin(plugin.name)).toBe(false);
    expect(plugin.uninstall).toHaveBeenCalledTimes(1);
    fail = false; b.use(plugin); expect(b.hasPlugin(plugin.name)).toBe(true);
  });

  it('reserves a name during install even when a different object reenters', () => {
    const logger = host(), nested = { name: 'same-name', install: vi.fn(), uninstall: vi.fn() };
    const original = { name: 'same-name', install: () => { logger.use(nested); }, uninstall: vi.fn() };
    logger.use(original);
    expect(nested.install).not.toHaveBeenCalled();
    expect(logger.getPlugins()).toHaveLength(1); expect(logger.getPluginInstance('same-name')).toBe(original);
    logger.uninstall('same-name'); expect(original.uninstall).toHaveBeenCalledTimes(1);
  });
  it('releases the name reservation after a static dependency error', () => {
    const logger = host();
    expect(() => logger.use({ name: 'dependency', dependencies: ['missing'], install() {} })).toThrow('requires');
    const replacement = { name: 'dependency', install: vi.fn() }; logger.use(replacement);
    expect(replacement.install).toHaveBeenCalledTimes(1);
  });
  it('does not let console failures escape rejected installation', () => {
    const a = host(), b = host(); const plugin = { name: 'console-owner', install() {} };
    a.use(plugin); vi.spyOn(console, 'warn').mockImplementation(() => { throw Error('console'); });
    expect(() => b.use(plugin)).not.toThrow();
    expect(b.hasPlugin(plugin.name)).toBe(false);
  });

  it('allows an installed-event listener to replace a completed registration', () => {
    const logger = host();
    const original = { name: 'replace-on-install', install: vi.fn(), uninstall: vi.fn() };
    const replacement = { name: original.name, install: vi.fn() };
    logger.on('plugin:install', name => {
      if (name === original.name && logger.getPluginInstance(name) === original) {
        logger.uninstall(name);
        logger.use(replacement);
      }
    });

    logger.use(original);

    expect(original.uninstall).toHaveBeenCalledTimes(1);
    expect(replacement.install).toHaveBeenCalledTimes(1);
    expect(logger.getPluginInstance(original.name)).toBe(replacement);
  });
});
