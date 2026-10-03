import { afterEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { BrowserApiErrorsPlugin } from '../src/plugins/BrowserApiErrorsPlugin';
import { ErrorCapturePlugin } from '../src/plugins/ErrorCapturePlugin';

const plugins: BrowserApiErrorsPlugin[] = [];
const loggers: AemeathLogger[] = [];
const originalConsole = console.error;
function install() {
  const logger = new AemeathLogger({ enableConsole: false });
  const plugin = new BrowserApiErrorsPlugin({ eventTarget: false });
  plugins.push(plugin); loggers.push(logger); logger.use(plugin);
  const logs = vi.fn(); logger.on('log', logs);
  return { logger, plugin, logs };
}
function consoleCapture() {
  const logger = new AemeathLogger({ enableConsole: false });
  const plugin = new ErrorCapturePlugin({ captureConsoleError: true, captureResourceError: false, captureUnhandledRejection: false });
  loggers.push(logger); logger.use(plugin);
  const logs = vi.fn(); logger.on('log', logs);
  return { logger, plugin, logs };
}
afterEach(() => {
  for (const plugin of [...plugins].reverse()) plugin.forceRestore();
  for (const logger of [...loggers].reverse()) logger.destroy();
  plugins.length = 0; loggers.length = 0;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); console.error = originalConsole;
});

