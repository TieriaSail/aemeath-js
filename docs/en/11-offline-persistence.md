# Offline Persistence

> v2.6.0+ · **Persistence is enabled by default** with `upload` · Cross-tab coordination is opt-in

> ⚠️ Persisted records are plaintext JSON and default to a seven-day TTL. Redact with
> `beforeSend` first and confirm this is compatible with your compliance requirements.
> Applications that must not persist logs locally should set `offlinePersistence: false`.

> ⚠️ **The backend must deduplicate on `(projectId/tenantId, logId)`.** Offline recovery
> is at-least-once. If the server commits a record but its response is lost, the client can
> only send the same `logId` again. Treat duplicates as success; never deduplicate with the
> per-attempt `requestId`.

---

## 🚀 Quick start

```typescript
import { initAemeath, classifyHttpUploadResponse } from 'aemeath-js';

initAemeath({
  upload: async (log) => {
    const res = await fetch('/api/logs', {
      method: 'POST',
      body: JSON.stringify(log),
    });
    return classifyHttpUploadResponse(
      res.status,
      res.headers.get('Retry-After'),
    );
  },
});
```

Once `upload` is configured, logs produced while offline are written to IndexedDB by
default and replayed automatically once the network returns — surviving a full browser
restart. Set `offlinePersistence: false` to opt out. Standard entry points then disable and
purge both the Upload queue cache and OfflinePersistence records so no local copy remains.

Install the independent plugin only when a browser application really runs in several tabs:

```typescript
import {
  AemeathLogger,
  OfflinePersistencePlugin,
  UploadPlugin,
} from 'aemeath-js';
import { CrossTabDeliveryPlugin } from 'aemeath-js/plugins/CrossTabDeliveryPlugin';

const logger = new AemeathLogger();
// Preinstall coordination before Upload and Offline can restore cached work.
logger.use(new CrossTabDeliveryPlugin());
logger.use(new UploadPlugin({ onUpload: upload }));
logger.use(new OfflinePersistencePlugin());
```

In the 2.6.0 beta, cross-tab mode requires the explicit installation order above. Do not call
`initAemeath({ upload })` and add the plugin afterwards: the standard initializer has already
started Upload cache recovery synchronously with the 2.5.2 semantics, and a plugin cannot retract
a request that has already begun. This constraint preserves even the original cache-recovery
timing for applications that do not opt in instead of delaying every application for a plugin that
may never be installed.

Without it, OfflinePersistence keeps its original single-context replay path: it does not elect a
leader, open BroadcastChannel, or probe Web Locks. IndexedDB also stays on the 2.5.2 v1 `records`
store and the KV backend does not write a namespace binding. The plugin is absent from both the root
entry and the miniapp entry, so miniapps do not need an opt-out flag.

When enabled, the plugin uses a separate `${dbName}-aemeath-delivery-v2` database and never upgrades
the default v1 database. A mixed 2.5 rollout or rollback can therefore still open v1, but this is
**format compatibility**, not an automatic transfer of pending v2 records back into v1. Before
removing the plugin, stop producing new logs, wait until `offline.getStatus()` reports
`pending / buffered / replaying` all at `0` and `crossTab.getStatus().leased === 0`, then deploy the
configuration change. For an emergency rollback, keep the v2 database intact and re-enable the plugin
to drain it later. On the first upgrade, unbound v1 bodies are migrated only
when `namespace` retains the canonical `dbName:key` identity. A custom namespace cannot prove which
project owns an unbound legacy body, so the SDK skips reading and migrating it. If a custom namespace
is ultimately required, first migrate and drain with the default identity, verify that pending delivery
is zero, then change both `dbName` and namespace; an already bound database cannot be rebound.

---

## 🤔 How is this different from `cache`?

`UploadPlugin`'s built-in `cache` is a **queue mirror**. It only covers page reloads:

