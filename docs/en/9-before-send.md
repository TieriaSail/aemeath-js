# 9. `beforeSend` — End-of-Pipeline Interceptor (Redaction / Filtering / Enrichment)

> Available since `aemeath-js@2.4.0`.
> Naming inspired by [Sentry's `beforeSend`](https://docs.sentry.io/platforms/javascript/configuration/filtering/#using-beforesend).

---

## 1. What is it?

`beforeSend` is a **global** hook that sits at the **end** of the SDK's logging pipeline:

```
log() / auto error capture / NetworkPlugin / ...
              ↓
plugin beforeLog → build LogEntry → plugin afterLog → ★ beforeSend ★ → listener / UploadPlugin
```

**Key properties:**

- ✅ **Applies to ALL logs**: manual (`logger.info/error/...`), auto-captured errors, and `NetworkPlugin` network logs all go through
- ✅ **Runs at the end**: after every plugin's `afterLog`, before all listeners (including `UploadPlugin`)
- ✅ **Fail-safe**: exceptions inside the hook are silently swallowed and never break your page
- ✅ **Replaceable at runtime**: use `setBeforeSend(...)` to swap hooks dynamically (e.g. after user login)

---

## 2. Three return values, three behaviors

```ts
import { initAemeath } from 'aemeath-js';

initAemeath({
  beforeSend: (entry) => {
    // 1. Mutate: return a new LogEntry
    return { ...entry, message: redact(entry.message) };

    // 2. Drop: return null
    // return null;

    // 3. Pass through: return entry / undefined / void
    // return entry;
  },
});
```

| Return value | Behavior |
|--------------|----------|
| `LogEntry` | Use the new entry |
| `null` | **Drop** — neither listeners nor UploadPlugin will see it |
| `undefined` / `void` / the original `entry` | Pass through unchanged |
| Throws | Original entry passes through (fail-safe); `console.warn` is only emitted when `debug: true` |
| `Promise` / thenable (typical mistake: declaring the hook as `async`) | Pass through unchanged; **always** emits `console.warn` because the hook must be synchronous |
| Any other invalid value (number / string / object missing `logId` / `level`) | Pass through unchanged; **always** emits `console.warn` to surface the bad return value |

---

## 3. The `LogEntry` shape (you need this to redact effectively)

```ts
interface LogEntry {
  /** Auto-generated, do not modify */
  logId: string;
  /** Internal, used by UploadPlugin */
  requestId?: string;
  level: 'debug' | 'info' | 'track' | 'warn' | 'error';
  /** Main message — primary redaction target */
  message: string;
  timestamp: number;
  environment?: string;
  release?: string;

  /** Error info (only for error level) */
  error?: {
    type: string;             // 'TypeError' / 'BusinessError' / 'NetworkError' / ...
    value: string;
    stacktrace?: { frames: StackFrame[] };
    stack?: string;
    [key: string]: unknown;
    // NOTE: For network logs, url/method/status/requestData/responseData live on
    // `entry.context`, NOT on `entry.error` (see the NetworkPlugin log shape below).
  };

  /** Tags for categorization */
  tags?: {
    errorCategory?: 'global' | 'promise' | 'resource' | 'early' | 'manual' | string;
    component?: string;
    action?: string;
    [key: string]: string | number | boolean | undefined;
  };

  /** Detailed context */
  context?: {
    user?: { id?: string; name?: string; email?: string; [key: string]: unknown };
    device?: { platform: string; userAgent: string; ... };
    app?: { name: string; version: string; environment: string; ... };
    [key: string]: unknown;
  };
}
```

### `NetworkPlugin` log shape

`NetworkPlugin` writes its fields to **`tags` and `context`** (not `error`):

```ts
{
  logId: 'log_xxx',
  level: 'info' | 'warn' | 'error',
  // success: 'HTTP 200: GET /api/user' / error: 'HTTP 500: POST /api/order' / slow: 'Slow request: ...'
  message: 'HTTP 200: GET /api/user',
  timestamp: 1234567890,
  tags: {
    errorCategory: 'http',                    // NOTE: 'http' (not 'network')
    type: 'fetch' | 'xhr' | 'request',         // 'request' is for miniprogram wx.request
    method: 'GET',
    httpStatus: 200,                          // present only when status is set
    slow: true,                               // present only for slow requests
  },
  context: {
    type: 'HTTP_REQUEST' | 'HTTP_ERROR',
    url: 'https://api.example.com/user?token=xxx&phone=13800138000',
    method: 'GET',
    status: 200,
    statusText: 'OK',
    duration: 123,
    timestamp: 1234567890,
    // ⚠️ requestData / responseData are typed as `unknown`:
    // - JSON request / response: parsed via safeParseJSON into an **object**, e.g. { password: 'secret' }
    // - FormData / Blob / ArrayBuffer: replaced with a placeholder string (e.g. '[FormData]')
    // - non-JSON text: kept as the raw **string**
    // When writing redaction rules, handle both string and object shapes
    // (see basic.ts / redact-network.ts examples).
    requestData: { password: 'secret' },      // field name is requestData (not requestBody)
    responseData: { token: 'jwt_xxx' },       // field name is responseData (not responseBody)
    error: { /* ... */ },                     // present only when the request failed
  },
  // Note: `entry.error` is NOT set for network logs. Network errors live at `entry.context.error`.
}
```

> 💡 **Redaction tip**: network logs often contain PII. At minimum, consider sanitizing `context.url`, `context.requestData`, and `context.responseData`.
> NetworkPlugin currently does **not** capture request/response headers, so there's nothing to redact there.

---

## 4. Common scenarios

### Scenario 1: strip sensitive URL params

```ts
import { initAemeath } from 'aemeath-js';

initAemeath({
  upload: async (log) => { /* ... */ },
  beforeSend: (entry) => {
    // network logs use errorCategory: 'http'
    if (entry.tags?.errorCategory !== 'http') return entry;

    const url = entry.context?.['url'];
    if (typeof url !== 'string') return entry;

    return {
      ...entry,
      context: {
        ...entry.context,
        url: url.replace(/(token|phone|idCard)=[^&]+/gi, '$1=***'),
      },
    };
  },
});
```

### Scenario 2: drop request / response body, keep status only

```ts
beforeSend: (entry) => {
  if (entry.tags?.errorCategory !== 'http' || !entry.context) return entry;
  return {
    ...entry,
    context: {
      ...entry.context,
      requestData: '[REDACTED]',
      responseData: '[REDACTED]',
    },
  };
};
```

### Scenario 3: redact user context

```ts
beforeSend: (entry) => {
  if (!entry.context?.user) return entry;
  const { id } = entry.context.user as { id?: string };
  return {
    ...entry,
    context: {
      ...entry.context,
      user: id ? { id } : undefined, // keep id, drop name / email / phone
    },
  };
};
```

### Scenario 4: drop noisy logs

```ts
beforeSend: (entry) => {
  // Drop 401 / 403 network logs
  if (
    entry.tags?.errorCategory === 'http'
    && [401, 403].includes(entry.context?.['status'] as number)
  ) {
    return null;
  }
  // Drop business "noise" logs
  if (entry.tags?.errorCategory === 'noise') return null;
  return entry;
};
```

### Scenario 5: enrich with a `traceId`

```ts
beforeSend: (entry) => ({
  ...entry,
  context: {
    ...entry.context,
    traceId: getTraceId(),
  },
});
```

---

## 5. Runtime swap (`setBeforeSend`)

Sometimes the redaction rules are not known at init time (e.g. they depend on logged-in user info). Swap at runtime:

```ts
import { initAemeath, setBeforeSend } from 'aemeath-js';

initAemeath({ upload: async (log) => { /* ... */ } });

// After login
setBeforeSend((entry) => {
  if (entry.context?.user) {
    return {
      ...entry,
      context: { ...entry.context, user: { id: currentUserId } },
    };
  }
  return entry;
});

// On logout / account switch
setBeforeSend(null); // remove hook, restore pass-through
```

---

## 6. Caveats and pitfalls

### 1. ❌ Don't call `logger.error/info/...` inside `beforeSend`

This causes **infinite recursion**. `SafeGuardPlugin` will catch it, but you should still avoid it.

```ts
beforeSend: (entry) => {
  logger.info('processing entry'); // ❌ DON'T
  return entry;
};
```

### 2. ✅ Hook exceptions never crash your page

```ts
beforeSend: (entry) => {
  throw new Error('boom'); // ✅ silently swallowed, original entry passes through
};
```

But you should still wrap your hook in `try-catch` to catch bugs in dev:

```ts
beforeSend: (entry) => {
  try {
    return { ...entry, message: redact(entry.message) };
  } catch (e) {
    if (process.env.NODE_ENV !== 'production') console.error(e);
    return entry;
  }
};
```

### 3. ✅ Always return a **new object**, don't mutate

The SDK doesn't enforce this, but mutating may corrupt data seen by other listeners:

```ts
// ❌ Avoid
beforeSend: (entry) => {
  entry.message = redact(entry.message);
  return entry;
};

// ✅ Recommended
beforeSend: (entry) => ({ ...entry, message: redact(entry.message) });
```

### 4. ⚠️ `beforeSend` is the **last gate**, not a substitute for app-level redaction

- Don't push sensitive data into `context` and rely on `beforeSend` as a safety net
- It's the **last line of defense**, not the **only one**

### 5. ⚠️ Performance: the hook runs on every log

Avoid heavy synchronous work (sync encryption, complex regex). If unavoidable:

- Short-circuit by `tags.errorCategory` before processing
- Pre-compile regex outside the hook

### 6. Relationship to `NetworkPlugin`'s `urlFilter` / `excludeUrls`

| Option | Effect |
|--------|--------|
| `network.excludeUrls` | **Don't capture** logs for that URL |
| `beforeSend` | Already captured, **mutate or drop** |

> Don't capture at all → `excludeUrls`
> Capture but redact → `beforeSend`

---

## 7. Plugin priority

`beforeSend` is implemented by the built-in `BeforeSendPlugin`, which is registered with `priority: PluginPriority.LATEST`, **always after every other plugin** (see [Plugin Ordering](./8-plugin-ordering.md)).

```ts
logger.getPlugins().forEach((p) => console.log(`[${p.priority}] ${p.name}`));
// [-1000] browser-api-errors
// [-100]  error-capture
// [-100]  safe-guard
// [0]     network
// [100]   upload
// [1000]  before-send  ← always last
```

> Same-priority plugins (e.g. two `EARLY` ones) preserve `use()` call order.
> `initAemeath()` calls `use(error-capture)` first, then `use(safe-guard)`.

> ⚠️ **Don't give custom plugins `priority > 1000`**: their `afterLog` would then run **after** `BeforeSendPlugin`, **bypassing your `beforeSend` redaction**. If you genuinely need post-processing after `beforeSend` (e.g. final serialization), use a listener (`logger.on('log', ...)`) instead — listeners run after all `afterLog` hooks (including `beforeSend`), so they observe the already-redacted entry.

---

## 8. API summary

```ts
initAemeath({
  beforeSend: (entry) => entry,
});

import { setBeforeSend } from 'aemeath-js';
setBeforeSend((entry) => entry);
setBeforeSend(null);

const plugin = getAemeath().getPluginInstance('before-send');
(plugin as BeforeSendPlugin)?.setHook((entry) => entry);
```

---

## 9. FAQ

### Q1: Do I need to change code when upgrading from < 2.4.0?

No. Fully backward compatible. `beforeSend` is a new optional option; omit it for the old behavior.

### Q2: Does `beforeSend` affect console output?

No. Console output happens **before** `beforeSend` (inside `log()`); only listeners and UploadPlugin see the post-processed result.

### Q3: Can `beforeSend` be async?

**No.** It must return synchronously. Async hooks would introduce concurrency complexity (high-volume logs + upload ordering). If you mistakenly use `async`, the returned Promise is ignored (redaction/filtering will not apply) and a console warning is printed (`[Aemeath] ... Promise / thenable`). For async work, do it inside `upload`.

### Q4: Can I register multiple `beforeSend` hooks?

`initAemeath({ beforeSend })` only takes one. To chain, compose inside your hook:

```ts
beforeSend: (entry) => {
  let result: LogEntry | null = entry;
  result = redactPII(result);
  if (!result) return null;
  result = filterNoise(result);
  return result;
};
```

You can also **write your own plugin**:

```ts
import { PluginPriority, type AemeathPlugin } from 'aemeath-js';

class MyRedactPlugin implements AemeathPlugin {
  readonly name = 'my-redact';
  readonly priority = PluginPriority.LATE; // earlier than LATEST BeforeSendPlugin
  install() {}
  afterLog(entry) {
    return { ...entry, message: redact(entry.message) };
  }
}

logger.use(new MyRedactPlugin());
```
