import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserApiErrorsPlugin } from '../src/plugins/BrowserApiErrorsPlugin';
import type { AemeathInterface } from '../src/types';

// Vitest binds/caches global event methods before plugin installation. A fresh
// iframe supplies real, unbound jsdom methods without those test-runner shims.
let frame: HTMLIFrameElement;
let realm: Window & typeof globalThis;
const plugins: BrowserApiErrorsPlugin[] = [];
function install() {
  const error = vi.fn();
  const plugin = new BrowserApiErrorsPlugin();
  plugins.push(plugin);
  plugin.install({ error } as unknown as AemeathInterface);
  return { plugin, error };
}
beforeEach(() => {
  frame = document.createElement('iframe');
  document.body.append(frame);
  realm = frame.contentWindow as Window & typeof globalThis;
  expect(realm.addEventListener).toBe(realm.EventTarget.prototype.addEventListener);
  vi.stubGlobal('window', realm);
});
afterEach(() => {
  for (const plugin of plugins.reverse()) plugin.forceRestore();
  plugins.length = 0;
  vi.unstubAllGlobals();
  frame.remove();
});
function receiver(kind: string): unknown {
  return kind === 'window' ? realm : kind === 'null' ? null : undefined;
}

it.each(['undefined', 'null'])('confirms native acceptance of an extracted method with %s', kind => {
  const listener = vi.fn();
  Reflect.apply(realm.addEventListener, receiver(kind), ['check', listener]);
  realm.dispatchEvent(new realm.Event('check'));
  Reflect.apply(realm.removeEventListener, receiver(kind), ['check', listener]);
  realm.dispatchEvent(new realm.Event('check'));
  expect(listener).toHaveBeenCalledTimes(1);
});

it.each(['undefined', 'null', 'window'].flatMap(add =>
  ['undefined', 'null', 'window'].map(remove => [add, remove]),
))('registers through %s and removes through %s with default hooks', (add, remove) => {
  install();
  const listener = vi.fn();
  Reflect.apply(realm.addEventListener, receiver(add), ['check', listener]);
  realm.dispatchEvent(new realm.Event('check'));
  Reflect.apply(realm.removeEventListener, receiver(remove), ['check', listener]);
  realm.dispatchEvent(new realm.Event('check'));
  expect(listener).toHaveBeenCalledTimes(1);
});

it('supports bare global calls and extracted functions without test-runner binding', () => {
  install();
  vi.stubGlobal('addEventListener', realm.addEventListener);
  vi.stubGlobal('removeEventListener', realm.removeEventListener);
  const listener = vi.fn();
  addEventListener('check', listener);
  const add = realm.addEventListener;
  add('check', listener);
  realm.addEventListener('check', listener);
  realm.dispatchEvent(new realm.Event('check'));
  removeEventListener('check', listener);
  realm.dispatchEvent(new realm.Event('check'));
  expect(listener).toHaveBeenCalledTimes(1);
});

it.each([0, false, 'invalid', Symbol('invalid'), {}])('preserves native rejection for receiver %s', invalid => {
  const nativeAdd = realm.addEventListener;
  const nativeRemove = realm.removeEventListener;
  const listener = vi.fn();
  function failure(method: Function) {
    try { Reflect.apply(method, invalid, ['check', listener]); }
    catch (error) { return { name: (error as Error).name, message: (error as Error).message }; }
    throw new Error('Invalid receiver unexpectedly accepted');
  }
  const addFailure = failure(nativeAdd); const removeFailure = failure(nativeRemove);
  install();
  expect(failure(realm.addEventListener)).toEqual(addFailure);
  expect(failure(realm.removeEventListener)).toEqual(removeFailure);
  realm.dispatchEvent(new realm.Event('check'));
  expect(listener).not.toHaveBeenCalled();
});

it('does not retain a listener cache after native receiver validation fails', () => {
  const invalid = {};
  const listener = vi.fn();
  const read = vi.fn(() => { throw new Error('must not read options'); });
  const options = { get capture() { return read(); } };
  const nativeRemove = realm.removeEventListener;
  let nativeFailure: unknown;
  try { Reflect.apply(nativeRemove, invalid, ['check', listener, options]); }
  catch (error) { nativeFailure = (error as Error).message; }
  install();
  expect(() => Reflect.apply(realm.addEventListener, invalid, ['check', listener])).toThrow();
  let failure: unknown;
  try { Reflect.apply(realm.removeEventListener, invalid, ['check', listener, options]); }
  catch (error) { failure = (error as Error).message; }
  expect(failure).toBe(nativeFailure);
  expect(read).not.toHaveBeenCalled();
});

