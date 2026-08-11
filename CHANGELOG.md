# Changelog

## 2.5.2-beta.0

Corrective reliable-delivery release for issues discovered after 2.5.1-beta.0.

### Fixed

- Runtime `deliveryScope` changes are rejected while offline persistence is still
  initializing. A zero pending count is not trusted until hydration finishes, preventing
  records from a previous tenant or project from being replayed through a newly bound target.
- Offline replay validates SDK split groups against `splitTotal` and one-based
  `splitIndex` values. Partial, duplicated or inconsistent groups are discarded as a unit
  instead of sending fragments that the backend cannot reconstruct.
- A callback's ordinary programming `TypeError` is no longer treated as proof that the
  network is offline. Known fetch network-failure signatures still pause delivery; other
  type errors follow the bounded, observable callback-error path.
- KV persistence restores the previous durable record when an index update fails. Updating
  Retry-After, parking or replay-attempt metadata can no longer erase the last good copy.
- Unexpected offline-store initialization failures now settle on the public `noop` backend,
  clear unusable in-memory state and emit the persistence-unavailable lifecycle signal
  instead of reporting `initializing` forever.
- KV and upload-cache writes/removals are verified after platform adapters return. Partial
  clear failures preserve the undeleted index and reject instead of reporting false success.
- Split chunks are admitted as a complete one-based group before any member can upload. Capacity
  eviction is planned and applied atomically; groups with an already in-flight member are protected
  because an issued request cannot be revoked. Split admission/rejection registries are bounded.
- Retryable attempts that settle after uninstall release their final logger reference, and
  thrown HTTP 4xx responses now follow the same terminal policy as returned HTTP results.
- IndexedDB reports persistence only after `IDBTransaction.oncomplete`; request success alone is no
  longer treated as durable. Malformed bodies fail cursor hydration without hanging it.
- Storage read failures are distinct from missing records across browser and miniapp adapters.
  Explicit clear/purge failures reject and preserve in-memory state instead of reporting success.
- `queue.concurrency` now creates real bounded batches while half-open recovery remains a single
  probe. Returned and thrown HTTP statuses, including redirects, use the same policy.
- Independent logical logs remain concurrent, while members of one `splitId` are serialized. A
  terminal chunk cancels unsent siblings, and one member's Retry-After defers the whole group.
- Retry counters and count-like configuration are normalized to bounded integer semantics, and
  temporary split bookkeeping expires or evicts at a hard cap.
- Persisted records are validated as a complete envelope before use; KV fallback must prove write,
  read and delete capability, and custom host event errors cannot change persistence outcomes.
- Explicit purge targets IDB and KV independently without fallback masking, invalid KV index
  counters cannot poison quota accounting, and the deprecated early-error script helper again
  accepts its documented optional configuration.
- `Retry-After` is now a server-owned deadline separate from SDK-local backoff. Explicit `flush()`
  may accelerate local scheduling but cannot violate the server's rate-limit contract.
- Cache restore, public requeue and offline replay now share one `logId`/split admission model.
  Remount cannot issue a second unresolved request, cached fragments cannot bypass completeness,
  oversized split declarations are rejected before the admission buffer can grow, and incomplete
  admissions share the same hard capacity with queued and parked work.
- Content deduplication emits a terminal `deduplicated` outcome so mirrored durable records are
  reconciled instead of resurfacing as ghost replay work.
- Persistence initialization is ordered as fallback reconciliation → hydrate → buffered writes.
  Failed scans degrade to delete-only mode, and KV records left by a previous IDB fallback are
  commit-first migrated when IndexedDB becomes available again.
- Persist writes, Retry-After/parking/replay-attempt updates, and terminal deletes now share one
  commit-aware retry path. Transient write intents are coalesced and bounded, replay waits for
  metadata commits, and `clear()` is a barrier over both durable data and pending intents.
- One canonical split-identity contract is shared by Logger, Upload, Offline and storage: a bare
  business `splitId` no longer couples independent logs, legacy KV records are normalized during
  hydration, and interleaved fanout groups remain atomic. Cache/live identity conflicts skip the
  entire cached group, while cleanup uses the hydrated index even if a member body disappeared.