| Scenario                                 | `cache` (built-in)             | `offlinePersistence`              |
| ---------------------------------------- | ------------------------------ | --------------------------------- |
| Page refresh / close and reopen          | ✅                             | ✅                                |
| Offline for a few minutes, then back     | ⚠️ Covers the paused queue     | ✅ Replays automatically          |
| Close the browser offline, open tomorrow | ❌ 1-hour TTL expired          | ✅ 7 days by default              |
| Recoverable failure exhausts hot retries | ✅ Mirrors `parked` state      | ✅ Keeps durable copy             |
| Storage medium                           | localStorage (~5MB per origin) | IndexedDB (2MB budget by default) |

In one line: `cache` protects the **queue**, `offlinePersistence` protects the **logs**.
They remain separate internally, but the standard-entry master switch
`offlinePersistence: false` disables both. A manually constructed `UploadPlugin` still controls
its own mirror through `cache.enabled`.

---

## 🔧 How it works

OfflinePersistence uses a single-context state machine by default. Installing
CrossTabDeliveryPlugin upgrades recovery ownership to the cross-tab lease state machine:

```
        Network drops
          │
          ├── UploadPlugin pauses the queue
          │      └─ upload:paused ──────────► snapshot persisted
          │
          └── logs produced while paused
                 └─ upload:enqueued{paused} ► persisted
          │
        Recoverable failure exhausts hot retries
          └── upload:parked ────────────────► parked deadline persisted
        (safety net) overflow / legacy drop ► persisted
          │
        Network returns
          │
          ├── UploadPlugin sends what is still in memory
          │      └─ upload:success ─────────► persisted copy deleted
          │
          └── online / upload:resumed ────────► single-context replay
              (with explicit CrossTabDeliveryPlugin)
              BroadcastChannel (wake only) ──► IDB election + group claim + fenced receipt
```

Five decisions worth knowing about:

**Delete on success, not on enqueue.** Deleting at enqueue time would throw away
the only durable copy the moment an upload fails, so the persisted record survives
until `upload:success`. The cost is a brief double copy; the benefit is that no
single failure loses a log.

**Explicit rejections are deleted too.** When the server answers `shouldRetry: false`
or `retryReason: 'payload'`, replaying the log can only earn another rejection. The
persisted copy is removed right away, so it neither occupies quota nor gets dug up
and re-sent the next time the app comes online.

**Replay goes through `requeue()`, not `logger.log()`.** Replayed logs enter the
upload queue directly: no second pass through `beforeSend`, no `logger.on('log')`
listeners firing again, no other plugin reprocessing them. Your analytics won't
suddenly gain a batch of events because someone's WiFi came back.

**Once explicitly enabled, one coordinator owns recovery across tabs.** IndexedDB leader leases, monotonic epochs,
per-record leases, and random fencing tokens decide ownership. BroadcastChannel is only a
low-latency wake hint and Web Locks only reduces election contention; neither is a correctness
authority. Outcomes from an expired token are ignored, while a real success may still delete by
stable `logId`.

**Upload cache transfers before deletion.** On startup, the Upload queue mirror no longer races
OfflineStore. Recovered cache items are frozen and imported first; the old cache is removed only
after every item commits or reaches an explicit terminal outcome. Another crash during transfer
still has the original cache to recover from.

**Parking does not spend the persisted lifecycle.** Under the default upload policy,
recoverable failures that exhaust hot retries are held by `UploadPlugin` in `parked`, while
the durable copy remains untouched. It is deleted only after the cooling/`Retry-After`
deadline (or an explicit `flush()`) leads to success; an `online` hint does not override
that deadline. `maxReplayAttempts` remains as a legacy
compatibility guard; parked transitions do not increment it.

**Split identity is structural.** Only `tags.splitId` accompanied by `splitIndex` or
`splitTotal` receives atomic group handling. A bare `splitId` remains a normal business tag,
so independent logs are never deferred, evicted, or deleted as accidental siblings. Legacy KV
records written with the old interpretation are normalized once during hydration.

---

## 🕐 Timing metadata on replayed logs

Delivery entries carry three different identities; the backend must not mix them:

```jsonc
{
  "logId": "stable-across-retries", // stable lifecycle id; backend idempotency key
  "requestId": "this-request-only", // changes for every real network call
  "deliveryAttempt": 3, // increments per call; durable when claimed by the opt-in plugin
  "timestamp": 1717000000000, // capture time — never modified
  "tags": {
    "offlineReplay": true, // this entry was replayed
    "uploadedAt": 1717003600000, // actual send time (present on all logs)
  },
}
```

