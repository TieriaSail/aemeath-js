import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
interface Harness {
  start(namespace: string, options?: Record<string, unknown>): Promise<{ state: string; reason?: string }>;
  seed(namespace: string, rows: unknown[]): Promise<void>;
  rows(namespace: string): Promise<Array<Record<string, unknown>>>;
  logs: Array<{ logId: string; release?: string; context?: Record<string, unknown>; error?: unknown }>;
  attempts: Array<{ logId: string; at: number }>;
  snapshots: Array<{ prepared?: unknown[] }>;
  completionEvents: string[];
  commitStops: Array<{ operation: string; completionEvents: string[]; state: string }>;
  readonly hookCalls: number;
  readonly checkpointCalls: number;
  readonly maxCheckpointDepth: number;
  getStatus(): { state: string; reason?: string };
  stop(): boolean;
  clear(): Promise<{ cleared: boolean }>;
  clearPair(): Promise<{ shared: boolean; results: Array<{ cleared: boolean }> }>;
  leaveInRoute(): void;
  uploadStatus(): { paused: boolean; consecutiveFailures: number };
  settleUpload(): Promise<void>;
  business(): Promise<boolean>;
  remountWithOldWorkerError(): Promise<{ state: string; reason?: string }>;
  switchDestination(): Promise<{ scope: string; status: { state: string; reason?: string }; uploaded: number }>;
  queuedIds(): string[];
  admitOrdinary(): { logId: string; pending: boolean };
}
declare global { interface Window { crashHarness: Harness } }
let server: Server, origin: string;
const directory = resolve('.release-candidate/crash-consumers');
test.beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/business-api') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
    const path = resolve(directory, `.${decodeURIComponent(url.pathname)}`, url.pathname.endsWith('/') ? 'index.html' : '');
    if (!path.startsWith(`${directory}${sep}`)) { res.writeHead(403); res.end(); return; }
    try {
      const body = readFileSync(path);
      const headers: Record<string, string> = { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self'", 'Content-Type': ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' } as Record<string, string>)[extname(path)] || 'application/octet-stream' };
      if (url.searchParams.has('blockWorker')) headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; worker-src 'none'; connect-src 'self'";
      res.writeHead(200, headers); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing fixture server'); origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())); });
