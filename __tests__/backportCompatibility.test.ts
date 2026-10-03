import { afterEach, describe, expect, it, vi } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { SafeGuardPlugin } from '../src/plugins/SafeGuardPlugin';
import { UploadPlugin } from '../src/plugins/UploadPlugin';
import { PerformancePlugin } from '../src/plugins/PerformancePlugin';
import { createAemeathPlugin } from '../src/integrations/vue';
import { sanitizeLogEntry } from '../src/utils/payloadSanitize';
import { initAemeath, resetAemeath } from '../src/singleton';
import * as browser from '../src/browser';
import { LogLevel, type LogEntry, type AemeathPlugin } from '../src/types';

const loggers: AemeathLogger[] = [];
function logger() { const l = new AemeathLogger({ enableConsole: false }); loggers.push(l); return l; }
afterEach(() => {
  loggers.splice(0).forEach(l => l.destroy()); browser.destroy(); resetAemeath();
  delete (window as any).__flushEarlyErrors__; vi.useRealTimers();
});
const entry = (img: unknown): LogEntry => ({ logId: 'L', level: LogLevel.ERROR, message: 'm', timestamp: 1, context: { img } });

describe('v1 backport compatibility', () => {
  it.each([{ level: 'error' }, { level: 'error', message: 'bad', options: null }])('ignores incomplete beforeLog results %j', result => {
    const l = logger(); const logs = vi.fn(); l.on('log', logs);
    l.use({ name: 'broken', install() {}, beforeLog: () => result } as unknown as AemeathPlugin);
    expect(() => l.info('original')).not.toThrow();
    expect(logs).toHaveBeenCalledWith(expect.objectContaining({ message: 'original', level: 'info' }));
  });
  it('preserves original arguments if a plugin result getter throws', () => {
    const l = logger(); const logs = vi.fn(); l.on('log', logs);
    l.use({ name: 'broken', install() {}, beforeLog: () => ({ level: 'error', get message() { throw Error('bad'); } }) } as unknown as AemeathPlugin);
    expect(() => l.info('original')).not.toThrow();
    expect(logs).toHaveBeenCalledWith(expect.objectContaining({ message: 'original', level: 'info' }));
  });
  it('still reports frozen Vue errors and preserves v1 tag/context metadata', () => {
    const l = logger(); const logs = vi.fn(); l.on('log', logs);
    const app: any = { config: { globalProperties: {} }, provide() {} };
    createAemeathPlugin({ logger: l }).install(app);
    const error = Object.freeze(new Error('vue-fault'));
    expect(() => app.config.errorHandler(error, null, 'render')).not.toThrow();
    expect(logs).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ value: 'vue-fault', stack: error.stack }),
      tags: expect.objectContaining({ errorCategory: 'vue', lifecycle: 'render' }),
      context: expect.objectContaining({ vueInfo: 'render' }),
    }));
  });
  it('cleans toJSON output and evaluates the getter/method only once', () => {
    const call = vi.fn(() => 'data:image/png;base64,' + 'A'.repeat(800));
    const read = vi.fn(() => call);
    const value = Object.defineProperty({}, 'toJSON', { get: read });
    const result = sanitizeLogEntry(entry(value));
    expect(result.strips.some(s => s.kind === 'data-url')).toBe(true);
    expect(read).toHaveBeenCalledTimes(1); expect(call).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result.entries)).not.toContain('data:image/png;base64,');
  });
  it('preserves the JSON property key argument for custom serializers', () => {
    const calls: string[] = [];
    const value = { toJSON(key: string) { calls.push(key); return key; } };
    const result = sanitizeLogEntry(entry({ 'with.dot': value, array: [value] }));
    expect(result.entries[0].context?.img).toEqual({ 'with.dot': 'with.dot', array: ['0'] });
    expect(calls).toEqual(['with.dot', '0']);
  });
  it('contains throwing serialization and does not chain returned serializers', () => {
    expect(sanitizeLogEntry(entry({ toJSON() { throw Error('bad'); } })).strips[0].kind).toBe('unserializable');
    const a = { toJSON: (): unknown => b }; const b = { toJSON: (): unknown => a };
    const result = sanitizeLogEntry(entry(a));
    expect(result.entries[0].context?.img).toEqual({});
    expect(() => JSON.stringify(result.entries)).not.toThrow();
  });
  it('keeps Date and self-returning toJSON values usable', () => {
    const date = new Date('2026-01-01T00:00:00Z');
    expect(JSON.stringify(sanitizeLogEntry(entry(date)).entries)).toContain(date.toISOString());
    const value = { label: 'ok', toJSON() { return this; } };
    expect(JSON.stringify(sanitizeLogEntry(entry(value)).entries)).toContain('"label":"ok"');
  });
  it('does not reintroduce raw data through self-returning serializers or Date overrides', () => {
    const value = { raw: 'data:image/png;base64,' + 'A'.repeat(800), toJSON() { return value; } };
    const date = new Date(); date.toJSON = () => value.raw;
    for (const v of [value, date]) {
      const result = sanitizeLogEntry(entry(v));
      expect(JSON.stringify(result.entries)).not.toContain('data:image/png;base64,');
      expect(result.strips.some(s => s.kind === 'data-url')).toBe(true);
    }
  });
  it('reads beforeLog result getters once and accepts a complete snapshot', () => {
    const l = logger(); const logs = vi.fn(); l.on('log', logs);
    const message = vi.fn(() => 'updated'); const options = vi.fn(() => ({ tags: { updated: true } }));
    l.use({ name: 'getters', install() {}, beforeLog: () => ({ level: LogLevel.INFO, get message() { return message(); }, get options() { return options(); } }) });
    l.error('original'); expect(message).toHaveBeenCalledTimes(1); expect(options).toHaveBeenCalledTimes(1);
    expect(logs).toHaveBeenCalledWith(expect.objectContaining({ message: 'updated', level: 'info' }));
  });
  it('retains v1 zero, Infinity and short duration settings', () => {
    const guard = new SafeGuardPlugin({ rateLimit: 0, maxErrors: Infinity, cooldownPeriod: 1, mergeWindow: 0, parkingLotSize: 0, parkingLotTTL: 1 });
    expect((guard as any).config).toMatchObject({ rateLimit: 0, maxErrors: Infinity, cooldownPeriod: 1, mergeWindow: 0, parkingLotSize: 0, parkingLotTTL: 1 });
    expect((new SafeGuardPlugin({ rateLimit: NaN, parkingLotSize: -1 }) as any).config).toMatchObject({ rateLimit: 100, parkingLotSize: 200 });
  });
  it('recovers valid cached rows even next to corrupt data', () => {
    vi.useFakeTimers(); const l = logger();
    localStorage.setItem('__aemeath_safeguard_parking__', JSON.stringify([null, 1, {}, { level: 'info', message: 'keep', options: {}, timestamp: Date.now() }]));
    const guard = new SafeGuardPlugin({ mode: 'strict' }); l.use(guard);
    expect((guard as any).parkingLot.map((x: any) => x.message)).toEqual(['keep']);
  });
  it('persists on pagehide and removes that listener on uninstall', () => {
    const l = logger(); const guard = new SafeGuardPlugin({ mode: 'strict' });
    const persist = vi.spyOn(guard as any, 'persistToStorage'); l.use(guard);
    window.dispatchEvent(new Event('pagehide')); expect(persist).toHaveBeenCalledTimes(1);
    l.uninstall('safe-guard'); const calls = persist.mock.calls.length;
    window.dispatchEvent(new Event('pagehide')); expect(persist).toHaveBeenCalledTimes(calls);
  });
  it('keeps v1 direct extension methods and payloadSanitize opt-in defaults', () => {
    const l = initAemeath({ enableConsole: false, errorCapture: false, browserApiErrors: false, network: { enabled: false }, offlinePersistence: false });
    expect(l.hasPlugin('payload-sanitize')).toBe(false);
    expect(l.getHealth).toBeTypeOf('function'); expect(l.pause).toBeTypeOf('function');
    l.use(new PerformancePlugin({ sampleRate: 0 }));
    expect(l.startMark).toBeTypeOf('function'); expect(l.endMark).toBeTypeOf('function');
    expect(l).not.toHaveProperty('platform'); expect(l).not.toHaveProperty('extensions');
  });
  it('bounds CLS timestamps without changing the session score', () => {
    const plugin: any = new PerformancePlugin(); let callback: (entry: unknown) => void = () => {};
    plugin.observeMetric = (_kind: string, fn: typeof callback) => { callback = fn; };
    plugin.observeCLS();
    for (let i = 0; i < 1000; i++) callback({ startTime: i, value: 0.001 });
    expect(plugin.clsSessionEntries.length).toBeLessThanOrEqual(100);
    expect(plugin.clsSessionValue).toBeCloseTo(1);
    callback({ startTime: 7000, value: 0.25 }); expect(plugin.clsMaxSessionValue).toBeCloseTo(1);
  });
  it('adds error evidence to IIFE early records without changing legacy fields', async () => {
    const early = ['error', 'unhandledrejection', 'resource', 'compatibility'].map(type => ({ type, message: type+' detail', stack: null, timestamp: 1 }));
    (window as any).__flushEarlyErrors__ = (cb: (errors: unknown[]) => void) => cb(early);
    const captured: LogEntry[] = [];
    const l = browser.init({ enableConsole: false, browserApiErrors: false, errorCapture: false, safeGuard: false, offlinePersistence: false,
      upload: log => { captured.push(log); return { success: true }; } });
    await (l.getPluginInstance('upload') as UploadPlugin).flush();
    expect(captured.map(e => [e.message, e.level]).sort()).toEqual([
      ['error detail', 'error'], ['Unhandled Promise rejection', 'error'], ['Resource loading failed', 'warn'], ['compatibility detail', 'error'],
    ].sort());
    captured.forEach(e => {
      expect(e.context).toMatchObject(early.find(item => item.type === e.error?.type)!);
      expect(e.error?.evidence).toMatchObject({ capturePhase: 'early', stackOrigin: 'unavailable' });
      expect(e.tags?.errorCategory).toBe('early');
    });
  });
});
