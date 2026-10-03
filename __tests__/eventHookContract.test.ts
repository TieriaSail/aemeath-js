import { afterEach, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { BrowserApiErrorsPlugin } from '../src/plugins/BrowserApiErrorsPlugin';
const plugins: BrowserApiErrorsPlugin[] = [];
const loggers: AemeathLogger[] = [];
const globals = window as unknown as Record<string, unknown>;
function install(names = ['EventTarget']) {
  const logger = new AemeathLogger({ enableConsole: false });
  const plugin = new BrowserApiErrorsPlugin({ eventTargetObjects: names, timer: false, xhr: false, requestAnimationFrame: false });
  plugins.push(plugin); loggers.push(logger); logger.use(plugin);
  return { logger, plugin };
}
afterEach(() => {
  for (const plugin of [...plugins].reverse()) plugin.forceRestore();
  for (const logger of loggers) logger.destroy();
  plugins.length = 0; loggers.length = 0;
  delete globals.ReviewLockedTarget; delete globals.ReviewChildTarget;
  vi.restoreAllMocks();
});
it.each(['active', 'replacement', 'paused'] as const)('keeps native listener deduplication across %s instances', mode => {
  const first = install(); const target = new EventTarget(); const fn = vi.fn();
  target.addEventListener('check', fn);
  if (mode !== 'active') first.logger.uninstall(first.plugin.name);
  if (mode !== 'paused') install();
  target.addEventListener('check', fn);
  target.dispatchEvent(new Event('check'));
  expect(fn).toHaveBeenCalledTimes(1);
  target.removeEventListener('check', fn);
  target.dispatchEvent(new Event('check'));
  expect(fn).toHaveBeenCalledTimes(1);
});
it('does not read removal options twice or remove the opposite capture registration', () => {
  install(); const target = new EventTarget(); const fn = vi.fn();
  target.addEventListener('check', fn, true);
  target.addEventListener('check', fn, false);
  const read = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
  target.removeEventListener('check', fn, { get capture() { return read(); } });
  expect(read).toHaveBeenCalledTimes(1);
  target.dispatchEvent(new Event('check'));
  expect(fn).toHaveBeenCalledTimes(1);
});
it('converts the event type once during removal', () => {
  install(); const target = new EventTarget(); const fn = vi.fn();
  target.addEventListener('check', fn);
  const type = { toString: vi.fn(() => 'check') };
  target.removeEventListener(type as unknown as string, fn);
  expect(type.toString).toHaveBeenCalledTimes(1);
  target.dispatchEvent(new Event('check')); expect(fn).not.toHaveBeenCalled();
});
it('keeps pre-install native registrations removable even if the same callback was wrapped elsewhere', () => {
  const native = new EventTarget(); const hooked = new EventTarget(); const fn = vi.fn();
  native.addEventListener('check', fn);
  install(); hooked.addEventListener('check', fn);
  native.removeEventListener('check', fn);
  native.dispatchEvent(new Event('check')); expect(fn).not.toHaveBeenCalled();
});
it('rolls back a half-installed target and continues patching subsequent targets', () => {
  class Locked extends EventTarget {}
  const nativeAdd = EventTarget.prototype.addEventListener;
  Object.defineProperty(Locked.prototype, 'removeEventListener', {
    value: EventTarget.prototype.removeEventListener, configurable: true, writable: false,
  });
  globals.ReviewLockedTarget = Locked;
  const { plugin } = install(['ReviewLockedTarget', 'EventTarget']);
  expect(Object.prototype.hasOwnProperty.call(Locked.prototype, 'addEventListener')).toBe(false);
  expect(EventTarget.prototype.addEventListener).not.toBe(nativeAdd);
  plugin.forceRestore();
  expect(Locked.prototype.addEventListener).toBe(nativeAdd);
});
it('skips a throwing target getter without disabling other targets', () => {
  const nativeAdd = EventTarget.prototype.addEventListener;
  Object.defineProperty(globals, 'ReviewLockedTarget', { configurable: true, get() { throw new Error('host access'); } });
  install(['ReviewLockedTarget', 'EventTarget']);
  expect(EventTarget.prototype.addEventListener).not.toBe(nativeAdd);
});
it('preserves a third-party event patch during soft uninstall', () => {
  const { plugin } = install(); const patched = EventTarget.prototype.addEventListener;
  const thirdParty = vi.fn(function(this: EventTarget, ...args: Parameters<EventTarget['addEventListener']>) {
    return patched.apply(this, args);
  });
  EventTarget.prototype.addEventListener = thirdParty;
  plugin.uninstall();
  expect(EventTarget.prototype.addEventListener).toBe(thirdParty);
});

it('calls the business listener once while each active logger observes the original error', () => {
  const suppress = (event: ErrorEvent) => event.preventDefault();
  window.addEventListener('error', suppress);
  try {
    const first = install(); const firstLogs = vi.fn(); first.logger.on('log', firstLogs);
    const target = new EventTarget(); const error = new Error('shared event');
    const fn = vi.fn(() => { throw error; });
    target.addEventListener('check', fn, { once: true });
    const second = install(); const secondLogs = vi.fn(); second.logger.on('log', secondLogs);
    target.addEventListener('check', fn);
    target.dispatchEvent(new Event('check'));
    target.dispatchEvent(new Event('check'));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(firstLogs).toHaveBeenCalledTimes(1);
    expect(secondLogs).toHaveBeenCalledTimes(1);
    expect(firstLogs.mock.calls[0][0].error.stack).toBe(error.stack);
    expect(secondLogs.mock.calls[0][0].error.evidence.errorObjectId).toBe(firstLogs.mock.calls[0][0].error.evidence.errorObjectId);
  } finally { window.removeEventListener('error', suppress); }
});
it('does not share observers across unrelated targets using the same callback', () => {
  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeRemove = EventTarget.prototype.removeEventListener;
  class First extends EventTarget {}
  class Second extends EventTarget {}
  for (const ctor of [First, Second]) {
    Object.defineProperty(ctor.prototype, 'addEventListener', { value: nativeAdd, configurable: true, writable: true });
    Object.defineProperty(ctor.prototype, 'removeEventListener', { value: nativeRemove, configurable: true, writable: true });
  }
  globals.ReviewLockedTarget = First; globals.ReviewChildTarget = Second;
  const suppress = (event: ErrorEvent) => event.preventDefault();
  window.addEventListener('error', suppress);
  try {
    const first = install(['ReviewLockedTarget']); const firstLogs = vi.fn(); first.logger.on('log', firstLogs);
    const second = install(['ReviewChildTarget']); const secondLogs = vi.fn(); second.logger.on('log', secondLogs);
    const callback = () => { throw new Error('target scoped'); };
    const a = new First(); const b = new Second();
    a.addEventListener('check', callback); b.addEventListener('check', callback);
    a.dispatchEvent(new Event('check'));
    expect(firstLogs).toHaveBeenCalledTimes(1); expect(secondLogs).not.toHaveBeenCalled();
    first.plugin.uninstall();
    b.dispatchEvent(new Event('check'));
    expect(firstLogs).toHaveBeenCalledTimes(1); expect(secondLogs).toHaveBeenCalledTimes(1);
  } finally { window.removeEventListener('error', suppress); }
});
it('preserves abort and removal behavior through stacked instances and inherited prototypes', () => {
  class Child extends EventTarget {}
  globals.ReviewChildTarget = Child;
  install(['EventTarget', 'ReviewChildTarget']);
  const target = new Child(); const fn = vi.fn(); const controller = new AbortController();
  target.addEventListener('check', fn, { signal: controller.signal });
  install(['EventTarget', 'ReviewChildTarget']);
  target.addEventListener('check', fn);
  controller.abort(); target.dispatchEvent(new Event('check')); expect(fn).not.toHaveBeenCalled();
  target.addEventListener('check', fn, true);
  const read = vi.fn(() => true);
  target.removeEventListener('check', fn, { get capture() { return read(); } });
  expect(read).toHaveBeenCalledTimes(1);
  target.dispatchEvent(new Event('check')); expect(fn).not.toHaveBeenCalled();
});
it('keeps removal work bounded after repeated plugin replacements', () => {
  const remove = vi.spyOn(EventTarget.prototype, 'removeEventListener');
  for (let i = 0; i < 8; i++) {
    const { plugin } = install();
    if (i < 7) plugin.uninstall();
  }
  const target = new EventTarget(); const fn = vi.fn();
  target.addEventListener('check', fn);
  remove.mockClear();
  target.removeEventListener('check', fn);
  expect(remove).toHaveBeenCalledTimes(2);
  target.dispatchEvent(new Event('check')); expect(fn).not.toHaveBeenCalled();
});
