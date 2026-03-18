# PerformancePlugin - Performance Monitoring Plugin

> 🧪 **Experimental** — This plugin is under active development. APIs may change in future versions. Not enabled by default; manual installation required.

> Monitor Web Vitals and custom performance metrics

---

## 📦 Core Features

### 1. Web Vitals Monitoring ⭐

Automatically monitor Google Core Web Vitals:

- **LCP** (Largest Contentful Paint) - Largest contentful paint
- **INP** (Interaction to Next Paint) - Interaction responsiveness (replaced FID in 2024)
- **CLS** (Cumulative Layout Shift) - Cumulative layout shift (Session Window algorithm)
- **FCP** (First Contentful Paint) - First contentful paint
- **TTFB** (Time to First Byte) - Time to first byte

> **Note**: LCP, INP, and CLS are cumulative metrics reported once when the page becomes hidden. FCP and TTFB are one-time metrics reported immediately.

### 2. Resource Loading Monitoring

Monitor slow resource loading (default >1s)

### 3. Long Task Monitoring

Monitor long tasks that block the main thread (default >50ms)

### 4. Custom Performance Measurement

Provides `startMark`, `endMark`, `measure` APIs to measure custom code segments

### 5. Sampling Rate Control

Supports sampling rate configuration to reduce data volume in production

---

## 🚀 Quick Start

### Singleton Pattern (Recommended)

```typescript
import { initAemeath, getAemeath, PerformancePlugin } from 'aemeath-js';

initAemeath({
  upload: async (log) => { /* ... */ return { success: true }; },
});

getAemeath().use(
  new PerformancePlugin({
    monitorWebVitals: true,
    sampleRate: 0.1, // 10% sampling rate
  }),
);
```

### Manual Assembly

```typescript
import { AemeathLogger, PerformancePlugin } from 'aemeath-js';

const logger = new AemeathLogger();

logger.use(
  new PerformancePlugin({
    monitorWebVitals: true,
    sampleRate: 1, // 100% sampling
  }),
);
```

---

## 📖 API Documentation

### PerformancePluginOptions

```typescript
interface WebVitalsOptions {
  lcp?: boolean;   // default true
  inp?: boolean;   // default true
  cls?: boolean;   // default true
  fcp?: boolean;   // default true
  ttfb?: boolean;  // default true
}

interface PerformancePluginOptions {
  /**
   * Web Vitals monitoring
   * - true (default): monitor all Web Vitals
   * - false: disable all Web Vitals
   * - WebVitalsOptions: fine-grained control per metric
   */
  monitorWebVitals?: boolean | WebVitalsOptions;

  /** Whether to monitor resource loading (default: false) */
  monitorResources?: boolean;

  /** Whether to monitor long tasks (default: false) */
  monitorLongTasks?: boolean;

  /** Long task threshold in ms (default: 50) */
  longTaskThreshold?: number;

  /** Slow resource threshold in ms (default: 1000) */
  slowResourceThreshold?: number;

  /** Sampling rate for auto-collection (0-1, default: 1). Does not affect manual mark/measure. */
  sampleRate?: number;

  /** Plugin-level route matching (narrows the global routeMatch scope) */
  routeMatch?: RouteMatchConfig;
}
```

> **routeMatch rules**: `excludeRoutes` takes precedence over `includeRoutes`. When a global `routeMatch` is set via `initAemeath`, this plugin-level `routeMatch` further narrows the scope (both must match).

**Fine-grained Web Vitals configuration:**

```typescript
// Only monitor LCP and FCP, disable others
logger.use(new PerformancePlugin({
  monitorWebVitals: { lcp: true, fcp: true, inp: false, cls: false, ttfb: false },
}));

// Only disable CLS (others default to true)
logger.use(new PerformancePlugin({
  monitorWebVitals: { cls: false },
}));
```

### Custom Performance Measurement APIs

After installing `PerformancePlugin`, AemeathLogger extends the following methods:

#### `logger.startMark(name: string): void`

Start a performance mark.

```typescript
logger.startMark('data-fetch');
```

#### `logger.endMark(name: string): number | null`

End a performance mark and return duration in milliseconds. Returns `null` if mark doesn't exist.

```typescript
const duration = logger.endMark('data-fetch');
console.log(`Duration: ${duration}ms`);
```

#### `logger.measure(name: string, startMark: string, endMark: string): number | null`

Measure time between two marks. Returns duration in milliseconds, or `null` if measurement fails.

```typescript
performance.mark('start');
// ... execute code ...
performance.mark('end');
const duration = logger.measure('operation', 'start', 'end');
```

---

## 📡 Reporting Strategy

### Data Flow

```
PerformancePlugin
  ↓ logger.info() / logger.warn()
Standard log pipeline (beforeLog → build LogEntry → afterLog → console → listeners)
  ↓
UploadPlugin (if installed) → Server
```

Performance data is just **regular logs** flowing through the standard pipeline. If UploadPlugin is installed, performance logs are uploaded alongside other logs.

