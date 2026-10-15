# Crash detection: recovery mode

`CrashDetectionPlugin` is an explicit browser-only plugin. Import it from
`aemeath-js/plugins/CrashDetectionPlugin`, and import `initCrashWorker` from
`aemeath-js/crash-worker` in an application-owned worker entry. Root imports,
singleton defaults, IIFE and mini-program defaults do not enable it.

The plugin reports **suspected unexpected termination of a previous visible page**.
A stale heartbeat is indirect evidence. It cannot prove a renderer crash, OOM,
browser kill, or a specific JavaScript exception. It creates a `warn` observation
with `tags.observation = 'suspected-crash'` and `tags.confidence = 'indirect'`;
it does not invent an Error, stack or error evidence. Browser/process exits can
look identical, storage can be evicted, and an abruptly interrupted normal exit
can lose its terminal snapshot. This is a recovery signal, not an exact crash counter.

## Setup

Install Upload and OfflinePersistence on the same Logger first, with separate
project/tenant storage keys. See the complete [typed example](../../examples/11-crash-detection/basic.ts).
Enable only after the application's required consent has been obtained.

```typescript
import { CrashDetectionPlugin } from 'aemeath-js/plugins/CrashDetectionPlugin';
const crash = new CrashDetectionPlugin({
  namespace: 'shop-production-crash',
  deliveryScope: 'shop-production', // same as UploadPlugin
  createWorker: () => new Worker(new URL('./crash.worker.ts', import.meta.url), { type: 'module' }),
  checkpoint: { collect: () => ({ routeKey: 'checkout' }) },
});
logger.use(crash);
const status = await crash.ready(); // resolves; unsupported environments do not reject
```

`crash.worker.ts`:

```typescript
import { initCrashWorker } from 'aemeath-js/crash-worker';
initCrashWorker();
```

Use a separate plugin object and fresh worker for each Logger. A second monitor
for the same namespace in one document disables with `monitor-resource-in-use`;
independent namespaces work separately. Different documents can cooperate through
IndexedDB. Never share or reuse a terminated Worker. The namespace is permanently
bound to its delivery scope; `clearStoredData` preserves this binding. Use a new
namespace and separate offline/cache resources when changing projects or tenants.
If an otherwise valid `UploadPlugin.setOnUpload` call changes its delivery scope,
the crash plugin stops with `delivery-scope-changed` and warns. It does not block
the business call or send the old namespace's events to the new destination.
Upload's existing pending-data and persistence-readiness checks still apply.
Only crash recovery items may yield to this switch; queued/in-flight ordinary
logs still prevent changing scope. Already-started crash requests cannot be
cancelled, but their late results do not change the new destination's queue state.
Unconfirmed events remain in the original namespace for recovery there.
After monitoring stops, pending receipt completions do not emit observation
completion events or pause/resume ordinary delivery. Already committed ACKs remain valid.

## Configuration and status

| Option | Default | Contract |
| --- | --- | --- |
| `enabled` | `true` after explicit installation | `false` creates no worker |
| `namespace` | required | 1–80 ASCII letters/digits/`_ . -`; one physical crash DB |
| `deliveryScope` | required | 1–120 ASCII letters/digits/`_ . : -`; must match Upload |
| `createWorker` | required | Return a fresh dedicated Worker owned by this plugin |
| `mode` | `recovery` | `realtime` / `hybrid` warn and disable |
| `realtime` | absent | Reserved shape; any value conflicts with recovery |
| `sampleRate` | `1` | Number in `[0, 1]`; sampled-out sessions are inactive |
| `routeMatch` | absent | Composes with Logger route filtering |
| `checkpoint.collect` | absent | Synchronous whitelist-only checkpoint producer |
| `checkpoint.sanitize` | absent | Synchronous final checkpoint filter; `null` clears it |

The reserved `realtime` shape is `{ monitorMainThreadStall?, stallThresholdMs?,
coordination?: 'indexeddb' | 'shared-worker', createSharedWorker? }`. These fields
are reserved, not implemented. Recovery remains the default in future upgrades.

`getStatus()` returns `state` (`idle`, `starting`, `active`, `disabled`, `stopped`),
`requestedMode`, actual `mode` (`recovery` or `none`), `implementedModes`, `reason`
and capability probes (`worker`, `indexedDB`, `lifecycle`). An IndexedDB flag
becomes true only after a committed worker-side write/read/delete transaction.
`ready()` settles after initialization or disable/stop; check `getStatus()` for later failures.
`logger.hasPlugin(...)` only means registered, not operational.

`addBreadcrumb({ name, phase? })` accepts semantic identifiers and optional
`pending` / `done` / `failed`. It retains the most recent 20 entries. Checkpoints
accept only `routeKey` and `operation: { name, phase }`. Identifiers use 1–80 ASCII
letters/digits/`_ . : -`; URL/path/query/hash/text fields and extra properties are
excluded. Callbacks must be synchronous and throw-free; failure disables monitoring.
Do not encode account IDs, tokens or personal data into semantic labels.
No DOM, request bodies, raw routes or global Logger user context are collected.

## Runtime, privacy and delivery

The worker observes at five-second intervals while visible, checkpoints at most
every fifteen seconds (plus lifecycle transitions), and waits thirty seconds before
recovery. A candidate must be unchanged across two observations and have passed
its own startup/resume warmup. Hidden, frozen, bfcache, ended, unknown, very short
or expired sessions are suppressed. Hidden/frozen/bfcache states pause polling and
close the DB; resume starts another warmup. No `beforeunload` cleanup hook is installed.
Route exclusion suppresses recording/recovery; a worker tick can detect later SPA
route inclusion within five seconds without patching history APIs. Timer/clock
jumps restart warmup. Browser throttling and observer failure can still limit accuracy.

