# 上报可靠性示例（断网续传 / 载荷清洗 / 丢弃观测）

> 适用版本：`aemeath-js@2.5.0+`
> 完整文档：[断网续传](../../docs/zh/11-offline-persistence.md) · [载荷清洗](../../docs/zh/10-payload-sanitize.md) · [上报插件](../../docs/zh/4-upload-plugin.md)

v2.4.0 解决的是同一个问题的三个面：**日志不应该因为网络不好或者体积太大就悄悄消失。**

| 变化                     | 之前                              | 现在                                        |
| ------------------------ | --------------------------------- | ------------------------------------------- |
| 断网                     | 3 次重试在几百毫秒内烧光，日志永久丢失 | 队列暂停，网络恢复后继续；开启续传还能跨会话 |
| 重试间隔                 | 无退避，失败即刻重来              | 指数退避 1s → 2s → 4s …… 封顶 30s           |
| 超大日志（Data URL 等）  | 原样上报，撑爆接口 / 数据库 / 存储 | 占位、按字段拆分，实在不行明确报错          |
| 日志被丢弃               | 静默                              | `onDrop` + `upload:drop` 事件 + 累计计数    |

## 示例文件

| 文件                | 说明                                                     |
| ------------------- | -------------------------------------------------------- |
| `basic.ts`          | 最小配置：一行开启断网续传，重点是怎么写 `retryReason`   |
| `observe-drops.ts`  | 三种方式拿到"哪条没送到、为什么"：回调 / 事件 / 计数     |
| `tuning.ts`         | 全部可调项 + 每一项该在什么时候调                        |

## 最重要的一件事：告诉 SDK 失败的原因

新的可靠性机制全靠 `retryReason` 区分"网络断了"和"这条日志有问题"：

```ts
import { classifyHttpUploadResponse } from 'aemeath-js';

upload: async (log) => {
  try {
    const res = await fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
    return classifyHttpUploadResponse(res.status, res.headers.get('Retry-After'));
  } catch {
    return { success: false, retryReason: 'network' };   // 不消耗预算，队列暂停
  }
}
```

不填 `retryReason` 也能跑（按 `server` 处理），但断网时就退化成"消耗预算"了 ——
这是**唯一**需要你改一行代码的地方。

## 兼容性

全部为新增配置，不改变任何已有选项的语义。行为上有两处变化：

- 上传失败后不再立刻重试，而是按指数退避 —— 如果你的测试断言了具体时序，需要相应调整
- 判定离线后队列会暂停而不是继续消耗重试预算。想要旧行为：`queue: { offlinePolicy: 'legacy' }`

`payloadSanitize` 默认启用；关闭（`payloadSanitize: false`）会输出一次控制台警告。
