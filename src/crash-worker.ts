import { CrashStore } from './plugins/crash/CrashStore';
import { checkpointSnapshot, breadcrumbSnapshot } from './plugins/crash/privacy';
import { HEARTBEAT_MS, PROTOCOL, WARMUP_MS } from './plugins/crash/types';
import type { CrashRequest, CrashResponse, PageRecord, PageState } from './plugins/crash/types';

type IntervalHandle = ReturnType<typeof setInterval> | number;
interface WorkerScope {
  indexedDB: IDBFactory;
  setInterval?: (fn: () => void, ms: number) => IntervalHandle;
  clearInterval?: (timer: IntervalHandle) => void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown): void;
}
/** Explicit worker entry; importing this module starts no listeners, timers or storage. */
export function initCrashWorker(scope: WorkerScope = globalThis as unknown as WorkerScope): () => void {
  if (typeof document !== 'undefined' && scope === (globalThis as unknown as WorkerScope)) throw new Error('dedicated-worker-required');
  const schedule = scope.setInterval?.bind(scope) ?? setInterval;
  const cancel = scope.clearInterval?.bind(scope) ?? clearInterval;
  let store: CrashStore | undefined;
  let page: PageRecord | undefined;
  let session: string | undefined;
  let timer: IntervalHandle | undefined;
  let tail: Promise<void> = Promise.resolve();
  let stopped = false;
  let ended = false;
  let lastSweep = Date.now();
  let recoveryAfter = lastSweep + WARMUP_MS;
  const candidates = new Map<string, PageRecord>();
  const post = (value: unknown): void => { if (!stopped) scope.postMessage(value); };
  const sweep = async (): Promise<void> => {
    if (stopped || ended || !store || !page || page.state !== 'visible') return;
    const now = Date.now();
    const gap = now - lastSweep;
    lastSweep = now;
    if (gap < 0 || gap > HEARTBEAT_MS * 3) {
      recoveryAfter = now + WARMUP_MS;
      page.eligibleAfter = recoveryAfter;
      page.beats = 0;
      candidates.clear();
    }
    page.seen = now;
    await store.open();
    await store.savePage(page);
    if (now < recoveryAfter) return;
    const pages = await store.pages();
    const present = new Set(pages.map(item => item.id));
    for (const id of candidates.keys()) if (!present.has(id)) candidates.delete(id);
    for (const other of pages) {
      if (other.id === page.id || other.state !== 'visible' || now - other.seen < WARMUP_MS || now < other.seen) { candidates.delete(other.id); continue; }
      const previous = candidates.get(other.id);
      if (previous && previous.seen === other.seen && previous.revision === other.revision) {
        await store.recover(previous, now);
        candidates.delete(other.id);
      } else candidates.set(other.id, other);
    }
  };
  const enqueue = (work: () => Promise<void>): void => {
    tail = tail.then(() => stopped ? undefined : work()).catch(() => { post({ protocol: PROTOCOL, session, type: 'fatal', reason: 'worker-storage-failed' }); });
  };
  const startTimer = (): void => {
    if (stopped || ended || timer || !page || (page.state !== 'visible' && page.state !== 'unknown')) return;
    timer = schedule(() => {
      enqueue(async () => { await sweep(); if (page?.state === 'visible' || page?.state === 'unknown') post({ protocol: PROTOCOL, session, type: 'tick' }); });
    }, HEARTBEAT_MS);
  };
  const pauseTimer = (): void => { if (timer) cancel(timer); timer = undefined; };
  const onMessage = (event: MessageEvent): void => {
    const req = event.data as CrashRequest;
    if (!req || req.protocol !== PROTOCOL || typeof req.session !== 'string' || !Number.isSafeInteger(req.id) || typeof req.op !== 'string') return;
    if (session && req.session !== session) return;
    enqueue(async () => {
      const response: CrashResponse = { protocol: PROTOCOL, session: req.session, id: req.id, ok: false };
      try {
        if (ended) throw new Error('worker-stopped');
        if (req.op === 'init') {
          if (session) throw new Error('worker-already-initialized');
          session = req.session;
          const data = req.data as { namespace: string; deliveryScope: string; pageId: string; state: PageState; release?: string; environment?: string };
          if (!data || !/^[a-zA-Z0-9_.-]{1,80}$/.test(data.namespace) || !data.deliveryScope || !data.pageId) throw new Error('invalid-config');
          if (!scope.indexedDB) throw new Error('indexeddb-unavailable');
          if (typeof TextEncoder !== 'function') throw new Error('text-encoder-unavailable');
          store = new CrashStore(scope.indexedDB, data.namespace, data.deliveryScope);
          await store.open();
          const now = Date.now();
          page = { key: `page:${data.pageId}`, kind: 'page', id: data.pageId, state: data.state === 'visible' ? 'visible' : 'hidden', started: now, seen: now, mainSeen: now, revision: 0, eligibleAfter: now + WARMUP_MS, beats: 0, checkpoint: {}, breadcrumbs: [], release: data.release, environment: data.environment };
          await store.savePage(page);
          startTimer();
          response.data = { indexedDB: true };
        } else {
          if (!store || !page) throw new Error('worker-not-initialized');
          await store.open();
          const data = req.data as Record<string, unknown>;
          if (req.op === 'beat') {
            const now = Date.now();
            const state = data['state'] as PageState;
            if (!['visible', 'hidden', 'frozen', 'bfcache', 'ended', 'unknown'].includes(state)) throw new Error('invalid-lifecycle');
            if (state === 'visible' && page.state !== 'visible') { page.eligibleAfter = now + WARMUP_MS; page.beats = 0; recoveryAfter = now + WARMUP_MS; candidates.clear(); lastSweep = now; }
            page.state = state;
            if (state === 'visible' || state === 'unknown') startTimer(); else pauseTimer();
            page.seen = now;
            page.mainSeen = now;
            page.revision++;
            page.beats++;
            page.checkpoint = checkpointSnapshot(data['checkpoint']);
            const breadcrumbs = data['breadcrumbs'];
            if (Array.isArray(breadcrumbs)) page.breadcrumbs = breadcrumbs.slice(-20).flatMap(item => { const clean = breadcrumbSnapshot(item); return clean ? [{ ...clean, timestamp: typeof item.timestamp === 'number' ? item.timestamp : now }] : []; });
            await store.savePage(page);
          } else if (req.op === 'claim') response.data = await store.claim(Date.now(), String(data['token']));
          else if (req.op === 'update') response.data = await store.update(String(data['id']), String(data['token']), String(data['operation']), data['value']);
          else if (req.op === 'clear') { page.eligibleAfter = Date.now() + WARMUP_MS; page.beats = 0; candidates.clear(); await store.clear(page); }
          else if (req.op === 'stop') { ended = true; pauseTimer(); page.state = 'ended'; page.seen = Date.now(); await store.savePage(page); }
          else throw new Error('unknown-worker-operation');
        }
        response.ok = true;
      } catch (error) { response.reason = error instanceof Error ? error.message : 'worker-storage-failed'; }
      finally { if (page?.state !== 'visible' || req.op === 'stop') store?.close(); }
      post(response);
    });
  };
  scope.addEventListener('message', onMessage);
  return () => { stopped = true; scope.removeEventListener('message', onMessage); if (timer) cancel(timer); store?.close(); };
}
