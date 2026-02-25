# PerformancePlugin - Performance Monitoring Plugin

> Monitor Web Vitals and custom performance metrics

---

## 📦 Core Features

### 1. Web Vitals Monitoring ⭐

Automatically monitor Google Core Web Vitals:

- **LCP** (Largest Contentful Paint) - Largest contentful paint
- **FID** (First Input Delay) - First input delay
- **CLS** (Cumulative Layout Shift) - Cumulative layout shift
- **FCP** (First Contentful Paint) - First contentful paint
- **TTFB** (Time to First Byte) - Time to first byte

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

### Basic Usage

```typescript
import { Logger, PerformancePlugin } from 'aemeath-js';

const logger = new Logger();

logger.use(
  new PerformancePlugin({
    monitorWebVitals: true, // Monitor Web Vitals
    sampleRate: 1, // 100% sampling
  }),
);

// Plugin automatically records performance metrics
```

### Using with Singleton Pattern

```typescript
import { initAemeath, getAemeath } from 'aemeath-js';
import { PerformancePlugin } from 'aemeath-js';

// Initialize Logger
initAemeath({ errorCapture: true });

// Add performance monitoring
getAemeath().use(
  new PerformancePlugin({
    monitorWebVitals: true,
    sampleRate: 0.1, // 10% sampling rate
  }),
);
```

---

## 📖 API Documentation

### PerformancePluginOptions

```typescript
interface PerformancePluginOptions {
  /** Whether to monitor Web Vitals (default: true) */
  monitorWebVitals?: boolean;

  /** Whether to monitor resource loading (default: false) */
  monitorResources?: boolean;

  /** Whether to monitor long tasks (default: false) */
  monitorLongTasks?: boolean;

  /** Long task threshold in ms (default: 50) */
  longTaskThreshold?: number;

  /** Sampling rate (0-1, default: 1) */
  sampleRate?: number;
}
```

### Custom Performance Measurement APIs

After installing `PerformancePlugin`, Logger extends the following methods:

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
//   message: 'Performance metric',
//   tags: {
//     category: 'performance',
//     metric: 'LCP',
//     rating: 'good'
//   },
//   context: {
//     metric: {
//       name: 'LCP',
//       value: 2450,
//       rating: 'good'  // 'good' | 'needs-improvement' | 'poor'
//     }
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
//   message: 'Slow resource loading',
//   tags: {
//     category: 'performance',
//     type: 'slow-resource'
//   },
//   context: {
//     resource: {
//       name: 'https://example.com/large-image.jpg',
//       type: 'img',
//       duration: 3245,
//       size: 2048000
//     }
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
//   message: 'Long task detected',
//   tags: {
//     category: 'performance',
//     type: 'long-task'
//   },
//   context: {
//     task: {
//       duration: 150,
//       startTime: 1234567890,
//       name: 'script'
//     }
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
import { Logger, PerformancePlugin, UploadPlugin } from 'aemeath-js';

const logger = new Logger();

// 1. Performance monitoring (10% sampling)
logger.use(
  new PerformancePlugin({
    monitorWebVitals: true, // Monitor core metrics
    monitorResources: false, // Don't monitor resources in production (avoid too many logs)
    monitorLongTasks: true, // Monitor long tasks
    longTaskThreshold: 100, // Only record tasks >100ms
    sampleRate: 0.1, // 10% sampling rate
  }),
);

// 2. Upload to server
logger.use(
  new UploadPlugin({
    onUpload: async (log) => {
      // Only upload performance metrics
      if (log.extra?.metric || log.extra?.resource || log.extra?.task) {
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

| Metric   | Good   | Needs Improvement | Poor    |
| -------- | ------ | ----------------- | ------- |
| **LCP**  | ≤2.5s  | 2.5s - 4.0s       | >4.0s   |
| **FID**  | ≤100ms | 100ms - 300ms     | >300ms  |
| **CLS**  | ≤0.1   | 0.1 - 0.25        | >0.25   |
| **FCP**  | ≤1.8s  | 1.8s - 3.0s       | >3.0s   |
| **TTFB** | ≤800ms | 800ms - 1800ms    | >1800ms |

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

```typescript
// Only upload performance metrics, not all logs
onUpload: async (log) => {
  if (log.extra?.metric || log.extra?.resource || log.extra?.task) {
    await uploadToServer(log);
    return { success: true };
  }
  return { success: false, shouldRetry: false };
};
```

### 5. Regular Data Analysis

- Set performance budgets
- Monitor trend changes
- Optimize slow resources and long tasks

---

## 📝 Complete Example

```typescript
import { Logger, PerformancePlugin, UploadPlugin } from 'aemeath-js';

const logger = new Logger();

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

**Made with ❤️ by AemeathJs Team**