- Hydration treats body reads and legacy normalization as one integrity scan; failure clears partial
  in-memory accounting and enters the explicit persistence-unavailable state.
- The browser IIFE remembers custom persistence locations used in the current runtime so a later
  explicit `offlinePersistence: false` purges those locations as well as the defaults.

## 2.5.1-beta.0

Completes two observability and protocol gaps left in the first reliable-delivery beta.

### Added

- `UploadResult.retryAfter` accepts the raw HTTP `Retry-After` header and parses both
  delta-seconds and HTTP-date. Existing `retryAfterMs` remains the explicit override, and
  retry scheduling uses the greater of the server delay and local backoff.
- Exported `parseRetryAfter()` for integrations which need the same standards-compliant
  parsing outside `UploadPlugin`.
- Exported `classifyHttpUploadResponse()` so fetch, XHR and miniprogram integrations share
  the same safe HTTP policy: 2xx succeeds; 408/425/429/5xx retry; other 4xx are terminal.
- `logger.getDeliveryStatus()` provides one deduplicated view across the active queue,
  in-flight attempts, parked entries and durable offline records. `totalPending` is a union
  by stable `logId`, not a misleading sum of memory and disk counts.
- Unified `delivery:*` lifecycle aliases and a listener-gated `delivery:status` event.
  Existing `upload:*` events and plugin-specific status methods remain fully supported.
- Upload status adds `pendingItems` for queued, in-flight and parked entries, while the
  existing `items` array remains queue-only for patch-version compatibility. It also exposes
  per-attempt outcome counts and stable IDs; offline status exposes the durable snapshot.

### Fixed

- Long `Retry-After` delays are scheduled in safe timer-sized segments instead of
  overflowing the host's `setTimeout` range and retrying immediately.
- Thrown axios/ky/got-style HTTP errors now preserve `Retry-After` from common
  `response.headers` shapes instead of retaining only the status classification.
- Browser `online` hints no longer wake a parked server/rate-limit item before its
  `Retry-After` deadline; they only probe work whose delay has actually expired.
- `oldestPendingAgeMs` now uses the original log capture timestamp, including replayed and
  in-flight entries, rather than only the most recent in-memory enqueue time.
- Delivery status snapshots tolerate missing or failing third-party status providers and
  now cover Upload/Offline plugin install and uninstall transitions without affecting the
  logging path.
- Offline deletion intent now survives a failed storage delete for every terminal path
  (success, rejection, TTL and quota eviction), preventing a deleted record from reappearing
  after remount. Replay also admits split entries as an atomic group within queue capacity.
- Incremental initialization can re-enable persistence in one call after an earlier explicit
  opt-out, and a rejected miniprogram initialization no longer leaks its persistence option
  into the next valid initialization.
- Multiple offline instances now claim the IndexedDB `dbName` and KV fallback `key`
  independently, closing cross-project replay gaps hidden by differing only one of them.
- Published `./plugins/*` subpaths now include every public plugin entry, including
  `OfflinePersistencePlugin`, `PayloadSanitizePlugin`, `BrowserApiErrorsPlugin`, and
  `BeforeSendPlugin`, instead of resolving to files absent from the npm tarball.
- `setUpload(null)` now truly pauses delivery without acknowledging queued logs. Rebinding a
  callback resumes the same queue, and an optional `deliveryScope` rejects unsafe target or
  tenant switches while pending work still exists.
- The browser/IIFE callback now preserves a returned `UploadResult` (including
  `Retry-After`) while continuing to accept legacy callbacks that return `void`.
- `offlinePersistence: false` is now a complete persistence master switch: it purges both
  OfflinePersistence records and UploadPlugin's queue cache, including a dormant KV
  fallback left by an earlier IndexedDB failure. An immediate re-enable waits for that
  purge and restores the last explicit storage options. Purging also protects storage
  currently owned by another active logger instance.
- Retry deadlines and parked state survive reloads in both persistence layers. Expiring the
  short Upload queue mirror no longer deletes a still-valid OfflinePersistence record.
