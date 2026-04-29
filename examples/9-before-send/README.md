# `beforeSend` 钩子示例

> 适用版本：`aemeath-js@1.5.0+`（v1 LTS）/ `aemeath-js@2.4.0+`（v2）
> 完整文档：[docs/zh/9-before-send.md](../../docs/zh/9-before-send.md) | [docs/en/9-before-send.md](../../docs/en/9-before-send.md)

`beforeSend` 是日志管道末端的最后一道关卡，对**所有日志**（包括 `NetworkPlugin` 自动捕获）生效，常用于：

- 隐私保护 / 数据脱敏（敏感字段、token、URL 参数）
- 业务过滤（丢弃噪音日志）
- 字段补充（统一加 `traceId` / `sessionId`）

## 示例文件

| 文件 | 说明 |
|------|------|
| `basic.ts` | 基础：脱敏 message + 网络请求体 |
| `redact-network.ts` | 网络日志脱敏（URL 参数 / 请求体 / 响应体；NetworkPlugin 不抓 headers） |
| `drop-noise.ts` | 业务过滤：丢弃噪音日志 |
| `runtime-swap.ts` | 运行时通过 `setBeforeSend` 动态切换钩子 |
| `compose-rules.ts` | 多个规则在单个钩子内组合 |

## 关键 API

```ts
import { initAemeath, setBeforeSend } from 'aemeath-js';

initAemeath({
  upload: async (log) => { /* ... */ },
  beforeSend: (entry) => entry,  // 修改 / 返回 null 丢弃 / 返回 undefined 放行
});

// 运行时替换
setBeforeSend((entry) => entry);

// 清除（恢复原样放行）
setBeforeSend(null);
```

## 必读注意

- ❌ 不要在 `beforeSend` 内调用 `logger.error/info/...`（会无限递归）
- ❌ 不要 mutate 原 entry，应返回**新对象**
- ✅ 钩子异常会被静默吞掉，永不阻塞主管道
- ✅ `beforeSend` 必须**同步**返回（异步处理请放进 `upload` 函数）
