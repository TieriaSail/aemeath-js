# UploadPlugin - Log Upload Plugin

> Fully customizable callback-based upload, simple and flexible

---

## 📦 Core Features

### 1. Upload Callback

You have complete control over how logs are uploaded

### 2. Priority Callback

You define log priority (number 1-100, higher = more priority)

### 3. Queue Mechanism

- Enabled by default
- Serial processing (one request at a time)
- Sorted by priority

### 4. Auto Retry

- Failed uploads automatically downgrade priority (-10)
- Re-queued for retry
- Max 3 retries (configurable)

### 5. Local Cache

- Queue saved to localStorage
- Auto-restored after page refresh
- Auto-cleanup of expired logs

---

## 🚀 Quick Start

### Basic Usage

```typescript
import { Logger, UploadPlugin } from 'aemeath-js';

const logger = new Logger();

logger.use(
  new UploadPlugin({
    // Upload callback (required)
    onUpload: async (log) => {
      await fetch('/api/logs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(log),
      });
    },
  }),
);

// Use it
logger.error('Something went wrong', error);
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
    },
  }),
);
```

### Custom Priority

```typescript
logger.use(
  new UploadPlugin({
    onUpload: async (log) => {
      await fetch('/api/logs', {
        method: 'POST',
        body: JSON.stringify(log),
      });
    },

    // Priority callback
    getPriority: (log) => {
      // Error logs: highest priority
      if (log.level === 'error') return 100;

      // Urgent business logs
      if (log.extra?.urgent) return 80;

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
  - `info`: 10
  - `debug`: 1

### Retry Mechanism

1. Upload fails
2. Decrease priority by 10
3. Re-queue
4. Try again
5. Repeat up to 3 times (configurable)

### Serial Processing

- Only one upload request at a time
- Prevents performance issues
- Ensures request order
- 100ms delay between requests

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
    },

    // Cache configuration
    cache: {
      enabled: true, // Enable cache
      key: '__logger_queue__', // Cache key
    },

    // Upload on page unload
    uploadOnUnload: true,
  }),
);
```

### Configuration Details

| Option                 | Type                               | Default                   | Description          |
| ---------------------- | ---------------------------------- | ------------------------- | -------------------- |
| `onUpload`             | `(log: LogEntry) => Promise<void>` | **Required**              | Upload callback      |
| `getPriority`          | `(log: LogEntry) => number`        | By level                  | Priority callback    |
| `queue.maxSize`        | `number`                           | `100`                     | Max queue size       |
| `queue.concurrency`    | `number`                           | `1`                       | Concurrent uploads   |
| `queue.maxRetries`     | `number`                           | `3`                       | Max retry count      |
| `queue.uploadInterval` | `number`                           | `30000`                   | Upload interval (ms) |
| `cache.enabled`        | `boolean`                          | `true`                    | Enable cache         |
| `cache.key`            | `string`                           | `__logger_upload_queue__` | Cache key            |
| `uploadOnUnload`       | `boolean`                          | `true`                    | Upload on unload     |

---

## 💡 Best Practices

### 1. Avoid Infinite Loops

```typescript
// ❌ BAD - creates infinite loop
onUpload: async (log) => {
  try {
    await fetch('/api/logs', { body: JSON.stringify(log) });
  } catch (error) {
    logger.error('Upload failed', error); // This triggers upload again!
  }
};

// ✅ GOOD - use console
onUpload: async (log) => {
  try {
    await fetch('/api/logs', { body: JSON.stringify(log) });
  } catch (error) {
    console.error('Upload failed:', error); // Safe
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

  const response = await fetch('/api/logs', {
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(log),
  });

  // If 401, refresh token and retry
  if (response.status === 401) {
    token = await refreshAuthToken();
    await fetch('/api/logs', {
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(log),
    });
  }
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

---

## 🎯 Comparison

| Feature            | Old (endpoint)    | New (callback)       |
| ------------------ | ----------------- | -------------------- |
| **Flexibility**    | ❌ Limited        | ✅ Full control      |
| **Auth**           | ❌ Difficult      | ✅ Easy              |
| **CORS**           | ❌ Hard           | ✅ Native support    |
| **Custom Headers** | ❌ Limited        | ✅ Any headers       |
| **HTTP Client**    | ❌ Built-in fetch | ✅ Any (fetch/axios) |
| **Priority**       | ❌ Fixed          | ✅ Custom (1-100)    |
| **Queue**          | ✅ Yes            | ✅ Yes (improved)    |
| **Serial**         | ❌ No             | ✅ Yes               |
| **API Complexity** | ⭐⭐⭐            | ⭐                   |

**Simpler, more flexible, more powerful!** 🎉

---

**Version:** 1.1.0  
**Last Updated:** 2026-02-05
