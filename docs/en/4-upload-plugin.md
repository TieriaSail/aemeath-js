# UploadPlugin - Log Upload Plugin

> Fully customizable callback-based upload, simple and flexible

> 💡 **Privacy tip**: UploadPlugin has no built-in redaction. To filter / strip sensitive fields per entry, use the [`beforeSend` hook](./9-before-send.md) (v2.4.0+), which runs **before** UploadPlugin receives the entry.

---

## 📦 Core Features

### 1. Upload Callback

Control retry behaviour through the return value:

```typescript
interface UploadResult {
  success: boolean;
  shouldRetry?: boolean;
  /** v2.5.0+: failure semantics. 'network' means this failure costs no retry budget */
  retryReason?: 'network' | 'server' | 'payload';
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

### 5. Offline Pause ⭐ v2.4.0

When the network is judged unavailable the queue **pauses** instead of firing blanks:
`onUpload` is not called, no retry budget is spent, nothing is dropped. It resumes
automatically once connectivity returns. See [Reliability & Drops](#-reliability--drops).

### 6. Observable Drops ⭐ v2.4.0

Every abandoned log fires the `onDrop` callback and the `upload:drop` event with a reason.

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
import { initAemeath, getAemeath } from 'aemeath-js';

initAemeath({
  upload: async (log) => {
    await fetch('/api/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(log),
    });
    return { success: true };
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
import { AemeathLogger, UploadPlugin } from 'aemeath-js';

const logger = new AemeathLogger();

logger.use(
  new UploadPlugin({
    onUpload: async (log) => {
      await fetch('/api/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(log),
      });
      return { success: true };
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

      await fetch('/api/logs', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(log),
      });
      return { success: true };
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
      return { success: res.ok };
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
Failure → Downgrade priority (-10), re-queue for retry
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
4. Repeat up to 3 times (configurable); only then is the log dropped

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
Probe succeeds, or an `online` event arrives → emits upload:resumed, draining continues
```

Two independent signals drive the decision:

| Signal                       | Meaning                                                                     |
| ---------------------------- | --------------------------------------------------------------------------- |
| `navigator.onLine === false` | Definitely offline. Not even one `onUpload` call is made                     |
| Consecutive **transport** failures ≥ `suspectedOfflineThreshold` (default 3) | Suspected offline. In WebViews `onLine` often only means "a network interface exists", so a heuristic is needed |

Only **transport** failures count: `onUpload` throwing, or you returning
`retryReason: 'network'`. A 5xx from the server proves the channel is *up*, so those
failures never pause the queue — they go through the retry budget instead.

