# Module 1: Error Capture

## 🚀 Quick Start

### Singleton Pattern (Recommended)

`initAemeath()` enables `ErrorCapturePlugin` by default — no extra setup needed:

```typescript
import { initAemeath, getAemeath, classifyHttpUploadResponse } from 'aemeath-js';

initAemeath({
  upload: async (log) => {
    const res = await fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
    return classifyHttpUploadResponse(res.status, res.headers.get('Retry-After'));
  },
});

const logger = getAemeath();
```

### Manual Assembly

```typescript
import { AemeathLogger, ErrorCapturePlugin } from 'aemeath-js';

const logger = new AemeathLogger();
logger.use(new ErrorCapturePlugin());
```

✅ Auto captures:

- Global JS errors
- Unhandled promise rejections
- Resource loading failures
- With `BrowserApiErrorsPlugin` enabled, supported callback hooks can capture the original exception. They cannot recover details the browser never exposed.

---

## 📚 API

### Route-Based Filtering (routeMatch)

`routeMatch` is a **global** config in `initAemeath()` that controls all plugins (error capture, network, performance). Each plugin can also have its own `routeMatch` to further narrow the scope.

```typescript
initAemeath({
  upload: async (log) => { /* ... */ return { success: true }; },

  // Global routeMatch — applies to ALL plugins
  routeMatch: {
    includeRoutes: ['/home', '/product', /^\/user\/.+/],
    excludeRoutes: ['/debug'],
  },

  // Plugin-level routeMatch — narrows scope for error capture only
  errorCapture: {
    routeMatch: {
      includeRoutes: ['/checkout'],
    },
  },
});
```

**Rules:**
- `excludeRoutes` takes priority over `includeRoutes`.
- Routes support three matching patterns: exact string, RegExp, and function `(path: string) => boolean`.
- If only `excludeRoutes` is set, all routes except excluded ones are monitored.
- If only `includeRoutes` is set, only those routes are monitored.

### ErrorCapturePluginOptions

```typescript
interface ErrorCapturePluginOptions {
  /** Capture unhandled Promise rejections @default true */
  captureUnhandledRejection?: boolean;
  /** Capture resource loading errors @default true */
  captureResourceError?: boolean;
  /** Capture console.error calls @default false */
  captureConsoleError?: boolean;
  /** Custom error filter (return false to skip) */
  errorFilter?: (error: Error) => boolean;
  /** Plugin-level route matching (narrows the global routeMatch scope) */
  routeMatch?: RouteMatchConfig;
  /** Debug mode @default false */
  debug?: boolean;
}
```

### Singleton Pattern — errorCapture option

When using `initAemeath()`, `errorCapture` accepts a union type:

```typescript
// Option 1: boolean (default: true)
initAemeath({
  errorCapture: true,
});

// Option 2: configure ErrorCapturePlugin
initAemeath({
  errorCapture: {
    enabled: true,
    captureUnhandledRejection: true,
    captureResourceError: true,
    captureConsoleError: true,
    debug: false,
    routeMatch: {
      includeRoutes: ['/checkout', '/payment'],
    },
    errorFilter: (error) => !error.message.includes('expected error'),
  },
});
```

The nested `errorCapture.errorFilter` takes precedence over the legacy top-level `errorFilter`.
Resource-error interception is independently configurable through `captureResourceError`; when
enabled, resource errors use the same route, filter, and evidence rules. Platforms without a
resource-error adapter safely ignore that capture option.

`captureConsoleError` captures only calls containing an `Error` argument. Console output produced
by `logger.error()` itself is suppressed from automatic capture, although applications should still
verify counts when both a host capture point and host-owned console output report the same error.

---

## 💡 Examples

### React Integration

```tsx
import React, { Component } from 'react';
import { getAemeath } from 'aemeath-js';

const logger = getAemeath();

class ErrorBoundary extends Component {
  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    logger.error('React error', {
      error,
      context: { componentStack: errorInfo.componentStack },
    });
  }

  render() {
    return this.props.children;
  }
}
```

### Vue Integration

```typescript
import { createApp } from 'vue';
import { getAemeath } from 'aemeath-js';

const logger = getAemeath();
const app = createApp(App);

app.config.errorHandler = (err, instance, info) => {
  logger.error('Vue error', {
    error: err,
    context: { componentName: instance?.$options.name, info },
  });
};
```

### Manual Capture

```typescript
try {
  dangerousOperation();
} catch (error) {
  logger.error('Operation failed', {
    error,
    context: { operation: 'dangerousOperation' },
  });
}
```

---

## 🛡️ Browser API Enhanced Capture (BrowserApiErrorsPlugin)

