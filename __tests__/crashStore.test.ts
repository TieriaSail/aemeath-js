import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { CrashStore } from '../src/plugins/crash/CrashStore';
import { LogLevel } from '../src/types';
import type { PageRecord } from '../src/plugins/crash/types';
import { TTL_MS } from '../src/plugins/crash/types';
const stores: CrashStore[] = [];
const now = 1_000_000;
const page = (id = 'old-page'): PageRecord => ({ key: `page:${id}`, kind: 'page', id, state: 'visible', started: now - 120_000, seen: now - 40_000, mainSeen: now - 40_000, revision: 10, eligibleAfter: now - 90_000, beats: 12, checkpoint: { routeKey: 'checkout' }, breadcrumbs: [], release: 'old-release' });
async function open(factory = new IDBFactory(), scope = 'tenant-a') { const store = new CrashStore(factory, 'test', scope); stores.push(store); await store.open(); return store; }
afterEach(() => { stores.splice(0).forEach(store => store.close()); vi.restoreAllMocks(); });
describe('crash store transaction contracts (fake IndexedDB, not browser acceptance)', () => {
  it('proves scope binding and isolates the dedicated database', async () => {
    const factory = new IDBFactory(); await open(factory);
    await expect(open(factory, 'tenant-b')).rejects.toThrow('delivery-scope-mismatch');
    expect((await factory.databases()).map(db => db.name)).toEqual(['__aemeath_crash_v1__:test']);
  });
  it('rechecks stale visibility/revision atomically before creating one stable episode', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const store = await open(); const old = page(); await store.savePage(old);
    await store.savePage({ ...old, revision: 11 }); expect(await store.recover(old, now)).toBe(false);
    await store.savePage(old); expect(await store.recover(old, now)).toBe(true);
    expect(await store.recover(old, now)).toBe(false);
    const claimed = await store.claim(now, 'token'); expect(claimed).toHaveLength(1);
    expect(claimed[0]!.event.id).toBe('old-page:suspected-crash:1');
    expect(claimed[0]!.event.release).toBe('old-release');
  });
  it.each(['hidden', 'frozen', 'bfcache', 'ended', 'unknown'] as const)('suppresses %s leftovers', async state => {
    vi.spyOn(Date, 'now').mockReturnValue(now); const store = await open(); const old = { ...page(), state };
    await store.savePage(old); expect(await store.recover(old, now)).toBe(false); expect(await store.claim(now, 't')).toEqual([]);
  });
  it('suppresses short sessions, warmup, future clocks and expired records', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now); const store = await open();
    for (const old of [{ ...page('short'), beats: 1 }, { ...page('warmup'), eligibleAfter: now }, { ...page('future'), seen: now + 1 }, { ...page('expired'), seen: now - TTL_MS - 1 }]) {
      await store.savePage(old); expect(await store.recover(old, now)).toBe(false);
    }
  });
  it('serializes two tabs, persists prepared group/partial ACK, and fences a stale receipt', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now); const factory = new IDBFactory();
    const a = await open(factory), b = await open(factory); const old = page(); await a.savePage(old); await a.recover(old, now);
    const claims = await Promise.all([a.claim(now, 'a'), b.claim(now, 'b')]); expect(claims.flat()).toHaveLength(1);
    const claim = claims.flat()[0]!; const id = claim.event.id; const token = claim.token;
    const entries = [1, 2].map(index => ({ logId: `${id}-${index}`, level: LogLevel.WARN, timestamp: old.mainSeen, message: 'sanitized' }));
    expect(await a.update(id, token, 'prepare', entries)).toBe(true);
    expect(await a.update(id, token, 'ack', entries[0]!.logId)).toBe(true);
    clock.mockReturnValue(now + 31_000);
    const [reclaimed] = await b.claim(now + 31_000, 'replacement'); expect(reclaimed!.event.prepared).toEqual(entries);
    expect(reclaimed!.event.acknowledged).toEqual([entries[0]!.logId]);
    expect(await a.update(id, token, 'ack', entries[1]!.logId)).toBe(false);
    await b.update(id, 'replacement', 'ack', entries[1]!.logId);
    expect(await a.claim(now + 100_000, 'late')).toEqual([]);
  });
  it('honors Retry-After across reopen and keeps filtered episode tombstones', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now); const store = await open(); await store.savePage(page()); await store.recover(page(), now);
    const [claim] = await store.claim(now, 'a'); const id = claim!.event.id;
    await store.update(id, 'a', 'retry', { nextEligibleAt: now + 1000, serverNotBefore: now + 60_000 });
    store.close(); await store.open(); expect(await store.claim(now + 50_000, 'b')).toEqual([]);
    clock.mockReturnValue(now + 61_000); await store.claim(now + 61_000, 'b'); await store.update(id, 'b', 'filter');
    expect(await store.claim(now + 200_000, 'c')).toEqual([]);
    expect(await store.recover(page(), now + 200_000)).toBe(false);
  });
  it('refuses namespace clear while a foreign observer may still be active', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now); const store = await open();
    const current = { ...page('current'), seen: now }; const peer = { ...page('peer'), state: 'hidden' as const };
    await store.savePage(current); await store.savePage(peer);
    await expect(store.clear(current)).rejects.toThrow('storage-in-use');
    expect(await store.pages()).toHaveLength(2);
    await store.savePage({ ...peer, state: 'ended' }); await store.clear(current);
    expect((await store.pages()).map(row => row.id)).toEqual(['current']);
  });
  it('clear invalidates leases and quota rejection rolls back atomically', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now); const store = await open(); await store.savePage(page()); await store.recover(page(), now);
    const [claim] = await store.claim(now, 'a'); await store.clear();
    expect(await store.update(claim!.event.id, 'a', 'ack', 'x')).toBe(false); expect(await store.pages()).toEqual([]);
    await expect(store.savePage({ ...page(), checkpoint: { routeKey: 'x'.repeat(2 * 1024 * 1024) } })).rejects.toThrow('storage-budget-exceeded');
    expect(await store.pages()).toEqual([]);
  });
});