Crash storage is a separate `__aemeath_crash_v1__:<namespace>` IndexedDB database,
with seven-day TTL, 100 page records, 100 event records and a 2 MiB total budget.
Whitelist checkpoint/breadcrumb bounds keep page payloads below 4 KiB. Budget,
quota, blocked database, schema or transaction failure disables monitoring.
It never falls back to main-thread heartbeats or localStorage.

Recovery runs SafeGuard, beforeLog, afterLog, PayloadSanitize and beforeSend, then
atomically stores the **final complete log group before any upload**. Deliberate
filtering is persisted as a tombstone. Privacy-hook errors reject this new path;
ordinary logging keeps its existing fail-open behavior. A crash outbox owns its
records until Upload's durable receipt acknowledges success or terminal rejection.
Prepared replay bypasses filters, keeps original IDs, timestamps and release/environment,
and does not merge the new page's user context. Normal `on('log')` listeners and
console logging are not replayed. OfflinePersistence does not mirror this outbox.

Custom `beforeLog` / `afterLog` hooks must also be synchronous. A Promise/thenable
result, including an asynchronous item in an `afterLog` fanout array, rejects
observation preparation and disables monitoring. Its rejection is handled instead
of escaping to the host as an unhandled rejection. Ordinary logging keeps its
existing pipeline behavior.

Delivery is at least once: the backend must deduplicate by `(deliveryScope, logId)`
and accept repeats as success. `requestId` changes per attempt. Retry-After, partial
split ACKs and lease fencing survive recovery. Normal receipt expiry or a lost ACK
can cause a repeat with the same logId. Active retries use existing Upload scheduling.

Ordinary logs can reclaim queued crash observations' RAM slots under capacity
pressure. This does not ACK/delete the durable event or cancel a request already
in flight; recovery can resume after its existing lease expires. Crash delivery
may therefore be delayed. Reentrant checkpoint lifecycle events are coalesced,
and recursive route/breadcrumb callbacks cannot grow the monitoring call stack.
Runtime errors from the plugin's own Worker are handled there and disable the
monitor with a warning; other workers and business error handlers are untouched.

`await crash.clearStoredData()` returns `{ cleared, reason? }`, clears the crash
namespace while retaining its binding/current page, and invalidates old leases.
It does not clear ordinary OfflinePersistence logs, remote records or bytes already
sent. It can fail when inactive; inspect the return. Revoke consent by clearing,
then calling `logger.uninstall('crash-detection')`. Uninstall closes only the worker
created by this plugin after a best-effort terminal snapshot. It does not purge the outbox.
Concurrent clear calls on the same active installation share one operation.
Recovery remains paused until it completes; inspect the shared result before
uninstalling or continuing a consent change.

## Compatibility and diagnostics

Requires a working Dedicated Worker, the host's worker-loading/bundler support,
worker-side IndexedDB transactions, crypto random IDs, TextEncoder and basic page
lifecycle listeners. A successful constructor alone is insufficient. Missing
SharedWorker, BroadcastChannel, Web Locks, freeze/resume, wasDiscarded, longtask or
memory APIs does not by itself disable recovery. This plugin does not change CSP,
create blob/eval workers, install a Service Worker, or patch browser prototypes.
For CSP, deploy a reachable worker under an allowed `worker-src` policy and correct
public base. SSR imports are inert; installation outside the browser disables.

Failures stop monitoring and emit a guarded `console.warn` once per reason and
namespace/document, including when SDK debug output is off. Business work continues.
Console absence or a throwing console must not escape. Common reason codes:

| Reason | Action |
| --- | --- |
| `dedicated-worker-unavailable`, `lifecycle-api-unavailable`, `browser-environment-required` | Required environment capability is absent |
| `worker-creation-failed`, `worker-execution-failed`, `worker-timeout:init` | Check CSP, worker URL, emitted assets and module loading |
| `indexeddb-unavailable`, `indexeddb-open-failed`, `indexeddb-blocked`, `indexeddb-transaction-failed` | Storage could not be proven usable |
| `delivery-scope-mismatch`, `missing-delivery-dependencies`, `delivery-receipt-unavailable` | Fix installation order and destination binding |
| `delivery-scope-changed` | Upload changed destination; install a new monitor with a matching scope and separate namespace |
| `monitor-resource-in-use`, `worker-already-owned` | Use separate resources/fresh Worker; do not stop the first owner |
| `feature-not-implemented`, `configuration-conflict`, `invalid-config` | Correct the mode/options |
| `storage-budget-exceeded`, `checkpoint-callback-failed`, `observation-rejected` | Reduce data or fix the failing callback; inspect before remounting |

Vite 5, Webpack 5 and Rsbuild production consumer builds are part of release gates;
the SDK's older peer-version ranges do not certify this new worker integration.
Chromium, Firefox and WebKit must pass the same candidate's native worker/IndexedDB
contracts in isolated CI before release. Source tests and successful builds alone
are not browser compatibility acceptance.

Call `startCrashExample()` explicitly when using the typed example. Importing its module starts no monitor. A same-origin deployment may use `worker-src 'self'`; the positive CI fixtures also enforce `default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self'`. Adapt this policy to the host application. Under capacity pressure, completed event history and terminal/suppressed page history may be reclaimed; pending events are retained until their TTL.

Namespace clear refuses with `{ cleared: false, reason: 'storage-in-use' }` if a foreign visible observer is recent, or a hidden/frozen/bfcache peer may still be active. The monitor remains active. Stop cooperating monitors before retrying. A hidden leftover cannot prove liveness; it is conservatively retained until an ended state or TTL cleanup.
