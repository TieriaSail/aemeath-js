# Unified delivery status

> v1.10.1+ · One read API and one event stream for memory queue and durable replay

```typescript
const logger = initAemeath({ upload });

const current = logger.getDeliveryStatus();
logger.on('delivery:status', (status) => {
  renderDeliveryIndicator(status);
});
```

`totalPending` is deduplicated by stable `logId`; a log present in both the upload queue
and IndexedDB counts once. `queued`, `inFlight`, `parked`, `persisted`, and `buffered` remain raw
layer counters for diagnosis. `persistedOnly` shows records that exist only on disk.
`buffered` counts persistence writes or metadata updates waiting for a storage retry; their
`logId`s are included in `totalPending` without double-counting committed copies.

The top-level state is one of:

| State | Meaning |
|---|---|
| `disabled` | No UploadPlugin is installed |
| `idle` | Upload is enabled and nothing is pending |
| `delivering` | Work is queued, in flight, or replaying |
| `paused` | Network or `setUpload(null)` is holding the queue |
| `degraded` | Work is parked/buffered, transport failures exist, or persistence is unavailable |

The status also exposes attempt/drop counters, oldest pending age, and persistence backend,
bytes, buffered writes, quota drops, legacy give-ups, and successful replay count.

## Lifecycle events

The original `upload:*` events remain compatible. 1.10.1 additionally emits unified aliases:

| Existing event | Unified alias |
|---|---|
| `upload:enqueued` | `delivery:queued` |
| `upload:attempt` | `delivery:attempt` |
| `upload:retry-scheduled` | `delivery:retry-scheduled` |
| `upload:parked` / `upload:unparked` | `delivery:parked` / `delivery:unparked` |
| `upload:success` | `delivery:delivered` |
| `upload:drop` | `delivery:dropped` |
| `upload:paused` / `upload:resumed` | `delivery:paused` / `delivery:resumed` |
| `upload:offline-unavailable` | `delivery:persistence-unavailable` |

`delivery:persisted` is emitted after a durable record is successfully written.
Listener exceptions are isolated and cannot break upload or persistence chains.

The status API is observational; it does not replace mandatory backend idempotency on
`(project/tenant scope, logId)`.
