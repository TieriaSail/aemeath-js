# Global Context

## Introduction

Global context allows you to configure common information that will be automatically attached to every log entry without manual passing each time.

**Use Cases**:

- User identification: `userId`, `username`, `email`
- Device info: `deviceId`, `platform`, `os`, `browser`
- App info: `appVersion`, `buildNumber`
- Network info: `ip`, `region`
- Other information needed in all logs

## Basic Usage

### Configure on Initialization

```typescript
import { initAemeath } from 'aemeath-js';

initAemeath({
  context: {
    userId: '12345',
    deviceId: 'abc-def-123',
    appVersion: '1.0.0',
    platform: 'iOS',
  },
});
```

### Usage

```typescript
import { getAemeath } from 'aemeath-js';

const logger = getAemeath();
logger.info('User clicked button');

// Output:
// {
//   level: 'info',
//   message: 'User clicked button',
//   timestamp: 1703123456789,
//   context: {
//     userId: '12345',
//     deviceId: 'abc-def-123',
//     appVersion: '1.0.0',
//     platform: 'iOS'
//   }
// }
```

## Dynamic Updates

### updateContext() - Merge Update

```typescript
const logger = getAemeath();

// Update userId after login
logger.updateContext('userId', '12345');

// Update other info
logger.updateContext('username', 'John');

// Current context: { userId: '12345', username: 'John', ...existing }
```

### setContext() - Complete Replacement

```typescript
const logger = getAemeath();

// Completely replace context
logger.setContext({
  deviceId: 'new-device',
  appVersion: '2.0.0',
});

// Current context: { deviceId: 'new-device', appVersion: '2.0.0' }
// Previous userId, username etc. are cleared
```

### getContext() - Get Current Context

```typescript
const logger = getAemeath();

const context = logger.getContext();
console.log(context); // { userId: '12345', deviceId: 'abc', ... }
```

### clearContext() - Clear Context

```typescript
const logger = getAemeath();

logger.clearContext();
// Current context: {}
```

## Real-World Scenarios

### Scenario 1: User Login/Logout

```typescript
import { getAemeath } from 'aemeath-js';

const logger = getAemeath();

// User login
function onUserLogin(user) {
  logger.updateContext('userId', user.id);
  logger.updateContext('username', user.name);
  logger.updateContext('email', user.email);
  logger.updateContext('role', user.role);

  logger.info('User logged in');
}

// User logout
function onUserLogout() {
  const currentContext = logger.getContext();

  // Keep device info, remove user info
  logger.setContext({
    deviceId: currentContext.deviceId,
    platform: currentContext.platform,
    appVersion: currentContext.appVersion,
  });

  logger.info('User logged out');
}
```

### Scenario 2: App Initialization

```typescript
// App.tsx
import { initAemeath } from 'aemeath-js';

function getDeviceInfo() {
  const ua = navigator.userAgent;
  return {
    platform: /iPhone/.test(ua)
      ? 'iOS'
      : /Android/.test(ua)
        ? 'Android'
        : 'Web',
    userAgent: ua,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
  };
}

function initApp() {
  const deviceInfo = getDeviceInfo();

  initAemeath({
    upload: async (log) => {
      const res = await fetch('/api/logs', {
        method: 'POST',
        body: JSON.stringify(log),
      });
      return { success: res.ok };
    },
    context: {
      // App info
      appName: 'MyApp',
      appVersion: process.env.APP_VERSION,
      buildNumber: process.env.BUILD_NUMBER,
      environment: process.env.NODE_ENV,

      // Device info
      ...deviceInfo,
    },
  });
}
```

### Scenario 3: Multi-tenant System

```typescript
import { getAemeath } from 'aemeath-js';

const logger = getAemeath();

// Update context when switching tenant
function switchTenant(tenantId: string) {
  logger.updateContext('tenantId', tenantId);
  logger.updateContext('tenantName', getTenantName(tenantId));

  logger.info('Switched tenant');
}

// All subsequent logs will include tenantId
logger.info('User action'); // tenantId automatically attached
logger.error('Error occurred', { error }); // tenantId automatically attached
```

### Scenario 4: A/B Testing

```typescript
import { getAemeath } from 'aemeath-js';

const logger = getAemeath();

// Assign A/B test group
function assignABTest(userId: string) {
  const group = Math.random() > 0.5 ? 'A' : 'B';

  logger.updateContext('abTestGroup', group);
  logger.updateContext('abTestId', 'exp-001');

  logger.info('AB test assigned', { context: { group } });
}

// All subsequent logs carry A/B test info
logger.info('Button clicked'); // abTestGroup, abTestId automatically attached
```

## Global Context vs Per-Log Data

### Global Context (Persistent)

- **Global, persistent** — configured once, automatically attached to all logs
- Suitable for user, device, app identification info

