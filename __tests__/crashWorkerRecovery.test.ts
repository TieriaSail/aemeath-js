import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { initCrashWorker } from '../src/crash-worker';
import { CrashStore } from '../src/plugins/crash/CrashStore';
import { PROTOCOL } from '../src/plugins/crash/types';
import type { CrashResponse, PageRecord } from '../src/plugins/crash/types';
const disposers: Array<() => void> = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks(); });
async function setup() {
  let now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const factory = new IDBFactory(), store = new CrashStore(factory, 'runtime', 'scope'); await store.open(); disposers.push(() => store.close());
  const candidate: PageRecord = { key: 'page:old', kind: 'page', id: 'old', state: 'visible', started: now - 120_000, seen: now - 40_000, mainSeen: now - 40_000, beats: 10, revision: 10, eligibleAfter: now - 80_000, checkpoint: {}, breadcrumbs: [] };
  await store.savePage(candidate);
  const incoming = new EventTarget(); let tick: (() => void) | undefined;
  const responses = new Map<number, CrashResponse>(); let id = 0;
  disposers.push(initCrashWorker({ indexedDB: factory,
    addEventListener: (_, listener) => incoming.addEventListener('message', listener as EventListener),
    removeEventListener: (_, listener) => incoming.removeEventListener('message', listener as EventListener),
    postMessage: value => { const response = value as CrashResponse; if (response.id) responses.set(response.id, response); },
    setInterval: fn => { tick = fn; return 1 as unknown as ReturnType<typeof setInterval>; },
    clearInterval: () => { tick = undefined; },
  }));
  async function exchange(op: string, data: unknown = {}) {
    const current = ++id; incoming.dispatchEvent(new MessageEvent('message', { data: { protocol: PROTOCOL, session: 'runtime-session', id: current, op, data } }));
    for (let tries = 0; tries < 200 && !responses.has(current); tries++) await new Promise(resolve => setTimeout(resolve, 1));
    const response = responses.get(current); if (!response) throw Error('No worker response'); return response;
  }
  async function send(op: string, data: unknown = {}) {
    const response = await exchange(op, data); expect(response.ok).toBe(true); return response.data;
  }
  await send('init', { namespace: 'runtime', deliveryScope: 'scope', pageId: 'current', state: 'visible' });
  async function advance(delta = 5000) {
    now += delta; tick?.();
    // The request is serialized after the interval task, so this response fences its completion.
    await send('beat', { state: 'visible', checkpoint: {}, breadcrumbs: [] });
  }
  return { store, candidate, send, exchange, advance, time: () => now, hasTimer: () => !!tick };
}
describe('worker recovery state machine without native browser emulation claims', () => {
  it('requires startup warmup plus two independent unchanged observations', async () => {
    const runtime = await setup();
    for (let count = 0; count < 6; count++) await runtime.advance();
    expect(await runtime.store.claim(runtime.time(), 'early')).toEqual([]);
    await runtime.advance(); expect(await runtime.store.claim(runtime.time(), 'ready')).toHaveLength(1);
  });
  it('suppresses a candidate that demonstrates new observer activity', async () => {
    const runtime = await setup(); for (let count = 0; count < 6; count++) await runtime.advance();
    await runtime.store.savePage({ ...runtime.candidate, seen: runtime.time(), revision: 11 });
    await runtime.advance(); expect(await runtime.store.claim(runtime.time(), 'claim')).toEqual([]);
  });
  it('restarts warmup after sleep and pauses hidden/frozen polling', async () => {
    const runtime = await setup(); for (let count = 0; count < 6; count++) await runtime.advance();
    await runtime.advance(60_000); expect(await runtime.store.claim(runtime.time(), 'after-sleep')).toEqual([]);
    await runtime.send('beat', { state: 'hidden', checkpoint: {}, breadcrumbs: [] }); expect(runtime.hasTimer()).toBe(false);
    await runtime.send('beat', { state: 'visible', checkpoint: {}, breadcrumbs: [] }); expect(runtime.hasTimer()).toBe(true);
    await runtime.advance(); expect(await runtime.store.claim(runtime.time(), 'after-resume')).toEqual([]);
  });
  it('keeps a stopped worker terminal when a stale heartbeat arrives', async () => {
    const runtime = await setup();
    await runtime.send('stop');
    const response = await runtime.exchange('beat', { state: 'visible', checkpoint: {}, breadcrumbs: [] });
    expect(response).toMatchObject({ ok: false, reason: 'worker-stopped' });
    expect(runtime.hasTimer()).toBe(false);
    expect((await runtime.store.pages()).find(page => page.id === 'current')?.state).toBe('ended');
  });
});
