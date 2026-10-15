# 崩溃检测：恢复模式

`CrashDetectionPlugin` 是显式安装的浏览器插件，入口为
`aemeath-js/plugins/CrashDetectionPlugin`。应用自己的 Worker 入口从
`aemeath-js/crash-worker` 导入 `initCrashWorker`。根入口、单例默认配置、IIFE
和小程序默认配置均不会启用本功能。

它上报的是**前一个可见页面疑似意外终止**。心跳遗留只是间接证据，不能证明渲染进程
崩溃、OOM、浏览器被杀或某个 JS 异常。记录使用 `warn` 级别、
`tags.observation = 'suspected-crash'`、`tags.confidence = 'indirect'`，不伪造
Error、堆栈或错误证据。浏览器退出可能留下相同迹象；存储可能被清除；普通离开若
来不及写入结束状态，也可能成为疑似事件。它适合作为恢复信号，不能当精确崩溃计数器。

## 接入

先在同一 Logger 安装 Upload 和 OfflinePersistence，为项目/租户设置独立存储键，
并在取得应用所需授权后启用。参见[完整可类型检查示例](../../examples/11-crash-detection/basic.ts)。

```typescript
import { CrashDetectionPlugin } from 'aemeath-js/plugins/CrashDetectionPlugin';
const crash = new CrashDetectionPlugin({
  namespace: 'shop-production-crash',
  deliveryScope: 'shop-production', // 与 UploadPlugin 一致
  createWorker: () => new Worker(new URL('./crash.worker.ts', import.meta.url), { type: 'module' }),
  checkpoint: { collect: () => ({ routeKey: 'checkout' }) },
});
logger.use(crash);
const status = await crash.ready(); // 不兼容时仍 resolve，查看状态与 reason
```

同级 `crash.worker.ts`：

```typescript
import { initCrashWorker } from 'aemeath-js/crash-worker';
initCrashWorker();
```

每个 Logger 使用独立插件对象与全新 Dedicated Worker。单文档同 namespace 的第二个
监控器会以 `monitor-resource-in-use` 停用，第一个继续工作；独立 namespace 可以并存。
跨文档通过 IndexedDB 协作。Worker 不能共享，也不能复用已终止对象。
namespace 永久绑定 deliveryScope；清理数据仍保留绑定。切换项目/租户须使用新
namespace 以及独立的离线库、缓存键。原本合法的 `UploadPlugin.setOnUpload` 调用若
切换投递作用域，崩溃插件会以 `delivery-scope-changed` 停用并 warn，不阻断该业务
调用，也不把旧 namespace 的事件发送到新目标。Upload 原有的待投递数据与离线层
就绪检查仍然生效。
只有崩溃恢复项可以为该切换让位；普通日志仍在排队或上传时，继续拒绝切换。
已经发出的崩溃请求无法撤回，其迟到结果不改变新目标的队列状态；未确认事件保留
在原 namespace，后续仅能在原作用域恢复投递。
监控停止后，尚在等待的回执结果不再触发观察事件的完成回调，也不改变普通投递的
暂停/恢复状态；已经提交的 ACK 仍然有效。

## 配置与状态

| 配置 | 默认值 | 约束 |
| --- | --- | --- |
| `enabled` | 显式安装后 `true` | `false` 不创建 Worker |
| `namespace` | 必填 | 1–80 位 ASCII 字母数字或 `_ . -`，对应独立崩溃库 |
| `deliveryScope` | 必填 | 1–120 位 ASCII 字母数字或 `_ . : -`，与 Upload 一致 |
| `createWorker` | 必填 | 返回本插件独占的全新 Dedicated Worker |
| `mode` | `recovery` | `realtime` / `hybrid` 告警并停用 |
| `realtime` | 不设置 | 已预留；恢复模式下出现此项即配置冲突 |
| `sampleRate` | `1` | `[0, 1]` 数值，未采中不工作 |
| `routeMatch` | 不设置 | 与 Logger 路由过滤取交集 |
| `checkpoint.collect` | 不设置 | 同步返回白名单检查点 |
| `checkpoint.sanitize` | 不设置 | 同步最终清洗；返回 `null` 清空 |