```typescript
logger.setContext({ userId: '12345', platform: 'iOS' });

logger.info('Action 1'); // context automatically attached
logger.info('Action 2'); // context automatically attached
logger.error('Error', { error }); // context automatically attached
```

### Per-Log Data (Temporary)

- **Single-use** — passed via `LogOptions` each time
- Use `tags` for classification/filtering, `context` for detailed data

```typescript
logger.info('Button clicked', {
  tags: { buttonId: 'submit' },
  context: { clickCount: 1, timestamp: Date.now() },
});
```

### Combined Usage

```typescript
// Set global context
logger.setContext({
  userId: '12345',
  platform: 'iOS',
  appVersion: '1.0.0',
});

// Pass per-log data when logging
logger.info('Button clicked', {
  tags: { buttonId: 'submit' },
  context: { clickCount: 1 },
});

// Output:
// {
//   level: 'info',
//   message: 'Button clicked',
//   tags: { buttonId: 'submit' },
//   context: {
//     userId: '12345',       // from global context
//     platform: 'iOS',       // from global context
//     appVersion: '1.0.0',   // from global context
//     clickCount: 1           // from per-log context
//   }
// }
```

## Best Practices

### 1. Configure basic info on app startup

```typescript
// main.ts
import { initAemeath } from 'aemeath-js';

initAemeath({
  context: {
    appName: 'MyApp',
    appVersion: '1.0.0',
    environment: 'production',
    buildNumber: '100',
  },
});
```

### 2. Update user info after login

```typescript
// auth.ts
import { getAemeath } from 'aemeath-js';

function onLogin(user) {
  const logger = getAemeath();
  logger.updateContext('userId', user.id);
  logger.updateContext('username', user.name);
  logger.updateContext('role', user.role);
}
```

### 3. Avoid storing large objects in context

❌ **Bad**:

```typescript
logger.setContext({
  userProfile: {
    // Large amount of detailed user info
    ...
  }
});
```

✅ **Good**:

```typescript
logger.setContext({
  userId: user.id,
  username: user.name,
});
```

### 4. Don't store sensitive information

❌ **Bad**:

```typescript
logger.setContext({
  password: '***',
  token: '***',
  creditCard: '***',
});
```

✅ **Good**:

```typescript
logger.setContext({
  userId: user.id,
  email: user.email, // if needed
});
```

### 5. Use meaningful key names

❌ **Bad**:

```typescript
logger.setContext({
  u: '12345',
  p: 'iOS',
  v: '1.0.0',
});
```

✅ **Good**:

```typescript
logger.setContext({
  userId: '12345',
  platform: 'iOS',
  appVersion: '1.0.0',
});
```

## Complete Example

```typescript
// logger-config.ts
import { initAemeath, getAemeath } from 'aemeath-js';

function getDeviceInfo() {
  const ua = navigator.userAgent;
  return {
    platform: /iPhone|iPad/.test(ua) ? 'iOS' :
              /Android/.test(ua) ? 'Android' : 'Web',
    userAgent: ua,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height
  };
}

// Initialize
initAemeath({
  upload: async (log) => {
    await fetch('/api/logs', {
      method: 'POST',
      body: JSON.stringify(log),
    });
    return { success: true };
  },
  context: {
    appName: 'My App',
    appVersion: '1.0.0',
    environment: 'production',
    ...getDeviceInfo()
  }
});

export const logger = getAemeath();

// auth.ts
import { logger } from './logger-config';

export function onLogin(user) {
  logger.updateContext('userId', user.id);
  logger.updateContext('username', user.name);
  logger.updateContext('role', user.role);

  logger.info('User logged in successfully');
}

export function onLogout() {
  const context = logger.getContext();

  // Keep device info, remove user info
  logger.setContext({
    appName: context.appName,
    appVersion: context.appVersion,
    environment: context.environment,
    platform: context.platform,
    userAgent: context.userAgent,
    screenWidth: context.screenWidth,
    screenHeight: context.screenHeight
  });

  logger.info('User logged out');
}

// pages/Home.tsx
import { logger } from './logger-config';

export function HomePage() {
  const handleClick = () => {
    // context automatically attached
    logger.info('Home page button clicked', {
      tags: { buttonId: 'hero-cta' },
    });
  };

  return <button onClick={handleClick}>Get Started</button>;
}
```

## API Reference

### setContext(context)

Completely replace global context.

```typescript
logger.setContext({ userId: '12345' });
```

### updateContext(key, value)

Update a single key in global context. Existing keys are preserved.

```typescript
logger.updateContext('userId', '12345');
logger.updateContext('username', 'John'); // userId retained
```

### getContext()

Get current global context (returns copy).

```typescript
const context = logger.getContext();
```

### clearContext()

Clear global context.

```typescript
logger.clearContext();
```