- Durable terminal deletion markers prevent a record from resurrecting after a failed
  IndexedDB/KV delete, including across a fresh module lifecycle.
- Corrupt cache timestamps and unaddressable KV index elements are isolated without hiding
  healthy records; invalid metadata that still names a record fails closed so its body cannot
  become an orphan. A single record larger than `maxTotalBytes` is rejected instead of violating
  the configured storage ceiling.
- Parked recovery now releases one half-open probe at a time, and compatibility normalization
  preserves count-only third-party status providers without fabricating `undefined` log IDs.
- `setUpload(null)` now also stops an already-running queue loop after its current in-flight
  request, and rebinding a callback no longer emits a false `resumed` event while the network
  state machine remains paused.
- A split group larger than the configured upload queue stays durable for a future launch
  with a viable `maxSize`, without starting a permanent one-second replay wake loop.
- Upload lifecycle events are fail-safe even when a hand-written `AemeathInterface.emit()`
  throws, preventing an event observer from stranding an entry in `in-flight`.

## 2.5.0-beta.1

Reliable-delivery correction for the first 2.5 beta. Retry scheduling and log lifecycle
are now separate: exhausting the hot retry budget no longer claims that a recoverable log
was dropped.

### Changed

- `shouldRetry: true` retries even when `retryReason` is omitted; the reason is normalized
  to `unknown`. Conversely, an explicit non-payload `retryReason` is itself treated as retry
  intent when `shouldRetry` is omitted. Bare `{ success: false }` remains terminal for
  backward compatibility, and `shouldRetry: false` always wins.
- Recoverable server, auth, rate-limit, callback and cancellation failures move to a bounded
  `parked` area after `maxRetries`. The first cooling period is 60 seconds and subsequent
  periods back off to 15 minutes. Active and parked entries share `queue.maxSize`; only real
  terminal rejection or capacity eviction emits `upload:drop`.
- `online` is now a wake-up hint, not proof of end-to-end recovery. It releases one half-open
  probe and resumes the full queue only after the probe reaches the server or succeeds.
- `AbortError` is classified as `cancelled`, not as evidence that the whole channel is down.
  Thrown HTTP responses now distinguish permanent payload statuses, auth, rate limiting and
  retryable server failures. `UploadResult.retryAfterMs` can extend local backoff.
- The built-in cache persists parked state across reloads, coalesces hot-path writes, includes
  in-flight entries on teardown, and also saves on `pagehide` for Safari/WKWebView.
- `requestId` is documented correctly as a per-attempt correlation identifier. Backends must
  use the stable `logId` as their idempotency key.

### Added

- Typed events `upload:attempt`, `upload:retry-scheduled`, `upload:parked`, and
  `upload:unparked`.
- `getQueueStatus()` now reports `parked`, `maxSize`, `oldestPendingAgeMs`, and an item
  `state` of `queued` or `parked`.
- `storage-rejected` distinguishes entries the persistence engine cannot store from actual
  quota exhaustion.

### Fixed

- Offline replay now respects available upload capacity, cools down after local queue
  overflow, and keeps a durable record while its in-memory copy is parked.
- Offline initialization is lifecycle-epoch guarded, so a stale async init cannot clear a
  remounted instance's delivery tombstones. Deletes are read back before a delivered
  tombstone is cleared, preventing records from being replayed after a swallowed KV failure.
- `OfflinePersistencePlugin` is now installed by default whenever `upload` is configured,
  closing the page-restart gap in reliable delivery. Applications which cannot retain
  plaintext logs locally can opt out with `offlinePersistence: false`.

## 2.5.0-beta.0

Reliability release: logs should survive a bad network instead of being burned through
in a few seconds. Adds offline pausing, exponential backoff, payload sanitization, an
optional offline persistence plugin, and makes every drop observable.

This is a **beta** channel (`npm install aemeath-js@beta`). The `latest` tag still points
at 1.x.

### Upgrading from 2.4.x

Everything below is additive at the API level — no option was removed or renamed, and
`npx tsc` on existing app code passes. But three defaults changed behavior. Read these.

