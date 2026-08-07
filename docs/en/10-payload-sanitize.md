# Payload Sanitize

> v1.10.0+ · **Opt-in (disabled by default)** · Keeps every log entry small enough for your endpoint, database and local storage

---

## 🎯 The problem

Data URLs, Blobs and 30KB response bodies end up in logs all the time — especially
when `NetworkPlugin` captures request/response payloads automatically. Each one
triggers a chain of failures:

| Layer            | Consequence                                                          |
| ---------------- | -------------------------------------------------------------------- |
| Upload endpoint  | Request body rejected by the gateway (413), the whole entry is lost   |
| Database         | MySQL `TEXT` caps at 65535 bytes; anything above is silently truncated |
| localStorage     | ~5MB per origin — a single entry can blow the upload cache            |
| IndexedDB        | Once the quota is full, writes fail and offline replay stops working  |

And that base64 blob is nearly worthless for debugging. What you need to know is
"there was a 245KB PNG here", not every byte of it.

---

## 📦 Three rules

Applied in order. **Text you logged deliberately is never silently truncated.**

### 1. Binary content → structured placeholder

Data URLs, `Blob`, `File`, `ArrayBuffer` and TypedArrays are replaced with a one-line summary:

```typescript
logger.error('upload failed', {
  context: { screenshot: 'data:image/png;base64,iVBORw0KG...' }, // 245KB
});

// What actually gets uploaded:
// context.screenshot === '[omitted:data-url mime=image/png bytes=245678]'
```

Two more values that would otherwise make the entry unsendable are handled here too:

- **Circular references** → `[omitted:circular]` (otherwise `JSON.stringify` throws)
- **Unserializable objects** → `[omitted:unserializable]` (replaced in place; every other field still ships)

> Data URLs under 256 bytes (e.g. `data:text/plain,ok`) are kept as-is — they are
> meaningful on their own, and replacing them would lose information.
>
> This rule applies to **every** entry, not just oversized ones: a 300-byte inline SVG
> on an otherwise tiny log is still replaced. If you deliberately log small `data:` URIs
> and want them intact, raise the bar by disabling the plugin (`payloadSanitize: false`)
> or store them elsewhere and log a reference.

### 2. A single oversized field → reject the entry, loudly

```typescript
logger.info('dump', { context: { blob: 'x'.repeat(200000) } });
```

```
[Aemeath] Log "xxx" was DROPPED: field "context.blob" alone is 200002 bytes,
above the 60000-byte budget for a single upload. A single field cannot be split,
so the whole entry is unsendable. Split the data across fields, store it
elsewhere and log a reference, or raise `payloadSanitize.maxBytes`.
```

**Why reject instead of truncate?** Truncating means deciding for you which half
matters. A logging library should not make that call — a 60KB single field is a
problem to fix on the application side.

The drop is **observable** through both channels: a `payload:rejected` event
carries the offending field, its size, and the `budget` it was measured against,
and the same drop also goes through
UploadPlugin's shared exit with reason `payload-too-large`, firing `onDrop` and
`upload:drop`. Integrations that only listen to `onDrop` will not miss it.

### 3. Oversized as a whole → split across entries

When no single field is over budget but the total is, the entry is split on
field boundaries. Nothing is dropped:

```typescript
logger.error('checkout failed', {
  context: { cart: /* 30KB */, user: /* 20KB */, trace: /* 25KB */ },
});
```

```jsonc
// chunk 1
{ "logId": "abc-1", "message": "checkout failed", "timestamp": 1717...,
  "tags": { "splitId": "abc", "splitIndex": 1, "splitTotal": 2, "splitBytes": 76543 },
  "context": { "cart": ..., "user": ... } }

// chunk 2
{ "logId": "abc-2", "message": "checkout failed", "timestamp": 1717...,
  "tags": { "splitId": "abc", "splitIndex": 2, "splitTotal": 2, "splitBytes": 76543 },
  "context": { "trace": ... } }
```

Each chunk is a **standalone valid** `LogEntry` that can be stored on its own;
your backend reassembles them by `tags.splitId`. A `console.warn` is emitted once
and a `payload:split` event fires.

#### What splitting does to a log's identity

Three things are worth knowing before your backend sees a split entry:

- **Each chunk gets its own `logId`** (`abc-1`, `abc-2`, …). The original is preserved in
  `tags.splitId`. This is deliberate: if all chunks shared one `logId`, a backend using it
  as a primary or idempotency key would deduplicate away every chunk but one.
- **`splitId`, `splitIndex`, `splitTotal`, and `splitBytes` are reserved tag names.** If
  you set a tag with one of those names, it is overwritten on split so reassembly keeps
  working.