### Reporting Timing

| Metric | Source | When Reported | Count |
|--------|--------|--------------|-------|
| **FCP** | `PerformanceObserver('paint')` | **Immediately** when browser first paints content | 1 |
| **TTFB** | `performance.getEntriesByType('navigation')` | **Immediately** on plugin install | 1 |
| **LCP** | `PerformanceObserver('largest-contentful-paint')` | Caches latest value, reports **when page is hidden** | 1 |
| **INP** | `PerformanceObserver('event')` | Tracks slowest interaction, reports **when page is hidden** | 1 |
| **CLS** | `PerformanceObserver('layout-shift')` | Session Window accumulation, reports **when page is hidden** | 1 |
| **Slow resource** | `PerformanceObserver('resource')` | **Immediately** when threshold exceeded | N |
| **Long task** | `PerformanceObserver('longtask')` | **Immediately** when threshold exceeded | N |
| **Manual mark** | User calls `endMark()` | **Immediately** on call | User-controlled |

> **"When page is hidden"** means `document.visibilityState` becomes `'hidden'` (tab switch, minimize, etc.). This is Google's recommended timing for cumulative metrics.

**No periodic polling** — everything is event-driven.

### Log Structure

All performance logs follow a consistent `message` + `tags` + `context` structure:

**Web Vitals (LCP / INP / CLS / FCP / TTFB)**

```json
{
  "level": "info",
  "message": "[performance] web-vital",
  "tags": { "category": "performance", "metric": "LCP", "rating": "good" },
  "context": {
    "metric": { "name": "LCP", "value": 2450, "rating": "good" }
  }
}
```

**Slow Resource**

```json
{
  "level": "warn",
  "message": "[performance] slow-resource",
  "tags": { "category": "performance", "type": "slow-resource" },
  "context": {
    "resource": { "name": "https://example.com/large.js", "type": "script", "duration": 3245, "size": 102400 }
  }
}
```

**Long Task**

```json
{
  "level": "warn",
  "message": "[performance] long-task",
  "tags": { "category": "performance", "type": "long-task" },
  "context": {
    "task": { "duration": 150, "startTime": 12345, "name": "self" }
  }
}
```

**Manual Measurement**

```json
{
  "level": "info",
  "message": "[performance] measurement",
  "tags": { "category": "performance", "type": "measurement", "name": "api-call" },
  "context": {
    "measurement": { "name": "api-call", "duration": 500, "timestamp": 1234567890 }
  }
}
```

### Custom Filtering

Use UploadPlugin's `onUpload` callback for flexible filtering:

```typescript
new UploadPlugin({
  onUpload: async (log) => {
    // Only upload performance logs
    if (log.tags?.category !== 'performance') {
      return { success: false, shouldRetry: false };
    }

    // Only upload poor-rated Web Vitals
    if (log.tags?.metric && log.tags?.rating !== 'poor') {
      return { success: false, shouldRetry: false };
    }

    await fetch('/api/metrics', { method: 'POST', body: JSON.stringify(log) });
    return { success: true };
  },
})
```

---

## 🎯 Use Cases

### Case 1: Monitor Web Vitals

```typescript
logger.use(
  new PerformancePlugin({
    monitorWebVitals: true,
  }),
);

// Automatically records:
// {
//   level: 'info',
//   message: '[performance] web-vital',
//   tags: { category: 'performance', metric: 'LCP', rating: 'good' },
//   context: {
//     metric: { name: 'LCP', value: 2450, rating: 'good' }
//   }
// }
```

### Case 2: Monitor Slow Resources

```typescript
logger.use(
  new PerformancePlugin({
    monitorResources: true, // Monitor resources >1s
  }),
);

// Example log:
// {
//   level: 'warn',
//   message: '[performance] slow-resource',
//   tags: { category: 'performance', type: 'slow-resource' },
//   context: {
//     resource: { name: 'https://example.com/large.jpg', type: 'img', duration: 3245, size: 2048000 }
//   }
// }
```

### Case 3: Monitor Long Tasks

```typescript
logger.use(
  new PerformancePlugin({
    monitorLongTasks: true,
    longTaskThreshold: 100, // Only record tasks >100ms
  }),
);

// Example log:
// {
//   level: 'warn',
//   message: '[performance] long-task',
//   tags: { category: 'performance', type: 'long-task' },
//   context: {
//     task: { duration: 150, startTime: 1234567890, name: 'script' }
//   }
// }
```

### Case 4: Custom Performance Measurement

#### Measure Async Operations

```typescript
logger.use(new PerformancePlugin());

async function fetchUserData(userId: string) {
  logger.startMark('fetch-user-data');

  try {
    const data = await fetch(`/api/users/${userId}`);
    const result = await data.json();
    return result;
  } finally {
    const duration = logger.endMark('fetch-user-data');
    console.log(`Fetch user data took ${duration}ms`);
  }
}
```

#### Measure React Component Rendering