#### 1. A throwing `onUpload` no longer always burns the retry budget

Failures are now split into *transport* failures (the request never reached the server)
and *server* failures (the server answered, unhappily). Transport failures pause the
queue and wait for the network instead of consuming `maxRetries`.

When your callback **throws**, the SDK has to guess which one it was. It only concludes
"offline" on positive evidence — `TypeError` (what `fetch` throws on network failure),
`AbortError`/`TimeoutError`, or an `ERR_NETWORK`-style code with no `response` attached.
Everything else, including anything thrown by axios/ky/got for a 4xx or 5xx, counts as a
server failure and drains the retry budget exactly like 2.4 did.

To remove the guesswork, return `retryReason` explicitly:

```js
upload: async (log) => {
  try {
    const res = await fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
    if (!res.ok) return { success: false, shouldRetry: res.status >= 500, retryReason: 'server' };
    return { success: true };
  } catch (err) {
    return { success: false, shouldRetry: true, retryReason: 'network' };
  }
}
```

`retryReason` is optional and defaults to `'server'`.

**Mini programs must set it.** There is no `navigator.onLine` there, so `retryReason` is
the only signal the SDK has. `wx.request`'s `fail` callback only fires when the request
could not be sent, so it maps directly to `'network'`.

To keep 2.4 semantics wholesale, set `queue: { offlinePolicy: 'legacy' }`. That disables
pausing and backoff, and every failure consumes budget again.

#### 2. `PayloadSanitizePlugin` is installed by default

It rewrites oversized values and can split or drop entries. Disable with
`payloadSanitize: false`.

- **Data URLs and binary-ish values over 256 bytes are replaced with a placeholder**
  (`[omitted:data-url mime=image/png bytes=522]`), even on logs that are otherwise
  small. If you deliberately log small inline SVGs or `data:` URIs, you will lose them.
- **An entry over `maxBytes` (default 60000) is split into multiple entries.** Each chunk
  gets its own `logId` of the form `${originalLogId}-${n}`, and carries
  `tags.splitId` (the original `logId`), `tags.splitIndex`, `tags.splitTotal`, and
  `tags.splitBytes`. Chunk `logId`s are deliberately distinct so that a backend using
  `logId` as an idempotency key stores all of them rather than deduplicating away all
  but one. Join on `tags.splitId` to reassemble.
- `splitId` / `splitIndex` / `splitTotal` / `splitBytes` are **reserved tag names**. A tag
  of yours with one of those names is overwritten on split.
- Small fields (under 512 bytes) are replicated onto every chunk, so correlation data
  like `context.userId` / `context.sessionId` and your own tags survive on all of them.
  Large fields are distributed across chunks, so `error` and big `context` values land on
  exactly one chunk each.
- **A single field larger than the whole budget cannot be split, so the entry is dropped.**
  This is a new way to lose a log under default config. It is not silent: it goes to
  `console.error`, the `payload:rejected` event, and `onDrop` / `upload:drop` with
  `reason: 'payload-too-large'`, naming the offending field.
- Custom top-level fields your own plugins attach to a `LogEntry` are replicated onto every
  chunk. If one of them alone exceeds the budget the entry is rejected, since a top-level
  field cannot be redistributed.
- Extremely large or pathologically shaped payloads stop being walked after an internal
  node budget; the remainder is replaced with `[omitted:walk-budget-exceeded]`. This
  protects the main thread from payloads whose shared references expand exponentially.
- A property whose getter throws is replaced with `[omitted:unserializable]` rather than
  taking down the whole sanitization pass.
- `payloadSanitize.maxBytes` is floored to an integer, and values under 1024 fall back to
  the default rather than rejecting every log.
- One `logger.error(...)` that splits into N chunks now fires your `log` listener N times,
  prints N console lines, and produces N upload requests. Fan-out across all plugins is
  capped at 64 entries per log, with a one-time console warning if the cap is hit.

#### 3. New console output

`console.info` once per session on the first stripped value; `console.warn` up to 3× on
split; `console.error` up to 3× on rejection. If your tests assert on a clean console,
either expect these or set `payloadSanitize: false`.

