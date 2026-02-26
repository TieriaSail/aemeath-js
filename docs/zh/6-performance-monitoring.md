# PerformancePlugin - 性能监控插件

> 监控 Web Vitals 和自定义性能指标

---

## 📦 核心特性

### 1. Web Vitals 监控 ⭐

自动监控 Google 核心性能指标：

- **LCP** (Largest Contentful Paint) - 最大内容绘制
- **FID** (First Input Delay) - 首次输入延迟
- **CLS** (Cumulative Layout Shift) - 累积布局偏移
- **FCP** (First Contentful Paint) - 首次内容绘制
- **TTFB** (Time to First Byte) - 首字节时间

### 2. 资源加载监控

监控慢资源加载（默认 >1s）

### 3. 长任务监控

监控阻塞主线程的长任务（默认 >50ms）

### 4. 自定义性能测量

提供 `startMark`、`endMark`、`measure` API 测量自定义代码段

### 5. 采样率控制

支持采样率配置，减少生产环境数据量

---

## 🚀 快速开始

### 单例模式（推荐）

```typescript
import { initAemeath, getAemeath, PerformancePlugin } from 'aemeath-js';

initAemeath({
  upload: async (log) => { /* ... */ return { success: true }; },
});

getAemeath().use(
  new PerformancePlugin({
    monitorWebVitals: true,
    sampleRate: 0.1, // 10% 采样率
  }),
);
```

### 手动组装

```typescript
import { AemeathLogger, PerformancePlugin } from 'aemeath-js';

const logger = new AemeathLogger();

logger.use(
  new PerformancePlugin({
    monitorWebVitals: true,
    sampleRate: 1, // 100% 采样
  }),
);
```

---

## 📖 API 文档

### PerformancePluginOptions

```typescript
interface PerformancePluginOptions {
  /** 是否监控 Web Vitals（默认：true） */
  monitorWebVitals?: boolean;

  /** 是否监控资源加载（默认：false） */
  monitorResources?: boolean;

  /** 是否监控长任务（默认：false） */
  monitorLongTasks?: boolean;

  /** 长任务阈值（ms，默认：50） */
  longTaskThreshold?: number;

  /** 采样率（0-1，默认：1） */
  sampleRate?: number;
}
```

### 自定义性能测量 API

安装 `PerformancePlugin` 后，AemeathLogger 会扩展以下方法：

#### `logger.startMark(name: string): void`

开始一个性能标记。

```typescript
logger.startMark('data-fetch');
```

#### `logger.endMark(name: string): number | null`

结束性能标记并返回耗时（毫秒）。如果标记不存在，返回 `null`。

```typescript
const duration = logger.endMark('data-fetch');
console.log(`耗时: ${duration}ms`);
```

#### `logger.measure(name: string, startMark: string, endMark: string): number | null`

测量两个标记之间的时间。返回耗时（毫秒），如果测量失败返回 `null`。

```typescript
performance.mark('start');
// ... 执行代码 ...
performance.mark('end');
const duration = logger.measure('operation', 'start', 'end');
```

---

## 🎯 使用场景

### 场景1：监控 Web Vitals

```typescript
logger.use(
  new PerformancePlugin({
    monitorWebVitals: true,
  }),
);

// 自动记录：
// {
//   level: 'info',
//   message: '性能指标',
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

### 场景2：监控慢资源

```typescript
logger.use(
  new PerformancePlugin({
    monitorResources: true, // 监控 >1s 的资源
  }),
);

// 示例日志：
// {
//   level: 'warn',
//   message: '慢资源加载',
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

### 场景3：监控长任务

```typescript
logger.use(
  new PerformancePlugin({
    monitorLongTasks: true,
    longTaskThreshold: 100, // 只记录 >100ms 的任务
  }),
);

// 示例日志：
// {
//   level: 'warn',
//   message: '长任务检测',
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

### 场景4：自定义性能测量

#### 测量异步操作

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
    console.log(`获取用户数据耗时: ${duration}ms`);
  }
}
```

#### 测量 React 组件渲染

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

#### 使用原生 Performance API

```typescript
performance.mark('operation-start');
// ... 执行代码 ...
performance.mark('operation-end');
const duration = logger.measure(
  'operation',
  'operation-start',
  'operation-end',
);
```