Two counters run in parallel: a global consecutive-failure count ("the whole channel is
down") and a per-log one ("this particular entry can't get out"). Either reaching the
threshold pauses the queue, so a steady stream of other logs cannot dilute the decision.

The failure that triggers the pause is **refunded** — it does not count against the retry budget.

### Retry budget vs offline pause

They guard against different things:

- **`maxRetries`** guards against a **single poison-pill log** — the channel is healthy and
  only this one entry keeps being rejected.
- **`offlinePolicy`** guards against **the whole channel being down** — the queue pauses and
  spends no retry budget at all.

That is why an outage can no longer burn through `maxRetries` in a second, which was the
core problem fixed in v2.5.0.

The converse holds too: a full backend outage (sustained 5xx) goes through the retry
budget, the queue keeps running, and logs are dropped with an explicit `max-retries`
reason once the budget is gone. Misreading that as "offline" would suspend the queue
indefinitely, leave the budget unspent, and pile logs up until they overflow.

If the channel stays down, the queue grows to `maxSize` and overflows from the lowest
priority upward (reason `queue-overflow`). That is a bounded, observable degradation —
not a silent loss.

### Tell the SDK why an upload failed

`retryReason` is optional, but it makes things noticeably better:

```typescript
upload: async (log) => {
  try {
    const res = await fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
    if (res.ok) return { success: true };
    if (res.status === 413 || res.status === 400) {
      // The log itself is the problem — retrying is pointless
      return { success: false, shouldRetry: false, retryReason: 'payload' };
    }
    // The server actually answered with a failure → spend retry budget
    return { success: false, shouldRetry: true, retryReason: 'server' };
  } catch {
    // The request never left the device → don't blame this log for it
    return { success: false, shouldRetry: true, retryReason: 'network' };
  }
};
```

Omitting `retryReason` is treated as `server`, matching pre-v2.4.0 behaviour.

#### What happens when your callback throws

Without `retryReason`, a thrown error is all the SDK has to go on, so it guesses — and it
only concludes "offline" on **positive evidence**:

| Thrown value | Classified as |
| --- | --- |
| `TypeError` (what `fetch` throws on network failure) | `network` |
| `AbortError` / `TimeoutError`, or the plugin's own upload timeout | `network` |
| Error with `code` of `ERR_NETWORK`, `ECONNRESET`, `ETIMEDOUT`, … | `network` |
| Anything carrying a `response` (axios/ky/got on a 4xx or 5xx) | `server` |
| Anything else, including bugs in your own callback | `server` |

The asymmetry is intentional. Misreading a server failure as `network` pauses the whole
queue and takes log upload silently dark; misreading a network failure as `server` just
drains the retry budget and drops with a `max-retries` reason you can see in `onDrop`. A
bounded, observable loss beats an unbounded, silent one — so the burden of proof sits on
the "offline" side.

If you use axios, ky, got, or any client that throws on non-2xx, this matters to you: a
backend outage will drain the retry budget rather than pause the queue. That is the same
behaviour as 2.4. Return `retryReason` explicitly if you want certainty instead of a
heuristic.

### Know what you lost

```typescript
initAemeath({
  upload,
  onDrop: (log, info) => {
    // info.reason: 'no-retry' | 'max-retries' | 'queue-overflow' | 'cache-expired'
    //            | 'storage-quota' | 'payload-too-large' | 'offline-give-up'
    console.warn('[log dropped]', info.reason, log.logId);
  },
});

// Equivalent event form
getAemeath().on('upload:drop', ({ log, reason }) => { /* ... */ });
```

| Reason              | When it happens                                                    |
| ------------------- | ------------------------------------------------------------------ |
| `no-retry`          | Server explicitly said don't retry (`shouldRetry: false`)           |
| `max-retries`       | Retry budget exhausted                                              |
| `queue-overflow`    | Queue exceeded `maxSize`, lowest-priority entry evicted             |
| `cache-expired`     | Cached entry older than `cache.ttl`                                 |
| `payload-too-large` | A single field exceeds the size budget (see [Payload Sanitize](./10-payload-sanitize.md)) |
| `storage-quota`     | Offline store write failed or quota exhausted                       |
| `offline-give-up`   | Offline replay failed repeatedly and the entry was abandoned        |

### Available events

| Event              | Payload                                      |
| ------------------ | -------------------------------------------- |
| `upload:enqueued`  | `{ log, priority, source, paused }`          |
| `upload:success`   | `{ log, source }`                            |
| `upload:drop`      | `{ log, reason, retryCount, error, source }` |
| `upload:paused`    | `{ reason, queued, logs }`                   |
| `upload:resumed`   | `{ queued }`                                 |

### Upload-time metadata added to every entry

Two fields are added to the outgoing **copy** (the queued entry itself is never mutated):

| Field                         | Meaning                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `requestId`                   | Unique per attempt, for idempotent de-duplication on the consumer side          |
| `tags.uploadedAt`             | **When it was sent.** Paired with `timestamp` (when it was captured) this makes real-time vs replayed obvious |
| `tags.droppedSinceLastReport` | How many entries were dropped since the last success (only present when > 0)    |

Your backend no longer sees an unexplained gap — it sees "there is a hole here, and it is
N entries deep". Strip these in [`beforeSend`](./9-before-send.md) if you don't want them.

### Inspect live state

```typescript
const upload = getAemeath().getPluginInstance('upload');
console.log(upload.getQueueStatus());
// { length, isProcessing, paused, consecutiveFailures,
//   drops: { total, byReason }, items }
```

### Opting back into the old behaviour

```typescript
initAemeath({ upload, queue: { offlinePolicy: 'legacy' } });
```

`legacy` disables both the offline pause and the backoff, fully restoring v2.4 behaviour:
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
      await fetch('/api/logs', {
        method: 'POST',
        body: JSON.stringify(log),
      });
      return { success: true };
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
| `queue.maxSize`                   | `number`                                   | `100`                     | Max queue size                               |
| `queue.concurrency`               | `number`                                   | `1`                       | Concurrent uploads                           |
| `queue.maxRetries`                | `number`                                   | `3`                       | Max retry count (guards against poison pills)|
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

`OfflinePersistencePlugin` behaves the same way; separate the instances with `dbName` (see
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
    await fetch('/api/logs', { body: JSON.stringify(log) });
    return { success: true };
  } catch (error) {
    logger.error('Upload failed', { error }); // This triggers upload again!
    return { success: false, shouldRetry: true };
  }
};

// ✅ GOOD - use console
onUpload: async (log) => {
  try {
    await fetch('/api/logs', { body: JSON.stringify(log) });
    return { success: true };
  } catch (error) {
    console.error('Upload failed:', error); // Safe
    return { success: false, shouldRetry: true };
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

  return { success: response.ok };
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
