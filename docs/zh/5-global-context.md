# 全局上下文

## 简介

全局上下文允许你配置一些通用信息，这些信息会自动附加到每条日志中，无需每次手动传递。

**适用场景**：

- 用户标识：`userId`, `username`, `email`
- 设备信息：`deviceId`, `platform`, `os`, `browser`
- 应用信息：`appVersion`, `buildNumber`
- 网络信息：`ip`, `region`
- 其他需要在所有日志中携带的信息

## 基础使用

### 初始化时配置

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

### 使用

```typescript
import { getAemeath } from 'aemeath-js';

const logger = getAemeath();
logger.info('User clicked button');

// 输出：
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

## 动态更新

### updateContext() - 合并更新

```typescript
const logger = getAemeath();

// 用户登录后更新 userId
logger.updateContext('userId', '12345');

// 再次更新其他信息
logger.updateContext('username', 'John');

// 当前上下文: { userId: '12345', username: 'John', ...原有信息 }
```

### setContext() - 完全替换

```typescript
const logger = getAemeath();

// 完全替换上下文
logger.setContext({
  deviceId: 'new-device',
  appVersion: '2.0.0',
});

// 当前上下文: { deviceId: 'new-device', appVersion: '2.0.0' }
// 原有的 userId, username 等都被清除了
```

### getContext() - 获取当前上下文

```typescript
const logger = getAemeath();

const context = logger.getContext();
console.log(context); // { userId: '12345', deviceId: 'abc', ... }
```

### clearContext() - 清空上下文

```typescript
const logger = getAemeath();

logger.clearContext();
// 当前上下文: {}
```

## 实际应用场景

### 场景1：用户登录/登出

```typescript
import { getAemeath } from 'aemeath-js';

const logger = getAemeath();

// 用户登录
function onUserLogin(user) {
  logger.updateContext('userId', user.id);
  logger.updateContext('username', user.name);
  logger.updateContext('email', user.email);
  logger.updateContext('role', user.role);

  logger.info('User logged in');
}

// 用户登出
function onUserLogout() {
  const currentContext = logger.getContext();

  // 只保留设备信息，清除用户信息
  logger.setContext({
    deviceId: currentContext.deviceId,
    platform: currentContext.platform,
    appVersion: currentContext.appVersion,
  });

  logger.info('User logged out');
}
```

### 场景2：应用启动时初始化

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
      // 应用信息
    appName: 'MyApp',
    appVersion: process.env.APP_VERSION,
    buildNumber: process.env.BUILD_NUMBER,
      environment: process.env.NODE_ENV,

      // 设备信息
      ...deviceInfo,
    },
  });
}
```

### 场景3：多租户系统

```typescript
import { getAemeath } from 'aemeath-js';

const logger = getAemeath();

// 切换租户时更新上下文
function switchTenant(tenantId: string) {
  logger.updateContext('tenantId', tenantId);
  logger.updateContext('tenantName', getTenantName(tenantId));

  logger.info('Switched tenant');
}

// 之后所有日志都会自动附加 tenantId
logger.info('User action'); // 自动附加 tenantId
logger.error('Error occurred', { error }); // 自动附加 tenantId
```

### 场景4：A/B 测试

```typescript
import { getAemeath } from 'aemeath-js';

const logger = getAemeath();

// 分配 A/B 测试组
function assignABTest(userId: string) {
  const group = Math.random() > 0.5 ? 'A' : 'B';

  logger.updateContext('abTestGroup', group);
  logger.updateContext('abTestId', 'exp-001');

  logger.info('AB test assigned', { context: { group } });
}

// 之后所有日志都会携带 A/B 测试信息
logger.info('Button clicked'); // 自动附加 abTestGroup, abTestId
```

## 全局上下文 vs 单次数据

### 全局上下文（持久的）

- **全局的、持久的** — 配置一次，所有日志都自动附加
- 适用于用户、设备、应用等标识信息

```typescript
logger.setContext({ userId: '12345', platform: 'iOS' });

logger.info('Action 1'); // 自动附加 context
logger.info('Action 2'); // 自动附加 context
logger.error('Error', { error }); // 自动附加 context
```

### 单次数据（临时的）

- **单次使用** — 通过 `LogOptions` 每次传递
- 用 `tags` 做分类筛选，用 `context` 传详细数据

```typescript
logger.info('Button clicked', {
  tags: { buttonId: 'submit' },
  context: { clickCount: 1, timestamp: Date.now() },
});
```

### 两者结合使用

```typescript
// 设置全局上下文
logger.setContext({
  userId: '12345',
  platform: 'iOS',
  appVersion: '1.0.0',
});

// 记录日志时传递单次数据
logger.info('Button clicked', {
  tags: { buttonId: 'submit' },
  context: { clickCount: 1 },
});

// 输出：
// {
//   level: 'info',
//   message: 'Button clicked',
//   tags: { buttonId: 'submit' },
//   context: {
//     userId: '12345',       // 来自全局上下文
//     platform: 'iOS',       // 来自全局上下文
//     appVersion: '1.0.0',   // 来自全局上下文
//     clickCount: 1           // 来自单次 context
//   }
// }
```

## 最佳实践

### 1. 在应用启动时配置基础信息

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

### 2. 用户登录后更新用户信息

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

### 3. 避免在 context 中存储大对象

❌ **不好**：

```typescript
logger.setContext({
  userProfile: {
    // 大量用户详细信息
    ...
  }
});
```

✅ **好**：

```typescript
logger.setContext({
  userId: user.id,
  username: user.name,
});
```

### 4. 不要存储敏感信息

❌ **不好**：

```typescript
logger.setContext({
  password: '***',
  token: '***',
  creditCard: '***',
});
```

✅ **好**：

```typescript
logger.setContext({
  userId: user.id,
  email: user.email, // 如果需要的话
});
```

### 5. 使用有意义的键名

❌ **不好**：

```typescript
logger.setContext({
  u: '12345',
  p: 'iOS',
  v: '1.0.0',
});
```

✅ **好**：

```typescript
logger.setContext({
  userId: '12345',
  platform: 'iOS',
  appVersion: '1.0.0',
});
```

## 完整示例

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

// 初始化
initAemeath({
  upload: async (log) => {
    await fetch('/api/logs', {
      method: 'POST',
      body: JSON.stringify(log),
    });
    return { success: true };
  },
  context: {
    appName: 'MyApp',
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

  // 保留设备信息，移除用户信息
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
    // context 会自动附加
    logger.info('Home page button clicked', {
      tags: { buttonId: 'hero-cta' },
    });
  };

  return <button onClick={handleClick}>Get Started</button>;
}
```

## API 参考

### setContext(context)

完全替换全局上下文。

```typescript
logger.setContext({ userId: '12345' });
```

### updateContext(key, value)

逐键更新全局上下文，已有的其他键会保留。

```typescript
logger.updateContext('userId', '12345');
logger.updateContext('username', 'John'); // userId 保留
```

### getContext()

获取当前全局上下文（返回副本）。

```typescript
const context = logger.getContext();
```

### clearContext()

清空全局上下文。

```typescript
logger.clearContext();
```
