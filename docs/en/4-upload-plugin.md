# UploadPlugin - Log Upload Plugin

> Fully customizable callback-based upload, simple and flexible

> 💡 **Privacy tip**: UploadPlugin has no built-in redaction. To filter / strip sensitive fields per entry, use the [`beforeSend` hook](./9-before-send.md) (v2.4.0+), which runs **before** UploadPlugin receives the entry.

> ⚠️ **Backend idempotency is mandatory**: reliable delivery has at-least-once semantics.
> Enforce a unique constraint on `(projectId/tenantId, logId)` and return success when a
> `logId` was already accepted. `requestId` changes on every attempt and is only for
> diagnostics, never deduplication.

---

## 📦 Core Features

### 1. Upload Callback

Control retry behaviour through the return value:

```typescript
interface UploadResult {
  success: boolean;
  shouldRetry?: boolean;
  /** Failure classification affects scheduling, not whether the log is retained. */
  retryReason?:
    | 'network' | 'server' | 'payload' | 'auth' | 'rate-limit'
    | 'unknown' | 'callback-error' | 'cancelled';
  /** Minimum delay requested by the server, e.g. a parsed Retry-After value. */
  retryAfterMs?: number;
  /** Raw HTTP Retry-After header; supports delta-seconds and HTTP-date. */
  retryAfter?: string | null;
  error?: string;
}
```

### 2. Priority Callback

You define log priority (number 1-100, higher = more priority)

### 3. Queue Mechanism

- Enabled by default
- Serial processing (one request at a time)
- Sorted by priority

### 4. Auto Retry (with exponential backoff)

- Failed uploads automatically downgrade priority (-10)
- Re-queued after 1s → 2s → 4s… (capped at 30s)
- Max 3 retries (configurable)
- Enters a recoverable `parked` state when the hot retry budget is exhausted
- `shouldRetry` controls intent; `retryReason` controls classification and scheduling

### 5. Offline Pause ⭐ v2.4.0