#### Type-level change

`AfterLogResult` widened from `false | LogEntry | void` to
`false | LogEntry | LogEntry[] | void` so a plugin can fan one entry out into several.
Implementing `afterLog` is unaffected. Code that *consumes* another plugin's `afterLog`
return value and narrows it with a plain truthiness check now needs an `Array.isArray`
guard.

### Added

- `queue.offlinePolicy` (`'pause'` | `'legacy'`, default `'pause'`), `queue.retryBackoff`,
  `queue.suspectedOfflineThreshold`, and `cache.ttl` on `UploadPlugin`.
- `UploadResult.retryReason`: `'network'` | `'server'` | `'payload'`.
- `onDrop` callback and `upload:drop` event covering queue overflow, retry exhaustion,
  cache expiry, server rejection, and oversized payloads.
- Events `upload:enqueued`, `upload:success`, `upload:paused`, `upload:resumed`,
  `payload:split`, `payload:rejected`.
- `AemeathEventMap`, so `logger.on('upload:drop', ({ log, reason }) => …)` is typed.
- `UploadPlugin#requeue()`, `UploadPlugin#isPending()`, and drop counters on
  `getQueueStatus()`.
- `PayloadSanitizePlugin` (default on) with `payloadSanitize.maxBytes`.
- `OfflinePersistencePlugin` (opt-in via `offlinePersistence`), persisting to IndexedDB
  with fallback to key-value storage and then to a no-op store. Replayed entries keep
  their original `timestamp` and gain `tags.offlineReplay` and `tags.uploadedAt`.

### Fixed

- **Self-feedback loop (P0, latent since v1.1):** `UploadPlugin` now runs `onUpload`
  inside a network-capture ignore window. Fetch / XHR / `wx.request` started during that
  window are not recorded by `NetworkPlugin`, so a successful upload can no longer be
  logged as `HTTP 200: POST /…` and re-uploaded forever. Previously this only "worked"
  when the upload URL happened to contain one of six hard-coded path fragments
  (`/api/logs`, …). Default config with a normal endpoint produced ~9 uploads/sec that
  never converged (confirmed in Playwright Chromium + WebKit). Also exports
  `runWithoutNetworkCapture` for custom upload paths that bypass `UploadPlugin`.
- `UploadPlugin` no longer treats a server 5xx as evidence that the device is offline, so
  a backend outage drains the retry budget instead of pausing the queue indefinitely.
- Retries are spaced by exponential backoff rather than fired back to back.
- A single log that repeatedly fails at the transport layer now triggers the offline pause
  even when other logs keep resetting the global failure counter.
- Corrupted cache entries with a non-numeric `retryCount` no longer retry forever.
- Splitting no longer discards top-level fields outside a fixed whitelist. Previously an
  entry carrying a custom field could lose most of its content while the console reported
  a successful split.
- Split chunks are now guaranteed to fit within `maxBytes`; the per-chunk budget estimate
  previously undercounted the chunk `logId` suffix and the `context` wrapper.
- An `__proto__` key from `JSON.parse`'d data is preserved as an ordinary key instead of
  being dropped and swapping the sanitized copy's prototype.
- An unserializable `message` no longer causes the whole entry (including an intact
  `context`) to be rejected.
- An oversized reserved `split*` tag no longer rejects an entry over a value that
  splitting would have overwritten anyway.
- `utf8Bytes` no longer undercounts strings containing lone surrogates on runtimes without
  `TextEncoder`.
- `getAemeath()` installs `PayloadSanitizePlugin`, so the default-on sanitizer is present
  no matter which entry path created the instance.
- `initAemeath()` on an existing instance can now add `payloadSanitize` and
  `offlinePersistence` incrementally, and no longer reports `cache` / `onDrop` / `queue` /
  `getPriority` as ignored when they were applied.
- The `<script>` (IIFE) build installs `PayloadSanitizePlugin` and no longer swallows
  exceptions from the upload callback.

#### Reliability of the upload loop itself