describe('browser callback hook lifecycle', () => {
  it.each([
    ['setTimeout', false], ['setInterval', false], ['requestAnimationFrame', false],
    ['setTimeout', true], ['setInterval', true], ['requestAnimationFrame', true],
  ] as const)('%s captures a reused callback after reinstall (same instance: %s)', (api, sameInstance) => {
    const scheduled: Function[] = [];
    vi.stubGlobal(api, (callback: Function) => { scheduled.push(callback); return 1; });
    const old = install();
    const error = new Error('reused callback');
    const callback = () => { throw error; };
    globalThis[api](callback);
    old.logger.uninstall(old.plugin.name);
    const current = sameInstance ? old : install();
    if (sameInstance) current.logger.use(current.plugin);
    globalThis[api](callback);
    expect(() => scheduled[scheduled.length - 1]()).toThrow(error);
    expect(current.logs).toHaveBeenCalledTimes(1);
    if (!sameInstance) expect(old.logs).not.toHaveBeenCalled();
  });

  it('delegates invalid animation callbacks to the native API', () => {
    const nativeError = new TypeError('native validation');
    const native = vi.fn(() => { throw nativeError; });
    vi.stubGlobal('requestAnimationFrame', native);
    const { logs } = install();
    expect(() => requestAnimationFrame(null as unknown as FrameRequestCallback)).toThrow(nativeError);
    expect(native).toHaveBeenCalledWith(null);
    expect(logs).not.toHaveBeenCalled();
  });

  it('rethrows the original callback error if reporting also throws', () => {
    let scheduled!: Function;
    vi.stubGlobal('setTimeout', (callback: Function) => { scheduled = callback; return 1; });
    const { logger } = install();
    vi.spyOn(logger, 'error').mockImplementation(() => { throw new Error('reporting failure'); });
    const error = new Error('business failure');
    setTimeout(() => { throw error; });
    expect(() => scheduled()).toThrow(error);
  });

  it('captures XHR callbacks on a reused request after replacing the plugin', () => {
    vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(() => {});
    const old = install();
    const xhr = new XMLHttpRequest(); const error = new Error('xhr callback');
    xhr.onload = () => { throw error; };
    xhr.send();
    old.logger.uninstall(old.plugin.name);
    const current = install();
    xhr.send();
    expect(() => xhr.onload!.call(xhr, new ProgressEvent('load'))).toThrow(error);
    expect(current.logs).toHaveBeenCalledTimes(1);
    expect(old.logs).not.toHaveBeenCalled();
  });

  it('keeps timer argument function identity, receiver and return value', () => {
    let scheduled!: Function;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: Function) => { scheduled = callback; return 17; }) as any);
    install();
    const arg = () => {};
    const receiver = {};
    const callback = vi.fn(function(this: unknown, actual: unknown) {
      expect(this).toBe(receiver); expect(actual).toBe(arg); return 'result';
    });
    expect(globalThis.setTimeout(callback, 0, arg)).toBe(17);
    expect(scheduled.call(receiver, arg)).toBe('result');
  });

  it('does not invoke function metadata getters or use an overridden apply', () => {
    let scheduled!: Function;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: Function) => { scheduled = callback; return 1; }) as any);
    const { logs } = install();
    const error = new Error('business');
    const callback = () => { throw error; };
    const metadata = vi.fn(() => { throw new Error('metadata'); });
    Object.defineProperty(callback, '__aemeath_wrapped__', { get: metadata });
    Object.defineProperty(callback, 'apply', { value: () => { throw new Error('overridden apply'); } });
    globalThis.setTimeout(callback);
    expect(metadata).not.toHaveBeenCalled();
    expect(() => scheduled()).toThrow(error);
    expect(logs).toHaveBeenCalledTimes(1);
  });

  it('lets XHR send proceed when a callback property cannot be read', () => {
    const send = vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(() => {});
    install();
    const xhr = new XMLHttpRequest();
    Object.defineProperty(xhr, 'onload', { get() { throw new Error('unreadable'); } });
    expect(() => xhr.send()).not.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reads each XHR callback getter only once per send', () => {
    vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(() => {});
    const { logs } = install();
    const xhr = new XMLHttpRequest(); const error = new Error('first callback');
    const read = vi.fn(() => () => { throw error; });
    let assigned!: Function;
    Object.defineProperty(xhr, 'onload', { get: read, set(value) { assigned = value; } });
    xhr.send();
    expect(read).toHaveBeenCalledTimes(1);
    expect(() => assigned.call(xhr, new ProgressEvent('load'))).toThrow(error);
    expect(logs).toHaveBeenCalledTimes(1);
  });

  it('keeps repeated XHR sends from stacking capture wrappers', () => {
    vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(() => {});
    const { logs } = install();
    const xhr = new XMLHttpRequest(); const error = new Error('only once');
    xhr.onload = () => { throw error; };
    xhr.send(); const first = xhr.onload;
    xhr.send(); expect(xhr.onload).toBe(first);
    expect(() => xhr.onload!.call(xhr, new ProgressEvent('load'))).toThrow(error);
    expect(logs).toHaveBeenCalledTimes(1);
  });

  it('keeps both active logger instances observing callbacks', () => {
    let scheduled!: Function;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: Function) => { scheduled = callback; return 1; }) as any);
    const first = install(); const second = install();
    const error = new Error('shared callback');
    globalThis.setTimeout(() => { throw error; });
    expect(() => scheduled()).toThrow(error);
    expect(first.logs).toHaveBeenCalledTimes(1);
    expect(second.logs).toHaveBeenCalledTimes(1);
  });
});

describe('console capture teardown', () => {
  it('restores the original after out-of-order uninstall', () => {
    const base = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = consoleCapture(); const second = consoleCapture();
    first.logger.uninstall(first.plugin.name);
    second.logger.uninstall(second.plugin.name);
    expect(console.error).toBe(base);
  });

  it('does not revive an old console hook on reinstall', () => {
    const base = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = consoleCapture(); const second = consoleCapture();
    first.logger.uninstall(first.plugin.name);
    first.logger.use(first.plugin);
    console.error(new Error('one observation per active logger'));
    expect(first.logs).toHaveBeenCalledTimes(1);
    expect(second.logs).toHaveBeenCalledTimes(1);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('leaves later third-party patches intact and inactive hooks inert', () => {
    const base = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = consoleCapture();
    const before = console.error;
    const thirdParty = vi.fn((...args: unknown[]) => before(...args));
    console.error = thirdParty;
    first.logger.uninstall(first.plugin.name);
    expect(console.error).toBe(thirdParty);
    console.error(new Error('third party'));
    expect(first.logs).not.toHaveBeenCalled();
    expect(base).toHaveBeenCalledTimes(1);
  });
});