- **Small fields are replicated onto every chunk; large ones are not.** Anything under
  512 bytes — `context.userId`, `context.sessionId`, your own tags — appears on all
  chunks, so session joins and tag-based alerting still work on every fragment. The large
  fields that forced the split (and `error`, which is treated as one unit) land on exactly
  one chunk each. So an error-level entry split into 3 yields three entries with
  `level: "error"`, only one of which carries the `error` object.

If your ingestion has `NOT NULL` columns on fields that only appear on one chunk, either
reassemble by `splitId` before writing, or raise `maxBytes` so splitting does not trigger.

Splits happen only on **field boundaries** — a field is never cut in half. Short
messages (≤200 bytes) are inlined into every chunk for readability, and
`level` / `timestamp` / `environment` / `release` are copied to all of them.

---

## ⚙️ Configuration

```typescript
// 1.10: off by default — pass true (or options) to enable
initAemeath({
  upload,
  payloadSanitize: true,
});

// Custom budget
initAemeath({
  upload,
  payloadSanitize: { maxBytes: 30000 },
});

// Explicitly leave it off (same as omitting the option)
initAemeath({ upload, payloadSanitize: false });
```

| Option     | Type     | Default | Description                             |
| ---------- | -------- | ------- | --------------------------------------- |
| `maxBytes` | `number` | `60000` | Max UTF-8 bytes for one upload payload  |

### Why 60000

Derived from the most common storage target: a MySQL `TEXT` column holds
**65535 bytes**. Leaving ~5KB for the request envelope, server-side fields and
gateway headers, 60000 is the value that reliably makes it into the column.

Note the unit is **UTF-8 bytes of the serialized payload**, not characters: a CJK
character is 3 bytes, an emoji is 4. 60000 bytes is roughly 20000 CJK characters
or 60000 ASCII characters.

If your backend uses `MEDIUMTEXT` (16MB) or MongoDB, raise it freely.

### What disabling means

```
[Aemeath] `payloadSanitize` is disabled. Data URLs, Blobs and oversized text will be
uploaded and cached as-is, which can break your upload endpoint, truncate database
columns and exhaust localStorage / IndexedDB quota. You are on your own here.
```

Oversized entries then flow into the upload queue and local cache untouched, with
every consequence in the table above.

---

## 🔭 Observability

```typescript
const logger = getAemeath();

logger.on('payload:split', ({ splitId, chunks, bytes }) => {
  console.log(`log ${splitId} split into ${chunks} parts (${bytes} bytes)`);
});

logger.on('payload:rejected', ({ logId, field, fieldBytes, budget }) => {
  console.log(`log ${logId} rejected: ${field} is ${fieldBytes} bytes, limit ${budget}`);
});

// Cumulative counters
const plugin = logger.getPluginInstance('payload-sanitize');
console.log(plugin.getStats());
// { processed, sanitized, split, splitChunks, rejected }
```

Console output is self-limiting: the placeholder notice appears once per session,
and split warnings / rejection errors stop after 3 occurrences each. Production
consoles never get flooded by the logger itself, but the counters keep counting.

---

## 🧩 Position in the pipeline

```
Capture plugins (ErrorCapture / Network / Performance…)
        ↓
   PayloadSanitizePlugin   ← here
        ↓
   BeforeSendPlugin (your beforeSend hook)
        ↓
   listeners / UploadPlugin
```

Running **before** `beforeSend` is deliberate: when you write redaction logic you
are already looking at a sanitized skeleton, not wondering whether some field
holds 200KB of base64.

Chunks produced by a split each traverse the rest of the pipeline in full —
`beforeSend` is called once per chunk.

A split group is all-or-nothing from here on. If your `beforeSend` suppresses one
chunk, the SDK drops its siblings too, because a partial group cannot be
reassembled and letting the rest through would silently leak the very log you meant
to suppress. The same rule applies when the upload queue overflows: it evicts the
whole group rather than a single chunk.

### Splitting multiplies request count, not log count

`SafeGuardPlugin`'s rate limit counts logs before sanitization, so a log that splits
into 3 chunks becomes 3 uploads. Four logs allowed past the limiter can therefore
produce twelve requests.

This is inherent — the bytes have to reach your backend somehow — but it only
applies to logs that actually exceed `maxBytes`. If you are seeing sustained
splitting, the fix is upstream: stop attaching large payloads to logs, or raise
`maxBytes` if your storage can take it. Identical logs that both split are still
deduplicated as whole groups, so a repeated error does not multiply.

---

## 🔗 Related

- [UploadPlugin](./4-upload-plugin.md) — queueing, retries and drops
- [Offline persistence](./11-offline-persistence.md) — durable offline storage and replay
- [`beforeSend` hook](./9-before-send.md) — final interception point
