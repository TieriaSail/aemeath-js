# 统一 Delivery 状态中心

> v1.10.1+ · 用一个读取接口和一组事件统一观察内存队列与持久补传

```typescript
const logger = initAemeath({ upload });

const current = logger.getDeliveryStatus();
logger.on('delivery:status', (status) => {
  renderDeliveryIndicator(status);
});
```

`totalPending` 会按稳定 `logId` 去重：同一日志同时存在于上传队列和 IndexedDB 时
只计算一次。`queued`、`inFlight`、`parked`、`persisted`、`buffered` 保留各层原始计数，
便于诊断；`persistedOnly` 表示只剩磁盘副本的记录。`buffered` 是等待存储退避重试的
写入或元数据更新，其 `logId` 会进入 `totalPending`，但不会与已提交副本重复计数。

顶层状态包括：

| 状态 | 含义 |
|---|---|
| `disabled` | 未安装 UploadPlugin |
| `idle` | 上传已启用，当前无待投递数据 |
| `delivering` | 有排队、飞行中或补传任务 |
| `paused` | 网络状态或 `setUpload(null)` 正在冻结队列 |
| `degraded` | 存在 parked/buffered、传输失败，或持久层不可用 |

状态还包含：尝试/丢弃原因计数、最老待投递年龄，以及持久层 backend、bytes、buffered、
quotaDrops、legacy giveUps、replayed 等数据。

## 生命周期事件

原有 `upload:*` 事件保持兼容，1.10.1 同时发送统一别名：

| 原事件 | 统一别名 |
|---|---|
| `upload:enqueued` | `delivery:queued` |
| `upload:attempt` | `delivery:attempt` |
| `upload:retry-scheduled` | `delivery:retry-scheduled` |
| `upload:parked` / `upload:unparked` | `delivery:parked` / `delivery:unparked` |
| `upload:success` | `delivery:delivered` |
| `upload:drop` | `delivery:dropped` |
| `upload:paused` / `upload:resumed` | `delivery:paused` / `delivery:resumed` |
| `upload:offline-unavailable` | `delivery:persistence-unavailable` |

持久记录真正写入后会发送 `delivery:persisted`。监听器异常会被隔离，不能污染上传
或持久化任务链。

状态中心只负责观测，不能替代后端对 `(项目/租户作用域, logId)` 的强制幂等。