---

## 🏭 生产环境配置

### 推荐配置

```typescript
import { AemeathLogger, PerformancePlugin, UploadPlugin } from 'aemeath-js';

const logger = new AemeathLogger();

// 1. 性能监控（10% 采样）
logger.use(
  new PerformancePlugin({
    monitorWebVitals: true,
    monitorResources: false,
    monitorLongTasks: true,
    longTaskThreshold: 100,
    sampleRate: 0.1,
  }),
);

// 2. 上传到服务器
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

### 开发环境配置

```typescript
logger.use(
  new PerformancePlugin({
    monitorWebVitals: true,
    monitorResources: true, // 开发环境可以监控资源
    monitorLongTasks: true,
    longTaskThreshold: 50,
    sampleRate: 1, // 开发环境 100% 采样
  }),
);
```

---

## 📊 Web Vitals 评分标准

| 指标     | Good   | Needs Improvement | Poor    |
| -------- | ------ | ----------------- | ------- |
| **LCP**  | ≤2.5s  | 2.5s - 4.0s       | >4.0s   |
| **FID**  | ≤100ms | 100ms - 300ms     | >300ms  |
| **CLS**  | ≤0.1   | 0.1 - 0.25        | >0.25   |
| **FCP**  | ≤1.8s  | 1.8s - 3.0s       | >3.0s   |
| **TTFB** | ≤800ms | 800ms - 1800ms    | >1800ms |

### 评分说明

- **good**: 性能优秀，用户体验良好
- **needs-improvement**: 需要改进，用户体验一般
- **poor**: 性能较差，用户体验差

---

## 🌐 浏览器支持

| 浏览器  | Web Vitals  | 资源监控 | 长任务监控 |
| ------- | ----------- | -------- | ---------- |
| Chrome  | ✅ 完全支持 | ✅       | ✅         |
| Edge    | ✅ 完全支持 | ✅       | ✅         |
| Firefox | ⚠️ 部分支持 | ✅       | ⚠️         |
| Safari  | ⚠️ 有限支持 | ✅       | ❌         |

**注意**：插件会自动检测浏览器支持情况，不支持的指标会被跳过。

---

## 💡 最佳实践

### 1. 生产环境使用采样

```typescript
sampleRate: 0.1; // 10% 采样，减少数据量
```

### 2. 只监控关键指标

```typescript
monitorWebVitals: true,
monitorResources: false,  // 避免过多日志
monitorLongTasks: true
```

### 3. 合理设置阈值

```typescript
longTaskThreshold: 100; // 只记录 >100ms 的任务
```

### 4. 与 UploadPlugin 配合

```typescript
// 只上传性能指标，不上传所有日志
onUpload: async (log) => {
  if (log.tags?.category === 'performance') {
    await uploadToServer(log);
    return { success: true };
  }
  return { success: false, shouldRetry: false };
};
```

### 5. 定期分析数据

- 设置性能预算（Performance Budget）
- 监控趋势变化
- 优化慢资源和长任务

---

## 📝 完整示例

```typescript
import { AemeathLogger, PerformancePlugin, UploadPlugin } from 'aemeath-js';

const logger = new AemeathLogger();

// 配置性能监控
logger.use(
  new PerformancePlugin({
    monitorWebVitals: true,
    monitorResources: true,
    monitorLongTasks: true,
    longTaskThreshold: 50,
    sampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1,
  }),
);

// 配置上传
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

// 使用
export function App() {
  useEffect(() => {
    logger.startMark('app-init');

    // 初始化应用
    initializeApp().then(() => {
      logger.endMark('app-init');
    });
  }, []);

  return <YourApp />;
}
```

---

## 🔗 相关文档

- [完整示例](./../../examples/5-performance-plugin/)
- [基础示例](./../../examples/5-performance-plugin/basic.ts)
- [自定义测量示例](./../../examples/5-performance-plugin/custom-measurement.ts)
- [快速开始](./../../QUICK_START.md)

---

## 📦 体积

- **PerformancePlugin**: ~4KB
- **依赖**: 无
- **Tree-shakable**: ✅

---

**Made with ❤️ by TieriaSail**
