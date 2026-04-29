# 8. 插件执行顺序（Plugin Ordering）

> 适用版本：`aemeath-js@2.4.0+`
> 之前版本不支持 `priority` 字段，所有插件按 `use()` 调用顺序执行（即等同于 `priority: 0` 全相同）。

---

## 为什么需要"插件顺序"？

`AemeathLogger` 是一个插件化的日志管道。多个插件会在同一条日志的生命周期里依次工作：

```
log() 被调用
    ↓
[plugin A.beforeLog] → [plugin B.beforeLog] → ...   （创建前钩子）
    ↓
LogEntry 构建
    ↓
[plugin A.afterLog]  → [plugin B.afterLog]  → ...   （创建后钩子）
    ↓
listener 收到 entry
```

**插件之间的执行顺序会影响最终行为**，比如：

- `BrowserApiErrorsPlugin` 必须在 `ErrorCapturePlugin` **之前** 安装（先 wrap 浏览器 API，才能让其后的错误捕获到完整堆栈）
- `BeforeSendPlugin`（隐私脱敏）必须在 `UploadPlugin` **之前** 处理 entry，才能避免敏感数据落盘

为了让用户和插件作者都能 **明确控制顺序**，从 v2.4.0 开始引入 `priority` 字段。

---

## 规则总览

```ts
interface AemeathPlugin {
  /**
   * 插件执行优先级（数值小的先执行）
   * - 默认 0
   * - 相同 priority 按 use() 调用顺序执行（稳定排序）
   */
  priority?: number;
}
```

完整排序规则：

1. **数值越小越先执行**（同时影响 `install` / `beforeLog` / `afterLog` / `uninstall`）
2. **相同 priority 按 `use()` 调用顺序执行**（稳定排序）
3. **未声明 `priority` 的插件 = 0**（与 v2.3 及之前完全一致，向下兼容）

---

## 推荐使用 `PluginPriority` 常量

避免魔法数字：

```ts
import { PluginPriority } from 'aemeath-js';

export const PluginPriority = {
  EARLIEST: -1000, // 最早：必须在所有插件之前 wrap 浏览器 API
  EARLY:    -100,  // 较早：错误捕获、beforeLog 拦截
  NORMAL:    0,    // 默认：大多数功能插件
  LATE:      100,  // 较晚：消费类（上传、批处理）
  LATEST:    1000, // 最后：用户最终拦截（beforeSend、隐私脱敏）
};
```

**经验法则：**

| 场景 | 推荐 priority |
|------|-------------|
| 需要 monkey-patch 全局 API 的插件 | `EARLIEST` |
| 错误捕获、SafeGuard 等会修改/拦截输入的插件 | `EARLY` |
| 一般功能性插件（添加上下文、丰富数据） | `NORMAL` |
| 上传、持久化、最终消费 | `LATE` |
| 全链路最终拦截（脱敏、过滤） | `LATEST` |

---

## 内置插件 priority 一览

| 插件 | priority | 原因 |
|------|----------|------|
| `BrowserApiErrorsPlugin` | `EARLIEST` (-1000) | 必须在所有插件 install 之前 wrap 浏览器 API |
| `ErrorCapturePlugin` | `EARLY` (-100) | 错误捕获，需要尽早拦截 |
| `SafeGuardPlugin` | `EARLY` (-100) | 频率限制 / 重复合并，需在消费前生效 |
| `NetworkPlugin` | `NORMAL` (0) | 普通功能插件 |
| `PerformancePlugin` | `NORMAL` (0) | 普通功能插件 |
| `EarlyErrorCapturePlugin` | `NORMAL` (0) | 普通功能插件 |
| `UploadPlugin` | `LATE` (100) | 消费类，处于管道末端 |
| `BeforeSendPlugin`（v2.4.0+） | `LATEST` (1000) | 全链路最终拦截，必须最后 |

> **注意**：`SafeGuardPlugin` 和 `ErrorCapturePlugin` 都是 `EARLY`，谁先生效取决于 `use()` 顺序。
> `initAemeath()` 当前按 `ErrorCapture → SafeGuard` 的顺序调用 `use()`。
> 二者实际行为差异极小：`ErrorCapturePlugin` 没有 `beforeLog/afterLog`（只在 `install` 中注册全局错误处理器），唯一会影响日志管道的 `beforeLog` 节流逻辑全部由 `SafeGuardPlugin` 提供。