- An exception raised inside the upload loop no longer bricks the plugin. `processQueue()`
  is invoked as a floating promise from six places (timers, the `online` handler, cache
  restore), so a throw used to surface as an unhandled rejection while the `finally` block
  immediately rescheduled with a zero delay — a hot loop that uploaded nothing ever again.
  The loop now catches, marks the error as SDK-internal, and backs off for 30s.
  The reachable trigger was a cache entry whose `error.stack` was not a string; `stack` is
  now type-checked before use. Because `ErrorCapturePlugin` would capture that unhandled
  rejection as a *host* error and upload it through the same broken path, this could feed
  on itself: measured at 216 self-generated logs and ~48 KB of cache growth in 300 ms.
- `ErrorCapturePlugin` now recognises the `[Aemeath]`, `[Aemeath:*]`, `[PayloadSanitize]`
  and `[OfflinePersistence]` prefixes, so warnings from the newer plugins are no longer
  captured and re-uploaded as host errors.
- `flush()` no longer destroys the retry budget. It bypasses `nextAttemptAt`, and failed
  items are re-queued from inside the same loop, so one `flush()` used to retry every log
  to exhaustion in a single burst (measured: 12 requests in 1.2s, all three logs dropped).
  Each log is now attempted at most once per pass.
- Concurrent `flush()` calls no longer interfere. `forceRun` was a shared boolean, so the
  second call's cleanup truncated the first mid-loop and leaked the flag into scheduled
  runs; it is now reference-counted.
- Re-installing a plugin instance works again. `uninstall()` set a `destroyed` flag that
  `install()` never cleared, so `logger.use(sameInstance)` — what an HMR boundary or a
  framework remount does — produced a plugin that reported healthy while silently
  uploading nothing. Fixed in both `UploadPlugin` and `OfflinePersistencePlugin`.
- A torn-down `UploadPlugin` no longer acts after teardown. An in-flight request that
  landed post-`uninstall()` would invoke the host's `onDrop`, re-queue into a dead queue,
  and — because the cache key is deterministic and therefore shared across instances —
  overwrite the *live* plugin's cache.
- `plugin.uninstall()` called without an argument now detaches the `log` listener, using
  the logger reference stored at install time. Previously the dead instance kept collecting
  logs and firing `queue-overflow` drops for logs it could never send.
- A probe that receives an explicit rejection (`shouldRetry: false`) now resumes the queue.
  The transport is demonstrably fine in that case, but half-open state was never cleared,
  leaving `paused: true` forever, `upload:resumed` never firing, and offline replay
  permanently stalled.
- The `upload:enqueued` payload and `getQueueStatus()` now report `paused` using the same
  criterion. They disagreed during half-open, which meant logs produced in that window were
  not mirrored to offline storage.
- A log in flight when the page unloads is written to the cache instead of vanishing. It was
  spliced out of the queue and tracked only by id, so it reached neither the cache nor the
  server.
- Definitively dropped logs are removed from the cache instead of being restored and
  re-uploaded in the next session.
- Repeatedly calling `flush()` while offline no longer inflates the probe interval toward
  its 60s ceiling; the probe backoff advances only when a probe actually runs.

#### Integrity across sanitize / upload / offline persistence

- **Logs pending across a page reload are no longer uploaded twice.** With
  `offlinePersistence` enabled and the upload cache at its default, `UploadPlugin.install()`
  restored from cache and uploaded synchronously while `OfflinePersistencePlugin` was still
  awaiting its store. The success cleanup found an empty index and returned, so the
  persisted copy survived, was read back during hydration, and replayed. Successes that
  arrive before hydration now leave a tombstone that hydration honours.
- **Two identical logs that both split are deduplicated again.** `generateLogHash` mixed in
  `splitId`, which is a random per-entry value, so byte-identical logs produced disjoint
  hashes and one upload became six. The hash now uses `splitIndex`/`splitTotal`, and
  deduplication compares whole split groups so chunks from different groups can never be
  interleaved into an unassemblable mix.
