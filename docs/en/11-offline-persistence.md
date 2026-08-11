# Offline Persistence

> v1.10.1+ · Enabled by default by `initAemeath({ upload })` · Persist while offline, replay when back online

> To keep delivery memory-only, pass `offlinePersistence: false`. Manual plugin assembly
> remains explicit: install `OfflinePersistencePlugin` after `UploadPlugin`.

---

## 🚀 Quick start

```typescript
import { classifyHttpUploadResponse, initAemeath } from 'aemeath-js';

initAemeath({
  upload: async (log) => {
    const res = await fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
    return classifyHttpUploadResponse(res.status, res.headers.get('Retry-After'));
  },
  // offlinePersistence defaults to true
});
```

Logs produced while offline are written to IndexedDB and replayed automatically
once the network returns — surviving a full browser restart.

---

## 🤔 How is this different from `cache`?

`UploadPlugin`'s built-in `cache` is a **queue mirror**. It only covers page reloads:

| Scenario                              | `cache` (built-in) | `offlinePersistence` |
| ------------------------------------- | ------------------ | -------------------- |
| Page refresh / close and reopen       | ✅                 | ✅                   |
| Offline for a few minutes, then back  | ⚠️ Covers the paused queue | ✅ Replays automatically |
| Close the browser offline, open tomorrow | ❌ 1-hour TTL expired | ✅ 7 days by default |
| Log dropped by UploadPlugin           | ❌ Gone, not in the cache | ✅ Persisted for replay |
| Storage medium                        | localStorage (~5MB per origin) | IndexedDB (2MB budget by default) |

In one line: `cache` protects the **queue**, `offlinePersistence` protects the **logs**.

---

## 🔧 How it works

Entirely event-driven — the main upload path is untouched:

```
        Network drops
          │
          ├── UploadPlugin pauses the queue
          │      └─ upload:paused ──────────► snapshot persisted
          │
          └── logs produced while paused
                 └─ upload:enqueued{paused} ► persisted
          │
        (safety net) upload:drop ───────────► persisted
          │
        Network returns
          │
          ├── UploadPlugin sends what is still in memory
          │      └─ upload:success ─────────► persisted copy deleted
          │
          └── online / upload:resumed
                 └─ batched upload.requeue() ► the rest is replayed
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

**No same-instance duplicate uploads.** When the network returns, the in-memory queue
and persisted store may both hold the same entry. Before replaying, the plugin checks
`upload.isPending(logId)` and skips queued, in-flight, or parked copies. Cross-tab
coordination is not part of 1.10.1; the backend idempotency requirement below is mandatory.

**Recoverable failures are parked, not deleted.** Bounded hot retries protect the endpoint;
after that, the entry moves to `parked` and keeps its durable copy. Terminal responses
(`shouldRetry: false`, non-retryable 4xx, payload rejection) are deleted immediately.
`maxReplayAttempts` remains a termination guard for the legacy replay path.

**Split identity is structural.** Only `tags.splitId` accompanied by `splitIndex` or
`splitTotal` receives atomic group handling. A bare `splitId` remains a normal business tag,
so independent logs are never deferred, evicted, or deleted as accidental siblings. Legacy KV
records written with the old interpretation are normalized once during hydration.

---

## 🕐 Timing metadata on replayed logs

Replayed entries carry extra information so you can tell "happened then" from
"delivered later":

```jsonc
{
  "timestamp": 1717000000000,     // capture time — never modified
  "tags": {
    "offlineReplay": true,        // this entry was replayed
    "uploadedAt": 1717003600000,  // actual send time (present on all logs)
  }
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
    storage: 'auto',           // 'auto' | 'indexeddb' | 'localstorage'
    ttl: 7 * 24 * 3600 * 1000, // lifetime of a persisted copy
    maxEntries: 500,           // max records retained
    maxTotalBytes: 2_000_000,  // max bytes retained
    replayBatchSize: 10,       // entries per replay round
    maxReplayAttempts: 3,      // legacy replay termination guard
    replayTimeoutMs: 60000,    // reconciliation timeout
    dbName: 'aemeath-offline', // IndexedDB database name
    key: '__aemeath_offline__',// localStorage key prefix
    debug: false,
  },
});
```

| Option              | Type                                      | Default              | Description                                     |
| ------------------- | ----------------------------------------- | -------------------- | ----------------------------------------------- |
| `storage`           | `'auto' \| 'indexeddb' \| 'localstorage'` | `'auto'`             | Preference; still falls back if unavailable     |
| `ttl`               | `number`                                  | 7 days               | Measured from the moment it was persisted       |
| `maxEntries`        | `number`                                  | IDB 500 / KV 100     | Durable record limit and basis for the bounded transient write-intent buffer |
| `maxTotalBytes`     | `number`                                  | IDB 2MB / KV 512KB   | Durable byte limit and basis for the bounded transient write-intent buffer |
| `replayBatchSize`   | `number`                                  | `10`                 | Prevents a thundering herd on recovery          |
| `maxReplayAttempts` | `number`                                  | `3`                  | Legacy replay termination guard                  |
| `replayTimeoutMs`   | `number`                                  | `60000`              | Requeue window when neither success nor failure arrives |
| `dbName`            | `string`                                  | `'aemeath-offline'`  | IndexedDB database name                         |
| `key`               | `string`                                  | `'__aemeath_offline__'` | Key prefix for the KV backend                |
| `debug`             | `boolean`                                 | `false`              | Emit internal debug logs                        |

Manual installation (when not using `initAemeath`):

```typescript
import { AemeathLogger, UploadPlugin, OfflinePersistencePlugin } from 'aemeath-js';

