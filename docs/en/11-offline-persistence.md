# Offline Persistence

> v2.5.0+ · **Enabled by default** when `upload` is configured · Persist offline, replay online

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
    const res = await fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
    return classifyHttpUploadResponse(res.status, res.headers.get('Retry-After'));
  },
});
```

Once `upload` is configured, logs produced while offline are written to IndexedDB by
default and replayed automatically once the network returns — surviving a full browser
restart. Set `offlinePersistence: false` to opt out. Standard entry points then disable and
purge both the Upload queue cache and OfflinePersistence records so no local copy remains.

---

## 🤔 How is this different from `cache`?

`UploadPlugin`'s built-in `cache` is a **queue mirror**. It only covers page reloads:

| Scenario                              | `cache` (built-in) | `offlinePersistence` |
| ------------------------------------- | ------------------ | -------------------- |
| Page refresh / close and reopen       | ✅                 | ✅                   |
| Offline for a few minutes, then back  | ⚠️ Covers the paused queue | ✅ Replays automatically |
| Close the browser offline, open tomorrow | ❌ 1-hour TTL expired | ✅ 7 days by default |
| Recoverable failure exhausts hot retries | ✅ Mirrors `parked` state | ✅ Keeps durable copy |
| Storage medium                        | localStorage (~5MB per origin) | IndexedDB (2MB budget by default) |

In one line: `cache` protects the **queue**, `offlinePersistence` protects the **logs**.
They remain separate internally, but the standard-entry master switch
`offlinePersistence: false` disables both. A manually constructed `UploadPlugin` still controls
its own mirror through `cache.enabled`.

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
        Recoverable failure exhausts hot retries
          └── upload:parked ────────────────► durable copy retained
        (safety net) overflow / legacy drop ► persisted
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

**Avoids duplicate recovery within one page.** When the network returns, the in-memory
queue and persisted store may both hold the same entry. Before replaying, the plugin checks
`upload.isPending(logId)` and skips anything already queued or in flight in this page. This
check does not cross tab boundaries; see the 2.6 design linked below.

**Parking does not spend the persisted lifecycle.** Under the default upload policy,
recoverable failures that exhaust hot retries are held by `UploadPlugin` in `parked`, while
the durable copy remains untouched. It is deleted only after the cooling/`Retry-After`
deadline (or an explicit `flush()`) leads to success; an `online` hint does not override
that deadline. `maxReplayAttempts` remains as a legacy
compatibility guard; parked transitions do not increment it.

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
    maxReplayAttempts: 3,      // legacy replay guard; parked does not count
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
| `maxEntries`        | `number`                                  | IDB 500 / KV 100     | **Disk** max records; oldest evicted (memory queue unaffected) |
| `maxTotalBytes`     | `number`                                  | IDB 2MB / KV 512KB   | **Disk** max bytes; oldest evicted (memory queue unaffected) |
| `replayBatchSize`   | `number`                                  | `10`                 | Prevents a thundering herd on recovery          |
| `maxReplayAttempts` | `number`                                  | `3`                  | Legacy replay guard; parked does not count      |
| `replayTimeoutMs`   | `number`                                  | `60000`              | Requeue window when neither success nor failure arrives |
| `dbName`            | `string`                                  | `'aemeath-offline'`  | IndexedDB database name                         |
| `key`               | `string`                                  | `'__aemeath_offline__'` | Key prefix for the KV backend                |
| `debug`             | `boolean`                                 | `false`              | Emit internal debug logs                        |

Manual installation (when not using `initAemeath`):

```typescript
import { Aemeath, UploadPlugin, OfflinePersistencePlugin } from 'aemeath-js';

const logger = new Aemeath();
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
2. On an explicit quota error, evict another 20% and retry once
3. If the quota retry still fails, fire `onDrop` with reason `storage-quota`
4. For a non-quota storage rejection, keep healthy entries and report `storage-rejected`

Eviction is by persist time rather than priority: offline logs usually share the
same priority, so chronological order is the only stable, predictable criterion.

### `maxEntries` / `maxTotalBytes` only bound disk

These options cap **what is persisted to the offline store**, not the in-memory
`UploadPlugin` queue:

| Scenario | Who decides | Outcome |
|---|---|---|
| Same tab: offline → online (page stays open) | Memory queue | Entries evicted from disk **may still upload from memory** |
| After close / reload (only disk left) | `maxEntries` / `maxTotalBytes` | Eviction sticks; oldest entries are not replayed |

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
//   bytes: 128374,         // estimated footprint
//   replaying: 3,          // currently in flight
//   quotaDrops: 0,         // dropped due to quota
//   giveUps: 0,            // legacy replay failures that were abandoned
//   replayed: 137,         // successfully replayed
//   items: [{ logId, capturedAt, state: 'persisted' | 'replaying' }],
// }

await plugin.clear(); // wipe all persisted copies
```

Do not add the Upload and persistence counts when you need the global picture: the same
`logId` normally exists in memory and on disk. Use the unified query, which deduplicates by
`logId`:

```typescript
const status = getAemeath().getDeliveryStatus();
// { totalPending, queued, inFlight, parked, persisted, persistedOnly, replaying, ... }
```

Subscribe with `logger.on('delivery:status', listener)` for unified snapshots;
`delivery:persisted` reports a successful durable write. The existing
`plugin.getStatus()` remains the storage-specific diagnostic API.

---

## 🚧 Known limitations

**In 2.5, multiple tabs can replay the same entry.** Each tab holds its own storage handle,
so one entry may be replayed by several tabs at once. The backend must deduplicate by
`logId` and treat duplicates as success.

**Best effort, not transactional.** IndexedDB writes are async; if the process is
killed (a crash, or shutting down right after `window.close()`), the last few
in-flight writes are lost.

**Give each instance its own `dbName` and `key` when a page runs several.** `dbName`
identifies IndexedDB while `key` identifies the KV fallback. If two instances share either
resource, logs one project buffered offline can get
replayed automatically to the other project's endpoint — and because replay happens on its own,
this kind of cross-wiring is especially hard to trace. When the SDK detects the collision it
**deactivates the second instance** (`getStatus().backend` returns `'noop'`) and warns on the
console. To persist on both across either backend, name both resources apart:

```ts
new OfflinePersistencePlugin({ dbName: 'host-offline', key: 'host-offline' });
new OfflinePersistencePlugin({ dbName: 'widget-offline', key: 'widget-offline' });
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