`realtime` 预留 `{ monitorMainThreadStall?, stallThresholdMs?, coordination?:
'indexeddb' | 'shared-worker', createSharedWorker? }`。预留不表示已实现，未来升级仍以
recovery 为默认模式。

`getStatus()` 返回 `state`（idle/starting/active/disabled/stopped）、requestedMode、
实际 mode（recovery/none）、implementedModes、reason 和 worker/indexedDB/lifecycle
能力探测。indexedDB 仅在 Worker 完成可提交的写、读、删事务后才为 true。
`ready()` 在初始化成功、停用或卸载后完成；后续故障请读 getStatus。
`logger.hasPlugin(...)` 只说明已注册，不代表正在监控。

`addBreadcrumb({ name, phase? })` 最多保存最近 20 条，phase 为 pending/done/failed。
检查点仅接受 routeKey、operation: { name, phase }。语义标识只接受 1–80 位 ASCII
字母数字或 `_ . : -`；URL、路径、query/hash、自由文本及额外字段不会采集。
回调必须同步且不抛异常，否则停用插件。不要把账号、token 或个人信息编码进标识。
不采集 DOM、请求体、原始路由，也不合并 Logger 全局用户上下文。

## 运行、隐私与投递

可见时 Worker 每 5 秒观察，检查点最多每 15 秒采集一次，生命周期切换额外采集。
恢复先暖机 30 秒，再用两次观察确认候选记录没有进展；候选自身也须通过启动/恢复
暖机。hidden/frozen/bfcache/ended/unknown、短会话、过期会话默认不报。
隐藏、冻结、bfcache 时暂停轮询并关闭数据库；恢复后重新暖机。不安装 beforeunload
清理钩子。路由排除时不记录/恢复；Worker 最迟 5 秒发现 SPA 后续路由重新命中，无需
改写 history API。时钟或定时器突跳重新暖机；浏览器节流和观察器故障仍会影响准确性。

崩溃库为独立的 `__aemeath_crash_v1__:<namespace>` IndexedDB，TTL 7 天，上限
100 个页面、100 个事件、总量 2 MiB；白名单和条数限制使页面检查点/面包屑低于
4 KiB。预算、配额、数据库阻塞、schema 或事务失败都会停用插件。不会回退到主线程
心跳或 localStorage。

恢复记录经过 SafeGuard、beforeLog、afterLog、PayloadSanitize、beforeSend 后，
先把**最终完整日志组原子落盘，再进入上传**。主动过滤落墓碑；隐私钩子异常时拒绝该
新路径，普通日志继续保持原有异常放行行为。崩溃 outbox 持有唯一可靠副本，直到 Upload
投递回执确认成功或终态拒绝。已准备记录补传不再执行过滤，沿用原 logId、时间戳、
release/environment，不合并新页面用户上下文，不重放普通 on('log') 和控制台输出。
OfflinePersistence 不镜像这份 outbox。

自定义 `beforeLog` / `afterLog` 也必须同步。观察记录遇到 Promise/thenable 返回值
（包括 `afterLog` 扇出数组中的异步项）会拒绝准备并停用监控；异步拒绝被处理，
不会作为未处理拒绝泄漏到宿主。普通日志的既有管道行为不变。

投递为至少一次；后端必须按 `(deliveryScope, logId)` 幂等，重复请求视为成功。
requestId 每次尝试可能变化。Retry-After、分片部分 ACK 和租约隔离会持久化。
租约到期或 ACK 丢失仍可能产生相同 logId 的重复投递，网络调度沿用 Upload。

