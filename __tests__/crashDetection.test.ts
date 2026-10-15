import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBDatabase as FakeDatabase } from 'fake-indexeddb';
import { AemeathLogger } from '../src/core/Logger';
import { CrashDetectionPlugin } from '../src/plugins/CrashDetectionPlugin';
import { BeforeSendPlugin } from '../src/plugins/BeforeSendPlugin';
import { UploadPlugin, type UploadCallback } from '../src/plugins/UploadPlugin';
import { initCrashWorker } from '../src/crash-worker';
import { CrashStore } from '../src/plugins/crash/CrashStore';
import { PROTOCOL } from '../src/plugins/crash/types';
import type { PageRecord } from '../src/plugins/crash/types';
import type { LogEntry } from '../src/types';

// Structured message bridge + actual worker runtime and IDB transactions. This
// deliberately remains source/fake-IDB testing; native Workers are CI acceptance.
class TestWorker extends EventTarget {
  readonly incoming = new EventTarget();
  terminated = false;
  readonly stop: () => void;
  messages: Array<{ op: string }> = [];
  constructor(factory: IDBFactory) {
    super();
    this.stop = initCrashWorker({ indexedDB: factory,
      addEventListener: (_type, listener) => this.incoming.addEventListener('message', listener as EventListener),
      removeEventListener: (_type, listener) => this.incoming.removeEventListener('message', listener as EventListener),
      postMessage: data => { if (!this.terminated) queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: structuredClone(data) }))); },
    });
  }
  postMessage(data: unknown): void {
    this.messages.push(data as { op: string });
    if (!this.terminated) queueMicrotask(() => this.incoming.dispatchEvent(new MessageEvent('message', { data: structuredClone(data) })));
  }
  terminate(): void { this.terminated = true; this.stop(); }
}
const hosts: AemeathLogger[] = [];
const workers: TestWorker[] = [];
let factory: IDBFactory;
let namespace = 0;
const worker = (): Worker => { const instance = new TestWorker(factory); workers.push(instance); return instance as unknown as Worker; };
function host(deps = true, onUpload: UploadCallback = vi.fn(async () => ({ success: true })), queue?: ConstructorParameters<typeof UploadPlugin>[0]['queue']) {
  const logger = new AemeathLogger({ enableConsole: false }); hosts.push(logger);
  if (deps) {
    logger.use(new UploadPlugin({ onUpload, deliveryScope: 'tenant', cache: { enabled: false }, queue }));
    // This is a dependency stub, explicitly ready with no persisted items.
    const offline = { name: 'offline-persistence', install() {}, getStatus: () => ({ backend: 'noop', pending: 0, items: [] }) };
    logger.use(offline);
  }
  return logger;
}
function plugin(overrides: Partial<ConstructorParameters<typeof CrashDetectionPlugin>[0]> = {}) {
  return new CrashDetectionPlugin({ namespace: `unit-${++namespace}`, deliveryScope: 'tenant', createWorker: worker, ...overrides });
}
async function until(check: () => boolean) { for (let count = 0; count < 200; count++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw Error('condition timed out'); }
async function seedRecovery(ns: string, id: string): Promise<CrashStore> {
  const now = Date.now(), store = new CrashStore(factory, ns, 'tenant'); await store.open();
  const old: PageRecord = { key: `page:${id}`, kind: 'page', id, state: 'visible', started: now - 200_000, seen: now - 60_000, mainSeen: now - 60_000, revision: 8, beats: 8, eligibleAfter: now - 120_000, checkpoint: {}, breadcrumbs: [] };
  await store.savePage(old); await store.recover(old, now); return store;
}
beforeEach(() => { factory = new IDBFactory(); vi.stubGlobal('Worker', TestWorker); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); });
afterEach(async () => { hosts.splice(0).forEach(logger => logger.destroy()); await new Promise(resolve => setTimeout(resolve, 10)); workers.splice(0).forEach(value => value.terminate()); vi.unstubAllGlobals(); });
describe('crash plugin opt-in and failure isolation', () => {
  it('imports inertly and completes real worker-side storage handshake', async () => {
    const logger = host(), crash = plugin(); expect(workers).toHaveLength(0); logger.use(crash);
    expect((await crash.ready()).state).toBe('active'); expect(crash.getStatus().capabilities.indexedDB).toBe(true);
    expect(workers[0]!.messages[0]!.op).toBe('init');
    logger.uninstall(crash.name); await until(() => workers[0]!.terminated);
    expect(crash.getStatus().state).toBe('stopped');
  });
  it('missing dependencies disable with unconditional guarded warn rather than throwing Logger.use', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { throw Error('console patched'); });
    const logger = host(false), crash = plugin(); expect(() => logger.use(crash)).not.toThrow();
    expect((await crash.ready()).reason).toBe('missing-delivery-dependencies'); expect(warn).toHaveBeenCalledTimes(1); expect(workers).toHaveLength(0);
  });
  it.each(['realtime', 'hybrid'] as const)('reserved %s remains explicitly unsupported', async mode => {
    const logger = host(), crash = plugin({ mode }); logger.use(crash);
    expect((await crash.ready()).reason).toBe('feature-not-implemented'); expect(workers).toHaveLength(0);
  });
  it('requires actual Worker support and rejects ignored realtime configuration', async () => {
    const logger = host(), conflict = plugin({ realtime: { monitorMainThreadStall: false } }); logger.use(conflict);
    expect((await conflict.ready()).reason).toBe('configuration-conflict'); logger.uninstall(conflict.name);
    vi.stubGlobal('Worker', undefined); const crash = plugin(); logger.use(crash);
    expect((await crash.ready()).reason).toBe('dedicated-worker-unavailable');
  });
  it('contains CSP/factory errors and asynchronous worker errors', async () => {
    const logger = host(), csp = plugin({ createWorker: () => { throw new DOMException('CSP', 'SecurityError'); } }); logger.use(csp);
    expect((await csp.ready()).reason).toBe('worker-creation-failed'); logger.uninstall(csp.name);
    const crash = plugin(); logger.use(crash); await crash.ready(); workers[0]!.dispatchEvent(new Event('error'));
    expect(crash.getStatus().reason).toBe('worker-execution-failed');
    expect(() => logger.info('business still works')).not.toThrow();
  });
  it('rejects one physical namespace conflict but permits independent namespaces and remount', async () => {
    const a = host(), b = host(), first = plugin(), second = plugin({ namespace: (first as unknown as { options: { namespace: string } }).options.namespace });
    a.use(first); expect((await first.ready()).state).toBe('active'); b.use(second);
    expect((await second.ready()).reason).toBe('monitor-resource-in-use'); expect(first.getStatus().state).toBe('active');
    b.uninstall(second.name); const other = plugin(); b.use(other); expect((await other.ready()).state).toBe('active');
    a.uninstall(first.name); await until(() => workers[0]!.terminated);
    const remount = plugin({ namespace: (first as unknown as { options: { namespace: string } }).options.namespace }); a.use(remount); expect((await remount.ready()).state).toBe('active');
  });
  it('pauses hidden/bfcache, records normal leave, and handles dependency removal', async () => {
    const logger = host(), crash = plugin(); logger.use(crash); await crash.ready();
    document.dispatchEvent(new Event('freeze')); window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); window.dispatchEvent(new PageTransitionEvent('pagehide'));
    await until(() => workers[0]!.messages.filter(message => message.op === 'beat').length >= 5);
    logger.uninstall('upload'); expect(crash.getStatus().reason).toBe('delivery-dependency-removed');
  });
  it('durably prepares before upload and recovers original identity without current user', async () => {
    const oldClock = Date.now() - 60_000;
    const ns = `seed-${++namespace}`; const store = new CrashStore(factory, ns, 'tenant'); await store.open();
    const old: PageRecord = { key: 'page:seed', kind: 'page', id: 'seed', state: 'visible', started: oldClock - 100_000, seen: oldClock, mainSeen: oldClock, revision: 8, beats: 8, eligibleAfter: oldClock - 60_000, checkpoint: { routeKey: 'checkout' }, breadcrumbs: [], release: 'old-version' };
    await store.savePage(old); await store.recover(old, Date.now());
    const uploaded: LogEntry[] = []; const logger = host(true, vi.fn(async logs => {
      const probe = new CrashStore(factory, ns, 'tenant'); await probe.open();
      // A second owner cannot claim an event before the current network ACK.
      expect(await probe.claim(Date.now(), 'competitor')).toEqual([]); probe.close(); uploaded.push(logs); return { success: true };
    }));
    logger.setContext({ user: { id: 'current-user' } }); const hook = vi.fn(entry => ({ ...entry, message: 'safe' })); logger.use(new BeforeSendPlugin({ beforeSend: hook }));
    const crash = plugin({ namespace: ns }); logger.use(crash); await crash.ready(); await until(() => uploaded.length === 1);
    expect(uploaded[0]!.logId).toBe('seed:suspected-crash:1'); expect(uploaded[0]!.release).toBe('old-version');
    expect(uploaded[0]!.context?.user).toBeUndefined(); expect(uploaded[0]!.error).toBeUndefined(); expect(uploaded[0]!.message).toBe('safe'); expect(hook).toHaveBeenCalledTimes(1);
    expect((await crash.clearStoredData()).cleared).toBe(true); store.close();
  });
  it('async checkpoint errors fail closed without leaking callback error text', async () => {
    const logger = host(), crash = plugin({ checkpoint: { collect: (() => Promise.reject(Error('private-value'))) as never } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logger.use(crash); expect((await crash.ready()).reason).toBe('checkpoint-callback-failed');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('private-value');
  });
  it('disables recovery on async afterLog failure without uploading unsafe observations or blocking ordinary logs', async () => {
    const ns = `async-hook-${++namespace}`, store = await seedRecovery(ns, 'async-hook');
    const onUpload = vi.fn(async () => ({ success: true })), logger = host(true, onUpload);
    logger.use({ name: 'async-after', install() {}, afterLog: entry => {
      if (entry.tags?.observation === 'suspected-crash') return Promise.reject(new Error('async hook failed')) as never;
      return undefined;
    } });
    const crash = plugin({ namespace: ns }); logger.use(crash); await crash.ready();
    await until(() => crash.getStatus().state === 'disabled');
    expect(crash.getStatus().reason).toBe('observation-rejected'); expect(onUpload).not.toHaveBeenCalled();
    logger.info('ordinary still works');
    await (logger.getPluginInstance('upload') as UploadPlugin).flush();
    expect(onUpload).toHaveBeenCalledTimes(1);
    const retained = await store.claim(Date.now() + 31_000, 'inspection');
    expect(retained[0]!.event.prepared).toBeUndefined(); expect(retained[0]!.event.acknowledged).toEqual([]);
    store.close();
  });
  it('clear waits for preparation and preserves an active monitor', async () => {
    const logger = host(), crash = plugin(); logger.use(crash); await crash.ready();
    expect(await crash.clearStoredData()).toEqual({ cleared: true }); expect(crash.getStatus().state).toBe('active');
  });
  it('does not terminate a worker owned by a different namespace', async () => {
    const a = host(), b = host(), shared = worker(); const first = plugin({ createWorker: () => shared }), second = plugin({ createWorker: () => shared });
    a.use(first); await first.ready(); b.use(second);
    expect((await second.ready()).reason).toBe('worker-already-owned'); expect(workers[0]!.terminated).toBe(false);
    expect(first.getStatus().state).toBe('active');
  });
  it('worker rejects mismatched session messages without affecting host listeners', async () => {
    const logger = host(), crash = plugin(); logger.use(crash); await crash.ready();
    workers[0]!.dispatchEvent(new MessageEvent('message', { data: { protocol: PROTOCOL, session: 'wrong', type: 'fatal', reason: 'forged' } }));
    expect(crash.getStatus().state).toBe('active');
  });

  it('does not post an old checkpoint after its callback uninstalls the monitor', async () => {
    const logger = host();
    const crash = plugin({ checkpoint: { collect: () => {
      logger.uninstall('crash-detection');
      return { routeKey: 'checkout' };
    } } });
    logger.use(crash);

    expect((await crash.ready()).state).toBe('stopped');
    await until(() => workers[0]!.terminated);
    const operations = workers[0]!.messages.map(message => message.op);
    expect(operations).toEqual(['init', 'stop']);
  });

  it('does not settle a remounted initialization from an older checkpoint callback', async () => {
    const logger = host();
    let remounted = false;
    const crash = plugin({ checkpoint: { collect: () => {
      if (!remounted) {
        remounted = true;
        logger.uninstall('crash-detection');
        logger.use(crash);
      }
      return { routeKey: 'checkout' };
    } } });
    logger.use(crash);
    await crash.ready();
    await until(() => workers.length === 2);

    expect((await crash.ready()).state).toBe('active');
    expect(crash.getStatus().capabilities.indexedDB).toBe(true);
    await until(() => workers[0]!.terminated);
    expect(workers[0]!.messages.map(message => message.op)).toEqual(['init', 'stop']);
  });

  it('does not block a valid business destination switch when monitoring is active', async () => {
    const logger = host(), crash = plugin(); logger.use(crash); await crash.ready();
    const upload = logger.getPluginInstance('upload') as UploadPlugin;
    const nextUpload = vi.fn(async () => ({ success: true }));
    expect(() => upload.setOnUpload(nextUpload, { deliveryScope: 'next-tenant' })).not.toThrow();
    expect(upload.getDeliveryScope()).toBe('next-tenant');
    expect(crash.getStatus()).toMatchObject({ state: 'disabled', reason: 'delivery-scope-changed' });
    expect(() => logger.warn('business after switching')).not.toThrow();
    await upload.flush(); expect(nextUpload).toHaveBeenCalledTimes(1);
  });

  it('keeps the pre-existing pending-data guard when a business destination switch is unsafe', async () => {
    const logger = host(), crash = plugin(); logger.use(crash); await crash.ready();
    const upload = logger.getPluginInstance('upload') as UploadPlugin;
    upload.setOnUpload(null); logger.warn('pending ordinary business log');
    expect(() => upload.setOnUpload(vi.fn(), { deliveryScope: 'next-tenant' })).toThrow(/still pending/);
    expect(upload.getDeliveryScope()).toBe('tenant');
    expect(crash.getStatus().state).toBe('active');
  });

  it('allows the same ready empty destination switch without a crash plugin', () => {
    const logger = host(), upload = logger.getPluginInstance('upload') as UploadPlugin;
    expect(() => upload.setOnUpload(vi.fn(), { deliveryScope: 'next-tenant' })).not.toThrow();
    expect(upload.getDeliveryScope()).toBe('next-tenant');
  });

  it('ignores an old worker error after the monitor has been remounted', async () => {
    const logger = host(), crash = plugin(); logger.use(crash); await crash.ready();
    const oldWorker = workers[0]!;
    logger.uninstall(crash.name); logger.use(crash);
    oldWorker.dispatchEvent(new Event('error'));
    expect((await crash.ready()).state).toBe('active');
    expect(workers).toHaveLength(2);
    expect(() => logger.warn('business after remount')).not.toThrow();
  });

  it('does not attach a worker returned after its factory uninstalls the plugin', async () => {
    const logger = host();
    const crash = plugin({ createWorker: () => { const value = worker(); logger.uninstall('crash-detection'); return value; } });
    logger.use(crash);
    expect((await crash.ready()).state).toBe('stopped');
    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminated).toBe(true);
    expect(workers[0]!.messages).toEqual([]);
    expect(() => logger.warn('business after cancelled factory')).not.toThrow();
  });

  it('does not let a cancelled factory failure disable a new installation', async () => {
    const logger = host(); let remounted = false;
    const crash = plugin({ createWorker: () => {
      if (!remounted) {
        remounted = true; logger.uninstall('crash-detection'); logger.use(crash);
        throw Error('old factory failed');
      }
      return worker();
    } });
    logger.use(crash); await crash.ready();
    expect((await crash.ready()).state).toBe('active');
    expect(workers).toHaveLength(1);
  });

  it('does not let a cancelled storage clear disable a new installation', async () => {
    const logger = host(), crash = plugin(); logger.use(crash); await crash.ready();
    const oldWorker = workers[0]!, send = oldWorker.postMessage.bind(oldWorker); let heldClear = false;
    vi.spyOn(oldWorker, 'postMessage').mockImplementation(data => {
      if ((data as { op?: string }).op === 'clear') { heldClear = true; return; }
      send(data);
    });
    const clearing = crash.clearStoredData(); await until(() => heldClear);
    logger.uninstall(crash.name); logger.use(crash);
    expect(await clearing).toEqual({ cleared: false, reason: 'plugin-inactive' });
    expect((await crash.ready()).state).toBe('active');
    expect(() => logger.warn('business after cancelled clear')).not.toThrow();
  });

  it('removes stopped monitor items from Upload without losing the durable copy', async () => {
    const ns = `cancelled-queue-${++namespace}`, now = Date.now();
    const store = new CrashStore(factory, ns, 'tenant'); await store.open();
    const old: PageRecord = { key: 'page:queued', kind: 'page', id: 'queued', state: 'visible', started: now - 200_000, seen: now - 60_000, mainSeen: now - 60_000, revision: 8, beats: 8, eligibleAfter: now - 120_000, checkpoint: {}, breadcrumbs: [] };
    await store.savePage(old); await store.recover(old, now);
    const logger = host(), upload = logger.getPluginInstance('upload') as UploadPlugin;
    upload.setOnUpload(null);
    const crash = plugin({ namespace: ns }); logger.use(crash); await crash.ready();
    await until(() => upload.isPending('queued:suspected-crash:1'));
    logger.uninstall(crash.name);
    expect(upload.getQueueStatus().length).toBe(0);
    expect(upload.isPending('queued:suspected-crash:1')).toBe(false);
    const next = vi.fn(async () => ({ success: true }));
    expect(() => upload.setOnUpload(next, { deliveryScope: 'next-tenant' })).not.toThrow();
    logger.warn('ordinary after stop'); await upload.flush();
    expect(next).toHaveBeenCalledTimes(1);
    // Cancelling the RAM mirror does not ACK or erase the old tenant's outbox.
    expect(await store.claim(now + 60_000, 'next-owner')).toHaveLength(1); store.close();
  });

  it('contains a route configuration failure during a business breadcrumb call', async () => {
    const logger = host(), routeMatch = { includeRoutes: ['/'] };
    const crash = plugin({ routeMatch }); logger.use(crash); await crash.ready();
    Object.defineProperty(routeMatch, 'includeRoutes', { get() { throw Error('route state unavailable'); } });
    expect(() => crash.addBreadcrumb({ name: 'checkout', phase: 'done' })).not.toThrow();
    expect(crash.getStatus()).toMatchObject({ state: 'disabled', reason: 'breadcrumb-failed' });
    expect(() => logger.warn('ordinary business still works')).not.toThrow();
  });

  it('observes an unsupported async factory rejection instead of leaking an unhandled rejection', async () => {
    const logger = host(), crash = plugin({ createWorker: (() => Promise.reject(Error('async worker factory failed'))) as never });
    logger.use(crash);
    expect((await crash.ready()).reason).toBe('invalid-dedicated-worker');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(() => logger.warn('ordinary after invalid async factory')).not.toThrow();
    expect(workers).toHaveLength(0);
  });

  it('terminates a late unclaimed Worker returned by an unsupported async factory', async () => {
    const logger = host(), crash = plugin({ createWorker: (() => Promise.resolve(worker())) as never });
    logger.use(crash);
    expect((await crash.ready()).reason).toBe('invalid-dedicated-worker');
    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminated).toBe(true);
    expect(() => logger.warn('ordinary after late async worker')).not.toThrow();
  });

  it('does not let warning callback reentry overwrite a new installation', async () => {
    const logger = host(); let failed = false, remounted = false;
    const crash = plugin({ checkpoint: { collect: () => {
      if (!failed) { failed = true; throw Error('monitor callback failed'); }
      return {};
    } } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      if (!remounted) { remounted = true; logger.uninstall(crash.name); logger.use(crash); }
    });
    try {
      logger.use(crash); await crash.ready();
      expect((await crash.ready()).state).toBe('active');
      expect(workers).toHaveLength(2);
    } finally { warn.mockRestore(); }
  });

  it('coalesces a lifecycle event raised inside a checkpoint instead of collecting recursively', async () => {
    const logger = host(); let armed = false, calls = 0;
    const crash = plugin({ checkpoint: { collect: () => {
      calls++;
      if (armed) { armed = false; window.dispatchEvent(new PageTransitionEvent('pagehide')); }
      return { routeKey: 'checkout' };
    } } });
    logger.use(crash); await crash.ready(); await until(() => workers[0]!.messages.some(message => message.op === 'claim'));
    const before = calls, offset = workers[0]!.messages.length; armed = true;
    document.dispatchEvent(new Event('freeze'));
    await until(() => workers[0]!.messages.length > offset);
    expect(calls - before).toBe(1);
    const beats = workers[0]!.messages.slice(offset).filter(message => message.op === 'beat') as Array<{ op: string; data: { state: string } }>;
    expect(beats).toHaveLength(1); expect(beats[0]!.data.state).toBe('ended');
  });

  it('contains an unavailable cleanup timer and still terminates its owned worker', async () => {
    const logger = host(), crash = plugin(); logger.use(crash); await crash.ready();
    const schedule = globalThis.setTimeout;
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<typeof setTimeout>) => {
      if (args[1] === 2000) throw Error('cleanup timer unavailable');
      return schedule(...args);
    }) as typeof setTimeout);
    try {
      expect(() => crash.uninstall(logger)).not.toThrow();
      expect(workers[0]!.terminated).toBe(true);
      expect(crash.getStatus().state).toBe('stopped');
      expect(() => logger.warn('ordinary after cleanup failure')).not.toThrow();
    } finally { timer.mockRestore(); }
  });

  it('does not throw during construction when optional monitoring configuration cannot be read', async () => {
    const logger = host();
    const config = { get namespace(): string { throw Error('configuration state unavailable'); }, deliveryScope: 'tenant', createWorker: worker };
    let crash: CrashDetectionPlugin | undefined;
    expect(() => { crash = new CrashDetectionPlugin(config); }).not.toThrow();
    logger.use(crash!); expect((await crash!.ready()).reason).toBe('invalid-config');
    expect(workers).toHaveLength(0);
  });

  it('lets ordinary logs reclaim optional crash queue capacity without deleting durable evidence', async () => {
    const ns = `capacity-${++namespace}`, now = Date.now(), store = new CrashStore(factory, ns, 'tenant'); await store.open();
    const old: PageRecord = { key: 'page:capacity', kind: 'page', id: 'capacity', state: 'visible', started: now - 200_000, seen: now - 60_000, mainSeen: now - 60_000, revision: 8, beats: 8, eligibleAfter: now - 120_000, checkpoint: {}, breadcrumbs: [] };
    await store.savePage(old); await store.recover(old, now);
    try {
      const logger = host(true, vi.fn(async () => ({ success: true })), { maxSize: 1 });
      const upload = logger.getPluginInstance('upload') as UploadPlugin; upload.setOnUpload(null);
      const crash = plugin({ namespace: ns }); logger.use(crash); await crash.ready();
      await until(() => upload.isPending('capacity:suspected-crash:1'));
      const ordinary: LogEntry[] = []; logger.on('log', entry => ordinary.push(entry));
      logger.warn('ordinary business must keep its slot');
      expect(upload.isPending(ordinary[0]!.logId)).toBe(true);
      expect(upload.isPending('capacity:suspected-crash:1')).toBe(false);
      expect(upload.getQueueStatus().drops.total).toBe(0);
      expect(await store.claim(now + 60_000, 'after-yield')).toHaveLength(1);
    } finally { store.close(); }
  });

  it('bounds route callback reentry from lifecycle events', async () => {
    const logger = host(); let armed = false, calls = 0, nested = 0;
    const crash = plugin({ routeMatch: { includeRoutes: [() => {
      calls++;
      if (armed && nested++ < 2) document.dispatchEvent(new Event('visibilitychange'));
      return true;
    }] } });
    logger.use(crash); await crash.ready(); await until(() => workers[0]!.messages.some(message => message.op === 'claim'));
    const before = calls; armed = true; document.dispatchEvent(new Event('visibilitychange'));
    expect(calls - before).toBe(1); expect(crash.getStatus().state).toBe('active');
  });

  it('does not recursively record breadcrumbs from its route callback', async () => {
    const logger = host(); let armed = false, calls = 0;
    const crash = plugin({ routeMatch: { includeRoutes: [() => {
      calls++; if (armed) { armed = false; crash.addBreadcrumb({ name: 'nested' }); }
      return true;
    }] } });
    logger.use(crash); await crash.ready(); await until(() => workers[0]!.messages.some(message => message.op === 'claim'));
    const before = calls; armed = true; crash.addBreadcrumb({ name: 'business' });
    expect(calls - before).toBe(1);
  });

  it('lets queued crash fragments yield while a sibling is already uploading', async () => {
    const ns = `partial-capacity-${++namespace}`, now = Date.now(), store = new CrashStore(factory, ns, 'tenant'); await store.open();
    const old: PageRecord = { key: 'page:partial', kind: 'page', id: 'partial', state: 'visible', started: now - 200_000, seen: now - 60_000, mainSeen: now - 60_000, revision: 8, beats: 8, eligibleAfter: now - 120_000, checkpoint: {}, breadcrumbs: [] };
    await store.savePage(old); await store.recover(old, now);
    let finish!: (value: { success: boolean }) => void;
    const held = new Promise<{ success: boolean }>(resolve => { finish = resolve; }), sent: LogEntry[] = [];
    const logger = host(true, async entry => { sent.push(entry); return entry.context?.crash ? held : { success: true }; }, { maxSize: 2 });
    const upload = logger.getPluginInstance('upload') as UploadPlugin;
    logger.use({ name: 'crash-split', install() {}, afterLog: entry => entry.context?.crash ? [1, 2].map(index => ({ ...entry, logId: `${entry.logId}:${index}`, tags: { ...entry.tags, splitId: entry.logId, splitIndex: String(index), splitTotal: '2' } })) : undefined });
    try {
      const crash = plugin({ namespace: ns }); logger.use(crash); await crash.ready(); await until(() => sent.length === 1);
      const ordinary: LogEntry[] = []; logger.on('log', entry => ordinary.push(entry));
      logger.warn('ordinary one'); logger.warn('ordinary two');
      expect(ordinary.every(entry => upload.isPending(entry.logId))).toBe(true);
      expect(upload.isPending('partial:suspected-crash:1:2')).toBe(false);
      expect(upload.isInFlight('partial:suspected-crash:1:1')).toBe(true);
      finish({ success: true }); await upload.flush();
      expect(sent).toHaveLength(3);
      const remaining = await store.claim(now + 60_000, 'after-partial');
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.event.acknowledged).toEqual(['partial:suspected-crash:1:1']);
    } finally { finish({ success: true }); store.close(); }
  });

  it('does not let reentry from listener cleanup reset a remounted installation', async () => {
    const logger = host(); let fail = false;
    const crash = plugin({ checkpoint: { collect: () => { if (fail) { fail = false; throw Error('monitor callback'); } return {}; } } });
    logger.use(crash); await crash.ready(); await until(() => workers[0]!.messages.some(message => message.op === 'claim'));
    const remove = document.removeEventListener.bind(document); let remounted = false;
    const cleanup = vi.spyOn(document, 'removeEventListener').mockImplementation((...args) => {
      remove(...args);
      if (!remounted) { remounted = true; logger.uninstall(crash.name); logger.use(crash); }
    });
    try {
      fail = true; document.dispatchEvent(new Event('freeze'));
      expect((await crash.ready()).state).toBe('active');
      expect(workers).toHaveLength(2);
      await until(() => workers[0]!.terminated);
    } finally { cleanup.mockRestore(); }
  });

  it('handles only its owned worker error instead of reporting it as a host error', async () => {
    const logger = host(), crash = plugin(); logger.use(crash); await crash.ready();
    const error = new ErrorEvent('error', { cancelable: true, message: 'owned monitor worker failed' });
    expect(workers[0]!.dispatchEvent(error)).toBe(false);
    expect(error.defaultPrevented).toBe(true);
    expect(crash.getStatus()).toMatchObject({ state: 'disabled', reason: 'worker-execution-failed' });
    const unrelatedWorker = worker() as unknown as TestWorker;
    const unrelatedError = new ErrorEvent('error', { cancelable: true, message: 'business worker error' });
    expect(unrelatedWorker.dispatchEvent(unrelatedError)).toBe(true);
    expect(unrelatedError.defaultPrevented).toBe(false);
    expect(() => logger.warn('business after owned worker failure')).not.toThrow();
  });

  it('retains pagehide raised during the initial route callback without sending before init', async () => {
    const ns = `initial-leave-${++namespace}`, logger = host(); let leave = true;
    const crash = plugin({ namespace: ns, routeMatch: { includeRoutes: [() => {
      if (leave) { leave = false; window.dispatchEvent(new PageTransitionEvent('pagehide')); }
      return true;
    }] } });
    logger.use(crash);
    expect((await crash.ready()).state).toBe('active');
    expect(workers[0]!.messages[0]!.op).toBe('init');
    const store = new CrashStore(factory, ns, 'tenant'); await store.open();
    try { expect((await store.pages())[0]!.state).toBe('ended'); } finally { store.close(); }
  });

  it('does not overwrite a newer pagehide from an active route callback with visible', async () => {
    const logger = host(); let leave = false;
    const crash = plugin({ routeMatch: { includeRoutes: [() => {
      if (leave) { leave = false; window.dispatchEvent(new PageTransitionEvent('pagehide')); }
      return true;
    }] } });
    logger.use(crash); await crash.ready(); await until(() => workers[0]!.messages.some(message => message.op === 'claim'));
    leave = true; document.dispatchEvent(new Event('visibilitychange'));
    const beats = (workers[0]!.messages as Array<{ op: string; data?: { state?: string } }>).filter(message => message.op === 'beat');
    expect(beats[beats.length - 1]!.data!.state).toBe('ended');
    expect(crash.getStatus().state).toBe('active');
  });

  it('coalesces concurrent clear calls and keeps recovery paused until the shared clear completes', async () => {
    const logger = host(), crash = plugin(); logger.use(crash); await crash.ready();
    await new Promise(resolve => setTimeout(resolve, 10));
    const owned = workers[0]!, send = owned.postMessage.bind(owned), held: unknown[] = [];
    vi.spyOn(owned, 'postMessage').mockImplementation(data => {
      if ((data as { op: string }).op === 'clear') { held.push(data); return; }
      send(data);
    });
    const first = crash.clearStoredData(), second = crash.clearStoredData();
    try {
      await until(() => held.length > 0); await new Promise(resolve => setTimeout(resolve, 10));
      expect(held).toHaveLength(1);
      const before = owned.messages.filter(message => message.op === 'claim').length;
      const session = (owned.messages[0] as unknown as { session: string }).session;
      owned.dispatchEvent(new MessageEvent('message', { data: { protocol: PROTOCOL, session, type: 'tick' } }));
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(owned.messages.filter(message => message.op === 'claim')).toHaveLength(before);
    } finally { for (const data of held) send(data); }
    expect(await first).toEqual({ cleared: true }); expect(await second).toEqual({ cleared: true });
  });

  it('does not let queued optional recovery add a synchronous destination-switch failure', async () => {
    const ns = `switch-queued-${++namespace}`, store = await seedRecovery(ns, 'switch-queued');
    try {
      const logger = host(), upload = logger.getPluginInstance('upload') as UploadPlugin; upload.setOnUpload(null);
      const crash = plugin({ namespace: ns }); logger.use(crash); await crash.ready();
      await until(() => upload.isPending('switch-queued:suspected-crash:1'));
      const next = vi.fn(async (_entry: LogEntry) => ({ success: true }));
      expect(() => upload.setOnUpload(next, { deliveryScope: 'next-tenant' })).not.toThrow();
      expect(crash.getStatus()).toMatchObject({ state: 'disabled', reason: 'delivery-scope-changed' });
      logger.warn('ordinary after queued switch'); await upload.flush();
      expect(next).toHaveBeenCalledTimes(1); expect(next.mock.calls[0]![0].message).toBe('ordinary after queued switch');
      expect(await store.claim(Date.now() + 60_000, 'old-tenant-owner')).toHaveLength(1);
    } finally { store.close(); }
  });

  it('does not invoke onUpload for a recovery item cancelled by its attempt listener', async () => {
    const ns = `cancel-attempt-${++namespace}`, store = await seedRecovery(ns, 'cancel-attempt');
    try {
      const send = vi.fn(async (_entry: LogEntry) => ({ success: true })), logger = host(true, send);
      const upload = logger.getPluginInstance('upload') as UploadPlugin, crash = plugin({ namespace: ns }); let cancelled = false;
      logger.on('upload:attempt', detail => {
        if (detail.source === 'durable-observation') { cancelled = true; logger.uninstall(crash.name); }
      });
      logger.use(crash); await crash.ready(); await until(() => cancelled); await upload.flush();
      expect(send).not.toHaveBeenCalled();
      logger.warn('ordinary after cancelled attempt'); await upload.flush();
      expect(send).toHaveBeenCalledTimes(1);
      expect(await store.claim(Date.now() + 60_000, 'after-cancellation')).toHaveLength(1);
    } finally { store.close(); }
  });

  it('keeps the newer destination binding when a disable warning reenters setOnUpload', async () => {
    const logger = host(), crash = plugin(); logger.use(crash); await crash.ready();
    const upload = logger.getPluginInstance('upload') as UploadPlugin;
    const next = vi.fn(async (_entry: LogEntry) => ({ success: true })), newer = vi.fn(async (_entry: LogEntry) => ({ success: true }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      upload.setOnUpload(newer, { deliveryScope: 'newer-tenant' });
    });
    try {
      upload.setOnUpload(next, { deliveryScope: 'next-tenant' });
      expect(upload.getDeliveryScope()).toBe('newer-tenant');
      logger.warn('ordinary after nested destination switch'); await upload.flush();
      expect(next).not.toHaveBeenCalled(); expect(newer).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); }
  });

  it('does not let an old in-flight observation failure pause the new business destination', async () => {
    const ns = `switch-flight-${++namespace}`, store = await seedRecovery(ns, 'switch-flight');
    let finish!: (value: { success: boolean; retryReason: 'network' }) => void;
    const held = new Promise<{ success: boolean; retryReason: 'network' }>(resolve => { finish = resolve; });
    try {
      const old = vi.fn(async (_entry: LogEntry) => held), logger = host(true, old);
      const upload = logger.getPluginInstance('upload') as UploadPlugin, crash = plugin({ namespace: ns });
      logger.use(crash); await crash.ready(); await until(() => old.mock.calls.length === 1);
      const next = vi.fn(async (_entry: LogEntry) => ({ success: true }));
      expect(() => upload.setOnUpload(next, { deliveryScope: 'next-tenant' })).not.toThrow();
      logger.warn('ordinary after in-flight switch'); finish({ success: false, retryReason: 'network' }); await upload.flush();
      expect(next).toHaveBeenCalledTimes(1); expect(next.mock.calls[0]![0].message).toBe('ordinary after in-flight switch');
      expect(upload.getQueueStatus()).toMatchObject({ paused: false, consecutiveFailures: 0 });
      expect(await store.claim(Date.now() + 60_000, 'after-flight')).toHaveLength(1);
    } finally { finish({ success: false, retryReason: 'network' }); store.close(); }
  });

  it('does not admit a recovery item cancelled inside its priority callback', async () => {
    const ns = `cancel-priority-${++namespace}`, store = await seedRecovery(ns, 'cancel-priority');
    try {
      const logger = host(); logger.uninstall('upload');
      const crash = plugin({ namespace: ns });
      const send = vi.fn(async (_entry: LogEntry) => ({ success: true }));
      const upload = new UploadPlugin({ onUpload: send, deliveryScope: 'tenant', cache: { enabled: false }, getPriority: entry => {
        if (entry.context?.crash) logger.uninstall(crash.name);
        return 10;
      } });
      logger.use(upload);
      const enqueued = vi.fn(); logger.on('upload:enqueued', enqueued);
      logger.use(crash); await crash.ready(); await until(() => crash.getStatus().state === 'stopped');
      expect(enqueued).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
      logger.warn('ordinary after priority cancellation'); await upload.flush(); expect(send).toHaveBeenCalledTimes(1);
      expect(await store.claim(Date.now() + 60_000, 'after-priority')).toHaveLength(1);
    } finally { store.close(); }
  });

  it('does not publish an old observation success after its pending ACK loses the destination', async () => {
    const ns = `cancel-ack-${++namespace}`, store = await seedRecovery(ns, 'cancel-ack');
    try {
      let ackHeld = false;
      const createWorker = (): Worker => {
        const value = worker() as unknown as TestWorker, send = value.postMessage.bind(value);
        vi.spyOn(value, 'postMessage').mockImplementation(data => {
          const request = data as { op: string; data?: { operation?: string } };
          if (request.op === 'update' && request.data?.operation === 'ack') { ackHeld = true; return; }
          send(data);
        });
        return value as unknown as Worker;
      };
      const logger = host(), upload = logger.getPluginInstance('upload') as UploadPlugin, crash = plugin({ namespace: ns, createWorker });
      const successes: Array<{ source?: string; scope: string }> = [];
      logger.on('upload:success', event => successes.push({ source: event.source, scope: upload.getDeliveryScope() }));
      logger.use(crash); await crash.ready(); await until(() => ackHeld);
      const next = vi.fn(async (_entry: LogEntry) => ({ success: true }));
      upload.setOnUpload(next, { deliveryScope: 'next-tenant' });
      logger.warn('ordinary after pending ACK'); await upload.flush();
      expect(next).toHaveBeenCalledTimes(1);
      expect(successes).toEqual([{ source: undefined, scope: 'next-tenant' }]);
      expect(await store.claim(Date.now() + 60_000, 'after-cancelled-ack')).toHaveLength(1);
    } finally { store.close(); }
  });

  it('disables safely when a later worker message cannot be posted and preserves ordinary delivery', async () => {
    const sent = vi.fn(async (_entry: LogEntry) => ({ success: true })), logger = host(true, sent), crash = plugin();
    logger.use(crash); await crash.ready(); await new Promise(resolve => setTimeout(resolve, 10));
    const owned = workers[0]!, send = owned.postMessage.bind(owned); let rejectBeat = true;
    vi.spyOn(owned, 'postMessage').mockImplementation(data => {
      if (rejectBeat && (data as { op: string }).op === 'beat') { rejectBeat = false; throw new DOMException('message clone failed', 'DataCloneError'); }
      send(data);
    });
    expect(() => document.dispatchEvent(new Event('freeze'))).not.toThrow();
    await until(() => crash.getStatus().state === 'disabled');
    expect(crash.getStatus().reason).toBe('worker-message-failed');
    logger.warn('ordinary after message failure'); await (logger.getPluginInstance('upload') as UploadPlugin).flush();
    expect(sent).toHaveBeenCalledTimes(1); await until(() => owned.terminated);
  });

  it('contains a real worker-side transaction abort after startup without blocking ordinary delivery', async () => {
    const ns = `abort-active-${++namespace}`, sent = vi.fn(async (_entry: LogEntry) => ({ success: true })), logger = host(true, sent), crash = plugin({ namespace: ns });
    logger.use(crash); await crash.ready(); await new Promise(resolve => setTimeout(resolve, 10));
    const transaction = FakeDatabase.prototype.transaction; let aborted = false;
    const fault = vi.spyOn(FakeDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
      const tx = Reflect.apply(transaction, this, args) as IDBTransaction;
      if (!aborted && this.name === `__aemeath_crash_v1__:${ns}` && args[1] === 'readwrite') {
        aborted = true; queueMicrotask(() => tx.abort());
      }
      return tx;
    });
    try {
      expect(() => document.dispatchEvent(new Event('freeze'))).not.toThrow();
      await until(() => crash.getStatus().state === 'disabled');
      expect(aborted).toBe(true); expect(crash.getStatus().reason).toBe('indexeddb-transaction-failed');
      logger.warn('ordinary after storage abort'); await (logger.getPluginInstance('upload') as UploadPlugin).flush();
      expect(sent).toHaveBeenCalledTimes(1); await until(() => workers[0]!.terminated);
    } finally { fault.mockRestore(); }
  });

  it('does not emit success when its owner stops between a committed ACK and upload continuation', async () => {
    const ns = `ack-continuation-${++namespace}`, store = await seedRecovery(ns, 'ack-continuation');
    try {
      const logger = host(), crash = plugin({ namespace: ns }), upload = logger.getPluginInstance('upload') as UploadPlugin;
      let ackId: number | undefined, stopped = false;
      const successes: string[] = [];
      logger.on('upload:success', event => { if (event.source === 'durable-observation') successes.push(event.log.logId); });
      logger.use(crash); await crash.ready();
      const owned = workers[0]!, send = owned.postMessage.bind(owned);
      vi.spyOn(owned, 'postMessage').mockImplementation(data => {
        const request = data as { op: string; id: number; data?: { operation?: string } };
        if (request.op === 'update' && request.data?.operation === 'ack') ackId = request.id;
        send(data);
      });
      // Registered after WorkerClient: its response resolves the receipt first;
      // this microtask runs after that receipt commits but before Upload resumes.
      owned.addEventListener('message', event => {
        if (ackId !== undefined && (event as MessageEvent).data.id === ackId) queueMicrotask(() => { stopped = true; logger.uninstall(crash.name); });
      });
      await until(() => stopped); await upload.flush();
      expect(successes).toEqual([]);
      logger.warn('ordinary after committed ACK'); await upload.flush();
      expect((await store.claim(Date.now() + 60_000, 'after-committed-ack'))).toEqual([]);
    } finally { store.close(); }
  });

  it.each(['terminal', 'park', 'schedule', 'retry'] as const)('does not continue %s after its receipt owner stops in the commit microtask', async operation => {
    const ns = `commit-${operation}-${++namespace}`, store = await seedRecovery(ns, `commit-${operation}`);
    try {
      const logger = host(true, async entry => entry.context?.crash
        ? { success: false, shouldRetry: operation !== 'terminal', retryReason: operation === 'retry' ? 'network' : 'server' }
        : { success: true }, { maxRetries: operation === 'park' ? 0 : 3, suspectedOfflineThreshold: 1 });
      const crash = plugin({ namespace: ns }), upload = logger.getPluginInstance('upload') as UploadPlugin;
      let requestId: number | undefined, stopped = false;
      const events: string[] = [];
      logger.on('upload:drop', event => { if (event.source === 'durable-observation') events.push('drop'); });
      logger.on('upload:parked', event => { if (event.source === 'durable-observation') events.push('parked'); });
      logger.on('upload:retry-scheduled', event => { if (event.source === 'durable-observation') events.push('retry-scheduled'); });
      logger.use(crash); await crash.ready();
      const owned = workers[0]!, send = owned.postMessage.bind(owned);
      vi.spyOn(owned, 'postMessage').mockImplementation(data => {
        const request = data as { op: string; id: number; data?: { operation?: string } };
        if (request.op === 'update' && request.data?.operation === operation) requestId = request.id;
        send(data);
      });
      owned.addEventListener('message', event => {
        if (requestId !== undefined && (event as MessageEvent).data.id === requestId) queueMicrotask(() => { stopped = true; logger.uninstall(crash.name); });
      });
      await until(() => stopped); await upload.flush();
      expect(events).toEqual([]); expect(upload.getQueueStatus().paused).toBe(false);
      logger.warn(`ordinary after ${operation} completion`); await upload.flush();
      expect(upload.getQueueStatus().length).toBe(0);
    } finally { store.close(); }
  });
});