for (const builder of ['vite', 'webpack', 'rsbuild']) {
  test(`crash packed production consumer: ${builder}`, async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/${builder}/`);
    await expect.poll(() => page.evaluate(() => typeof window.crashHarness)).toBe('object');
    expect(await page.evaluate(() => window.crashHarness.start('consumer-native'))).toMatchObject({ state: 'active' });
    expect(await page.evaluate(() => window.crashHarness.business())).toBe(true);
    expect(await page.evaluate(() => window.crashHarness.clear())).toEqual({ cleared: true });
    expect(await page.evaluate(() => window.crashHarness.stop())).toBe(true);
    expect(errors).toEqual([]);
  });
}
test('crash recovery: visible stale record and hidden suppression', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`${origin}/vite/`); await page.waitForFunction(() => !!window.crashHarness);
  await page.evaluate(async () => {
    const now = Date.now(), h = window.crashHarness;
    const record = (id: string, state: string) => ({ key: `page:${id}`, kind: 'page', id, state, started: now - 200_000, seen: now - 60_000, mainSeen: now - 60_000, revision: 8, beats: 8, eligibleAfter: now - 120_000, checkpoint: { routeKey: 'old-route' }, breadcrumbs: [], release: 'old-release' });
    await h.seed('recovery-native', [record('stale-visible', 'visible'), record('stale-hidden', 'hidden'), record('normal-leave', 'ended')]);
    await h.start('recovery-native');
  });
  await expect.poll(() => page.evaluate(() => window.crashHarness.logs.length), { timeout: 65_000, intervals: [1000] }).toBe(1);
  const result = await page.evaluate(() => ({ log: window.crashHarness.logs[0], calls: window.crashHarness.hookCalls, snapshots: window.crashHarness.snapshots }));
  expect(result.log).toMatchObject({ logId: 'stale-visible:suspected-crash:1', release: 'old-release' });
  expect(result.log?.context?.user).toBeUndefined(); expect(result.log?.error).toBeUndefined(); expect(result.calls).toBe(1);
  expect(result.snapshots[0]?.prepared).toHaveLength(1);
});
test('crash delivery: prepared replay keeps identity and retry boundary', async ({ page }) => {
  await page.goto(`${origin}/webpack/`); await page.waitForFunction(() => !!window.crashHarness);
  await page.evaluate(async () => {
    const now = Date.now(); await window.crashHarness.seed('replay-native', [{ key: 'event:replay-event', kind: 'event', id: 'replay-event', pageId: 'previous', timestamp: now - 60_000, created: now - 30_000, checkpoint: {}, breadcrumbs: [], acknowledged: [], nextEligibleAt: now, attempts: 0, prepared: [{ logId: 'original-log-id', level: 'warn', message: 'already sanitized', timestamp: now - 60_000, release: 'original-release' }] }]);
    await window.crashHarness.start('replay-native', { failFirst: true });
  });
  await expect.poll(() => page.evaluate(() => window.crashHarness.logs.length), { timeout: 15_000 }).toBe(1);
  const result = await page.evaluate(() => ({ attempts: window.crashHarness.attempts, calls: window.crashHarness.hookCalls, logs: window.crashHarness.logs }));
  expect(result.calls).toBe(0); expect(result.attempts).toHaveLength(2);
  expect(result.attempts[1]!.at - result.attempts[0]!.at).toBeGreaterThanOrEqual(2000);
  expect(result.logs[0]).toMatchObject({ logId: 'original-log-id', release: 'original-release' });
});
test('crash privacy: asynchronous hooks stay isolated', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  for (const kind of ['rejected', 'entry-shaped', 'rejected-fanout', 'entry-shaped-fanout']) {
    await page.goto(`${origin}/vite/`); await page.waitForFunction(() => !!window.crashHarness);
    const namespace = `async-after-${kind}`;
    await page.evaluate(async ({ namespace, kind }) => {
      const now = Date.now();
      await window.crashHarness.seed(namespace, [{ key: 'event:async', kind: 'event', id: 'async', pageId: 'old', timestamp: now - 60_000, created: now, checkpoint: {}, breadcrumbs: [], acknowledged: [], nextEligibleAt: now, attempts: 0 }]);
      await window.crashHarness.start(namespace, { asyncAfterLog: kind });
    }, { namespace, kind });
    await expect.poll(() => page.evaluate(() => window.crashHarness.getStatus())).toMatchObject({ state: 'disabled', reason: 'observation-rejected' });
    expect(await page.evaluate(() => window.crashHarness.attempts)).toEqual([]);
    const event = await page.evaluate(async namespace => (await window.crashHarness.rows(namespace)).find(row => row.kind === 'event'), namespace);
    expect(event?.prepared).toBeUndefined(); expect(event?.acknowledged).toEqual([]);
    expect(await page.evaluate(() => window.crashHarness.switchDestination())).toMatchObject({ scope: 'next-destination', uploaded: 1 });
    expect(await page.evaluate(() => window.crashHarness.business())).toBe(true);
  }
  expect(errors).toEqual([]);
});
test('crash compatibility: worker storage and CSP disable safely', async ({ page }) => {
  await page.goto(`${origin}/rsbuild/`); await page.waitForFunction(() => !!window.crashHarness);
  expect(await page.evaluate(() => window.crashHarness.start('unsupported-storage', { noIdb: true }))).toMatchObject({ state: 'disabled', reason: 'indexeddb-unavailable' });
  expect(await page.evaluate(() => window.crashHarness.business())).toBe(true);
  await page.goto(`${origin}/vite/?blockWorker=1`); await page.waitForFunction(() => !!window.crashHarness);
  const status = await page.evaluate(() => window.crashHarness.start('csp-blocked'));
  expect(status.state).toBe('disabled'); expect(['worker-creation-failed', 'worker-execution-failed']).toContain(status.reason);
  expect(await page.evaluate(() => window.crashHarness.business())).toBe(true);
});
test('crash coordination: two native workers share one event claim', async ({ context }) => {
  const a = await context.newPage(), b = await context.newPage();
  await a.goto(`${origin}/vite/`); await b.goto(`${origin}/vite/`);
  await a.waitForFunction(() => !!window.crashHarness); await b.waitForFunction(() => !!window.crashHarness);
  await a.evaluate(async () => { const now = Date.now(); await window.crashHarness.seed('two-tabs', [{ key: 'event:shared', kind: 'event', id: 'shared', pageId: 'old', timestamp: now - 60_000, created: now, checkpoint: {}, breadcrumbs: [], acknowledged: [], nextEligibleAt: now, attempts: 0 }]); });
  await Promise.all([a.evaluate(() => window.crashHarness.start('two-tabs')), b.evaluate(() => window.crashHarness.start('two-tabs'))]);
  await expect.poll(async () => (await a.evaluate(() => window.crashHarness.logs.length)) + (await b.evaluate(() => window.crashHarness.logs.length))).toBe(1);
  const rows = await a.evaluate(() => window.crashHarness.rows('two-tabs'));
  expect(rows.filter(row => row.kind === 'event')).toHaveLength(1);
  expect(await a.evaluate(() => window.crashHarness.clear())).toMatchObject({ cleared: false, reason: 'storage-in-use' });
});
test('crash host isolation: reentry and destination switching', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/vite/`); await page.waitForFunction(() => !!window.crashHarness);
  expect(await page.evaluate(() => window.crashHarness.start('factory-stop', { factoryStops: true }))).toMatchObject({ state: 'stopped' });
  expect(await page.evaluate(() => window.crashHarness.business())).toBe(true);
  await page.goto(`${origin}/rsbuild/`); await page.waitForFunction(() => !!window.crashHarness);
  expect(await page.evaluate(() => window.crashHarness.start('factory-async', { asyncFactory: true }))).toMatchObject({ state: 'disabled', reason: 'invalid-dedicated-worker' });
  expect(await page.evaluate(() => window.crashHarness.business())).toBe(true);
  await page.goto(`${origin}/webpack/`); await page.waitForFunction(() => !!window.crashHarness);
  expect(await page.evaluate(() => window.crashHarness.start('host-isolation', { checkpointEvents: true }))).toMatchObject({ state: 'active' });
  expect(await page.evaluate(() => window.crashHarness.checkpointCalls)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.crashHarness.maxCheckpointDepth)).toBe(1);
  await expect.poll(() => page.evaluate(async () => (await window.crashHarness.rows('host-isolation')).find(row => row.kind === 'page')?.state)).toBe('frozen');
  expect(await page.evaluate(() => window.crashHarness.remountWithOldWorkerError())).toMatchObject({ state: 'active' });
  expect(await page.evaluate(() => window.crashHarness.switchDestination())).toMatchObject({ scope: 'next-destination', status: { state: 'disabled', reason: 'delivery-scope-changed' }, uploaded: 1 });
  expect(await page.evaluate(() => window.crashHarness.business())).toBe(true);
  expect(errors).toEqual([]);
});
test('crash admission: ordinary logs retain queue capacity', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/rsbuild/`); await page.waitForFunction(() => !!window.crashHarness);
  await page.evaluate(async () => {
    const now = Date.now();
    await window.crashHarness.seed('queue-capacity', [{ key: 'event:capacity', kind: 'event', id: 'capacity', pageId: 'old', timestamp: now - 60_000, created: now, checkpoint: {}, breadcrumbs: [], acknowledged: [], nextEligibleAt: now, attempts: 0, prepared: [{ logId: 'crash-capacity', level: 'warn', message: 'prepared', timestamp: now - 60_000 }] }]);
    await window.crashHarness.start('queue-capacity', { maxSize: 1, pauseQueue: true });
  });
  await expect.poll(() => page.evaluate(() => window.crashHarness.queuedIds())).toEqual(['crash-capacity']);
  const ordinary = await page.evaluate(() => window.crashHarness.admitOrdinary());
  expect(ordinary.pending).toBe(true);
  expect(await page.evaluate(() => window.crashHarness.queuedIds())).toEqual([ordinary.logId]);
  const event = (await page.evaluate(() => window.crashHarness.rows('queue-capacity'))).find(row => row.kind === 'event');
  expect(event?.acknowledged).toEqual([]); expect(event?.prepared).toHaveLength(1);
  expect(await page.evaluate(() => window.crashHarness.business())).toBe(true);
  expect(errors).toEqual([]);
});
test('crash worker error: monitoring failure stays isolated', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/vite/`); await page.waitForFunction(() => !!window.crashHarness);
  expect(await page.evaluate(() => window.crashHarness.start('worker-runtime-failure', { workerThrows: true }))).toMatchObject({ state: 'disabled', reason: 'worker-execution-failed' });
  expect(await page.evaluate(() => window.crashHarness.business())).toBe(true);
  // A real business callback still throws its original object and reaches the
  // host's own handler. Only this intentional control is cancelled by the test.
  expect(await page.evaluate(() => new Promise<boolean>(resolveControl => {
    const original = new Error('intentional business exception');
    const observe = (event: ErrorEvent): void => {
      if (event.error !== original) return;
      event.preventDefault(); window.removeEventListener('error', observe); resolveControl(true);
    };
    window.addEventListener('error', observe);
    setTimeout(() => { throw original; }, 0);
  }))).toBe(true);
  expect(await page.evaluate(() => window.crashHarness.business())).toBe(true);
  expect(errors).toEqual([]);
});

