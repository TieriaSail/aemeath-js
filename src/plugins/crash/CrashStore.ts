import type { LogEntry } from '../../types';
import { LEASE_MS, TTL_MS, WARMUP_MS } from './types';
import type { ClaimedEvent, CrashEvent, PageRecord } from './types';

interface Binding { key: 'binding'; kind: 'binding'; scope: string }
type Row = PageRecord | CrashEvent | Binding;
const STORE = 'records';
const MAX_BYTES = 2 * 1024 * 1024;
export function crashDatabaseName(namespace: string): string { return `__aemeath_crash_v1__:${namespace}`; }
function size(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).length; }
function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(new Error('indexeddb-request-failed')); });
}
/** All read/compare/write decisions run inside one real IDB transaction. */
export class CrashStore {
  private db: IDBDatabase | null = null;
  constructor(private readonly factory: IDBFactory, private readonly namespace: string, private readonly scope: string) {}
  async open(): Promise<void> {
    if (this.db) return;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = this.factory.open(crashDatabaseName(this.namespace), 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
      req.onblocked = () => reject(new Error('indexeddb-blocked'));
      req.onerror = () => reject(new Error('indexeddb-open-failed'));
      let settled = false;
      req.onsuccess = () => { if (settled) { req.result.close(); return; } settled = true; resolve(req.result); };
      const fail = req.onblocked;
      req.onblocked = event => { settled = true; fail?.call(req, event); };
    });
    this.db = db;
    db.onversionchange = () => this.close();
    try {
      await this.change(rows => {
        const binding = rows.find(row => row.kind === 'binding') as Binding | undefined;
        if (binding && binding.scope !== this.scope) throw new Error('delivery-scope-mismatch');
        rows.push(...(!binding ? [{ key: 'binding' as const, kind: 'binding' as const, scope: this.scope }] : []));
        // The same committed transaction proves write/read/delete access, not just presence of indexedDB.
        return undefined;
      }, true);
    } catch (error) { this.close(); throw error; }
  }
  close(): void { this.db?.close(); this.db = null; }
  private async change<T>(update: (rows: Row[]) => T, probe = false): Promise<T> {
    const db = this.db;
    if (!db) throw new Error('indexeddb-closed');
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      let result: T;
      let failure: unknown;
      const all = store.getAll();
      all.onsuccess = () => {
        try {
          const rows: Row[] = all.result;
          const existing = new Map(rows.map(row => [row.key, JSON.stringify(row)]));
          const now = Date.now();
          for (let index = rows.length - 1; index >= 0; index--) {
            const row = rows[index]!;
            if (row.kind !== 'binding' && now - (row.kind === 'page' ? row.seen : row.created) > TTL_MS) rows.splice(index, 1);
          }
          result = update(rows);
          // Reclaim terminal/suppressed page history first. Never evict a current
          // visible observer or an undelivered event to make a new write fit.
          const excess = rows.filter(row => row.kind === 'page').length - 100;
          if (excess > 0) {
            const reclaimable = rows.filter((row): row is PageRecord => row.kind === 'page' && (row.state === 'ended' || row.state === 'unknown' || (row.state !== 'visible' && now - row.seen > WARMUP_MS))).sort((a, b) => a.seen - b.seen);
            for (const old of reclaimable.slice(0, excess)) rows.splice(rows.indexOf(old), 1);
          }
          const completed = rows.filter((row): row is CrashEvent => row.kind === 'event' && !!row.prepared && row.prepared.every(entry => row.acknowledged.includes(entry.logId))).sort((a, b) => a.created - b.created);
          while ((rows.filter(row => row.kind === 'event').length > 100 || size(rows) > MAX_BYTES) && completed.length) rows.splice(rows.indexOf(completed.shift()!), 1);
          if (rows.filter(row => row.kind === 'page').length > 100 || rows.filter(row => row.kind === 'event').length > 100 || size(rows) > MAX_BYTES) throw new Error('storage-budget-exceeded');
          // Transaction serialization fences cooperating tabs. Diff writes avoid
          // rewriting a potentially large prepared outbox for every heartbeat.
          const retained = new Set(rows.map(row => row.key));
          for (const key of existing.keys()) if (!retained.has(key)) store.delete(key);
          for (const row of rows) if (JSON.stringify(row) !== existing.get(row.key)) store.put(row);
          if (probe) {
            store.put({ key: 'probe', value: 1 });
            const read = store.get('probe');
            read.onsuccess = () => { if (read.result?.value !== 1) tx.abort(); else store.delete('probe'); };
          }
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(result!);
      tx.onabort = () => reject(failure ?? new Error('indexeddb-transaction-failed'));
      tx.onerror = () => { /* onabort owns completion */ };
    });
  }
  async savePage(page: PageRecord): Promise<void> {
    await this.change(rows => {
      const index = rows.findIndex(row => row.key === page.key);
      if (index < 0) rows.push(page); else rows[index] = page;
    });
  }
  async pages(): Promise<PageRecord[]> {
    const db = this.db;
    if (!db) throw new Error('indexeddb-closed');
    return (await request(db.transaction(STORE).objectStore(STORE).getAll())).filter((row: Row): row is PageRecord => row.kind === 'page');
  }
  async recover(candidate: PageRecord, now: number): Promise<boolean> {
    return this.change(rows => {
      const page = rows.find(row => row.key === candidate.key) as PageRecord | undefined;
      if (!page || page.state !== 'visible' || page.beats < 2 || page.seen !== candidate.seen || page.revision !== candidate.revision || now - page.seen < WARMUP_MS || now - page.seen > TTL_MS || page.seen < page.eligibleAfter || page.mainSeen < page.eligibleAfter) return false;
      const id = `${page.id}:suspected-crash:1`;
      const key = `event:${id}`;
      if (!rows.some(row => row.key === key)) rows.push({
        key, kind: 'event', id, pageId: page.id, timestamp: page.mainSeen, created: now,
        checkpoint: page.checkpoint, breadcrumbs: page.breadcrumbs, release: page.release,
        environment: page.environment, acknowledged: [], nextEligibleAt: now, attempts: 0,
      });
      // The page tombstone prevents regeneration; completed event history may be
      // reclaimed under pressure, while undelivered events remain until TTL.
      page.state = 'unknown';
      return true;
    });
  }
  async claim(now: number, token: string): Promise<ClaimedEvent[]> {
    return this.change(rows => {
      const claimed: ClaimedEvent[] = [];
      for (const row of rows) {
        if (row.kind !== 'event' || row.nextEligibleAt > now || (row.lease && row.lease.until > now)) continue;
        if (row.prepared && row.prepared.every(entry => row.acknowledged.includes(entry.logId))) continue;
        row.lease = { token, until: now + LEASE_MS };
        // Return detached snapshots; persisted lease remains a plain record.
        claimed.push({ event: JSON.parse(JSON.stringify(row)), token });
        if (claimed.length === 10) break;
      }
      return claimed;
    });
  }
  async update(id: string, token: string, operation: string, data?: unknown): Promise<boolean | number> {
    return this.change(rows => {
      const event = rows.find(row => row.key === `event:${id}`) as CrashEvent | undefined;
      const now = Date.now();
      if (!event || event.lease?.token !== token || event.lease.until <= now) return false;
      if (operation === 'prepare') {
        if (!event.prepared) event.prepared = data as LogEntry[];
      } else if (operation === 'filter') {
        event.prepared = [];
      } else if (operation === 'ack' || operation === 'terminal') {
        if (typeof data !== 'string' || !event.prepared?.some(entry => entry.logId === data)) return false;
        if (!event.acknowledged.includes(data)) event.acknowledged.push(data);
      } else if (operation === 'attempt') {
        event.attempts++;
        event.lease.until = now + LEASE_MS;
        return event.attempts;
      } else if (operation === 'renew') event.lease.until = now + LEASE_MS;
      else if (operation === 'retry' || operation === 'schedule' || operation === 'park') {
        const update = data as { nextEligibleAt?: number; serverNotBefore?: number };
        event.nextEligibleAt = Math.max(now + 1000, update.nextEligibleAt ?? 0, update.serverNotBefore ?? 0);
        // Scheduled hot retries retain ownership; cold retries/parking return it.
        if (operation === 'schedule') event.lease.until = Math.max(now + LEASE_MS, event.nextEligibleAt + LEASE_MS);
        else delete event.lease;
      } else return false;
      return true;
    });
  }
  async clear(page?: PageRecord): Promise<void> {
    await this.change(rows => {
      if (page && rows.some(row => row.kind === 'page' && row.id !== page.id &&
        ((row.state === 'visible' && Date.now() - row.seen < WARMUP_MS) ||
          ['hidden', 'frozen', 'bfcache'].includes(row.state)))) throw new Error('storage-in-use');
      rows.splice(0, rows.length, { key: 'binding', kind: 'binding', scope: this.scope }, ...(page ? [page] : []));
    });
  }
}
