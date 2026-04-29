# 8. Plugin Ordering

> Available since `aemeath-js@1.5.0` (v1 LTS) and `aemeath-js@2.4.0` (v2).
> Earlier versions did not support `priority` and ran all plugins in `use()` call order (equivalent to all plugins having `priority: 0`).

---

## Why does plugin order matter?

`AemeathLogger` is a plugin pipeline. Multiple plugins participate in each log entry's lifecycle in sequence:

```
log() called
    ↓
[plugin A.beforeLog] → [plugin B.beforeLog] → ...   (pre-create hooks)
    ↓
LogEntry built
    ↓
[plugin A.afterLog]  → [plugin B.afterLog]  → ...   (post-create hooks)
    ↓
listener receives entry
```

**The order of plugins affects final behavior.** For example:

- `BrowserApiErrorsPlugin` must be installed **before** `ErrorCapturePlugin` (to wrap browser APIs first so error capture sees full stacks)
- `BeforeSendPlugin` (for redaction) must run **before** `UploadPlugin` consumes entries, otherwise sensitive data is uploaded

To let users and plugin authors **explicitly control order**, v1.5.0 (v1 LTS) / v2.4.0 (v2) introduced the `priority` field.

---

## Rules

```ts
interface AemeathPlugin {
  /**
   * Plugin execution priority (lower runs first).
   * - Default: 0
   * - Same priority preserves use() call order (stable sort).
   */
  priority?: number;
}
```

Full rules:

1. **Lower numbers run first** (applies to `install` / `beforeLog` / `afterLog` / `uninstall`)
2. **Same priority preserves `use()` call order** (stable sort)
3. **Plugins without `priority` are treated as `0`** (fully backward compatible with v2.3 and earlier)

---

## Use the `PluginPriority` constants

Avoid magic numbers:

```ts
import { PluginPriority } from 'aemeath-js';

export const PluginPriority = {
  EARLIEST: -1000, // Earliest: must wrap browser APIs before any other plugin
  EARLY:    -100,  // Early: error capture, beforeLog interceptors
  NORMAL:    0,    // Default: most functional plugins
  LATE:      100,  // Late: consumers (upload, batching)
  LATEST:    1000, // Latest: end-of-pipeline interceptors (beforeSend, redaction)
};
```

**Rule of thumb:**

| Use case | Recommended priority |
|----------|---------------------|
| Plugins that monkey-patch global APIs | `EARLIEST` |
| Error capture, SafeGuard, anything that filters/modifies input | `EARLY` |
| General functional plugins (add context, enrich data) | `NORMAL` |
| Upload, persistence, final consumption | `LATE` |
| End-of-pipeline interceptors (redaction, filtering) | `LATEST` |

---

## Built-in plugin priorities

| Plugin | Priority | Reason |
|--------|----------|--------|
| `BrowserApiErrorsPlugin` | `EARLIEST` (-1000) | Must wrap browser APIs before any other plugin installs |
| `ErrorCapturePlugin` | `EARLY` (-100) | Error capture, must intercept early |
| `SafeGuardPlugin` | `EARLY` (-100) | Rate limiting / dedup, must take effect before consumption |
| `NetworkPlugin` | `NORMAL` (0) | Regular functional plugin |
| `PerformancePlugin` | `NORMAL` (0) | Regular functional plugin |
| `EarlyErrorCapturePlugin` | `NORMAL` (0) | Regular functional plugin |
| `UploadPlugin` | `LATE` (100) | Consumer at the end of the pipeline |
| `BeforeSendPlugin` (v1.5.0+ / v2.4.0+) | `LATEST` (1000) | End-of-pipeline interceptor, must run last |

> **Note:** `SafeGuardPlugin` and `ErrorCapturePlugin` are both `EARLY`; their relative order depends on `use()` order.
> `initAemeath()` currently calls `use(error-capture)` then `use(safe-guard)`.
> The behavioral difference is negligible: `ErrorCapturePlugin` has no `beforeLog/afterLog` hooks
> (it only registers global error handlers in `install`), so all `beforeLog` rate-limiting still
> goes through `SafeGuardPlugin`.

