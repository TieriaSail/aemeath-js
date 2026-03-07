# Upload Plugin Examples

Upload logs to your backend with priority queue, retry, and local cache.

## Core Features

1. **Upload Callback (Returns UploadResult)**: You control how logs are uploaded and retry behavior ⭐ NEW
2. **Priority Callback**: You define log priority
3. **Queue Mechanism**: Default enabled, processes logs serially
4. **Auto Retry**: Failed logs are downgraded and retried (controlled by `shouldRetry`)
5. **Local Cache**: Queue persists across page refreshes
6. **Serial Processing**: Only one upload at a time (no performance impact)

### UploadResult Interface ⭐ NEW

```typescript
interface UploadResult {
  success: boolean; // Whether upload succeeded
  shouldRetry?: boolean; // Whether to retry on failure
  error?: string; // Error message
}
```

## Examples

### Basic Usage

```typescript
import { AemeathLogger, UploadPlugin } from 'aemeath-js';

const logger = new AemeathLogger();

logger.use(
  new UploadPlugin({
    // Upload callback (required) - Returns UploadResult
    onUpload: async (log) => {
      try {
        const response = await fetch('/api/logs', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(log),
        });

        const data = await response.json();

        if (data.code === 200) {
          return { success: true };
        } else {
          return {
            success: false,
            shouldRetry: true,
            error: data.message,
          };
        }
      } catch (error) {
        return {
          success: false,
          shouldRetry: true,
          error: error.message,
        };
      }
    },
  }),
);

// Use logger
logger.error('Something went wrong', { error: new Error('example') });
```

### With Authentication

```typescript
logger.use(
  new UploadPlugin({
    onUpload: async (log) => {
      const token = getAuthToken(); // Your auth logic

      const res = await fetch('/api/logs', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(log),
      });
      return { success: res.ok };
    },
  }),
);
```

### Custom Priority

```typescript
logger.use(
  new UploadPlugin({
    onUpload: async (log) => {
      const res = await fetch('/api/logs', {
        method: 'POST',
        body: JSON.stringify(log),
      });
      return { success: res.ok };
    },

    // Custom priority calculation
    getPriority: (log) => {
      // Error logs: highest priority
      if (log.level === 'error') return 100;

      // Urgent business logs
      if (log.tags?.urgent) return 80;

      // Warn logs: normal priority
      if (log.level === 'warn') return 50;

      // Others: low priority
      return 10;
    },
  }),
);
```

### With Axios

```typescript
import axios from 'axios';

logger.use(
  new UploadPlugin({
    onUpload: async (log) => {
      await axios.post('/api/logs', log, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        timeout: 5000,
      });
      return { success: true };
    },
  }),
);
```

### Cross-Domain Upload

```typescript
logger.use(
  new UploadPlugin({
    onUpload: async (log) => {
      const res = await fetch('https://logs.example.com/api/logs', {
        method: 'POST',
        mode: 'cors',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'your-api-key',
        },
        body: JSON.stringify(log),
      });
      return { success: res.ok };
    },
  }),
);
```

### Custom Queue Configuration

```typescript
logger.use(
  new UploadPlugin({
    onUpload: async (log) => {
      const res = await fetch('/api/logs', {
        method: 'POST',
        body: JSON.stringify(log),
      });
      return { success: res.ok };
    },

    queue: {
      maxSize: 200, // Max queue size
      concurrency: 1, // Serial processing (recommended)
      maxRetries: 5, // Max retry count
      uploadInterval: 60000, // Upload every 60s
    },

    cache: {
      enabled: true,
      key: 'my-app-logs',
    },
  }),
);
```

### With Error Handling ⭐ NEW