test('crash lifecycle: initialization and concurrent clear retain ordering', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/vite/`); await page.waitForFunction(() => !!window.crashHarness);
  expect(await page.evaluate(() => window.crashHarness.start('initial-route-leave', { initialRouteLeave: true }))).toMatchObject({ state: 'active' });
  await expect.poll(() => page.evaluate(async () => (await window.crashHarness.rows('initial-route-leave')).find(row => row.kind === 'page')?.state)).toBe('ended');
  expect(await page.evaluate(() => window.crashHarness.business())).toBe(true);
  await page.goto(`${origin}/webpack/`); await page.waitForFunction(() => !!window.crashHarness);
  expect(await page.evaluate(() => window.crashHarness.start('concurrent-clear'))).toMatchObject({ state: 'active' });
  expect(await page.evaluate(() => window.crashHarness.clearPair())).toEqual({ shared: true, results: [{ cleared: true }, { cleared: true }] });
  await page.evaluate(() => window.crashHarness.leaveInRoute());
  await expect.poll(() => page.evaluate(async () => (await window.crashHarness.rows('concurrent-clear')).find(row => row.kind === 'page')?.state)).toBe('ended');
  expect(await page.evaluate(() => window.crashHarness.business())).toBe(true);
  expect(errors).toEqual([]);
});

test('crash delivery: cancellation and destination changes preserve business', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  for (const scenario of ['queued', 'in-flight', 'cancel-attempt']) {
    await page.goto(`${origin}/rsbuild/`); await page.waitForFunction(() => !!window.crashHarness);
    const ns = `destination-${scenario}`;
    await page.evaluate(async ({ namespace, scenario }) => {
      const now = Date.now();
      await window.crashHarness.seed(namespace, [{ key: 'event:optional', kind: 'event', id: 'optional', pageId: 'old', timestamp: now - 60_000, created: now, checkpoint: {}, breadcrumbs: [], acknowledged: [], nextEligibleAt: now, attempts: 0 }]);
      await window.crashHarness.start(namespace, { pauseQueue: scenario === 'queued', holdUpload: scenario === 'in-flight', cancelAttempt: scenario === 'cancel-attempt' });
    }, { namespace: ns, scenario });
    if (scenario === 'cancel-attempt') {
      await expect.poll(() => page.evaluate(() => window.crashHarness.getStatus().state)).toBe('stopped');
      expect(await page.evaluate(() => window.crashHarness.attempts)).toEqual([]);
    } else {
      if (scenario === 'queued') await expect.poll(() => page.evaluate(() => window.crashHarness.queuedIds())).toHaveLength(1);
      else await expect.poll(() => page.evaluate(() => window.crashHarness.attempts)).toHaveLength(1);
      expect(await page.evaluate(() => window.crashHarness.switchDestination())).toMatchObject({ scope: 'next-destination', status: { state: 'disabled', reason: 'delivery-scope-changed' }, uploaded: 1 });
      expect(await page.evaluate(() => window.crashHarness.uploadStatus())).toMatchObject({ paused: false, consecutiveFailures: 0 });
      expect(await page.evaluate(() => window.crashHarness.logs[0]?.context?.crash)).toBeUndefined();
    }
    const record = (await page.evaluate(namespace => window.crashHarness.rows(namespace), ns)).find(row => row.kind === 'event');
    expect(record?.acknowledged).toEqual([]); expect(record?.prepared).toHaveLength(1);
    expect(await page.evaluate(() => window.crashHarness.business())).toBe(true);
  }
  expect(errors).toEqual([]);
});

test('crash receipt: committed responses respect producer lifetime', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  for (const operation of ['ack', 'terminal', 'park', 'schedule', 'retry']) {
    await page.goto(`${origin}/webpack/`); await page.waitForFunction(() => !!window.crashHarness);
    const namespace = `commit-${operation}`;
    await page.evaluate(async ({ namespace, operation }) => {
      const now = Date.now();
      await window.crashHarness.seed(namespace, [{ key: 'event:commit', kind: 'event', id: 'commit', pageId: 'old', timestamp: now - 60_000, created: now, checkpoint: {}, breadcrumbs: [], acknowledged: [], nextEligibleAt: now, attempts: 0 }]);
      await window.crashHarness.start(namespace, { commitOperation: operation, stopAfterCommit: operation });
    }, { namespace, operation });
    await expect.poll(() => page.evaluate(() => window.crashHarness.getStatus().state)).toBe('stopped');
    await page.evaluate(() => window.crashHarness.settleUpload());
    expect(await page.evaluate(() => window.crashHarness.commitStops)).toEqual([{ operation, completionEvents: [], state: 'active' }]);
    expect(await page.evaluate(() => window.crashHarness.completionEvents)).toEqual([]);
    expect(await page.evaluate(() => window.crashHarness.uploadStatus().paused)).toBe(false);
    const row = (await page.evaluate(ns => window.crashHarness.rows(ns), namespace)).find(row => row.kind === 'event');
    expect(row?.acknowledged).toEqual(operation === 'ack' || operation === 'terminal' ? ['commit'] : []);
    expect(await page.evaluate(() => window.crashHarness.switchDestination())).toMatchObject({ scope: 'next-destination', uploaded: operation === 'ack' ? 2 : 1 });
    expect(await page.evaluate(() => window.crashHarness.business())).toBe(true);
  }
  expect(errors).toEqual([]);
});