---

## Custom plugin examples

### Example 1: Must wrap a global object first

```ts
import { PluginPriority, type AemeathPlugin } from 'aemeath-js';

export class MyApiWrapperPlugin implements AemeathPlugin {
  readonly name = 'my-api-wrapper';
  readonly priority = PluginPriority.EARLIEST;

  install(logger) {
    const originalFn = window.someApi;
    window.someApi = (...args) => {
      try {
        return originalFn.apply(window, args);
      } catch (err) {
        logger.error(err);
        throw err;
      }
    };
  }
}
```

### Example 2: Run before built-in Upload but after others

```ts
import { PluginPriority, type AemeathPlugin } from 'aemeath-js';

export class MyEnricherPlugin implements AemeathPlugin {
  readonly name = 'my-enricher';
  readonly priority = PluginPriority.NORMAL; // between EARLY and LATE

  install() {}

  afterLog(entry) {
    return { ...entry, extra: { enriched: true } };
  }
}
```

### Example 3: Backward compatibility (no priority)

```ts
// Existing plugins need no changes — behavior is identical to priority: 0
export class LegacyPlugin implements AemeathPlugin {
  readonly name = 'legacy';
  install() {}
  afterLog(entry) {
    return entry;
  }
}
```

---

## Advanced API: `getPluginInstance(name)`

Available since v1.5.0 (v1 LTS) / v2.4.0 (v2). Look up an installed plugin by name:

```ts
const beforeSend = logger.getPluginInstance('before-send');
beforeSend?.setHook((entry) => { /* ... */ });
```

Use cases:

- Mutating plugin state at runtime (e.g. `BeforeSendPlugin.setHook`)
- Debugging / testing

> For regular use, prefer `hasPlugin()` / `getPlugins()`.

---

## Visualizing the order

```ts
logger.getPlugins().forEach((p) => {
  console.log(`[${p.priority}] ${p.name}`);
});

// Output (default initAemeath + user-added BeforeSend):
// [-1000] browser-api-errors
// [-100]  error-capture
// [-100]  safe-guard
// [0]     network
// [100]   upload
// [1000]  before-send
```

> `getPlugins()` returns plugins in **actual execution order**, safe for debugging.

---

## FAQ

### Q1: My old plugins don't declare `priority`. Will they break?

No. **Fully backward compatible.** Plugins without `priority` are treated as `priority: 0` and run in `use()` call order.

### Q2: Will third-party plugin libraries be force-upgraded?

No. Third-party plugins work without modification. Authors who want explicit ordering can add `priority` in a future version.

### Q3: How do I override a built-in plugin's `priority`?

Wrap or extend the instance:

```ts
import { UploadPlugin } from 'aemeath-js';

class MyUpload extends UploadPlugin {
  override readonly priority = 50;
}
```

### Q4: Does `priority` affect `uninstall` order?

Yes. `uninstall` runs in **reverse priority order** to preserve dependency relationships.

### Q5: What if two third-party plugins conflict?

**Recommended**: extend the class and re-declare `priority` (type-safe):

```ts
import { NetworkPlugin } from 'aemeath-js';

class EarlyNetworkPlugin extends NetworkPlugin {
  override readonly priority = -50; // force earlier
}
logger.use(new EarlyNetworkPlugin(/* ...same constructor args */));
```

> ⚠️ The `override` keyword is required when the parent class declares the same field (without it, projects with `noImplicitOverride` enabled will hit TS4114).

For one-off / debugging use, you can also patch an existing instance (note `priority` is `readonly`, so a cast is required):

```ts
const networkPlugin = new NetworkPlugin();
(networkPlugin as { priority: number }).priority = -50;
logger.use(networkPlugin);
```

> The cast bypasses the type checker; prefer the subclass approach for long-term code.