---

## 自定义插件示例

### 示例 1：必须最早 wrap 全局对象

```ts
import { PluginPriority, type AemeathPlugin } from 'aemeath-js';

export class MyApiWrapperPlugin implements AemeathPlugin {
  readonly name = 'my-api-wrapper';
  readonly priority = PluginPriority.EARLIEST;

  install(logger) {
    const originalFn = window.someApi;
    window.someApi = (...args) => {
      try {
        return originalFn.apply(window, args);
      } catch (err) {
        logger.error(err);
        throw err;
      }
    };
  }
}
```

### 示例 2：插入到内置 Upload 之前的最后一个钩子

```ts
import { PluginPriority, type AemeathPlugin } from 'aemeath-js';

export class MyEnricherPlugin implements AemeathPlugin {
  readonly name = 'my-enricher';
  readonly priority = PluginPriority.NORMAL; // 介于 EARLY 和 LATE 之间

  install() {}

  afterLog(entry) {
    return { ...entry, extra: { enriched: true } };
  }
}
```

### 示例 3：保持向下兼容（不声明 priority）

```ts
// 旧插件无需任何修改，行为完全等同于 priority: 0
export class LegacyPlugin implements AemeathPlugin {
  readonly name = 'legacy';
  install() {}
  afterLog(entry) {
    return entry;
  }
}
```

---

## 高级 API：`getPluginInstance(name)`

从 v2.4.0 开始，可按 name 获取已安装的插件实例：

```ts
const beforeSend = logger.getPluginInstance('before-send');
beforeSend?.setHook((entry) => { /* ... */ });
```

适用场景：

- 运行时动态修改插件状态（如 `BeforeSendPlugin.setHook`）
- 调试 / 测试

> 普通功能场景请优先使用 `hasPlugin()` / `getPlugins()`。

---

## 排序结果可视化

```ts
logger.getPlugins().forEach((p) => {
  console.log(`[${p.priority}] ${p.name}`);
});

// 输出（initAemeath 默认配置 + 用户加 BeforeSend）：
// [-1000] browser-api-errors
// [-100]  error-capture
// [-100]  safe-guard
// [0]     network
// [100]   upload
// [1000]  before-send
```

> `getPlugins()` 返回顺序 **永远 = 实际执行顺序**，可放心用于调试。

---

## 常见问题

### Q1：旧插件没声明 `priority`，会不会有问题？

不会。**完全向下兼容**。未声明 `priority` 的插件等同于 `priority: 0`，并按 `use()` 调用顺序执行。

### Q2：第三方插件库会被强制升级吗？

不会。第三方插件 **不需要任何修改** 即可继续工作。如果第三方插件作者希望显式声明顺序，可在新版本中加 `priority` 字段（向下兼容）。

### Q3：如何让我的插件覆盖内置插件的 `priority`？

不建议覆盖内置插件，但可以通过自定义插件实例实现：

```ts
import { UploadPlugin } from 'aemeath-js';

class MyUpload extends UploadPlugin {
  override readonly priority = 50; // 自定义值
}
```

### Q4：`priority` 影响 `uninstall` 顺序吗？

是的。`uninstall` 也按 `priority` 顺序倒序执行（与 `install` 相反），保证依赖关系不会被破坏。

### Q5：如果两个第三方插件冲突怎么办？

**推荐**：继承并重声明 `priority`（类型安全）：

```ts
import { NetworkPlugin } from 'aemeath-js';

class EarlyNetworkPlugin extends NetworkPlugin {
  override readonly priority = -50; // 强制提前
}
logger.use(new EarlyNetworkPlugin(/* ...原构造参数 */));
```

> ⚠️ `override` 关键字在父类声明了同名字段时是必需的（开启 `noImplicitOverride` 的项目里不加会编译报错 TS4114）。

如果只想临时调整一次、不愿继承，也可在已有实例上覆盖（注意 `priority` 是 `readonly`，需绕过类型检查）：

```ts
const networkPlugin = new NetworkPlugin();
(networkPlugin as { priority: number }).priority = -50;
logger.use(networkPlugin);
```

> 这种做法绕过了类型检查，仅在调试或临时排错时用；长期使用请走继承方案。
