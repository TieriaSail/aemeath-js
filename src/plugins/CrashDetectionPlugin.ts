import { ignoreAsyncResult } from '../utils/ignoreAsyncResult';
import { LogLevel } from '../types';
import type { AemeathInterface, AemeathPlugin } from '../types';
import { observationMetadata, observationPreparation } from '../core/observation';
import type { ObservationHost } from '../core/observation';
import { runWithoutConsoleCapture } from '../utils/consoleCaptureGuard';
import { RouteMatcher } from '../utils/routeMatcher';
import type { UploadPlugin, DurableDeliveryReceipt, DurableDeliveryUpdate } from './UploadPlugin';
import { WorkerClient } from './crash/WorkerClient';
import { breadcrumbSnapshot, checkpointSnapshot } from './crash/privacy';
import type { ClaimedEvent, CrashBreadcrumb, CrashDetectionOptions, CrashStatus, PageState } from './crash/types';
export type { CrashBreadcrumb, CrashCheckpoint, CrashDetectionOptions, CrashMode, CrashStatus } from './crash/types';

interface Resources { owners: Map<string, object>; warnings: Set<string>; workers: WeakSet<object> }
function discardUnclaimedWorker(worker: unknown, resource: Resources): void {
  try {
    if (worker && !resource.workers.has(worker as object)) (worker as Worker).terminate();
  } catch { /* invalid/cancelled factories cannot break host cleanup */ }
}
const resourceKey = Symbol.for('aemeath.crash-document-resources.v1');
function resources(document: Document): Resources {
  const descriptor = Object.getOwnPropertyDescriptor(document, resourceKey);
  if (descriptor) { if (!('value' in descriptor)) throw new Error('resource-registry-unavailable'); return descriptor.value as Resources; }
  const value: Resources = { owners: new Map(), warnings: new Set(), workers: new WeakSet() };
  Object.defineProperty(document, resourceKey, { value });
  return value;
}
function randomId(): string {
  const bytes = new Uint32Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, n => n.toString(16).padStart(8, '0')).join('');
}
/** Opt-in browser recovery only. No prototype hooks or default SDK registration. */
export class CrashDetectionPlugin implements AemeathPlugin {
  readonly name = 'crash-detection';
  readonly version = '1.0.0';
  private logger: AemeathInterface | null = null;
  private client: WorkerClient | null = null;
  private upload: UploadPlugin | null = null;
  private matcher: RouteMatcher | null = null;
  private generation = 0;
  private resolving: ((status: CrashStatus) => void) | null = null;
  private readiness: Promise<CrashStatus>;
  private status: CrashStatus | undefined;
  private resource: Resources | null = null;
  private resourceToken: object | null = null;
  private releaseScope: (() => void) | null = null;
  private listeners: Array<() => void> = [];
  private breadcrumbs: Array<CrashBreadcrumb & { timestamp: number }> = [];
  private busy = false;
  private clearing = false;
  private clearTask: Promise<{ cleared: boolean; reason?: string }> | null = null;
  private initialized = false;
  private lifecycleState: PageState | null = null;
  private lifecycleRevision = 0;
  private tickDone: Promise<void> = Promise.resolve();
  private finishTick: (() => void) | null = null;
  private checkpointAt = -Infinity;
  private collectingCheckpoint = false;
  private pendingCheckpointState: PageState | null = null;
  private matchingRoute = false;
  private addingBreadcrumb = false;
  private checkpoint: import('./crash/types').CrashCheckpoint = {};
  private readonly receipts = new Map<string, DurableDeliveryReceipt>();
  private readonly options: CrashDetectionOptions;
  constructor(options: CrashDetectionOptions) {
    try {
      const snapshot = { ...options };
      this.options = { ...snapshot, checkpoint: snapshot.checkpoint ? { ...snapshot.checkpoint } : undefined };
    } catch { this.options = {} as CrashDetectionOptions; }
    this.readiness = Promise.resolve(this.getStatus());
  }
  getStatus(): CrashStatus {
    const status = this.status ?? { state: 'idle' as const, requestedMode: this.options?.mode ?? 'recovery', mode: 'none' as const, implementedModes: ['recovery'] as const, capabilities: { worker: false, indexedDB: false, lifecycle: false } };
    return { ...status, implementedModes: ['recovery'], capabilities: { ...status.capabilities } };
  }
  ready(): Promise<CrashStatus> { return this.readiness.then(() => this.getStatus()); }
  install(logger: AemeathInterface): void {
    this.logger = logger;
    const epoch = ++this.generation;
    this.status = { ...this.getStatus(), state: 'starting', mode: 'none', reason: undefined };
    this.readiness = new Promise(resolve => { this.resolving = resolve; });
    // Logger must commit registration before granting its optional capability.
    void Promise.resolve().then(() => this.start(epoch)).catch(error => { if (epoch === this.generation) this.disable(error instanceof Error ? error.message : 'initialization-failed'); });
  }
  private settle(): void { const resolve = this.resolving; this.resolving = null; resolve?.(this.getStatus()); }
  private warn(reason: string): void {
    const key = `${this.options?.namespace}:${reason}`;
    try {
      const registry = this.resource ?? (typeof document !== 'undefined' ? resources(document) : null);
      if (registry?.warnings.has(key)) return;
      registry?.warnings.add(key);
      runWithoutConsoleCapture(() => console.warn(`[Aemeath] CrashDetectionPlugin disabled (${reason}).`));
    } catch { /* optional monitoring diagnostics cannot break host work */ }
  }
  private disable(reason: string, warning = true): void {
    if (this.status?.state === 'stopped' || this.status?.state === 'disabled') return;
    this.status = { ...this.getStatus(), state: 'disabled', mode: 'none', reason };
    this.settle(); this.cleanup();
    // Diagnostics may synchronously uninstall/reinstall us. Do not mutate this
    // generation's state after invoking that external code.
    if (warning) this.warn(reason);
  }
  private async start(epoch: number): Promise<void> {
    if (epoch !== this.generation || !this.logger) return;
    const options = this.options;
    if (options.enabled === false) { this.disable('configured-disabled', false); return; }
    if (!['recovery', 'realtime', 'hybrid'].includes(options.mode ?? 'recovery') || (typeof options.namespace !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(options.namespace)) || typeof options.deliveryScope !== 'string' || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(options.deliveryScope) || typeof options.createWorker !== 'function' || (options.sampleRate !== undefined && (!Number.isFinite(options.sampleRate) || options.sampleRate < 0 || options.sampleRate > 1))) { this.disable('invalid-config'); return; }
    if ((options.mode ?? 'recovery') !== 'recovery') { this.disable('feature-not-implemented'); return; }
    if (options.realtime !== undefined) { this.disable('configuration-conflict'); return; }
    if (Math.random() >= (options.sampleRate ?? 1)) { this.disable('sampled-out', false); return; }
    if (typeof window === 'undefined' || typeof document === 'undefined') { this.disable('browser-environment-required'); return; }
    const capabilities = this.status!.capabilities;
    capabilities.worker = typeof Worker === 'function';
    capabilities.lifecycle = typeof window.addEventListener === 'function' && typeof document.addEventListener === 'function' && typeof document.visibilityState === 'string';
    if (!capabilities.worker) { this.disable('dedicated-worker-unavailable'); return; }
    if (!capabilities.lifecycle) { this.disable('lifecycle-api-unavailable'); return; }
    if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') { this.disable('crypto-api-unavailable'); return; }
    const logger = this.logger;
    const host = logger as unknown as ObservationHost;
    if (typeof host[observationPreparation] !== 'function' || typeof host[observationMetadata] !== 'function') { this.disable('observation-port-unavailable'); return; }
    if (!logger.hasPlugin('upload') || !logger.hasPlugin('offline-persistence')) { this.disable('missing-delivery-dependencies'); return; }
    const upload = logger.getPluginInstance('upload') as UploadPlugin;
    if (typeof upload.reserveDeliveryScope !== 'function' || typeof upload.requeueCoordinated !== 'function') { this.disable('delivery-receipt-unavailable'); return; }
    this.releaseScope = upload.reserveDeliveryScope(options.deliveryScope, () => { if (epoch === this.generation) this.disable('delivery-scope-changed'); });
    if (!this.releaseScope) { this.disable('delivery-scope-mismatch'); return; }
    this.upload = upload;
    this.resource = resources(document);
    if (this.resource.owners.has(options.namespace)) { this.disable('monitor-resource-in-use'); return; }
    this.resourceToken = {};
    this.resource.owners.set(options.namespace, this.resourceToken);
    this.matcher = RouteMatcher.compose(logger.routeMatcher, options.routeMatch);
    const metadata = host[observationMetadata](this);
    if (!metadata) { this.disable('observation-port-unavailable'); return; }
    const resource = this.resource;
    let worker: Worker;
    try {
      worker = options.createWorker();
      const then = (worker as unknown as { then?: unknown } | null)?.then;
      if (typeof then === 'function') {
        // The factory must be synchronous. Still observe a JS consumer's async
        // result so rejection or a late Worker does not escape our ownership.
        try { Reflect.apply(then, worker, [(value: unknown) => discardUnclaimedWorker(value, resource), () => undefined]); } catch { /* unsupported thenable */ }
        if (epoch === this.generation) this.disable('invalid-dedicated-worker');
        return;
      }
    }
    catch { if (epoch === this.generation) this.disable('worker-creation-failed'); return; }
    if (epoch !== this.generation) {
      // The factory is application code and may synchronously tear us down.
      // Only discard an unclaimed Worker; another monitor may already own it.
      discardUnclaimedWorker(worker, resource);
      return;
    }
    if (!worker || typeof worker.postMessage !== 'function' || typeof worker.terminate !== 'function' || typeof worker.addEventListener !== 'function' || typeof worker.removeEventListener !== 'function') { this.disable('invalid-dedicated-worker'); return; }
    if (this.resource.workers.has(worker)) { this.disable('worker-already-owned'); return; }
    this.resource.workers.add(worker);
    let client: WorkerClient;
    try { client = new WorkerClient(worker, randomId(), () => { void this.tick(epoch); }, reason => { if (epoch === this.generation) this.disable(reason); }); }
    catch { try { worker.terminate(); } catch { /* owned worker cleanup */ } if (epoch === this.generation) this.disable('worker-listener-failed'); return; }
    if (epoch !== this.generation) { client.close(); return; }
    this.client = client;
    this.installLifecycle(epoch);
    const state = this.pageState();
    if (epoch !== this.generation || this.client !== client) return;
    await client.request('init', { namespace: options.namespace, deliveryScope: options.deliveryScope, pageId: randomId(), state, ...metadata });
    if (epoch !== this.generation || this.client !== client) return;
    this.initialized = true;
    this.status = { ...this.getStatus(), state: 'active', mode: 'recovery', capabilities: { ...capabilities, indexedDB: true } };
    await this.beat(this.pageState());
    if (epoch !== this.generation || this.client !== client) return;
    this.settle();
    void this.tick(epoch);
  }
  private pageState(): PageState {
    if (this.matchingRoute) return 'unknown';
    const epoch = this.generation, revision = this.lifecycleRevision; this.matchingRoute = true;
    try {
      const capture = this.matcher?.shouldCapture();
      // A route callback may synchronously emit a later lifecycle event. Its
      // completed observation wins over this older evaluation, including leave.
      if (revision !== this.lifecycleRevision) return this.lifecycleState ?? 'unknown';
      if (!capture) return 'unknown';
      if (this.lifecycleState === 'ended' || this.lifecycleState === 'bfcache' || this.lifecycleState === 'frozen') return this.lifecycleState;
      return document.visibilityState === 'visible' ? 'visible' : 'hidden';
    } finally { if (epoch === this.generation) this.matchingRoute = false; }
  }
  private installLifecycle(epoch: number): void {
    const listen = (target: Window | Document, type: string, fn: (event: Event) => void): void => {
      const listener = (event: Event): void => { try { if (epoch === this.generation) fn(event); } catch { if (epoch === this.generation) this.disable('lifecycle-observation-failed'); } };
      target.addEventListener(type, listener);
      this.listeners.push(() => target.removeEventListener(type, listener));
    };
    const observe = (fixed?: PageState, resumes = false): void => {
      const revision = ++this.lifecycleRevision;
      if (fixed !== undefined) this.lifecycleState = fixed;
      else if (resumes) this.lifecycleState = null;
      const state = fixed ?? this.pageState();
      if (epoch !== this.generation || revision !== this.lifecycleRevision) return;
      this.lifecycleState = state;
      void this.beat(state);
    };
    listen(document, 'visibilitychange', () => observe());
    listen(document, 'freeze', () => observe('frozen'));
    listen(document, 'resume', () => observe(undefined, true));
    listen(window, 'pagehide', event => observe((event as PageTransitionEvent).persisted ? 'bfcache' : 'ended'));
    listen(window, 'pageshow', () => observe(undefined, true));
    const dependency = (...args: unknown[]): void => { if (args[0] === 'upload' || args[0] === 'offline-persistence') this.disable('delivery-dependency-removed'); };
    const logger = this.logger!;
    logger.on('plugin:uninstall', dependency);
    this.listeners.push(() => logger.off('plugin:uninstall', dependency));
  }
  private async beat(state: PageState): Promise<void> {
    const client = this.client;
    if (!client) return;
    // Lifecycle listeners are installed before the handshake to retain exits.
    // Queue their latest state locally; the Worker must always receive init first.
    if (!this.initialized) { this.lifecycleState = state; return; }
    if (this.collectingCheckpoint) { this.pendingCheckpointState = state; return; }
    const epoch = this.generation;
    const isCurrent = (): boolean => epoch === this.generation && this.client === client;
    try {
      const now = Date.now();
      if (state !== 'visible' || now - this.checkpointAt >= 15_000 || now < this.checkpointAt) {
        this.collectingCheckpoint = true;
        try {
          const raw = this.options.checkpoint?.collect?.();
          const asyncRaw = ignoreAsyncResult(raw);
          if (!isCurrent()) return;
          if (asyncRaw) throw new Error('async-checkpoint');
          let checkpoint = checkpointSnapshot(raw);
          if (!isCurrent()) return;
          if (this.options.checkpoint?.sanitize) {
            const sanitized = this.options.checkpoint.sanitize(checkpoint);
            const asyncSanitized = ignoreAsyncResult(sanitized);
            if (!isCurrent()) return;
            if (asyncSanitized) throw new Error('async-checkpoint');
            checkpoint = checkpointSnapshot(sanitized);
          }
          if (!isCurrent()) return;
          this.checkpoint = checkpoint; this.checkpointAt = now;
        } catch { if (isCurrent()) this.disable('checkpoint-callback-failed'); return; }
        finally { if (isCurrent()) this.collectingCheckpoint = false; }
      }
      if (!isCurrent()) return;
      state = this.pendingCheckpointState ?? state; this.pendingCheckpointState = null;
      await client.request('beat', { state, checkpoint: state === 'unknown' ? {} : this.checkpoint, breadcrumbs: state === 'unknown' ? [] : this.breadcrumbs });
    } catch (error) { if (this.client === client) this.disable(error instanceof Error ? error.message : 'checkpoint-failed'); }
  }
  addBreadcrumb(breadcrumb: CrashBreadcrumb): void {
    if (this.addingBreadcrumb) return;
    const epoch = this.generation; this.addingBreadcrumb = true;
    try {
      if (this.status?.state !== 'active' || !this.matcher?.shouldCapture()) return;
      if (epoch !== this.generation) return;
      const clean = breadcrumbSnapshot(breadcrumb);
      if (!clean || epoch !== this.generation) return;
      this.breadcrumbs.push({ ...clean, timestamp: Date.now() });
      if (this.breadcrumbs.length > 20) this.breadcrumbs.shift();
    } catch { if (epoch === this.generation) this.disable('breadcrumb-failed'); }
    finally { if (epoch === this.generation) this.addingBreadcrumb = false; }
  }
  private async tick(epoch: number): Promise<void> {
    if (this.clearing || this.busy || this.status?.state !== 'active' || !this.client || epoch !== this.generation) return;
    this.busy = true;
    this.tickDone = new Promise(resolve => { this.finishTick = resolve; });
    const finish = this.finishTick;
    const client = this.client;
    try {
      await this.beat(this.pageState());
      if (epoch !== this.generation || this.client !== client || this.pageState() !== 'visible') return;
      // Renew receipts retained by Upload's queue and in-flight/parked machinery.
      for (const receipt of this.receipts.values()) if (!receipt.isSettled()) await receipt.renew();
      const claims = await client.request<ClaimedEvent[]>('claim', { token: randomId() });
      for (const claim of claims) {
        if (epoch !== this.generation || this.client !== client) break;
        await this.publish(claim, client);
      }
    } catch (error) { if (this.client === client) this.disable(error instanceof Error ? error.message : 'recovery-failed'); }
    finally { if (epoch === this.generation) this.busy = false; finish?.(); if (this.finishTick === finish) this.finishTick = null; }
  }
  private async publish(claim: ClaimedEvent, client: WorkerClient): Promise<void> {
    const event = claim.event;
    const update = (operation: string, value?: unknown): Promise<boolean | number> => client.request('update', { id: event.id, token: claim.token, operation, value });
    if (!event.prepared) {
      const host = this.logger as unknown as ObservationHost;
      const result = host[observationPreparation](this, {
        logId: event.id, timestamp: event.timestamp, level: LogLevel.WARN, message: 'Previous page may have terminated unexpectedly',
        release: event.release, environment: event.environment,
        options: { tags: { observation: 'suspected-crash', confidence: 'indirect' }, context: { crash: { pageInstanceId: event.pageId, checkpoint: event.checkpoint, breadcrumbs: event.breadcrumbs, detectedAt: event.created } } },
      });
      if (result.state !== 'prepared') {
        if (result.state === 'filtered') await update('filter');
        else throw new Error(`observation-${result.state}`);
        return;
      }
      if (!await update('prepare', result.entries)) throw new Error('observation-persistence-rejected');
      event.prepared = result.entries;
    }
    if (this.client !== client || this.status?.state !== 'active') return;
    const deliveries = event.prepared.filter(entry => !event.acknowledged.includes(entry.logId)).map(log => {
      let settled = false;
      const change = async (op: string, value?: unknown, finish = false): Promise<boolean> => {
        if (receipt.isSettled() || this.upload?.getDeliveryScope() !== this.options.deliveryScope) return false;
        try {
          const result = await update(op, value);
          if (receipt.isSettled()) return false;
          if (finish || result === false) { settled = true; this.receipts.delete(log.logId); }
          return result === true;
        } catch { if (this.client === client) this.disable('delivery-receipt-storage-failed'); return false; }
      };
      const receipt: DurableDeliveryReceipt = {
        logId: log.logId, isSettled: () => settled || this.client !== client || this.status?.state !== 'active' || this.receipts.get(log.logId) !== receipt,
        isOwnerActive: () => this.client === client && this.status?.state === 'active' && this.upload?.getDeliveryScope() === this.options.deliveryScope,
        releaseMemory: () => {
          if (receipt.isSettled()) return;
          settled = true; this.receipts.delete(log.logId);
          // Keep the durable event and its fence. Expiry safely returns it to
          // recovery, including when another fragment is already in flight.
        },
        beginAttempt: async () => {
          if (receipt.isSettled() || this.upload?.getDeliveryScope() !== this.options.deliveryScope) return null;
          try {
            const value = await update('attempt');
            if (receipt.isSettled()) return null;
            if (typeof value === 'number') return value;
            settled = true; this.receipts.delete(log.logId); return null;
          } catch { if (this.client === client) this.disable('delivery-receipt-storage-failed'); return null; }
        },
        renew: () => change('renew'), succeed: () => change('ack', log.logId, true), terminal: () => change('terminal', log.logId, true),
        retry: (value: DurableDeliveryUpdate) => change('retry', value, true),
        retryScheduled: (value: DurableDeliveryUpdate) => change('schedule', value),
        park: (value: DurableDeliveryUpdate) => change('park', value, true),
      };
      this.receipts.set(log.logId, receipt);
      return { log, source: 'durable-observation' as const, receipt };
    });
    await this.upload!.requeueCoordinated(deliveries);
  }
  clearStoredData(): Promise<{ cleared: boolean; reason?: string }> {
    if (this.clearTask) return this.clearTask;
    if (!this.client || this.status?.state !== 'active') return Promise.resolve({ cleared: false, reason: this.status?.reason ?? 'plugin-inactive' });
    const client = this.client;
    this.clearing = true;
    const task = this.clearForClient(client);
    this.clearTask = task;
    const finish = (): void => { if (this.clearTask === task) this.clearTask = null; };
    void task.then(finish, finish);
    return task;
  }
  private async clearForClient(client: WorkerClient): Promise<{ cleared: boolean; reason?: string }> {
    try {
      await this.tickDone;
      if (this.client !== client || this.status?.state !== 'active') return { cleared: false, reason: 'plugin-inactive' };
      await client.request('clear');
      if (this.client !== client) return { cleared: false, reason: 'plugin-inactive' };
      this.receipts.clear(); return { cleared: true };
    } catch (error) {
      if (this.client !== client) return { cleared: false, reason: 'plugin-inactive' };
      if (error instanceof Error && error.message === 'storage-in-use') return { cleared: false, reason: 'storage-in-use' };
      this.disable('storage-clear-failed'); return { cleared: false, reason: 'storage-clear-failed' };
    }
    finally { if (this.client === client) this.clearing = false; }
  }
  private cleanup(): void {
    this.generation++;
    const listeners = this.listeners.splice(0), client = this.client;
    const resource = this.resource, token = this.resourceToken, releaseScope = this.releaseScope, finish = this.finishTick;
    // Detach mutable ownership before external cleanup. Reentrant installations
    // own fresh state which this old snapshot cannot reset.
    this.client = null; this.resourceToken = null; this.releaseScope = null; this.finishTick = null;
    this.receipts.clear(); this.breadcrumbs = []; this.upload = null; this.matcher = null;
    this.busy = false; this.clearing = false; this.clearTask = null; this.initialized = false;
    this.lifecycleState = null; this.lifecycleRevision = 0; this.checkpointAt = -Infinity; this.checkpoint = {};
    this.collectingCheckpoint = false; this.pendingCheckpointState = null; this.matchingRoute = false; this.addingBreadcrumb = false;
    try { if (token && resource?.owners.get(this.options.namespace) === token) resource.owners.delete(this.options.namespace); } catch { /* owned resource cleanup */ }
    try { releaseScope?.(); } catch { /* optional reservation cleanup */ }
    finish?.();
    for (const remove of listeners) { try { remove(); } catch { /* host teardown stays safe */ } }
    if (client) {
      // Best effort terminal snapshot before terminating our own Worker.
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const close = (): void => { if (timeout !== undefined) { try { clearTimeout(timeout); } catch { /* still terminate */ } } client.close(); };
      try { timeout = setTimeout(close, 2000); void client.request('stop').then(close, close); }
      catch { close(); }
    }
  }
  uninstall(_logger: AemeathInterface): void {
    this.status = { ...this.getStatus(), state: 'stopped', mode: 'none', reason: undefined };
    this.settle(); this.logger = null; this.cleanup();
  }
}
