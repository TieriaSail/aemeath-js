# PerformancePlugin Examples

性能监控插件示例

## 目录

- [基础使用](#基础使用)
- [Web Vitals 监控](#web-vitals-监控)
- [资源监控](#资源监控)
- [自定义性能测量](#自定义性能测量)
- [生产环境配置](#生产环境配置)

---

## 基础使用

```typescript
import { Logger, PerformancePlugin } from 'aemeath-js';

const logger = new Logger();

logger.use(
  new PerformancePlugin({
    monitorWebVitals: true,
    sampleRate: 1, // 100% 采样
  }),
);

// 插件会自动记录性能指标
```

---

## Web Vitals 监控

监控 Google 核心性能指标：

```typescript
logger.use(
  new PerformancePlugin({
    monitorWebVitals: true,
  }),
);

// 自动监控：
// - LCP (Largest Contentful Paint) - 最大内容绘制
// - FID (First Input Delay) - 首次输入延迟
// - CLS (Cumulative Layout Shift) - 累积布局偏移
// - FCP (First Contentful Paint) - 首次内容绘制
// - TTFB (Time to First Byte) - 首字节时间

// 日志示例：
// {
//   level: 'info',
//   message: '性能指标',
//   extra: {
//     metric: {
//       name: 'LCP',
//       value: 2450,
//       rating: 'good'  // 'good' | 'needs-improvement' | 'poor'
//     }
//   }
// }
```

---

## 资源监控

监控慢资源加载：

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
//   extra: {
//     resource: {
//       name: 'https://example.com/large-image.jpg',
//       type: 'img',
//       duration: 3245,
//       size: 2048000
//     }
//   }
// }
```

---

## 自定义性能测量

测量特定代码段的执行时间：

```typescript
logger.use(new PerformancePlugin());

// 方式1：使用 mark
logger.startMark('data-fetch');
const data = await fetchData();
const duration = logger.endMark('data-fetch');
console.log(`数据获取耗时: ${duration}ms`);

// 方式2：测量组件渲染
function MyComponent() {
  useEffect(() => {
    logger.startMark('component-mount');

    return () => {
      logger.endMark('component-mount');
    };
  }, []);

  return <div>...</div>;
}

// 方式3：测量两个标记之间的时间
performance.mark('start');
// ... 执行代码 ...
performance.mark('end');
logger.measure('operation', 'start', 'end');
```

---

## 生产环境配置

推荐的生产环境配置：

```typescript
import { Logger, PerformancePlugin, UploadPlugin } from 'aemeath-js';

const logger = new Logger();

// 1. 性能监控（10% 采样）
logger.use(
  new PerformancePlugin({
    monitorWebVitals: true,
    monitorResources: false, // 生产环境不监控资源
    monitorLongTasks: true,
    longTaskThreshold: 100, // 只记录 >100ms 的任务
    sampleRate: 0.1, // 10% 采样率
  }),
);

// 2. 上传到服务器
logger.use(
  new UploadPlugin({
    onUpload: async (log) => {
      // 只上传性能指标，不上传所有日志
      if (log.extra?.metric) {
        await fetch('/api/metrics', {
          method: 'POST',
          body: JSON.stringify(log.extra.metric),
        });
      }
    },
  }),
);
```

---

## 完整示例

```typescript
import { Logger, PerformancePlugin, UploadPlugin } from 'aemeath-js';

const logger = new Logger();

// 配置性能监控
logger.use(new PerformancePlugin({
  monitorWebVitals: true,
  monitorResources: true,
  monitorLongTasks: true,
  longTaskThreshold: 50,
  sampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1
}));

// 配置上传
logger.use(new UploadPlugin({
  onUpload: async (log) => {
    await fetch('/api/logs', {
      method: 'POST',
      body: JSON.stringify(log)
    });
  }
}));

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

## 性能指标说明

### Web Vitals 评分标准

| 指标     | Good   | Needs Improvement | Poor    |
| -------- | ------ | ----------------- | ------- |
| **LCP**  | ≤2.5s  | 2.5s - 4.0s       | >4.0s   |
| **FID**  | ≤100ms | 100ms - 300ms     | >300ms  |
| **CLS**  | ≤0.1   | 0.1 - 0.25        | >0.25   |
| **FCP**  | ≤1.8s  | 1.8s - 3.0s       | >3.0s   |
| **TTFB** | ≤800ms | 800ms - 1800ms    | >1800ms |

### 浏览器支持

- ✅ Chrome 77+
- ✅ Edge 79+
- ✅ Firefox 支持部分指标
- ⚠️ Safari 支持有限

---

## 最佳实践

1. **生产环境使用采样**：

   ```typescript
   sampleRate: 0.1; // 10% 采样
   ```

2. **只监控关键指标**：

   ```typescript
   monitorWebVitals: true,
   monitorResources: false,  // 避免过多日志
   monitorLongTasks: true
   ```

3. **合理设置阈值**：

   ```typescript
   longTaskThreshold: 100; // 只记录 >100ms 的任务
   ```

4. **与 UploadPlugin 配合**：

   ```typescript
   // 只上传性能指标
   if (log.extra?.metric || log.extra?.resource) {
     await uploadToServer(log);
   }
   ```

5. **定期分析数据**：
   - 设置性能预算（Performance Budget）
   - 监控趋势变化
   - 优化慢资源和长任务