Keeping `timestamp` at capture time is deliberate — rewriting it would move the
error to a point on the timeline where the user wasn't even active. For the delay,
compute `uploadedAt - timestamp`.

---

## ⚙️ Configuration

```typescript
initAemeath({
  upload,
  offlinePersistence: {
    storage: 'auto', // 'auto' | 'indexeddb' | 'localstorage'
    ttl: 7 * 24 * 3600 * 1000, // lifetime of a persisted copy
    maxEntries: 500, // max records retained
    maxTotalBytes: 2_000_000, // max bytes retained
    replayBatchSize: 10, // entries per replay round
    maxReplayAttempts: 3, // legacy replay guard; parked does not count
    replayTimeoutMs: 60000, // reconciliation timeout
    dbName: 'aemeath-offline', // IndexedDB database name
    key: '__aemeath_offline__', // localStorage key prefix
    debug: false,
  },
});
```

| Option              | Type                                      | Default                 | Description                                                                  |
| ------------------- | ----------------------------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| `storage`           | `'auto' \| 'indexeddb' \| 'localstorage'` | `'auto'`                | Preference; still falls back if unavailable                                  |
| `ttl`               | `number`                                  | 7 days                  | Measured from the moment it was persisted                                    |
| `maxEntries`        | `number`                                  | IDB 500 / KV 100        | Durable record limit and basis for the bounded transient write-intent buffer |
| `maxTotalBytes`     | `number`                                  | IDB 2MB / KV 512KB      | Durable byte limit and basis for the bounded transient write-intent buffer   |
| `replayBatchSize`   | `number`                                  | `10`                    | Prevents a thundering herd on recovery                                       |
| `maxReplayAttempts` | `number`                                  | `3`                     | Legacy replay guard; parked does not count                                   |
| `replayTimeoutMs`   | `number`                                  | `60000`                 | Requeue window when neither success nor failure arrives                      |
| `dbName`            | `string`                                  | `'aemeath-offline'`     | IndexedDB database name                                                      |
| `key`               | `string`                                  | `'__aemeath_offline__'` | Key prefix for the KV backend                                                |
| `debug`             | `boolean`                                 | `false`                 | Emit internal debug logs                                                     |

Manual installation (when not using `initAemeath`):

```typescript
import {
  AemeathLogger,
  UploadPlugin,
  OfflinePersistencePlugin,
} from 'aemeath-js';
import { CrossTabDeliveryPlugin } from 'aemeath-js/plugins/CrossTabDeliveryPlugin';

const logger = new AemeathLogger();
// The optional coordinator must be first so it can claim restored Upload cache.
const crossTab = new CrossTabDeliveryPlugin({
  namespace: 'project-a', // optional; defaults to Offline dbName + key
  debug: false,
});
const offline = new OfflinePersistencePlugin();
logger.use(crossTab);
logger.use(new UploadPlugin({ onUpload }));
logger.use(offline); // must come after UploadPlugin
```

`namespace` and coordinator diagnostics belong to the optional plugin, not to
`OfflinePersistencePluginOptions`:

| CrossTab option | Type      | Default      | Description                                                                        |
| --------------- | --------- | ------------ | ---------------------------------------------------------------------------------- |
| `namespace`     | `string`  | `dbName:key` | v2 delivery isolation domain; drain legacy v1 data with the default identity first |
| `debug`         | `boolean` | `false`      | Emit coordinator diagnostics                                                       |

---

## 💾 Backends and fallback

```
IndexedDB ──unavailable──► localStorage ──unavailable──► noop (no persistence, warns once)
```

**Why the cross-tab plugin accepts IndexedDB only**: beyond capacity and asynchronous access, it can
atomically verify a leader epoch, claim a complete capacity unit, and write fencing tokens in one
transaction. localStorage cannot offer that guarantee, so CrossTabDeliveryPlugin does not pretend
to coordinate on a best-effort basis. If persistence falls back to KV, it reports `unsupported` and
OfflinePersistence resumes single-context replay.