### What problem does it solve?

In restricted cross-origin environments such as iOS WKWebView and Android WebView, `window.onerror` only returns `"Script error."` without any useful stack trace. `BrowserApiErrorsPlugin` wraps browser API callbacks with try-catch to capture full error details at the point of origin.

### Default Behavior

`initAemeath()` enables this plugin by default — no extra setup needed:

```typescript
initAemeath({
  upload: async (log) => { /* ... */ return { success: true }; },
});
// BrowserApiErrorsPlugin is enabled automatically
```

### Covered Browser APIs

| API | Description |
|-----|-------------|
| `EventTarget.addEventListener` | Wraps event callbacks with try-catch |
| `EventTarget.removeEventListener` | Recognizes wrapped listeners automatically |
| `setTimeout` / `setInterval` | Wraps timer callbacks with try-catch |
| `requestAnimationFrame` | Wraps animation callbacks with try-catch |
| `XMLHttpRequest.send` | Wraps onload / onerror / onreadystatechange callbacks |

### Configuration

```typescript
initAemeath({
  upload: async (log) => { /* ... */ return { success: true }; },

  // Option 1: disable
  browserApiErrors: false,

  // Option 2: custom config
  browserApiErrors: {
    eventTarget: true,           // Patch addEventListener @default true
    timer: true,                 // Patch setTimeout/setInterval @default true
    requestAnimationFrame: true, // Patch requestAnimationFrame @default true
    xhr: true,                   // Patch XMLHttpRequest.send @default true
  },
});
```

### Manual Assembly

```typescript
import { AemeathLogger, BrowserApiErrorsPlugin, ErrorCapturePlugin } from 'aemeath-js';

const logger = new AemeathLogger();

// ⚠️ BrowserApiErrorsPlugin MUST be installed BEFORE ErrorCapturePlugin
logger.use(new BrowserApiErrorsPlugin());
logger.use(new ErrorCapturePlugin());
```

### Deduplication

When try-catch captures an error, the error is still re-thrown (preserving original behavior). `window.onerror` will also receive the same error. Both observations retain independent occurrenceId values and share errorObjectId for the same original object. A time-window flag no longer suppresses subsequent global errors.

### Notes

- This plugin is for browser environments.
- Does not affect `fetch` errors (those are captured via Promise rejection, already covered by `ErrorCapturePlugin`)
- Uninstalling the plugin restores all APIs to their original implementations

---

## 📖 More

- [Early Error Capture](./2-early-error-capture.md)
- [Source Map Parser](./3-sourcemap-parser.md)
- [Upload Plugin](./4-upload-plugin.md)


## Error evidence