const logger = new AemeathLogger();
logger.use(new UploadPlugin({ onUpload }));
logger.use(new OfflinePersistencePlugin()); // must come after UploadPlugin
```

---

## 💾 Backends and fallback

```
IndexedDB ──unavailable──► localStorage ──unavailable──► noop (no persistence, warns once)
```

**Why IndexedDB first**: capacity measured in hundreds of MB rather than 5MB; an
async API that doesn't block the main thread; per-key reads and writes instead of
reserializing the whole collection every time. localStorage is only a fallback.

If a previous launch fell back to localStorage while IndexedDB was temporarily unavailable,
the next healthy launch migrates those KV records into IndexedDB commit-first and deletes each
KV copy only after the IDB transaction commits. Hydration and replay start after reconciliation;
an integrity or migration failure enters a delete-only degraded state instead of treating a
partially known store as empty.

Real cases that hit the fallback: IndexedDB `open()` hangs in Safari private mode
(we time out after 2 seconds), some WebViews disable IndexedDB entirely, and an
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
2. If the write still fails (usually quota) → evict another 20% and retry once
3. Still failing → drop the entry and fire `onDrop` with reason `storage-quota`

Eviction is by persist time rather than priority: offline logs usually share the
same priority, so chronological order is the only stable, predictable criterion.

### Persistence budget vs upload queue

These options cap committed offline records and also derive a bounded in-memory budget for
uncommitted write intents while storage is temporarily failing. They do not cap the separate
`UploadPlugin` queue:

| Scenario | Who decides | Outcome |
|---|---|---|
| Same tab: offline → online (page stays open) | Memory queue | Entries evicted from disk **may still upload from memory** |
| After close / reload (only disk left) | `maxEntries` / `maxTotalBytes` | Eviction sticks; oldest entries are not replayed |
| Transient storage failure | Persistence write-intent buffer | Writes retry with exponential backoff; overflow is reported, never allowed to grow without bound |

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
  onDrop: (log, info) => {
    if (info.reason === 'storage-quota') {
      // storage full, this one didn't make it onto disk
    }
  },
});
```

---

## 🔭 Inspecting state

For the combined upload + persistence view, prefer
[`logger.getDeliveryStatus()`](./12-delivery-status.md).

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
//   giveUps: 0,            // abandoned after repeated failures
//   replayed: 137,         // successfully replayed
//   items: [{ logId, capturedAt, state: 'persisted' | 'replaying' | 'buffering' }],
// }

await plugin.clear(); // wipe persisted copies and uncommitted write/delete intents
```

---

## 🚧 Known limitations

### Mandatory backend idempotency (`logId`)

**Multiple tabs can replay the same entry.** 1.10.1 prevents duplicates inside one
SDK instance, but it does not elect a single browser tab. The same record can therefore
reach your endpoint more than once.

Your ingestion endpoint **must** make `(project/tenant scope, logId)` unique and return
success for a repeated key without inserting a second row. `logId` stays stable across
retries and offline replay; `requestId` changes for every attempt and must not be used as
the deduplication key. Split payload chunks already have distinct `logId` values.

This is a correctness requirement, not an optional optimization. Cross-tab coordination
is planned for 2.6.0, but backend idempotency remains necessary for uncertain network
outcomes even after that work ships.

**Commit-aware, but still best effort at process shutdown.** An IndexedDB operation is reported
successful only after its transaction completes; a request-level success is not enough. The SDK
still cannot finish work that the browser terminates before commit, and the KV fallback cannot make
its separate record/index keys one native transaction. Failed operations remain observable and are
not reported as durable.

**Give each instance its own `dbName`, KV `key`, and upload `cache.key` when a page runs
several.** If two instances share either possible backend resource, logs one project buffered offline get
replayed automatically to the other project's endpoint — and because replay happens on its own,
this kind of cross-wiring is especially hard to trace. When the SDK detects the collision it
**deactivates the second instance** (`getStatus().backend` returns `'noop'`) and warns on the
console. To persist on both, name the stores apart:

```ts
new OfflinePersistencePlugin({ dbName: 'host-offline', key: 'host-offline-kv' });
new OfflinePersistencePlugin({ dbName: 'widget-offline', key: 'widget-offline-kv' });
```

`UploadPlugin.cache.key` has the same requirement; see
[Upload plugin](./4-upload-plugin.md).

**No encryption.** Records are stored as plain JSON. If your logs carry sensitive
data, redact in [`beforeSend`](./9-before-send.md) — it runs before anything is persisted.

---

## 🔗 Related

- [UploadPlugin](./4-upload-plugin.md) — queueing, retries, drops and events
- [Unified delivery status](./12-delivery-status.md) — combined state and lifecycle aliases
- [Payload sanitize](./10-payload-sanitize.md) — keeps entries small enough to persist
- [`beforeSend` hook](./9-before-send.md) — redact before anything hits disk