```typescript
import { useEffect } from 'react';

function MyComponent() {
  useEffect(() => {
    logger.startMark('component-mount');

    return () => {
      logger.endMark('component-mount');
    };
  }, []);

  return <div>...</div>;
}
```

#### Using Native Performance API

```typescript
performance.mark('operation-start');
// ... execute code ...
performance.mark('operation-end');
const duration = logger.measure(
  'operation',
  'operation-start',
  'operation-end',
);
```

---

## 🏭 Production Configuration

### Recommended Configuration

```typescript
import { AemeathLogger, PerformancePlugin, UploadPlugin } from 'aemeath-js';

const logger = new AemeathLogger();

// 1. Performance monitoring (10% sampling)
logger.use(
  new PerformancePlugin({
    monitorWebVitals: true,
    monitorResources: false,
    monitorLongTasks: true,
    longTaskThreshold: 100,
    sampleRate: 0.1,
  }),
);

// 2. Upload to server
logger.use(
  new UploadPlugin({
    onUpload: async (log) => {
      if (log.tags?.category === 'performance') {
        await fetch('/api/metrics', {
          method: 'POST',
          body: JSON.stringify(log),
        });
        return { success: true };
      }
      return { success: false, shouldRetry: false };
    },
  }),
);
```

### Development Configuration

```typescript
logger.use(
  new PerformancePlugin({
    monitorWebVitals: true,
    monitorResources: true, // Can monitor resources in development
    monitorLongTasks: true,
    longTaskThreshold: 50,
    sampleRate: 1, // 100% sampling in development
  }),
);
```

---

## 📊 Web Vitals Rating Standards

| Metric   | Good    | Needs Improvement | Poor     |
| -------- | ------- | ----------------- | -------- |
| **LCP**  | ≤2.5s   | 2.5s - 4.0s       | >4.0s    |
| **INP**  | ≤200ms  | 200ms - 500ms     | >500ms   |
| **CLS**  | ≤0.1    | 0.1 - 0.25        | >0.25    |
| **FCP**  | ≤1.8s   | 1.8s - 3.0s       | >3.0s    |
| **TTFB** | ≤800ms  | 800ms - 1800ms    | >1800ms  |

### Rating Explanation

- **good**: Excellent performance, good user experience
- **needs-improvement**: Needs improvement, average user experience
- **poor**: Poor performance, bad user experience

---

## 🌐 Browser Support

| Browser | Web Vitals         | Resource Monitoring | Long Task Monitoring |
| ------- | ------------------ | ------------------- | -------------------- |
| Chrome  | ✅ Full Support    | ✅                  | ✅                   |
| Edge    | ✅ Full Support    | ✅                  | ✅                   |
| Firefox | ⚠️ Partial Support | ✅                  | ⚠️                   |
| Safari  | ⚠️ Limited Support | ✅                  | ❌                   |

**Note**: Plugin automatically detects browser support, unsupported metrics will be skipped.

---

## 💡 Best Practices

### 1. Use Sampling in Production

```typescript
sampleRate: 0.1; // 10% sampling, reduce data volume
```

### 2. Monitor Only Key Metrics

```typescript
monitorWebVitals: true,
monitorResources: false,  // Avoid too many logs
monitorLongTasks: true
```

### 3. Set Reasonable Thresholds

```typescript
longTaskThreshold: 100; // Only record tasks >100ms
```

### 4. Work with UploadPlugin

See [Reporting Strategy > Custom Filtering](#custom-filtering) above.

### 5. Regular Data Analysis

- Set performance budgets
- Monitor trend changes
- Optimize slow resources and long tasks

---

## 📝 Complete Example

```typescript
import { AemeathLogger, PerformancePlugin, UploadPlugin } from 'aemeath-js';

const logger = new AemeathLogger();

// Configure performance monitoring
logger.use(
  new PerformancePlugin({
    monitorWebVitals: true,
    monitorResources: true,
    monitorLongTasks: true,
    longTaskThreshold: 50,
    sampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1,
  }),
);

// Configure upload
logger.use(
  new UploadPlugin({
    onUpload: async (log) => {
      await fetch('/api/logs', {
        method: 'POST',
        body: JSON.stringify(log),
      });
      return { success: true };
    },
  }),
);

// Usage
export function App() {
  useEffect(() => {
    logger.startMark('app-init');

    // Initialize app
    initializeApp().then(() => {
      logger.endMark('app-init');
    });
  }, []);

  return <YourApp />;
}
```

---

## 🔗 Related Documentation

- [Complete Examples](./../../examples/5-performance-plugin/)
- [Basic Example](./../../examples/5-performance-plugin/basic.ts)
- [Custom Measurement Example](./../../examples/5-performance-plugin/custom-measurement.ts)
- [Quick Start](./../../QUICK_START.md)

---

## 📦 Bundle Size

- **PerformancePlugin**: ~4KB
- **Dependencies**: None
- **Tree-shakable**: ✅

---

**Made with ❤️ by TieriaSail**
