# Changelog

## 1.10.2 — 2026-08-27

Unified singleton error-capture configuration.

### Added

- `initAemeath({ errorCapture })` now accepts every `ErrorCapturePluginOptions` field, including
  `captureUnhandledRejection`, `captureResourceError`, `captureConsoleError`, `errorFilter`,
  `routeMatch`, and `debug`. `enabled` remains the singleton-level installation switch.
- The public `ErrorCaptureConfig` type is exported from both the root and singleton entries.

### Changed

- A nested `errorCapture.errorFilter` takes precedence over the legacy top-level `errorFilter`.
- Resource errors now use the same route matching, error filtering, and five-second deduplication
  pipeline as other automatically captured errors. Resource interception remains independently
  configurable through `captureResourceError` and defaults to enabled.
- Logger-owned console output is excluded from `captureConsoleError`, preventing a manual
  `logger.error(..., { error })` from being captured a second time.
- Uninstall restores `console.error` only when the plugin still owns the active patch, so a patch
  installed later by the host is not overwritten.

## 1.10.1 — 2026-08-11

Reliable-delivery backport for the 1.x browser architecture.

### Changed

- `initAemeath({ upload })` and the IIFE entry enable offline persistence by default.
  Set `offlinePersistence: false` to disable and purge SDK-owned upload/offline storage.
- `UploadPlugin` now defaults to `queue.offlinePolicy: 'pause'`. Use `legacy` to restore
  1.10.0 retry/drop behavior.
- A single upload attempt now has a 30-second timeout by default so a hung callback cannot
  stall delivery indefinitely. Set `queue.uploadTimeoutMs: 0` to disable the guard explicitly.
- Recoverable failures exhaust a bounded hot-retry budget and enter `parked` instead of
  being deleted. Retry and park deadlines survive reloads.

### Added

- HTTP response classification and standard `Retry-After` parsing through
  `classifyHttpUploadResponse()` and `parseRetryAfter()`; Axios-style thrown responses are
  classified automatically.
- Unified `logger.getDeliveryStatus()` plus `delivery:*` lifecycle aliases.
- `setUpload(null)` true pause/resume semantics and `deliveryScope` protection against
  changing tenant/project while work remains pending.
- Persistent terminal tombstones, group-atomic split replay/eviction, corrupt-record
  validation, independent IDB/KV resource collision protection, and runtime persistence
  disable/re-enable support.
- Complete build artifacts for all public `./plugins/*` entry points.

### Important backend requirement

1.10.1 prevents duplicate replay within one SDK instance, but does not coordinate multiple
browser tabs. Ingestion must enforce idempotency on `(project/tenant scope, logId)` and treat
duplicate keys as success. `requestId` changes on each attempt and is not a deduplication key.

Cross-tab coordination is planned for 2.6.0; backend idempotency remains required because a
network outcome can be uncertain even with client-side leadership.

### Reliability corrections

- Block `deliveryScope` changes until offline hydration has reached a known state.
- Validate `splitTotal` and `splitIndex` before replaying persisted split groups; incomplete
  groups are discarded atomically.
- Distinguish known fetch network failures from ordinary callback `TypeError` exceptions.
- Restore the previous KV record when an index update fails.
- Verify KV and upload-cache writes/removals after adapters return, and keep undeleted index
  entries when a partial clear fails instead of reporting false success.
- Treat `IDBTransaction.oncomplete`, not request success, as the IndexedDB durability boundary.
  Storage reads that fail are never treated as missing records, and explicit clear/purge calls
  reject on failure without erasing the in-memory delivery state.
- Admit SDK split chunks as a complete one-based group before any member can upload. Capacity
  eviction is planned and applied atomically, in-flight groups are protected, and split rejection/
  admission registries are bounded and expiring.
- Make `queue.concurrency` effective while preserving one-at-a-time half-open probes; returned and
  thrown HTTP responses now share the same classification for every status, including redirects.
- Preserve concurrency across independent logical logs while serializing members of one `splitId`;
  a terminal first chunk can now cancel unsent siblings, and one member's Retry-After defers the
  entire group instead of allowing later chunks to bypass the server deadline.
- Reject malformed persisted bodies without hanging IndexedDB cursor traversal, and normalize
  externally writable retry counters and count-like configuration to non-negative integers. The
  persisted record validator now covers the full envelope, optional retry fields and log shape.
- Require KV backends to pass write, read and delete probing, and isolate custom host event errors
  so observability callbacks cannot change persistence outcomes.
- Run explicit purge against IDB and KV independently without fallback masking; a failed IDB clear
  can no longer be reported as success merely because the KV fallback was cleared.
- Validate KV index metadata with the same bounded counter/timestamp rules as record bodies, and
  restore the deprecated early-error script helper's optional configuration contract.
- Expand the release typecheck gate from three selected tests to the complete test suite.
- Settle unexpected persistence initialization failures on the public `noop` backend.
- Separate the server-owned `Retry-After` deadline from SDK-local backoff: `flush()` may bypass
  local scheduling but can no longer violate a server rate-limit contract.
- Route cache restore, public requeue and offline replay through one `logId`/split admission model;
  remount no longer issues a second request while the original attempt is unresolved, incomplete
  cached split groups cannot upload, declared split size is bounded before buffering begins, and
  incomplete admissions share the same hard capacity with queued and parked work.
- Give content deduplication an explicit terminal outcome so a duplicate mirrored on disk is deleted
  instead of surviving as a ghost replay record.
- Treat fallback reconciliation and hydration as prerequisites for writes. Requests arriving during
  initialization are buffered, failed scans enter read-only degradation, and records left in KV by a
  previous IndexedDB fallback are commit-first migrated when IndexedDB becomes available again.
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