it.each(['document', 'node', 'event-target'])('keeps %s listeners separate from the global target', kind => {
  install();
  const target = kind === 'document' ? realm.document : kind === 'node'
    ? realm.document.createElement('div') : new realm.EventTarget();
  const listener = vi.fn();
  const add = realm.addEventListener; const remove = realm.removeEventListener;
  add('check', listener); target.addEventListener('check', listener);
  remove('check', listener);
  realm.dispatchEvent(new realm.Event('check'));
  expect(listener).not.toHaveBeenCalled();
  target.dispatchEvent(new realm.Event('check'));
  expect(listener).toHaveBeenCalledTimes(1);
  expect(listener.mock.instances[0]).toBe(target);
  target.removeEventListener('check', listener);
  target.dispatchEvent(new realm.Event('check'));
  expect(listener).toHaveBeenCalledTimes(1);
});

it.each(['function', 'object'])('keeps callback receiver and error capture for a global %s listener', kind => {
  const error = new Error('global listener failure');
  const suppress = (event: ErrorEvent) => event.preventDefault();
  realm.addEventListener('error', suppress);
  const observed = vi.fn();
  const callback = vi.fn(function(this: unknown) { observed(this); throw error; });
  const listener = kind === 'function' ? callback : { handleEvent: callback };
  const { error: report } = install();
  const add = realm.addEventListener;
  add('check', listener);
  realm.dispatchEvent(new realm.Event('check'));
  expect(observed).toHaveBeenCalledWith(kind === 'function' ? realm : listener);
  expect(report).toHaveBeenCalledTimes(1);
  expect(report.mock.calls[0][1].error.stack).toBe(error.stack);
  realm.removeEventListener('check', listener);
  realm.removeEventListener('error', suppress);
});

it('preserves capture selection and evaluates removal options once across call forms', () => {
  install();
  const add = realm.addEventListener; const remove = realm.removeEventListener;
  const listener = vi.fn();
  add('check', listener, true); realm.addEventListener('check', listener, false);
  const capture = vi.fn(() => true);
  remove('check', listener, { get capture() { return capture(); } });
  expect(capture).toHaveBeenCalledTimes(1);
  realm.dispatchEvent(new realm.Event('check'));
  expect(listener).toHaveBeenCalledTimes(1);
  remove('check', listener, false);
  realm.dispatchEvent(new realm.Event('check'));
  expect(listener).toHaveBeenCalledTimes(1);
});

it.each(['once', 'signal', 'passive'])('preserves global listener option %s', kind => {
  install();
  const add = realm.addEventListener;
  const listener = vi.fn((event: Event) => event.preventDefault());
  const controller = new realm.AbortController();
  const options = kind === 'signal' ? { signal: controller.signal } : { [kind]: true };
  add('check', listener, options);
  const event = new realm.Event('check', { cancelable: true });
  realm.dispatchEvent(event);
  if (kind === 'signal') controller.abort();
  realm.dispatchEvent(new realm.Event('check'));
  expect(listener).toHaveBeenCalledTimes(kind === 'passive' ? 2 : 1);
  expect(event.defaultPrevented).toBe(kind !== 'passive');
  realm.removeEventListener('check', listener);
});

it.each(['stacked', 'paused', 'reinstalled'])('keeps global deduplication/removal while %s', mode => {
  const { plugin } = install();
  const add = realm.addEventListener; const listener = vi.fn();
  add('check', listener);
  if (mode === 'stacked') install();
  else {
    plugin.uninstall();
    if (mode === 'reinstalled') plugin.install({ error() {} } as unknown as AemeathInterface);
  }
  realm.addEventListener('check', listener);
  realm.dispatchEvent(new realm.Event('check'));
  const remove = realm.removeEventListener;
  remove('check', listener);
  realm.dispatchEvent(new realm.Event('check'));
  expect(listener).toHaveBeenCalledTimes(1);
});

it('forwards the original receiver through a third-party wrapper and restores descriptors', () => {
  const proto = realm.EventTarget.prototype;
  const addDescriptor = Object.getOwnPropertyDescriptor(proto, 'addEventListener');
  const nativeAdd = proto.addEventListener;
  const nativeRemove = proto.removeEventListener;
  const adds: unknown[] = []; const removes: unknown[] = [];
  proto.addEventListener = function(this: EventTarget, ...args) {
    adds.push(this); return Reflect.apply(nativeAdd, this, args);
  };
  proto.removeEventListener = function(this: EventTarget, ...args) {
    removes.push(this); return Reflect.apply(nativeRemove, this, args);
  };
  const thirdParty = proto.addEventListener;
  const { plugin } = install();
  const listener = vi.fn();
  Reflect.apply(realm.addEventListener, null, ['check', listener]);
  const remove = realm.removeEventListener;
  remove('check', listener);
  expect(adds).toEqual([null]);
  expect(removes).toEqual([undefined, undefined]);
  plugin.forceRestore();
  expect(proto.addEventListener).toBe(thirdParty);
  Object.defineProperty(proto, 'addEventListener', addDescriptor!);
  proto.removeEventListener = nativeRemove;
  realm.dispatchEvent(new realm.Event('check'));
  expect(listener).not.toHaveBeenCalled();
});