```typescript
logger.use(
  new UploadPlugin({
    onUpload: async (log) => {
      try {
        const response = await fetch('/api/logs', {
          method: 'POST',
          body: JSON.stringify(log),
        });

        // Check HTTP status
        if (response.status >= 500) {
          // Server error, should retry
          return {
            success: false,
            shouldRetry: true,
            error: `Server error: ${response.status}`,
          };
        }

        if (response.status >= 400) {
          // Client error (401, 404), don't retry
          return {
            success: false,
            shouldRetry: false,
            error: `Client error: ${response.status}`,
          };
        }

        // Check business response code
        const data = await response.json();
        if (data.code === 200) {
          return { success: true };
        } else {
          return {
            success: false,
            shouldRetry: true,
            error: data.message,
          };
        }
      } catch (error) {
        // Network error, should retry
        console.error('Failed to upload log:', error);
        return {
          success: false,
          shouldRetry: true,
          error: error.message,
        };
      }
    },
  }),
);
```

## How It Works

### Queue Processing Flow

```
1. Log captured
     ↓
2. Calculate priority (via getPriority callback)
     ↓
3. Add to priority queue (sorted by priority)
     ↓
4. Save to local cache
     ↓
5. Process queue (serial, one at a time)
     ↓
6. Call onUpload callback
     ↓
   Returns { success: true } → Remove from queue
     ↓
   Returns { success: false, shouldRetry: true } → Downgrade priority (-10), retry
     ↓
   Returns { success: false, shouldRetry: false } → Drop log
```

### Priority System

- Priority is a number (1-100)
- Higher number = higher priority
- Default:
  - `error`: 100
  - `warn`: 50
  - `info`: 10
  - `debug`: 1

### Retry Mechanism

- Failed uploads automatically retry
- Each retry decreases priority by 10
- Max retries: 3 (configurable)
- After max retries, log is dropped

### Serial Processing

- Only one upload at a time
- Prevents performance issues
- Ensures request order
- 100ms delay between uploads

## Queue Status

Debug queue status:

```typescript
const plugin = new UploadPlugin({
  /* config */
});
logger.use(plugin);

// Check queue status
console.log(plugin.getQueueStatus());
// {
//   length: 5,
//   isProcessing: false,
//   items: [
//     { priority: 100, retryCount: 0, level: 'error' },
//     { priority: 50, retryCount: 1, level: 'warn' },
//     ...
//   ]
// }
```

## Flush Logs

Force upload all logs immediately:

```typescript
const plugin = new UploadPlugin({
  /* config */
});
logger.use(plugin);

// Force upload
await plugin.flush();
```

## Best Practices

### 1. Don't Create Infinite Loops

```typescript
// ❌ BAD: Logging in upload callback
onUpload: async (log) => {
  try {
    await fetch('/api/logs', { body: JSON.stringify(log) });
    return { success: true };
  } catch (error) {
    logger.error('Upload failed', { error }); // Infinite loop!
    return { success: false, shouldRetry: true };
  }
};

// ✅ GOOD: Use console
onUpload: async (log) => {
  try {
    await fetch('/api/logs', { body: JSON.stringify(log) });
    return { success: true };
  } catch (error) {
    console.error('Upload failed:', error); // OK
    return { success: false, shouldRetry: true };
  }
};
```

### 2. Keep Priority Simple

```typescript
// ✅ GOOD: Simple rules
getPriority: (log) => {
  if (log.level === 'error') return 100;
  if (log.level === 'warn') return 50;
  return 10;
};

// ❌ BAD: Complex logic
getPriority: (log) => {
  // Lots of complex calculations...
  return result; // Slows down logging
};
```

### 3. Handle Auth Token Refresh

```typescript
onUpload: async (log) => {
  let token = getAuthToken();

  let response = await fetch('/api/logs', {
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(log),
  });

  // If 401, refresh token and retry
  if (response.status === 401) {
    token = await refreshAuthToken();
    response = await fetch('/api/logs', {
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(log),
    });
  }

  return { success: response.ok };
};
```

## Summary

The callback-based API gives you complete control over log uploads with features like priority queuing, local caching, and automatic retry with degradation.