Keep your existing `initAemeath` / `ErrorCapturePlugin` configuration; no new switch is required.
Automatically captured logs include `entry.error.evidence`. Start with the original message in
`entry.error.value`, then use [evidence-aware parsing](./3-sourcemap-parser.md#evidence-aware-parsing)
to decide whether the stack can be mapped.

`error.evidence.schemaVersion = 1` identifies the capture channel, early/runtime phase, original name,
reason kind and stack origin. `error.stack` contains only an input-provided original stack. Known
synthetic stacks live in `evidence.captureStack`; missing stacks are not manufactured. `stackOrigin`
is `original`, `capture-site` or `unavailable`. A redacted `Script error.` with an empty location has
`missingStackReason: 'browser-redacted'`; this does not prove a particular CDN/CORS misconfiguration.
An original stack may identify error creation, not its most recent throw.

Legacy message, level, `error.type` and `tags.errorCategory` remain compatible. Read the actual name
from `evidence.originalName`. The SDK does not write category/location fields onto the input Error.
`errorFilter` receives the original Error, including foreign-realm errors, preserving reference,
`instanceof` and custom exception-method predicates. Explicit filter redactions are reflected in the
final snapshot. Non-Error inputs receive a compatible Error argument; a stack created only for that
filter argument is never reported as an original stack. Throwing filters retain the legacy fail-open behavior.

Every observation has an `occurrenceId`; the same runtime object shares an `errorObjectId`.
Evidence-bearing errors bypass content deduplication in capture and upload, preserving occurrence
counts as records. Object identity does not establish a root cause or recovery. Volume may increase;
SafeGuard and application filtering still apply. Never group business incidents by captureStack.

Cross-realm/frozen errors, plain rejection objects from other realms, DOMException, primitive reasons
and bounded cause/errors graphs are supported. Primary message/stack and all structured original
`stacktrace.frames` are preserved for the existing PayloadSanitize reject/split policy. Location,
category, capture time and device metadata also bypass diagnostic size/count limits; safe reads,
cycle detection and depth protection still apply to snapshots. Console capture retains
`tags.source = 'console'` and all arguments in `context.consoleArgs`, using the captured error
snapshot for the selected Error argument; context uses the existing payload sanitization rules.
Diagnostic graphs and extras share an 8 KiB UTF-8 string budget, 128 nodes, depth 4, 8 array items
and 32 object properties (40 root extension candidates). This is not the serialized payload budget;
PayloadSanitize also handles structural overhead. Truncation, cycles and getter failures appear in
`evidence.normalization.issues`. Arbitrary toJSON/toString methods are not invoked; DOM/Bridge
instances are not enumerated. Apply beforeSend redaction to the new fields too.

Diagnostic sentinels (`[circular]`, `[truncated]`, `[unreadable]`) remain intact on repeated
normalization; they are structural overhead rather than captured string content. Keys are kept
whole or omitted with an issue when they cannot fit. Protocol metadata does not consume root
extension slots. Explicit early/global/rejection/resource provenance determines the error category;
wrapped and console observations use `manual`. Manual/unknown channels retain legacy classification
heuristics for compatibility, and explicit application `tags.errorCategory` still takes precedence.

Object reasons without a string message/value use `error.reason` as their canonical snapshot;
`error.value` is derived from it. Their diagnostic fields are not also duplicated at the error root,
so the same input is traversed and charged once. SDK metadata remains separate. Error instances,
including foreign-realm Error subclasses, continue to retain their own extensions at the error root.

`getCaptureDiagnostics()` returns the current module instance's bounded failure count and last
channel without recursively logging. It is not automatically uploaded. Explicit
`_isAemeathInternalError` markers still exclude internal events; SDK path/message substrings do not.

Upgrade consumers to accept evidence and stackless errors before deploying the SDK. Old cached logs
remain replayable; unknown historical stacks are not retroactively labeled original. Native Promise
handling semantics remain unchanged. Operation tracing and rejectionhandled status reporting are
not APIs in this version.

### Handling unknown values: normalizeCapturedError

Automatic capture and `logger.error(..., { error: new Error(...) })` already normalize errors.
Use `normalizeCapturedError(input, options?)` when your own catch block receives an `unknown`
value or a custom collector needs a safe `ErrorInfo`. It creates a snapshot without uploading it
or mutating the input. Pass the returned `ErrorInfo` to `logger.error`; string or object reasons
without an original stack do not receive a manufactured business stack.

```typescript
import { normalizeCapturedError, type AemeathInterface } from 'aemeath-js';

export function reportCaughtError(logger: AemeathInterface, reason: unknown) {
  const error = normalizeCapturedError(reason, { channel: 'manual' });
  logger.error('Operation failed', { error });
  return error;
}
```

Import both `ErrorEvidenceOptions` and `ErrorEvidence` types from `aemeath-js`:

| Option | Usage |
| --- | --- |
| `channel` | Capture source such as `manual`, `global`, `unhandledrejection`, `wrapped`, `console`, or `resource`; defaults to `manual` for raw input. |
| `phase` | `runtime` or `early`; defaults to `runtime` for raw input. |
| `message` | Fallback when the input has no string `value`/`message`; does not override an existing message. |
| `synthetic` | Set to `true` only when you know the supplied stack was manufactured at capture time. It is stored in `evidence.captureStack`, not `error.stack`. |
| `source` / `line` / `column` | Browser-reported location, kept as metadata; does not replace an original stack or create mappable frames. |

Normalizing an existing snapshot preserves its source/phase and `occurrenceId` by default;
explicit options can override source/phase. Capturing the same original object again shares
`errorObjectId`, while each observation has its own `occurrenceId`. Read an object reason's
business fields from `error.reason`; `error.value` is its display summary.

### Reading capture health: getCaptureDiagnostics

```typescript
import { getCaptureDiagnostics } from 'aemeath-js';

export function readCaptureHealth() {
  const { failures, lastChannel } = getCaptureDiagnostics();
  return { failures, lastChannel };
}
```

Returns `Readonly<{ failures: number; lastChannel?: string }>`. `failures` counts exceptions
contained by capture isolation in the currently loaded SDK module, **not application errors**.
Before any failure it is 0 and `lastChannel` is `undefined`. Reads do not reset the count or send
network requests; separate SDK copies do not aggregate their counts. An individual property-read
failure may only appear in `error.evidence.normalization.issues` without increasing this counter.
Pre-initialization script failures use `window.__AEMEATH_EARLY_CAPTURE_FAILURES__` separately.

Copyable example: [with-evidence.ts](https://github.com/TieriaSail/aemeath-js/blob/main/examples/1-error-capture/with-evidence.ts).
