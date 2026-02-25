# aemeath-js 单元测试指南

> ⚠️ 本文档仅供内部开发参考，不会发布到 npm。

## 概览

| 项目 | 内容 |
|------|------|
| 测试框架 | [Vitest](https://vitest.dev/) v4.x |
| 浏览器环境模拟 | jsdom |
| 覆盖率工具 | @vitest/coverage-v8 |
| 测试文件位置 | `__tests__/*.test.ts` |
| 配置文件 | `vitest.config.ts` |

## 快速开始

### 1. 安装依赖

```bash
npm install
```

依赖已在 `devDependencies` 中声明：
- `vitest` - 测试框架
- `@vitest/coverage-v8` - 覆盖率
- `jsdom` - 浏览器环境模拟
- `@testing-library/react` - React 组件测试
- `@testing-library/jest-dom` - DOM 断言扩展
- `@vue/test-utils` - Vue 组件测试

### 2. 运行测试

```bash
# 运行全部测试（一次性）
npm test

# 监听模式（文件变化自动重跑）
npm run test:watch

# 运行并生成覆盖率报告
npm run test:coverage

# 运行单个测试文件
npx vitest run __tests__/logger.test.ts
```

### 3. 查看覆盖率

运行 `npm run test:coverage` 后，覆盖率报告会生成在终端输出中，也可以在 `coverage/` 目录下查看 HTML 报告。

---

## 测试文件结构

```
__tests__/
├── setup.ts                         # 全局测试 setup（localStorage mock 等）
├── logger.test.ts                   # Logger 核心类（26 个测试）
├── errorDeduplicator.test.ts        # 错误去重器（21 个测试）
├── routeMatcher.test.ts             # 路由匹配器（16 个测试）
├── uploadPlugin.test.ts             # 上传插件（14 个测试）
├── safeGuardPlugin.test.ts          # 安全保护插件（14 个测试）
├── errorCapturePlugin.test.ts       # 错误捕获插件（17 个测试）
├── performancePlugin.test.ts        # 性能监控插件（13 个测试）
├── networkPlugin.test.ts            # 网络请求监控插件（15 个测试）
├── earlyErrorCapturePlugin.test.ts  # 早期错误捕获插件（11 个测试）
├── sourceMapParser.test.ts          # SourceMap 解析器（14 个测试）
├── sourceMapParserDeep.test.ts      # SourceMap 深度解析 - 混淆代码还原（10 个测试）
├── sourcemapUpload.test.ts          # SourceMap 上传插件 Vite/Webpack（17 个测试）
├── earlyErrorScript.test.ts         # 早期错误脚本（9 个测试）
├── buildPlugins.test.ts             # 构建工具插件 Vite/Webpack/Rsbuild（15 个测试）
├── browser.test.ts                  # Browser IIFE 入口（19 个测试）
├── singleton.test.ts                # 单例模式（17 个测试）
├── integrations/
│   ├── react.test.tsx               # React 集成 - ErrorBoundary/Hook/HOC（15 个测试）
│   └── vue.test.ts                  # Vue 集成 - Plugin/Composition API（20 个测试）
```

**总计：18 个测试文件，283 个测试用例。**

---

## 各测试文件覆盖范围

### `logger.test.ts` - Logger 核心类

| 测试分类 | 覆盖内容 |
|---------|---------|
| 基础日志方法 | `debug/info/warn/error` 调用、级别字段、tags、error 对象 |
| 控制台输出 | `enableConsole` 开关、`setConsoleEnabled` 动态切换 |
| 上下文管理 | `setContext`、`updateContext`、`clearContext`、`getContext`、动态上下文 |
| 事件系统 | `on/off/emit`、多监听器、异常隔离 |
| 插件系统 | `use`、重复安装、`uninstall`、依赖检查、`getPlugins`、链式调用 |
| environment/release | 自动注入 |
| destroy | 清理插件和监听器 |

### `errorDeduplicator.test.ts` - 错误去重器

| 测试分类 | 覆盖内容 |
|---------|---------|
| 基础去重 | 首次/重复/超时重置 |
| 信息完整度优先 | 位置信息优先、stack 更长优先 |
| 不同错误类型 | 资源错误、Promise rejection、JS 错误的不同 hash 策略 |
| 禁用/自定义 hash | `enabled=false`、自定义 `hashFn` |
| 缓存管理 | `maxCacheSize`、`clear`、`stop` |
| 统计/计数 | `getStats`、`getCount` |
| 定期清理 | 30 秒自动清理过期条目 |
| 全局单例 | `getGlobalDeduplicator`、`resetGlobalDeduplicator` |

### `routeMatcher.test.ts` - 路由匹配器

| 测试分类 | 覆盖内容 |
|---------|---------|
| 基础匹配 | 字符串精确匹配、正则、函数、异常处理 |
| shouldCapturePath | 无配置/白名单/黑名单/黑名单优先/混合模式 |
| shouldCapture | 基于 `window.location` 的判断 |
| 工厂函数 | `createRouteMatcher` |

### `uploadPlugin.test.ts` - 上传插件

| 测试分类 | 覆盖内容 |
|---------|---------|
| 安装与卸载 | 正确安装/卸载 |
| 日志入队和上传 | 触发上传回调、多条日志依次上传 |
| 优先级 | 默认优先级排序、自定义优先级 |
| 重试机制 | `shouldRetry`、不重试、超过最大次数、异常重试 |
| 队列容量 | `maxSize` 溢出时移除低优先级 |
| 本地缓存 | `localStorage` 持久化 |
| flush | 立即上传 |

### `safeGuardPlugin.test.ts` - 安全保护插件

| 测试分类 | 覆盖内容 |
|---------|---------|
| 安装与卸载 | 安装/卸载时的 API 挂载与移除 |
| 健康状态 | 初始状态、logCount 增长 |
| 错误数过多 | 超过 maxErrors 暂停、paused 事件 |
| 频率限制 | 高频日志自动暂停 |
| 暂停与恢复 | `pause/resume`、resumed 事件 |
| 定期重置 | resetInterval 自动重置和恢复 |
| 递归保护 | `enableRecursionGuard` 配置 |

### `errorCapturePlugin.test.ts` - 错误捕获插件

| 测试分类 | 覆盖内容 |
|---------|---------|
| 全局错误 | `window.onerror` 替换和捕获 |
| Promise rejection | `unhandledrejection` 监听开关 |
| 资源错误 | `error` 事件捕获阶段监听 |
| console.error | 替换与恢复 |
| 内部错误过滤 | `_isLoggerInternalError` 标记、Logger 前缀过滤 |
| 自定义过滤器 | `errorFilter` 回调 |
| 路由匹配 | 白名单/黑名单过滤 |
| 错误去重 | 短时间内相同错误只记录一次 |

### `browser.test.ts` - Browser IIFE 入口

| 测试分类 | 覆盖内容 |
|---------|---------|
| 导出检查 | `init/getAemeath/Logger/ErrorCapturePlugin/UploadPlugin/SafeGuardPlugin` |
| init 函数 | 默认插件、选项控制、upload 回调、重复初始化 |
| getAemeath | 未初始化抛错、初始化后返回 |
| 日志级别过滤 | `level` 配置对 debug/info/warn/error 的过滤 |
| 早期错误刷新 | `__flushEarlyErrors__` 集成 |

### `singleton.test.ts` - 单例模式

| 测试分类 | 覆盖内容 |
|---------|---------|
| initAemeath | 默认插件、选项控制、重复初始化、env/release/context 传递 |
| getAemeath | 未初始化警告、初始化后返回 |
| isAemeathInitialized | 状态检查 |
| resetAemeath | 重置后重新初始化 |
| errorFilter | 传递到 ErrorCapturePlugin |

### `performancePlugin.test.ts` - 性能监控插件

| 测试分类 | 覆盖内容 |
|---------|---------|
| 安装与卸载 | 正确安装/卸载、API 挂载 |
| 采样率 | `sampleRate=0` 不启动监控 |
| 自定义标记 API | `startMark/endMark` 耗时测量、多标记互不干扰、重复 endMark |
| 配置选项 | WebVitals/资源/长任务开关、longTaskThreshold |

### `networkPlugin.test.ts` - 网络请求监控插件

| 测试分类 | 覆盖内容 |
|---------|---------|
| 安装与卸载 | 正确安装/卸载、fetch 拦截与恢复 |
| URL 过滤 | 日志上报接口排除、自定义 urlFilter |
| Fetch 拦截 | 成功/失败/网络错误请求记录 |
| 请求体捕获 | captureRequestBody 开关 |
| logTypes 过滤 | 只记录指定类型的请求 |
| 慢请求 | slowThreshold 阈值、排除模式 |
| 业务码提取 | 从响应中提取 code 和 message |

### `earlyErrorCapturePlugin.test.ts` - 早期错误捕获插件

| 测试分类 | 覆盖内容 |
|---------|---------|
| 安装与卸载 | 正确安装/卸载、enabled 开关 |
| 刷新早期错误 | `__flushEarlyErrors__` 调用、多错误记录、空数组、脚本缺失警告 |
| 路由匹配 | excludeRoutes/includeRoutes 过滤 |
| getConfig | 默认配置、自定义配置 |

### `sourceMapParser.test.ts` - SourceMap 解析器

| 测试分类 | 覆盖内容 |
|---------|---------|
| 构造与配置 | 实例创建、工厂函数 |
| parse | 空堆栈、无位置信息、非本域资源、本域加载、加载失败、localhost |
| 缓存 | enableCache 开关、重复加载、clearCache、LRU 淘汰 |
| 堆栈行格式 | `at fn (url:line:col)` 和 `at url:line:col` 两种格式 |

### `earlyErrorScript.test.ts` - 早期错误捕获脚本

| 测试分类 | 覆盖内容 |
|---------|---------|
| 脚本结构 | IIFE 包裹、非空字符串 |
| 全局变量 | `__EARLY_ERRORS__`、`__LOGGER_INITIALIZED__`、`__flushEarlyErrors__` |
| 事件监听 | error、unhandledrejection |
| 资源错误 | tagName、resource 类型 |
| 幂等性 | 多次调用返回相同内容 |

### `buildPlugins.test.ts` - 构建工具插件

| 测试分类 | 覆盖内容 |
|---------|---------|
| Vite | 插件结构、HTML 注入、enabled 开关、注入位置 |
| Webpack | 实例创建、mode 配置、apply 方法、enabled 开关、file 模式输出、自定义 filename |
| Rsbuild | 插件结构、enabled 开关、modifyHTMLTags 注册与回调 |

### `integrations/react.test.tsx` - React 集成

| 测试分类 | 覆盖内容 |
|---------|---------|
| AemeathErrorBoundary | 正常渲染、ReactNode fallback、function fallback（含 reset）、默认 fallback UI |
| 错误上报 | 崩溃自动上报到 Logger、onError 回调、componentStack 上下文 |
| useAemeath | 在 ErrorBoundary 内获取 Context Logger、在 ErrorBoundary 外使用全局单例 |
| useErrorCapture | captureError 上报错误（附带 tags）、captureMessage 指定级别 |
| withErrorBoundary | HOC 包裹、displayName 设置、正常组件透传 |

### `integrations/vue.test.ts` - Vue 集成

| 测试分类 | 覆盖内容 |
|---------|---------|
| createAemeathPlugin | install 方法、errorHandler 注册、provide 注入 Logger |
| errorHandler | Error 对象上报、非 Error 包装、组件名获取（Options API / Composition API / \_\_file）|
| 原始 handler 保留 | originalErrorHandler 调用、app 已有 errorHandler 调用 |
| warnHandler | captureWarnings 开关、警告捕获、级别/内容验证 |
| useAemeath | inject 有值时返回注入 Logger、无值时使用全局单例 |
| useErrorCapture | captureError/captureMessage、默认级别、返回 logger 实例 |

### `sourcemapUpload.test.ts` - SourceMap 上传插件

| 测试分类 | 覆盖内容 |
|---------|---------|
| uploadSourceMaps | 扫描 .map 文件、空目录处理、deleteAfterUpload 开关、自动版本号、单文件失败不影响其他 |
| Vite 插件 | 插件结构（name/apply）、enabled 开关、configResolved 保存配置、closeBundle 触发上传 |
| Webpack 插件 | 实例创建、enabled 开关、afterEmit hook 注册、扫描并上传、无输出路径处理、上传出错不阻塞构建、deleteAfterUpload |

### `sourceMapParserDeep.test.ts` - SourceMap 深度解析（混淆代码还原）

| 测试分类 | 覆盖内容 |
|---------|---------|
| 单文件还原 | 混淆位置 → 原始函数名和行列号、源代码上下文提取（含 `>` 标记）|
| 多文件打包 | 多个源文件合并为单文件后的映射还原、正确识别不同源文件 |
| 变量名还原 | Terser/esbuild 压缩后的变量名（`a` → `UserService`）映射还原 |
| 混合场景 | 本域/非本域/Chrome 扩展混合堆栈、超时优雅降级、畸形 SourceMap 降级、缓存命中（同文件只 fetch 1 次）|
| 源代码上下文 | 错误行前后 3 行提取、文件开头边界处理（无负数行号）|

---

## 编写新测试的注意事项

### 1. 模拟外部错误

由于项目路径包含 `aemeath-js`，直接在测试中 `new Error()` 的 stack trace 会包含此路径，导致被 `isAemeathInternalError` 过滤。使用自定义 stack 来模拟"外部"错误：

```typescript
function createExternalError(message: string): Error {
  const error = new Error(message);
  error.stack = `Error: ${message}\n    at UserApp.render (app.js:10:5)`;
  return error;
}
```

### 2. Fake Timers 与 SafeGuardPlugin

SafeGuardPlugin 的频率限制基于 `Date.now()` 差值。使用 `vi.useFakeTimers()` 时，两条连续日志的时间差为 0，会导致 `logsPerSecond = Infinity`，触发频率限制。解决方法：

```typescript
vi.advanceTimersByTime(1001); // 推进时间，避免 timeSinceLastLog = 0
logger.info('test');
```

### 3. 模块单例重置

`browser/index.ts` 和 `singleton/index.ts` 使用模块级变量存储全局实例。测试中需要 `vi.resetModules()` + 动态 `import()` 来获取干净的模块：

```typescript
beforeEach(() => {
  vi.resetModules();
});

it('test', async () => {
  const mod = await import('../singleton/index');
  const logger = mod.initAemeath();
  // ...
  mod.resetAemeath();
});
```

### 4. Async 队列测试

UploadPlugin 内部有 `setTimeout` 延迟（去重延迟、队列间隔）。测试时需要配合 `vi.advanceTimersByTimeAsync()` 推进时间：

```typescript
vi.useFakeTimers();
logger.info('test');
await vi.advanceTimersByTimeAsync(500); // 等待去重延迟 + 队列处理
expect(uploadFn).toHaveBeenCalled();
```

---

## 常用命令速查

| 命令 | 说明 |
|------|------|
| `npm test` | 运行全部测试 |
| `npm run test:watch` | 监听模式 |
| `npm run test:coverage` | 覆盖率报告 |
| `npx vitest run __tests__/xxx.test.ts` | 运行单个文件 |
| `npx vitest run -t "测试描述"` | 运行匹配名称的测试 |
| `npx vitest --ui` | 可视化 UI 界面 |

---

## 后续可补充的测试

目前所有单元测试均已覆盖（包括 React/Vue 集成和 SourceMap Upload 插件）。

唯一剩余的是：

| 模块 | 原因 |
|------|------|
| 端到端集成测试（E2E） | 需要真实浏览器环境（Playwright / Cypress），属于不同的测试层级，建议在有真实用户反馈后再补充 |

---

## 不发布到 npm

以下文件和目录 **不会** 随包发布到 npm：

- `__tests__/` — 测试用例
- `coverage/` — 覆盖率报告
- `vitest.config.ts` — 测试配置
- `TESTING.md` — 本文档

保障机制：
1. `package.json` 的 `files` 字段采用白名单制，只包含 `dist`、`scripts`、`docs` 等
2. `.npmignore` 显式排除了测试相关文件

---

## 单元测试入门：从零理解

> 以下内容面向完全没接触过单元测试的前端开发者。

### 什么是单元测试？

想象你组装了一台电脑。在通电之前，你会不会先检查一下：

- CPU 是不是好的？
- 内存条插紧了没？
- 硬盘能不能读写？

**单元测试就是：逐个零件检查，确认每个零件单独工作正常。**

对应到代码中：
- "零件" = 一个函数、一个类、一个模块
- "检查" = 给它输入，看输出对不对

### 最简单的例子

假设你写了一个加法函数：

```typescript
// math.ts
export function add(a: number, b: number): number {
  return a + b;
}
```

单元测试就是写一段 **自动检查** 的代码：

```typescript
// math.test.ts
import { add } from './math';

it('1 + 2 应该等于 3', () => {
  const result = add(1, 2);
  expect(result).toBe(3);  // 如果不是 3，测试就 ❌ 报错
});

it('负数相加也应该正确', () => {
  expect(add(-1, -2)).toBe(-3);
});

it('0 + 0 应该是 0', () => {
  expect(add(0, 0)).toBe(0);
});
```

运行 `npm test`，如果全部 ✅，说明 `add` 函数没问题。

**关键理解：你不是"看一眼觉得对"，而是让代码自动验证，每次改动后都能重复验证。**

### 为什么不直接 console.log 看？

你可能会想："我 `console.log(add(1, 2))` 看看就好了呀？"

区别在于：

| | console.log | 单元测试 |
|--|-------------|---------|
| 能自动判断对错吗？ | ❌ 需要你肉眼看 | ✅ 自动判断 |
| 改了代码后能自动重查吗？ | ❌ 要手动再跑 | ✅ 一条命令全部重查 |
| 能防止别人改坏你的代码吗？ | ❌ | ✅ 改坏了测试会报错 |
| 有 100 个函数时呢？ | ❌ 你看不过来 | ✅ 2 秒跑完 221 个检查 |

### 核心概念：三步走（AAA 模式）

每个测试都是三步：

```typescript
it('用户登录后应该返回 token', () => {
  // 1. Arrange（准备）—— 搭环境、造数据
  const user = { name: 'test', password: '123' };

  // 2. Act（行动）—— 调用你要测的函数
  const result = login(user);

  // 3. Assert（断言）—— 验证结果对不对
  expect(result.token).toBeDefined();
});
```

记住：**准备 → 执行 → 验证**。

### 依赖问题：Mock（假替身）

现实中的函数不会像 `add(1, 2)` 这么简单。比如：

```typescript
// uploadLog.ts
export async function uploadLog(log: string) {
  const response = await fetch('/api/logs', {
    method: 'POST',
    body: log,
  });
  return response.ok;
}
```

问题来了：你总不能每次跑测试都真的发请求到服务器吧？

**解决办法：用一个"假的 fetch"替换真的 fetch。**

```typescript
it('上传成功应返回 true', async () => {
  // 1. 准备 —— 造一个假的 fetch，让它假装返回成功
  window.fetch = vi.fn().mockResolvedValue({ ok: true });

  // 2. 执行
  const result = await uploadLog('hello');

  // 3. 验证
  expect(result).toBe(true);
  expect(window.fetch).toHaveBeenCalledWith('/api/logs', {
    method: 'POST',
    body: 'hello',
  });
});
```

`vi.fn()` 就是 Vitest 提供的 **Mock 函数**。它：
- 不会真的发请求
- 可以预设返回值
- 可以记录被调用了几次、用了什么参数

**Mock 的本质：把不可控的外部依赖替换成可控的假替身。**

常见需要 Mock 的东西：

| 类型 | 举例 | 为什么要 Mock |
|------|------|-------------|
| 网络请求 | `fetch`、`axios` | 不能真的发请求 |
| 浏览器 API | `localStorage`、`location` | jsdom 环境不完整 |
| 定时器 | `setTimeout`、`setInterval` | 不想真的等 5 秒 |
| 随机数 | `Math.random()` | 需要结果确定 |
| 当前时间 | `Date.now()` | 需要结果确定 |

### 时间控制：假时钟

```typescript
// 你的代码里有个 3 秒后执行的逻辑
setTimeout(() => {
  console.log('3 秒到了');
}, 3000);
```

测试时你不想真的等 3 秒：

```typescript
it('3 秒后应触发回调', () => {
  vi.useFakeTimers();       // 开启假时钟（时间冻结）
  const fn = vi.fn();
  setTimeout(fn, 3000);

  expect(fn).not.toHaveBeenCalled();  // 时间没走，不应触发

  vi.advanceTimersByTime(3000);       // 瞬间推进 3 秒

  expect(fn).toHaveBeenCalled();      // 现在应该触发了
  vi.useRealTimers();       // 恢复真实时钟
});
```

### 生命周期：每个测试都是干净的

```typescript
describe('我的模块', () => {
  let logger;

  beforeEach(() => {
    // 每个 it 之前执行 —— 创建全新的实例
    logger = new Logger();
  });

  afterEach(() => {
    // 每个 it 之后执行 —— 清理
    logger.destroy();
  });

  it('测试 A', () => {
    logger.info('aaa');
    // logger 是全新的，不受测试 B 影响
  });

  it('测试 B', () => {
    logger.error('bbb');
    // logger 又是全新的，不受测试 A 影响
  });
});
```

**关键原则：测试之间绝对不能互相影响。** 每次都是新环境。

### 实战：假设你新开发了一个 RateLimiter

```typescript
// rateLimiter.ts
export class RateLimiter {
  private count = 0;
  private readonly max: number;

  constructor(maxPerSecond: number) {
    this.max = maxPerSecond;
  }

  /** 尝试通过，返回 true 表示允许，false 表示被限流 */
  tryPass(): boolean {
    if (this.count >= this.max) {
      return false;
    }
    this.count++;
    return true;
  }

  /** 重置计数器（每秒调用一次） */
  reset(): void {
    this.count = 0;
  }
}
```

**第一步：想清楚要测什么**

- 未超过限制时应该返回 true
- 超过限制时应该返回 false
- reset 后应该重新允许
- 边界情况：maxPerSecond = 0

**第二步：写测试**

```typescript
// __tests__/rateLimiter.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter } from '../rateLimiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(3); // 每秒最多 3 次
  });

  it('未超过限制时应返回 true', () => {
    expect(limiter.tryPass()).toBe(true);
    expect(limiter.tryPass()).toBe(true);
    expect(limiter.tryPass()).toBe(true);
  });

  it('超过限制时应返回 false', () => {
    limiter.tryPass();
    limiter.tryPass();
    limiter.tryPass();
    expect(limiter.tryPass()).toBe(false); // 第 4 次，被限流
  });

  it('reset 后应重新允许', () => {
    limiter.tryPass();
    limiter.tryPass();
    limiter.tryPass();
    limiter.reset();
    expect(limiter.tryPass()).toBe(true); // 重置后又可以了
  });

  it('maxPerSecond=0 时应始终拒绝', () => {
    const strictLimiter = new RateLimiter(0);
    expect(strictLimiter.tryPass()).toBe(false);
  });
});
```

**第三步：运行**

```bash
npx vitest run __tests__/rateLimiter.test.ts
```

看到 4 个 ✅ 就说明你的 `RateLimiter` 逻辑正确。以后无论谁修改了这个文件，只要跑一下测试就知道有没有改坏。

### 总结：一张图理解全流程

```
你写了代码
    ↓
你写测试（描述"它应该怎样"）
    ↓
运行 npm test
    ↓
  ┌──────────────────────┐
  │  全部 ✅ → 代码没问题  │
  │  有 ❌ → 哪里写错了    │
  └──────────────────────┘
    ↓
修改代码 → 再跑测试 → 直到全绿
    ↓
提交代码，安心上线 🚀
```

### 常用 API 速查

```typescript
// ===== 断言（验证结果） =====
expect(值).toBe(预期);              // 严格相等（===）
expect(值).toEqual({ a: 1 });      // 对象/数组深度比较
expect(值).toBeDefined();          // 不是 undefined
expect(值).toBeNull();             // 是 null
expect(值).toContain('子串');       // 字符串/数组包含
expect(值).toBeGreaterThan(0);     // 大于
expect(值).toBeTypeOf('string');   // 类型检查
expect(fn).toHaveBeenCalled();     // 函数被调用过
expect(fn).toHaveBeenCalledTimes(2); // 被调用了 2 次
expect(() => fn()).toThrow();      // 应该抛出异常

// ===== Mock（造假） =====
const fn = vi.fn();                      // 创建假函数
const fn = vi.fn().mockReturnValue(42);   // 假函数返回 42
const fn = vi.fn().mockResolvedValue({}); // 假函数返回 Promise

// ===== 时间控制 =====
vi.useFakeTimers();                // 冻结时间
vi.advanceTimersByTime(5000);      // 瞬间推进 5 秒
vi.useRealTimers();                // 恢复真实时间

// ===== 结构 =====
describe('模块名', () => {          // 分组
  beforeEach(() => { });            // 每个测试前执行
  afterEach(() => { });             // 每个测试后执行
  it('应该做什么', () => { });       // 一个测试用例
});
```