> **The backend must enforce idempotency by `logId`.** Leases and fencing remove normal same-version
> tab races, but they cannot turn “the server accepted the request and the browser crashed before
> committing the success proof” into distributed exactly-once delivery. Mixed 2.5/2.6 rollouts and
> emergency rollback can also issue duplicates. `deliveryAttempt` observes an attempt generation; it
> does not replace a unique `logId` constraint.

After the cross-tab plugin is explicitly installed, one IndexedDB `dbName` or KV `key` can bind to
only one `namespace`. Projects and tenants should
still use distinct `dbName` and `key` values. If physical storage is accidentally shared, the SDK
rejects the conflicting binding or safely degrades before reading any log body; isolating only the
leader is never treated as sufficient. `clear()` removes delivery data but retains this identity.

SDK split groups are committed to the coordinated database in one transaction, so another tab can
never observe a normal “first chunk written, remaining chunks pending” state. `replayBatchSize` is a
soft throughput target: one complete group larger than the target is still claimed as a unit instead
of starving forever. TTL cleanup rechecks active leases in the storage transaction, and uninstalling
coordination does not release a receipt with a real request in flight; successors wait for its outcome
or lease expiry.

If a previous launch fell back to localStorage while IndexedDB was temporarily unavailable,
the next healthy launch migrates those KV records into IndexedDB commit-first and deletes each
KV copy only after the IDB transaction commits. Hydration and replay start after reconciliation;
an integrity or migration failure enters a delete-only degraded state instead of treating a
partially known store as empty.

Real cases that hit the fallback: IndexedDB `open()` hangs in Safari private mode
(we time out after 3 seconds), some WebViews disable IndexedDB entirely, and an
explicit `storage: 'localstorage'`.

If neither is usable (for example, `localStorage.setItem` silently failing in
certain privacy modes), the plugin degrades to `noop`, warns once, and emits
`upload:offline-unavailable`. **Uploading itself is unaffected** — you only lose
offline replay.

> Availability is determined by a full round trip — write a sentinel, read it back,
> verify, clean up — because some hosts swallow quota errors in `setItem`, making
> "did it throw?" an unreliable test.

---

## ⚠️ Quota and drops

Quota is a real ceiling, so the policy here is **evict explicitly, report explicitly**,
never silently:

1. Check the entry and byte budget before writing; evict the oldest if over
2. On an explicit quota error, evict another 20% and retry once
3. If the quota retry still fails, fire `onDrop` with reason `storage-quota`
4. For a non-quota storage rejection, keep healthy entries and report `storage-rejected`

Eviction is by persist time rather than priority: offline logs usually share the
same priority, so chronological order is the only stable, predictable criterion.

### Persistence budget vs upload queue

These options cap committed offline records and also derive a bounded in-memory budget for
uncommitted write intents while storage is temporarily failing. They do not cap the separate
`UploadPlugin` queue:

| Scenario                                     | Who decides                     | Outcome                                                                                          |
| -------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------ |
| Same tab: offline → online (page stays open) | Memory queue                    | Entries evicted from disk **may still upload from memory**                                       |
| After close / reload (only disk left)        | `maxEntries` / `maxTotalBytes`  | Eviction sticks; oldest entries are not replayed                                                 |
| Transient storage failure                    | Persistence write-intent buffer | Writes retry with exponential backoff; overflow is reported, never allowed to grow without bound |

This split is intentional: a brief outage with the tab still open should not
throw away in-memory logs just because the disk budget filled up. Disk quota
protects “how much can we recover after the page dies.”

To limit **same-tab** backlog, set `queue.maxSize` on the upload queue (that is
what bounds memory). Disk eviction already fires `onDrop` with
`reason: 'storage-quota'` — observable, but it does **not** also remove the
entry from the memory queue.

```typescript
initAemeath({
  upload,
  // Offline persistence is already enabled by upload; configure only when tuning it.
  onDrop: (log, info) => {
    if (info.reason === 'storage-quota') {
      // storage full, this one didn't make it onto disk
    }
    if (info.reason === 'storage-rejected') {
      // this entry was not accepted by storage; capacity was not the cause
    }
  },
});
```