- **A split group is now delivered whole or not at all.** Queue overflow evicts the entire
  group instead of one chunk, and a `beforeSend` hook that suppresses one chunk suppresses
  its siblings. Previously a hook written to drop a log containing a secret dropped only the
  chunk carrying it and let the rest through.
- **`maxBytes` now holds on the wire.** `decorateForUpload` adds `requestId` and
  `tags.uploadedAt` after sanitization has already declared the entry within budget, so
  every upload exceeded the declared limit by roughly 110 bytes — which matters because
  `maxBytes` is meant to be set against a hard storage limit such as a `TEXT` column. The
  sanitizer now reserves headroom (`maxBytes / 8`, capped at 256 bytes).
- A replayed log evicted by *local* queue overflow no longer counts against
  `maxReplayAttempts`. It was never sent, so spending replay budget on local queue
  contention could abandon a log that was still safely on disk.
- Drops originating in the offline store (quota eviction, TTL expiry) are reported with
  `source: 'offline-store'` instead of being mislabelled `'offline-replay'`, which implied
  a replay that never happened.

#### Diagnostics

- The rejection message for an oversized field no longer contradicts itself. It reported the
  configured `maxBytes` while comparing against a lower internal limit, producing output like
  "3630 bytes, above the 4000-byte budget". It now reports the limit actually applied and
  explains why it is lower than the configured value. The `payload:rejected` event carries
  the same value in a new `budget` field.

#### Multiple SDK instances on one page

- Two instances sharing a storage slot no longer corrupt each other. `cache.key`
  (`__logger_upload_queue__`) and `dbName` (`aemeath-offline`) both have deterministic defaults,
  so a host site and an embedded widget that each initialise the SDK claimed the same
  localStorage entry and the same IndexedDB database. They overwrote each other's queues, and
  on the next visit each could restore — and upload — the other project's logs to its own
  endpoint. The SDK now detects the collision and yields: the second `UploadPlugin` turns its
  cache off, the second `OfflinePersistencePlugin` stays inactive, and both print an actionable
  warning naming the option to set. Uploading itself is never affected, and the instance
  reclaims its slot if the other one uninstalls. This behaviour predates 2.5, but offline
  pausing keeps logs cached far longer, which widened the window considerably.

#### Offline persistence never settling after a read failure

- A failure to read the offline store on startup no longer leaves the plugin permanently
  unsettled. `loadMeta()` rejecting — a corrupted database, a quota error, a parse failure on
  the localStorage backend — returned early without marking hydration complete. Two things
  followed silently: the tombstone set grew by one entry per successful upload for the life of
  the page, and `handleSuccess` recorded tombstones instead of deleting records, so logs that
  had already been uploaded stayed on disk and were replayed later. That is the duplicate-upload
  defect fixed earlier in this release, reachable through a different path. Hydration now
  settles in a `finally`, and `init()` no longer lets an exception escape as an unhandled
  rejection.

#### Teardown no longer aborts halfway

- A failure while detaching handlers during `uninstall()` no longer skips the rest of the
  cleanup. Detaching goes through host APIs — a mini program's `offAppHide`, the browser's
  `removeEventListener`, IndexedDB's `close()` — and whether those throw is not up to the SDK.
  A throw used to abandon the remaining steps, leaving listeners attached and `this.logger`
  non-null, so the uninstalled instance pinned the entire logger and its plugins in memory.
  Applications that remount frequently (HMR, framework teardown cycles) accumulated one such
  retained graph per cycle. Each cleanup step is now fault-isolated, and `uninstall()` itself
  no longer propagates.

### Known limitations

- Two instances that alternate between visits (one project on one load, another on the next)
  can still cross-restore under the shared default key, because the SDK has no stable project
  identity to distinguish them. Set `cache.key` and `dbName` explicitly in multi-instance
  deployments.
- `initAemeath()` references every plugin it can install from a runtime branch, so its
  bundle contains them regardless of your options, including the IndexedDB backend in the
  mini program build. Compose with `new AemeathLogger()` + `.use()` if you need the
  smallest bundle.
- Offline replay is not coordinated across tabs; two tabs replaying the same persisted
  store can upload duplicates. Dedupe on `logId` server-side.