When the network is judged unavailable the queue **pauses** instead of firing blanks:
`onUpload` is not called, no retry budget is spent, nothing is dropped. It resumes
automatically once connectivity returns. See [Reliability & Drops](#-reliability--drops).

### 6. Observable Drops ⭐ v2.4.0

Only a truly terminal lifecycle fires `onDrop` and `upload:drop`. Entering `parked`
is not a drop and has its own `upload:parked` event.

### 7. Local Cache

- Queue saved to localStorage, auto-restored after page refresh
- TTL measured from the moment it was written (default 1 hour, configurable)
- ⚠️ The cache is a **queue mirror**. It only survives page reloads and does **not**
  provide offline replay — that is what
  [OfflinePersistencePlugin](./11-offline-persistence.md) is for

---

## 🚀 Quick Start

### Singleton Pattern (Recommended)

`initAemeath()` accepts an `upload` callback directly — no need to manually register `UploadPlugin`:

```typescript
import { initAemeath, getAemeath, classifyHttpUploadResponse } from 'aemeath-js';

initAemeath({
  upload: async (log) => {
    const response = await fetch('/api/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(log),
    });
    return classifyHttpUploadResponse(
      response.status,
      response.headers.get('Retry-After'),
    );
  },
});

const logger = getAemeath();
logger.error('Something went wrong', { error });
```

> **Coexistence with NetworkPlugin**: fetch / XHR / `wx.request` started during
> `onUpload` (including its awaits) are automatically skipped by network monitoring.
> They will **not** be logged as `HTTP 200: POST /api/logs` and will not form a
> self-feedback loop. You do **not** need to put your upload URL in
> `network.excludeUrls` — that option is for third-party beacons and other endpoints.

### Manual Assembly

```typescript
import { AemeathLogger, UploadPlugin, classifyHttpUploadResponse } from 'aemeath-js';

const logger = new AemeathLogger();

logger.use(
  new UploadPlugin({
    onUpload: async (log) => {
      const response = await fetch('/api/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(log),
      });
      return classifyHttpUploadResponse(
        response.status,
        response.headers.get('Retry-After'),
      );
    },
  }),
);

logger.error('Something went wrong', { error });
```

### With Authentication

```typescript
logger.use(
  new UploadPlugin({
    onUpload: async (log) => {
      const token = getAuthToken(); // Your auth logic

      const response = await fetch('/api/logs', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(log),
      });
      return classifyHttpUploadResponse(
        response.status,
        response.headers.get('Retry-After'),
      );
    },
  }),
);
```

### Custom Priority

```typescript
logger.use(
  new UploadPlugin({
    onUpload: async (log) => {
      const res = await fetch('/api/logs', {
        method: 'POST',
        body: JSON.stringify(log),
      });
      return classifyHttpUploadResponse(res.status, res.headers.get('Retry-After'));
    },

    // Priority callback
    getPriority: (log) => {
      // Error logs: highest priority
      if (log.level === 'error') return 100;

      // Urgent business logs
      if (log.tags?.urgent) return 80;

      // Warn logs: normal priority
      if (log.level === 'warn') return 50;

      // Others: low priority
      return 10;
    },
  }),
);
```

---

## 📊 How It Works

### Queue Processing Flow

```
Log captured
    ↓
Calculate priority (via getPriority callback)
    ↓
Add to priority queue (sorted by priority)
    ↓
Save to local cache
    ↓
Process queue serially (one request at a time)
    ↓
Call onUpload callback
    ↓
Success → Remove from queue
    ↓
Recoverable failure → Downgrade priority (-10), re-queue for a hot retry
    ↓
Hot budget exhausted → cool in parked, then probe again (not a drop)
```

### Priority System

- Priority is a **number from 1-100**
- Higher number = higher priority
- Default priorities:
  - `error`: 100
  - `warn`: 50
  - `info` / `track`: 10
  - `debug`: 1

### Retry Mechanism

1. Upload fails
2. Decrease priority by 10
3. Schedule the next attempt with exponential backoff (1s → 2s → 4s…, capped at 30s)
4. Repeat up to 3 times (configurable)
5. When the hot budget is exhausted, enter `parked`; retry after its cooling/
   `Retry-After` deadline, or on an explicit `flush()`. An `online` hint only releases
   the network-paused active queue and never overrides a server delay.

### Serial Processing

- Only one upload request at a time
- Prevents performance issues
- Ensures request order
- 100ms delay between requests

---

## 🛡️ Reliability & Drops

> Since v2.4.0 UploadPlugin no longer silently swallows logs when the network is down.

### What happens when you go offline

```
Offline detected
    ↓
Queue pauses (emits upload:paused with a snapshot of the held logs)
    ↓
No onUpload call · no retry budget spent · nothing dropped
    ↓
Half-open probe after 5s → 10s → 20s… (capped at 60s)
    ↓
An `online` event allows one half-open probe only
    ↓
Probe succeeds or reaches the server → emits upload:resumed, draining continues
```

Two independent signals drive the decision:

| Signal                       | Meaning                                                                     |
| ---------------------------- | --------------------------------------------------------------------------- |
| `navigator.onLine === false` | Definitely offline. Not even one `onUpload` call is made                     |
| Consecutive **transport** failures ≥ `suspectedOfflineThreshold` (default 3) | Suspected offline. In WebViews `onLine` often only means "a network interface exists", so a heuristic is needed |

Only **transport** failures count: a thrown error that can be positively identified as a
network failure, or an explicit `retryReason: 'network'`. A 5xx from the server proves the
channel is *up*, so those failures never pause the queue — they go through the retry budget
instead.

Two counters run in parallel: a global consecutive-failure count ("the whole channel is
down") and a per-log one ("this particular entry can't get out"). Either reaching the
threshold pauses the queue, so a steady stream of other logs cannot dilute the decision.

The failure that triggers the pause is **refunded** — it does not count against the retry budget.

### Retry budget vs offline pause

They guard against different things:

- **`maxRetries`** bounds **hot retries** for one log so a failing backend cannot cause a
  request storm. It is no longer the lifecycle limit of the log.
- **`offlinePolicy`** guards against **the whole channel being down** — the queue pauses and
  spends no retry budget at all.

That is why an outage can no longer burn through `maxRetries` in a second, which was the
core problem fixed in v2.5.0.

The converse holds too: a full backend outage (sustained 5xx) spends the hot retry budget
without being mistaken for a device outage. Once that budget is gone, the log moves to
`parked`: 60 seconds for the first cooling period, exponentially increasing to 15 minutes.
Only one due item is woken as a recovery probe. Active and parked items share `queue.maxSize`,
so memory remains bounded; capacity eviction is reported as `queue-overflow`.

Queued, parked, and incomplete split-admission entries all consume that same capacity budget.
SDK split groups are admitted and evicted atomically. A `tags.splitId` without `splitIndex` or
`splitTotal` remains an ordinary business tag and does not couple independent logs.

If the channel stays down, the queue grows to `maxSize` and overflows from the lowest
priority upward (reason `queue-overflow`). That is a bounded, observable degradation —
not a silent loss.

### Tell the SDK why an upload failed

`shouldRetry` and `retryReason` are orthogonal: the former states intent, while the latter
selects scheduling. Compatibility rules are:

- `{ success: false, shouldRetry: true }` retries with reason `unknown`.
- `{ success: false, retryReason: 'server' }` also expresses retry intent.
- `{ success: false, shouldRetry: false }` is terminal.
- Bare `{ success: false }` remains terminal for backward compatibility.
- `retryReason: 'payload'` is terminal; `network` does not spend hot retry budget.

Providing both fields is recommended:

```typescript
import { classifyHttpUploadResponse } from 'aemeath-js';

upload: async (log) => {
  try {
    const res = await fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
    return classifyHttpUploadResponse(res.status, res.headers.get('Retry-After'));
  } catch {
    // The request never left the device → don't blame this log for it
    return { success: false, shouldRetry: true, retryReason: 'network' };
  }
};
```

When the server returns `Retry-After`, pass the raw header as `retryAfter`. The SDK parses
both delta-seconds (such as `120`) and HTTP-date, then waits for the greater of the server
delay and local backoff. If your integration already converted it, keep using
`retryAfterMs`; it takes precedence when both fields are present.

`flush()` can bypass SDK-local backoff and a local network pause, but it never bypasses
the server-owned `Retry-After` deadline.

#### What happens when your callback throws

Without `retryReason`, a thrown error is all the SDK has to go on, so it guesses — and it
only concludes "offline" on **positive evidence**:

| Thrown value | Classified as |
| --- | --- |
| `TypeError` with a known fetch network message (`Failed to fetch`, `Load failed`, `NetworkError …`) | `network` |
| `TimeoutError`, or the plugin's own upload timeout | `network` |
| `AbortError` | `cancelled` (not evidence that the whole channel is down) |
| Error with `code` of `ERR_NETWORK`, `ECONNRESET`, `ETIMEDOUT`, … | `network` |
| `response.status` 400/404/405/410/413/422 | `payload` (terminal) |
| `response.status` 401/403 | `auth` (recoverable, e.g. after refreshing credentials) |
| `response.status` 429 | `rate-limit`; a `Retry-After` value in common `response.headers` shapes is parsed automatically |
| Anything carrying another `response` (axios/ky/got) | `server` |
| Anything else, including ordinary programming `TypeError`s in your callback | `callback-error` |

The asymmetry is intentional. Misreading a server failure as `network` pauses the whole
queue and takes log upload silently dark; classifying a network failure as another
recoverable reason merely spends the hot retry budget and parks the log. It neither pauses
the whole queue nor fabricates a drop, so the burden of proof remains on the "offline" side.

If you use axios, ky, got, or any client that throws on non-2xx, this matters to you: a
backend outage will spend the hot retry budget rather than pause the queue. Return
`retryReason` explicitly if you want certainty instead of a
heuristic.

### Know what you lost

```typescript
initAemeath({
  upload,
  onDrop: (log, info) => {
    // info.reason: 'no-retry' | 'queue-overflow' | 'cache-expired'
    //            | 'storage-quota' | 'storage-rejected' | 'payload-too-large'
    //            | 'deduplicated'
    // max-retries / offline-give-up are legacy compatibility paths only
    console.warn('[log dropped]', info.reason, log.logId);
  },
});

// Equivalent event form
getAemeath().on('upload:drop', ({ log, reason }) => { /* ... */ });
```

| Reason              | When it happens                                                    |
| ------------------- | ------------------------------------------------------------------ |
| `no-retry`          | Server explicitly said don't retry (`shouldRetry: false`)           |
| `max-retries`       | `offlinePolicy: 'legacy'` only: retry budget exhausted              |
| `queue-overflow`    | Queue exceeded `maxSize`, lowest-priority entry evicted             |
| `cache-expired`     | Cached entry older than `cache.ttl`                                 |
| `payload-too-large` | A single field exceeds the size budget (see [Payload Sanitize](./10-payload-sanitize.md)) |
| `storage-quota`     | Offline store write failed or quota exhausted                       |
| `storage-rejected`  | Entry rejected by persistence for a non-quota reason                 |
| `offline-give-up`   | Legacy replay path failed repeatedly and abandoned the entry        |
| `deduplicated`      | SDK content deduplication selected another `logId` as the winner      |

### Available events

| Event              | Payload                                      |
| ------------------ | -------------------------------------------- |
| `upload:enqueued`  | `{ log, priority, source, paused }`          |
| `upload:attempt`   | `{ log, source, retryCount }`                |
| `upload:retry-scheduled` | `{ log, source, reason, retryCount, nextAttemptAt }` |
| `upload:parked`    | `{ log, priority, source, reason, retryCount, parkedUntil }` |
| `upload:unparked`  | `{ log, source, reason }`                    |
| `upload:success`   | `{ log, source }`                            |
| `upload:drop`      | `{ log, reason, retryCount, error, source }` |
| `upload:paused`    | `{ reason, queued, logs }`                   |
| `upload:resumed`   | `{ queued }`                                 |

Version 2.5.1 also emits the unified aliases `delivery:queued`, `delivery:attempt`,
`delivery:retry-scheduled`, `delivery:parked`, `delivery:unparked`,
`delivery:delivered`, `delivery:dropped`, `delivery:paused`, and `delivery:resumed`.
Persistence adds `delivery:persisted` and `delivery:persistence-unavailable`;
`delivery:status` carries the unified snapshot. Existing `upload:*` events remain supported.

### Upload-time metadata added to every entry

Upload-time metadata is added to the outgoing **copy** (the queued entry itself is never mutated):

| Field                         | Meaning                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `requestId`                   | Unique per attempt, for request correlation and diagnostics                     |
| `logId`                       | Stable across retries, parking and replay; the backend must use it as the idempotency key |
| `deliveryAttempt`             | Incremented before each real network call; records claimed by the opt-in cross-tab plugin persist it across tabs and restarts |
| `tags.uploadedAt`             | **When it was sent.** Paired with `timestamp` (when it was captured) this makes real-time vs replayed obvious |
| `tags.droppedSinceLastReport` | How many entries were dropped since the last success (only present when > 0)    |

Your backend no longer sees an unexplained gap — it sees "there is a hole here, and it is
N entries deep". Strip these in [`beforeSend`](./9-before-send.md) if you don't want them.

### Inspect live state

```typescript
const logger = getAemeath();
console.log(logger.getDeliveryStatus());
// {
//   state: 'idle' | 'delivering' | 'paused' | 'degraded' | 'disabled',
//   totalPending,       // memory + disk union by logId, never a double count
//   queued, inFlight, parked, persisted, persistedOnly, replaying,
//   oldestPendingAgeMs, consecutiveFailures,
//   attempts: { total, byReason },
//   drops: { total, byReason },
//   persistence: { enabled, backend, bytes, quotaDrops, giveUps, replayed },
// }

logger.on('delivery:status', (status) => {
  // Snapshots are only built and pushed when a listener is registered.
});

// The plugin-specific diagnostic API remains available:
const upload = logger.getPluginInstance('upload');
console.log(upload.getQueueStatus());
```

For patch-version compatibility, `getQueueStatus().items` remains the active queue snapshot
and still satisfies `items.length === length`. Use `pendingItems` when you need the complete
queued + in-flight + parked item list. `getDeliveryStatus()` already uses that complete view.

### Opting back into the old behaviour

```typescript
initAemeath({ upload, queue: { offlinePolicy: 'legacy' } });
```

`legacy` disables the offline pause, parked state and backoff, restoring the old behaviour:
every failure spends retry budget (transport failures included) and the log is dropped once
the budget runs out. Use it for regression comparison only — during an outage it burns
through the budget within seconds.
Intended for regression comparison only — not recommended in production.

---

## ⚙️ Configuration Options

### Full Configuration Example

```typescript
logger.use(
  new UploadPlugin({
    // Upload callback (required)
    onUpload: async (log) => {
      const response = await fetch('/api/logs', {
        method: 'POST',
        body: JSON.stringify(log),
      });
      return classifyHttpUploadResponse(
        response.status,
        response.headers.get('Retry-After'),
      );
    },

    // Priority callback (optional)
    getPriority: (log) => {
      if (log.level === 'error') return 100;
      if (log.level === 'warn') return 50;
      return 10;
    },

    // Queue configuration
    queue: {
      maxSize: 200, // Max queue size
      concurrency: 1, // Concurrency (recommend 1)
      maxRetries: 3, // Max retry count
      uploadInterval: 30000, // Upload interval (ms)
      offlinePolicy: 'pause', // Pause instead of burning retry budget when offline
      retryBackoff: true, // Exponential backoff (base 1s / max 30s)
      suspectedOfflineThreshold: 3, // Consecutive transport failures before assuming offline
    },

    // Cache configuration
    cache: {
      enabled: true, // Enable cache
      key: '__logger_queue__', // Cache key
      ttl: 3600000, // TTL measured from the moment it was written
    },

    // Called when a log is dropped
    onDrop: (log, info) => {
      console.warn('dropped', info.reason, log.logId);
    },

    // Upload on page unload
    saveOnUnload: true,
  }),
);
```

### Configuration Details

| Option                            | Type                                       | Default                   | Description                                  |
| --------------------------------- | ------------------------------------------ | ------------------------- | -------------------------------------------- |
| `onUpload`                        | `(log: LogEntry) => Promise<UploadResult>` | **Required**              | Upload callback                              |
| `getPriority`                     | `(log: LogEntry) => number`                | By level                  | Priority callback                            |
| `onDrop`                          | `(log, info) => void`                      | —                         | Called when a log is dropped (v2.5.0+)       |
| `queue.maxSize`                   | `number`                                   | `100`                     | Shared bound for queued, parked, and incomplete split-admission entries |
| `queue.concurrency`               | `number`                                   | `1`                       | Concurrent logical logs; chunks sharing one `splitId` remain serial |
| `queue.maxRetries`                | `number`                                   | `3`                       | Hot retries per cycle before parking         |
| `queue.uploadInterval`            | `number`                                   | `30000`                   | Upload interval (ms)                         |
| `queue.offlinePolicy`             | `'pause' \| 'legacy'`                      | `'pause'`                 | Offline strategy (v2.5.0+)                   |
| `queue.retryBackoff`              | `boolean \| { baseMs, maxMs }`             | `true`                    | Exponential backoff (v2.5.0+)                |
| `queue.suspectedOfflineThreshold` | `number`                                   | `3`                       | Consecutive transport failures before assuming offline (v2.5.0+) |
| `cache.enabled`                   | `boolean`                                  | `true`                    | Enable cache                                 |
| `cache.key`                       | `string`                                   | `__logger_upload_queue__` | Cache key                                    |
| `cache.ttl`                       | `number`                                   | `3600000`                 | Cache TTL from write time (v2.5.0+)          |
| `saveOnUnload`                    | `boolean`                                  | `true`                    | Save queue on unload                         |

### Give each instance its own `cache.key` when a page runs several

`cache.key` has a deterministic default (`__logger_upload_queue__`). When a host site and an
embedded third-party widget each initialise the SDK — or when a micro-frontend shell and its
children do — both instances claim the same localStorage entry:

- **They overwrite each other.** The later write wipes the earlier queue, and those logs are gone.
- **They cross wires.** On the next visit both restore from the same key, so one project's logs
  get uploaded to the other project's endpoint.

The SDK detects this collision and **turns caching off for the second instance**, printing an
actionable console warning. Uploading is unaffected; that instance simply loses its
resume-after-reload ability. To keep caching on both, give each one a key:

```ts
// Host site
new UploadPlugin({ onUpload, cache: { key: 'host-queue' } });

// Embedded widget
new UploadPlugin({ onUpload, cache: { key: 'widget-queue' } });
```

`OfflinePersistencePlugin` behaves the same way; separate both its `dbName` and fallback `key` (see
[Offline persistence](./11-offline-persistence.md)).

> The SDK cannot tell the two instances apart on its own — it has no stable project identity to
> work from. Auto-renaming based on install order would flip whenever scripts load
> asynchronously, turning a stable bug into an intermittent one, so the SDK yields and hands the
> decision to you instead.

---

## 💡 Best Practices

### 1. Avoid Infinite Loops

```typescript
// ❌ BAD - creates infinite loop
onUpload: async (log) => {
  try {
    const response = await fetch('/api/logs', { body: JSON.stringify(log) });
    return classifyHttpUploadResponse(response.status, response.headers.get('Retry-After'));
  } catch (error) {
    logger.error('Upload failed', { error }); // This triggers upload again!
    return { success: false, shouldRetry: true, retryReason: 'network' };
  }
};

// ✅ GOOD - use console
onUpload: async (log) => {
  try {
    const response = await fetch('/api/logs', { body: JSON.stringify(log) });
    return classifyHttpUploadResponse(response.status, response.headers.get('Retry-After'));
  } catch (error) {
    console.error('Upload failed:', error); // Safe
    return { success: false, shouldRetry: true, retryReason: 'network' };
  }
};
```

### 2. Keep Priority Logic Simple

```typescript
// ✅ GOOD - simple and clear
getPriority: (log) => {
  if (log.level === 'error') return 100;
  if (log.level === 'warn') return 50;
  return 10;
};

// ❌ AVOID - too complex
getPriority: (log) => {
  // Lots of complex calculations...
  return result; // Slows down logging
};
```

### 3. Handle Token Refresh

```typescript
onUpload: async (log) => {
  let token = getAuthToken();

  let response = await fetch('/api/logs', {
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(log),
  });

  // If 401, refresh token and retry
  if (response.status === 401) {
    token = await refreshAuthToken();
    response = await fetch('/api/logs', {
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(log),
    });
  }

  return classifyHttpUploadResponse(
    response.status,
    response.headers.get('Retry-After'),
  );
};
```

---

## 📖 Examples

See `examples/5-upload-plugin/` directory for complete examples:

- `basic.ts` - Basic usage
- `with-auth.ts` - With authentication
- `with-axios.ts` - Using Axios
- `advanced.ts` - Advanced usage (retry, monitoring)
- `project-config-example.ts` - Complete project configuration

**Version:** 1.1.0  
**Last Updated:** 2026-02-05
