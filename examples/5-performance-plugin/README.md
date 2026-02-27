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
import { AemeathLogger, PerformancePlugin } from 'aemeath-js';

const logger = new AemeathLogger();

logger.use(
  new PerformancePlugin({
    monitorWebVitals: true,
    sampleRate: 1, // 100% 采样（不影响手动 mark/measure）
  }),
);

// 插件会自动记录性能指标
```

---

## Web Vitals 监控

监控 Google 核心性能指标（2024+ 标准）：

```typescript
logger.use(
  new PerformancePlugin({
    monitorWebVitals: true,
  }),
);

// 自动监控：
// - LCP (Largest Contentful Paint) - 最大内容绘制
// - INP (Interaction to Next Paint) - 交互到下一帧绘制（替代已废弃的 FID）
// - CLS (Cumulative Layout Shift) - 累积布局偏移（Session Window 算法）
// - FCP (First Contentful Paint) - 首次内容绘制
// - TTFB (Time to First Byte) - 首字节时间
//
// 其中 LCP、INP、CLS 为累积型指标，在页面隐藏时上报最终值（各只一条日志）
// FCP、TTFB 为一次性指标，立即上报

// 日志示例：
// {
//   level: 'info',
//   message: '[performance] web-vital',
//   tags: { category: 'performance', metric: 'INP', rating: 'good' },
//   context: {
//     metric: {
//       name: 'INP',
//       value: 120,
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
    monitorResources: true,
    slowResourceThreshold: 1000, // 自定义阈值（默认 1000ms）
  }),
);

// 示例日志：
// {
//   level: 'warn',
//   message: '[performance] slow-resource',
//   tags: { category: 'performance', type: 'slow-resource' },
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

---

## 自定义性能测量

测量特定代码段的执行时间（不受采样率限制）：

```typescript
logger.use(new PerformancePlugin());

// 方式1：使用 mark
logger.startMark?.('data-fetch');
const data = await fetchData();
const duration = logger.endMark?.('data-fetch');
console.log(`数据获取耗时: ${duration}ms`);

// 方式2：测量组件渲染
function MyComponent() {
  useEffect(() => {
    logger.startMark?.('component-mount');

    return () => {
      logger.endMark?.('component-mount');
    };
  }, []);

  return <div>...</div>;
}

// 方式3：测量两个标记之间的时间
performance.mark('start');
// ... 执行代码 ...
performance.mark('end');
logger.measure?.('operation', 'start', 'end');
```

---

## 生产环境配置

推荐的生产环境配置：

```typescript
import { AemeathLogger, PerformancePlugin, UploadPlugin } from 'aemeath-js';

const logger = new AemeathLogger();

// 1. 性能监控（10% 采样）
logger.use(
  new PerformancePlugin({
    monitorWebVitals: true,
    monitorResources: false, // 生产环境按需开启
    monitorLongTasks: true,
    longTaskThreshold: 100, // 只记录 >100ms 的任务
    sampleRate: 0.1, // 10% 采样率（手动 mark/measure 不受此限制）
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

---

## 完整示例

```typescript
import { AemeathLogger, PerformancePlugin, UploadPlugin } from 'aemeath-js';

const logger = new AemeathLogger();

// 配置性能监控
logger.use(new PerformancePlugin({
  monitorWebVitals: true,
  monitorResources: true,
  monitorLongTasks: true,
  longTaskThreshold: 50,
  slowResourceThreshold: 1000,
  sampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1
}));

// 配置上传
logger.use(new UploadPlugin({
  onUpload: async (log) => {
    const res = await fetch('/api/logs', {
      method: 'POST',
      body: JSON.stringify(log)
    });
    return { success: res.ok };
  }
}));

// 使用
export function App() {
  useEffect(() => {
    logger.startMark?.('app-init');

    initializeApp().then(() => {
      logger.endMark?.('app-init');
    });
  }, []);

  return <YourApp />;
}
```

---

## 性能指标说明

### Web Vitals 评分标准（2024+ 标准）

| 指标     | Good    | Needs Improvement | Poor     |
| -------- | ------- | ----------------- | -------- |
| **LCP**  | ≤2.5s   | 2.5s - 4.0s       | >4.0s    |
| **INP**  | ≤200ms  | 200ms - 500ms     | >500ms   |
| **CLS**  | ≤0.1    | 0.1 - 0.25        | >0.25    |
| **FCP**  | ≤1.8s   | 1.8s - 3.0s       | >3.0s    |
| **TTFB** | ≤800ms  | 800ms - 1800ms    | >1800ms  |

> **注意**: FID 已于 2024 年 3 月被 INP 正式替代。INP 衡量整个页面生命周期中最慢交互的完整延迟，比 FID 更能反映真实用户体验。

### 上报策略

| 指标 | 上报时机 | 说明 |
| ---- | ------- | ---- |
| LCP  | `visibilitychange` (hidden) | 缓存最新值，只上报一次 |
| INP  | `visibilitychange` (hidden) | 取最慢交互 duration，只上报一次 |
| CLS  | `visibilitychange` (hidden) | Session Window 算法，只上报一次 |
| FCP  | 立即 | 一次性指标 |
| TTFB | 立即 | 一次性指标 |

### 浏览器支持

- ✅ Chrome 96+ (全部指标)
- ✅ Edge 96+
- ⚠️ Firefox 144+ (INP 需要 interactionId 支持)
- ⚠️ Safari 支持有限（FCP/TTFB 支持，LCP/INP/CLS 部分支持）
- 不支持的指标会静默降级，不影响业务

---

## 最佳实践

1. **生产环境使用采样**：

   ```typescript
   sampleRate: 0.1; // 10% 采样（手动 mark 不受影响）
   ```

2. **只监控关键指标**：

   ```typescript
   monitorWebVitals: true,
   monitorResources: false,  // 按需开启，避免过多日志
   monitorLongTasks: true
   ```

3. **合理设置阈值**：

   ```typescript
   longTaskThreshold: 100, // 只记录 >100ms 的任务
   slowResourceThreshold: 2000, // 只记录 >2s 的资源
   ```

4. **与 UploadPlugin 配合**：

   ```typescript
   // 只上传性能指标
   if (log.tags?.category === 'performance') {
     await uploadToServer(log);
   }
   ```

5. **定期分析数据**：
   - 设置性能预算（Performance Budget）
   - 监控趋势变化
   - 优化慢资源和长任务