---

## 🔭 Inspecting state

```typescript
const plugin = getAemeath().getPluginInstance('offline-persistence');

plugin.getStatus();
// {
//   backend: 'indexeddb',  // or 'localstorage' / 'noop' / 'initializing'
//   pending: 42,           // awaiting replay
//   buffered: 2,           // writes/metadata updates not committed yet
//   bytes: 128374,         // estimated footprint
//   replaying: 3,          // currently in flight
//   quotaDrops: 0,         // dropped due to quota
//   giveUps: 0,            // legacy replay failures that were abandoned
//   replayed: 137,         // successfully replayed
//   items: [{ logId, capturedAt, state: 'persisted' | 'replaying' | 'buffering' }],
// }

await plugin.clear(); // wipe persisted copies and uncommitted write/delete intents
```

Do not add the Upload and persistence counts when you need the global picture: the same
`logId` normally exists in memory and on disk. Use the unified query, which deduplicates by
`logId`:

```typescript
const status = getAemeath().getDeliveryStatus();
// { totalPending, queued, inFlight, parked, persisted, buffered, persistedOnly, replaying, ... }
```

Subscribe with `logger.on('delivery:status', listener)` for unified snapshots;
`delivery:persisted` reports a successful durable write. The existing
`plugin.getStatus()` remains the storage-specific diagnostic API.

Coordination status belongs to the independent plugin and does not expand the unified status shape:

```typescript
const crossTab = getAemeath().getPluginInstance('cross-tab-delivery');
crossTab.getStatus();
// { state: 'active', mode: 'strong', role: 'leader', leaderEpoch, leased, ... }
```

The plugin also emits `cross-tab-delivery:status`, `cross-tab-delivery:leader-changed`,
`cross-tab-delivery:lease-recovered`, and `cross-tab-delivery:degraded`.

---

## 🚧 Known limitations

**With CrossTabDeliveryPlugin explicitly installed, 2.6 coordinates IndexedDB replay across tabs,
but delivery remains at-least-once.** Leader
leases and record fencing prevent normal concurrent recovery. If the server commits and its
response is lost, no client can prove that the request failed, so the same `logId` may still be
sent again. localStorage/KV does not participate in cross-tab coordination; fallback resumes the
single-context replay path. The backend must
deduplicate by `logId` and treat duplicates as success.

**Commit-aware, but still best effort at process shutdown.** An IndexedDB operation is reported
successful only after its transaction completes; a request-level success is not enough. The SDK
still cannot finish work that the browser terminates before commit, and the KV fallback cannot make
its separate record/index keys one native transaction. Failed operations remain observable and are
not reported as durable.

**Give each instance its own `dbName` and `key` when a page runs several.** `dbName`
identifies IndexedDB while `key` identifies the KV fallback. If two instances share either
resource, logs one project buffered offline can get
replayed automatically to the other project's endpoint — and because replay happens on its own,
this kind of cross-wiring is especially hard to trace. When the SDK detects the collision it
**deactivates the second instance** (`getStatus().backend` returns `'noop'`) and warns on the
console. To persist on both across either backend, name both resources apart:

```ts
new OfflinePersistencePlugin({ dbName: 'host-offline', key: 'host-offline' });
new OfflinePersistencePlugin({
  dbName: 'widget-offline',
  key: 'widget-offline',
});
```

`UploadPlugin.cache.key` has the same requirement; see
[Upload plugin](./4-upload-plugin.md).

**No encryption.** Records are stored as plain JSON with a seven-day default TTL. If your logs carry sensitive
data, redact in [`beforeSend`](./9-before-send.md) — it runs before anything is persisted.

**Requires `logId` idempotency.** Replays reuse the original `logId` (`requestId` changes
every attempt). Enforce uniqueness on `(projectId/tenantId, logId)` and treat duplicates
as success.

---

## 🔗 Related

- [UploadPlugin](./4-upload-plugin.md) — queueing, retries, drops and events
- [Payload sanitize](./10-payload-sanitize.md) — keeps entries small enough to persist
- [`beforeSend` hook](./9-before-send.md) — redact before anything hits disk
