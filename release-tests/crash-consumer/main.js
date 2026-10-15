import { AemeathLogger } from 'aemeath-js/core/Logger';
import { UploadPlugin } from 'aemeath-js/plugins/UploadPlugin';
import { OfflinePersistencePlugin } from 'aemeath-js/plugins/OfflinePersistencePlugin';
import { CrashDetectionPlugin } from 'aemeath-js/plugins/CrashDetectionPlugin';
import { BeforeSendPlugin } from 'aemeath-js/plugins/BeforeSendPlugin';
import { PayloadSanitizePlugin } from 'aemeath-js/plugins/PayloadSanitizePlugin';

const logs = [], attempts = [], snapshots = [], completionEvents = [];
let logger, plugin, upload, offline, lastWorker, hookCalls = 0, checkpointCalls = 0;
let checkpointDepth = 0, maxCheckpointDepth = 0;
const commitStops = [];
let leaveFromRoute = false, finishHeldUpload;
const dbName = namespace => `__aemeath_crash_v1__:${namespace}`;
function database(namespace) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName(namespace), 1);
    req.onupgradeneeded = () => req.result.createObjectStore('records', { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
}
async function rows(namespace) {
  const db = await database(namespace);
  try { return await new Promise((resolve, reject) => { const tx = db.transaction('records'); const req = tx.objectStore('records').getAll(); tx.oncomplete = () => resolve(req.result); tx.onabort = () => reject(tx.error); }); }
  finally { db.close(); }
}
async function seed(namespace, records) {
  const db = await database(namespace);
  try { await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put({ key: 'binding', kind: 'binding', scope: 'release-tests' }); for (const row of records) tx.objectStore('records').put(row); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); }
  finally { db.close(); }
}
async function start(namespace, options = {}) {
  logger = new AemeathLogger({ enableConsole: false, release: 'current-release', context: { user: { id: 'current-user' } } });
  upload = new UploadPlugin({ deliveryScope: 'release-tests', cache: { enabled: false }, queue: { maxSize: options.maxSize, maxRetries: options.commitOperation === 'park' ? 0 : undefined, suspectedOfflineThreshold: options.commitOperation === 'retry' ? 1 : undefined }, onUpload: async log => {
    attempts.push({ logId: log.logId, at: Date.now() });
    const records = await rows(namespace);
    const persisted = records.find(row => row.kind === 'event' && row.prepared?.some(entry => entry.logId === log.logId));
    if (!persisted) throw Error('network attempted before durable preparation');
    snapshots.push(persisted);
    if (options.commitOperation && options.commitOperation !== 'ack') return { success: false, shouldRetry: options.commitOperation !== 'terminal', retryReason: options.commitOperation === 'retry' ? 'network' : 'server' };
    if (options.holdUpload) return new Promise(resolve => { finishHeldUpload = resolve; });
    if (options.failFirst && attempts.length === 1) return { success: false, shouldRetry: true, retryAfterMs: 2000, retryReason: 'server' };
    logs.push(log); return { success: true };
  } });
  logger.use(upload);
  for (const type of ['upload:success', 'upload:drop', 'upload:parked', 'upload:retry-scheduled']) logger.on(type, event => {
    if (event.source === 'durable-observation') completionEvents.push(type);
  });
  if (options.pauseQueue) upload.setOnUpload(null);
  offline = new OfflinePersistencePlugin({ dbName: `offline-${namespace}`, key: `offline-${namespace}`, storage: 'indexeddb' });
  logger.use(offline);
  logger.use(new PayloadSanitizePlugin());
  logger.use(new BeforeSendPlugin({ beforeSend: entry => { hookCalls++; if (options.filter) return null; return { ...entry, message: 'sanitized observation' }; } }));
  if (options.asyncAfterLog) logger.use({ name: 'async-after', install() {}, afterLog: entry => {
    if (entry.tags?.observation !== 'suspected-crash') return;
    const result = options.asyncAfterLog.startsWith('rejected')
      ? Promise.reject(new Error('unsupported async privacy hook'))
      : Object.assign(Promise.resolve(entry), entry);
    return options.asyncAfterLog.endsWith('fanout') ? [result] : result;
  } });
  if (options.cancelAttempt) logger.on('upload:attempt', event => { if (event.source === 'durable-observation') logger.uninstall('crash-detection'); });
  leaveFromRoute = !!options.initialRouteLeave;
  plugin = new CrashDetectionPlugin({ namespace, deliveryScope: 'release-tests', mode: options.mode,
    routeMatch: { includeRoutes: [() => {
      if (leaveFromRoute) { leaveFromRoute = false; window.dispatchEvent(new PageTransitionEvent('pagehide')); }
      return true;
    }] },
    createWorker: () => {
      if (options.asyncFactory) return Promise.reject(new Error('unsupported async worker factory'));
      if (options.workerThrows) return new Worker(new URL('./failing.worker.js', import.meta.url), { type: 'module' });
      lastWorker = options.noIdb
        ? new Worker(new URL('./unsupported.worker.js', import.meta.url), { type: 'module' })
        : new Worker(new URL('./crash.worker.js', import.meta.url), { type: 'module' });
      if (options.stopAfterCommit) {
        const owned = lastWorker, post = owned.postMessage.bind(owned), operations = new Map();
        const add = owned.addEventListener.bind(owned), remove = owned.removeEventListener.bind(owned), listeners = new Map();
        owned.postMessage = (message, ...args) => { operations.set(message.id, message.data?.operation); return post(message, ...args); };
        // Native dispatch can drain microtasks between separate listeners. Keep
        // WorkerClient's callback and our scheduling in one JS stack so its
        // receipt continuation runs before stop, and Upload resumes after stop.
        // Only this fixture-owned Worker is wrapped; messages and IDB are real.
        owned.addEventListener = (type, listener, ...args) => {
          if (type !== 'message') return add(type, listener, ...args);
          const wrapped = function (event) {
            const operation = operations.get(event.data.id); operations.delete(event.data.id);
            listener.call(this, event);
            if (event.data.ok && operation === options.stopAfterCommit) queueMicrotask(() => {
              commitStops.push({ operation, completionEvents: [...completionEvents], state: plugin.getStatus().state });
              logger.uninstall('crash-detection');
            });
          };
          listeners.set(listener, wrapped);
          return add(type, wrapped, ...args);
        };
        owned.removeEventListener = (type, listener, ...args) => {
          const wrapped = type === 'message' ? listeners.get(listener) : undefined;
          if (wrapped) listeners.delete(listener);
          return remove(type, wrapped || listener, ...args);
        };
      }
      if (options.factoryStops) logger.uninstall('crash-detection');
      return lastWorker;
    },
    checkpoint: { collect: () => {
      checkpointCalls++; checkpointDepth++;
      maxCheckpointDepth = Math.max(maxCheckpointDepth, checkpointDepth);
      try {
        if (options.checkpointEvents && checkpointCalls === 1) document.dispatchEvent(new Event('freeze'));
        return { routeKey: 'release-fixture' };
      } finally { checkpointDepth--; }
    } },
  });
  logger.use(plugin);
  return plugin.ready();
}
const button = document.createElement('button'); button.textContent = 'business'; let clicked = false; button.onclick = () => { clicked = true; }; document.body.append(button);
window.crashHarness = { start, seed, rows, logs, attempts, snapshots, completionEvents, commitStops,
  get hookCalls() { return hookCalls; },
  get checkpointCalls() { return checkpointCalls; },
  get maxCheckpointDepth() { return maxCheckpointDepth; },
  getStatus: () => plugin.getStatus(), stop: () => logger.uninstall('crash-detection'),
  clear: () => plugin.clearStoredData(),
  clearPair: async () => {
    const first = plugin.clearStoredData(), second = plugin.clearStoredData();
    return { shared: first === second, results: await Promise.all([first, second]) };
  },
  leaveInRoute: () => { leaveFromRoute = true; document.dispatchEvent(new Event('visibilitychange')); },
  uploadStatus: () => upload.getQueueStatus(),
  settleUpload: () => upload.flush(),
  queuedIds: () => upload.getQueueStatus().items.map(item => item.logId),
  admitOrdinary: () => {
    let logId; const observe = entry => { logId = entry.logId; };
    logger.on('log', observe);
    try { logger.warn('ordinary business log'); return { logId, pending: upload.isPending(logId) }; }
    finally { logger.off('log', observe); }
  },
  remountWithOldWorkerError: async () => {
    const oldWorker = lastWorker;
    logger.uninstall('crash-detection'); logger.use(plugin);
    oldWorker.dispatchEvent(new Event('error'));
    return plugin.ready();
  },
  switchDestination: async () => {
    await offline.whenReady();
    upload.setOnUpload(async log => { logs.push(log); return { success: true }; }, { deliveryScope: 'next-destination' });
    finishHeldUpload?.({ success: false, retryReason: 'network' }); finishHeldUpload = undefined;
    logger.warn('business after switching'); await upload.flush();
    return { scope: upload.getDeliveryScope(), status: plugin.getStatus(), uploaded: logs.length };
  },
  business: async () => { button.click(); const response = await fetch('/business-api'); return clicked && response.ok; },
};
