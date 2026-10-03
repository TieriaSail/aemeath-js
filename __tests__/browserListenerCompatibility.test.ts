import { afterEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { BrowserApiErrorsPlugin } from '../src/plugins/BrowserApiErrorsPlugin';

const plugins: BrowserApiErrorsPlugin[] = [];
const loggers: AemeathLogger[] = [];
function install(targets = ['EventTarget']) {
  const logger = new AemeathLogger({ enableConsole: false });
  const plugin = new BrowserApiErrorsPlugin({
    eventTargetObjects: targets, timer: false, xhr: false, requestAnimationFrame: false,
  });
  plugins.push(plugin); loggers.push(logger); logger.use(plugin);
  return { logger, plugin };
}
afterEach(() => {
  for (const plugin of plugins.reverse()) plugin.forceRestore();
  for (const logger of loggers) logger.destroy();
  plugins.length = 0; loggers.length = 0;
});

describe('browser listener compatibility', () => {
  it('preserves listener object identity and private state', () => {
    install();
    const target = new EventTarget();
    const receivers: unknown[] = [];
    class Listener {
      #calls = 0;
      handleEvent() { receivers.push(this); if (this === listener) this.#calls++; }
      get calls() { return this.#calls; }
    }
    const listener = new Listener();
    target.addEventListener('check', listener);
    target.dispatchEvent(new Event('check'));
    expect(receivers).toEqual([listener]);
    expect(listener.calls).toBe(1);
  });

  it.each(['object', 'frozen-function'] as const)('deduplicates and removes a %s listener', (kind) => {
    install();
    const target = new EventTarget();
    const callback = vi.fn();
    const listener = kind === 'object' ? { handleEvent: callback } : Object.freeze(callback);
    target.addEventListener('check', listener);
    target.addEventListener('check', listener);
    target.dispatchEvent(new Event('check'));
    expect(callback).toHaveBeenCalledTimes(1);
    target.removeEventListener('check', listener);
    target.dispatchEvent(new Event('check'));
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('resolves handleEvent at dispatch time without copying enumerable getters', () => {
    install();
    const target = new EventTarget();
    const first = vi.fn(); const second = vi.fn();
    let handler = first;
    const read = vi.fn(() => handler);
    const unrelated = vi.fn(() => 'unrelated');
    const listener = { get handleEvent() { return read(); }, get extra() { return unrelated(); } };
    target.addEventListener('check', listener);
    expect(read).not.toHaveBeenCalled();
    expect(unrelated).not.toHaveBeenCalled();
    target.dispatchEvent(new Event('check'));
    handler = second;
    target.dispatchEvent(new Event('check'));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(unrelated).not.toHaveBeenCalled();
  });

  it('supports a handleEvent method assigned after registration', () => {
    install();
    const target = new EventTarget();
    const listener = {} as EventListenerObject;
    target.addEventListener('check', listener);
    listener.handleEvent = vi.fn();
    target.dispatchEvent(new Event('check'));
    expect(listener.handleEvent).toHaveBeenCalledTimes(1);
    target.removeEventListener('check', listener);
  });

  it('does not depend on mutable callback metadata or its call property', () => {
    install();
    const target = new EventTarget();
    const callback = vi.fn();
    Object.defineProperty(callback, '__aemeath_wrapped__', { get() { throw new Error('metadata'); } });
    Object.defineProperty(callback, 'call', { value() { throw new Error('call override'); } });
    target.addEventListener('check', callback);
    target.dispatchEvent(new Event('check'));
    expect(callback).toHaveBeenCalledTimes(1);
    expect(() => target.removeEventListener('check', callback)).not.toThrow();
    target.dispatchEvent(new Event('check'));
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('reports getter failures at dispatch and rethrows the original error even if reporting fails', () => {
    const nativeAdd = EventTarget.prototype.addEventListener;
    let registered: EventListener | undefined;
    EventTarget.prototype.addEventListener = function(_type, callback) {
      if (typeof callback === 'function') registered = callback;
    };
    try {
      const { logger, plugin } = install();
      const error = new Error('handleEvent getter');
      const read = vi.fn(() => { throw error; });
      const listener = Object.defineProperty({}, 'handleEvent', { get: read }) as EventListenerObject;
      const target = new EventTarget();
      target.addEventListener('check', listener);
      expect(read).not.toHaveBeenCalled();
      const report = vi.spyOn(logger, 'error').mockImplementation(() => { throw new Error('report failed'); });
      expect(() => registered!.call(target, new Event('check'))).toThrow(error);
      expect(read).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledTimes(1);
      expect(report.mock.calls[0][1]?.error).toMatchObject({ value: 'handleEvent getter' });
      plugin.forceRestore();
    } finally {
      for (const plugin of [...plugins].reverse()) plugin.forceRestore();
      EventTarget.prototype.addEventListener = nativeAdd;
    }
  });

  it('keeps function receiver, capture matching, once and abort behavior', () => {
    install();
    const target = new EventTarget();
    const callback = vi.fn(function(this: unknown) { expect(this).toBe(target); });
    const controller = new AbortController();
    target.addEventListener('check', callback, { capture: true, signal: controller.signal });
    target.addEventListener('check', callback, { once: true });
    target.dispatchEvent(new Event('check'));
    expect(callback).toHaveBeenCalledTimes(2);
    target.removeEventListener('check', callback, false);
    target.dispatchEvent(new Event('check'));
    expect(callback).toHaveBeenCalledTimes(3);
    controller.abort();
    target.dispatchEvent(new Event('check'));
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it('can remove object listeners after soft uninstall', () => {
    const { plugin } = install();
    const target = new EventTarget();
    const listener = { handleEvent: vi.fn() };
    target.addEventListener('check', listener);
    plugin.uninstall();
    target.removeEventListener('check', listener);
    target.dispatchEvent(new Event('check'));
    expect(listener.handleEvent).not.toHaveBeenCalled();
  });

  it('keeps registrations made before installation removable', () => {
    const target = new EventTarget();
    const listener = { handleEvent: vi.fn() };
    target.addEventListener('check', listener);
    install();
    target.removeEventListener('check', listener);
    target.dispatchEvent(new Event('check'));
    expect(listener.handleEvent).not.toHaveBeenCalled();
  });

  it('restores inherited API properties without retaining inactive wrappers', () => {
    class ChildTarget extends EventTarget {}
    const globals = window as unknown as Record<string, unknown>;
    globals.AemeathReviewTarget = ChildTarget;
    const nativeAdd = EventTarget.prototype.addEventListener;
    try {
      const { plugin } = install(['EventTarget', 'AemeathReviewTarget']);
      plugin.forceRestore();
      expect(Object.prototype.hasOwnProperty.call(ChildTarget.prototype, 'addEventListener')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(ChildTarget.prototype, 'removeEventListener')).toBe(false);
      expect(ChildTarget.prototype.addEventListener).toBe(nativeAdd);
    } finally { delete globals.AemeathReviewTarget; }
  });

  it.each(['replacement', 'same-instance'] as const)('captures after %s reinstall with the same callback', (mode) => {
    const old = install();
    const target = new EventTarget();
    const error = new Error('replacement capture');
    const listener = () => { throw error; };
    const registered: EventListener[] = [];
    // Record what native add receives so the original exception can be asserted
    // directly, without jsdom reporting an intentional throw as an uncaught error.
    old.plugin.forceRestore();
    const originalAdd = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function(_type, callback) {
      if (typeof callback === 'function') registered.push(callback);
    };
    try {
      const first = install();
      target.addEventListener('check', listener);
      first.logger.uninstall(first.plugin.name);
      const second = mode === 'replacement' ? install() : first;
      if (mode === 'same-instance') second.logger.use(second.plugin);
      const logs = vi.fn(); second.logger.on('log', logs);
      target.addEventListener('other', listener);
      expect(() => registered[registered.length - 1]!.call(target, new Event('other'))).toThrow(error);
      expect(logs).toHaveBeenCalledTimes(1);
      expect(logs.mock.calls[0][0].error.value).toBe('replacement capture');
    } finally {
      for (const plugin of [...plugins].reverse()) plugin.forceRestore();
      EventTarget.prototype.addEventListener = originalAdd;
    }
  });
});