容量不足时，普通日志可以回收尚未发出的崩溃记录的内存占位；不会确认成功或删除
持久事件，也不取消已经发出的请求，原租约到期后仍可恢复，因此崩溃补报可能延后。
检查点回调内重入的生命周期事件会合并，路由/面包屑回调递归不会无限增长监控调用栈。
插件自身 Worker 的运行时错误在该 Worker 上处理，并停用监控、输出 warn；不接管
其他 Worker，也不改写宿主的业务错误处理。

`await crash.clearStoredData()` 返回 `{ cleared, reason? }`，清理本 namespace 的
记录、使旧租约失效，保留作用域绑定与当前页。不会清普通离线日志、远端记录或已经
发出的请求；未活动时可能失败，须检查返回。撤销授权时先清理，再
`logger.uninstall('crash-detection')`。卸载尝试写结束状态后终止本插件创建的 Worker，
不自动清空历史 outbox。
同一活动安装上的并发清理调用共享一次操作；完成之前暂停恢复投递。撤销授权或
卸载前，应等待并检查该次清理的返回结果。

## 兼容性与告警

必需：可用 Dedicated Worker、宿主能加载对应构建产物、Worker 内 IndexedDB 事务、
crypto 随机 ID、TextEncoder 与基本页面生命周期监听。仅构造函数存在并不足够。
缺少 SharedWorker、BroadcastChannel、Web Locks、freeze/resume、wasDiscarded、
longtask、memory API 本身不会停用恢复模式。不修改 CSP，不生成 blob/eval Worker，
不注册 Service Worker，不改写浏览器原型。Worker 部署路径与 worker-src 白名单由
应用配置。SSR 导入无副作用，浏览器外安装会停用。

失败后停止监控，以 console.warn 输出原因，按 namespace/文档/原因去重，不要求开启
debug。console 缺失或抛异常不影响业务。常见原因：

| reason | 含义/处理 |
| --- | --- |
| dedicated-worker-unavailable / lifecycle-api-unavailable / browser-environment-required | 缺少必需环境能力 |
| worker-creation-failed / worker-execution-failed / worker-timeout:init | 检查 CSP、Worker URL、构建资源与模块加载 |
| indexeddb-unavailable / indexeddb-open-failed / indexeddb-blocked / indexeddb-transaction-failed | 无法证明存储可用 |
| delivery-scope-mismatch / missing-delivery-dependencies / delivery-receipt-unavailable | 检查安装顺序和投递作用域 |
| delivery-scope-changed | Upload 已切换目标；使用匹配作用域与独立 namespace 安装新监控器 |
| monitor-resource-in-use / worker-already-owned | 使用独立资源、全新 Worker，保留第一持有者 |
| feature-not-implemented / configuration-conflict / invalid-config | 修正模式或参数 |
| storage-budget-exceeded / checkpoint-callback-failed / observation-rejected | 减少数据或修复回调后再考虑重装 |

发版门禁会从同一 npm 候选包安装并构建 Vite 5、Webpack 5、Rsbuild 生产示例；SDK
已有较宽 peer 版本范围不代表新 Worker 集成支持所有旧版本。正式发布前，同一候选包
须在隔离 CI 通过 Chromium、Firefox、WebKit 的原生 Worker/IndexedDB 验收。
源码测试和构建通过均不能代替浏览器验收。

使用完整类型示例时须显式调用 `startCrashExample()`，仅导入示例不会启动监控。同源部署可采用 `worker-src 'self'`；CI 正向示例还使用 `default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self'`。应用须自行调整策略。容量紧张时可回收已完成事件与结束/被抑制页面的历史；待投递事件仍保留到 TTL。

若其他页面可见且近期仍有进展，或存在可能仍活动的 hidden/frozen/bfcache 页面，清理返回 `{ cleared: false, reason: 'storage-in-use' }`，监控继续活动。先停止协作页面再重试；隐藏遗留无法确证存活，会保守保留至结束状态或 TTL 清理。
