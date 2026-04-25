# 微信小程序原生支持

自 `2.3.0-beta.0` 起，`aemeath-js` 提供了专门面向微信开发者工具 npm 构建器的精简产物 `dist-miniprogram/`。通过 `package.json` 的 `miniprogram` 字段接入，**无需任何兼容配置或 polyfill**。

本文面向三类用户：

1. **原生微信小程序**（`.js` 项目，无打包器）
2. **Taro / uni-app 等跨端框架**（已有打包器，目标为微信）
3. 评估是否需要迁移的现有用户

---

## 1. 为什么需要专用产物

微信开发者工具的 "构建 npm" 功能在解析 `aemeath-js` 的 ESM 默认入口时存在以下限制：

| 限制 | 主入口 `dist/` | 专用产物 `dist-miniprogram/` |
|------|---------------|-----------------------------|
| 文件后缀必须是 `.js` | CJS 产物后缀为 `.cjs` ❌ | `.js` ✅ |
| 不支持代码分片（chunk） | 入口 `index.cjs` 依赖多个 `chunk-*.cjs` ❌ | 单文件 bundle ✅ |
| 不处理 `package.json` 的 `exports` 字段 | 部分 sub-path 无法被解析 ❌ | 直接 `require('aemeath-js')` 即可 ✅ |
| 兼容 ES2017 语法 | ES2017 ✅ | ES2017 ✅ |

接入 `miniprogram` 字段后，微信开发者工具会把 `dist-miniprogram/` 整个目录拷贝到 `miniprogram_npm/aemeath-js/`，运行时即可 `require('aemeath-js')` 获得完整 API。

---

## 2. 精简版 API 范围

小程序产物为了极致体积控制（当前压缩后约 50KB），**仅导出在小程序环境下可运行的 API**：

### 可用导出

```javascript
const {
  AemeathLogger,

  ErrorCapturePlugin,
  UploadPlugin,
  SafeGuardPlugin,
  NetworkPlugin,

  createMiniAppAdapter,

  instrumentMiniAppRequest,

  initAemeath,
  getAemeath,
  isAemeathInitialized,
  resetAemeath,

  LogLevelEnum,
  ErrorCategory,
} = require('aemeath-js');
```

### 故意排除的 API（小程序环境无意义）

| 未导出 | 原因 |
|--------|------|
| `BrowserApiErrorsPlugin` | 依赖 `window` / `XMLHttpRequest`，小程序无此全局 |
| `PerformancePlugin` | 依赖 `PerformanceObserver` / Web Vitals |
| `EarlyErrorCapturePlugin` | 基于 `<script>` 内联的浏览器早期错误体系 |
| `createBrowserAdapter` / `detectPlatform` | 自动检测会把 `wx` 当成未声明全局，打包失败 |
| `instrumentFetch` / `instrumentXHR` | 小程序没有 `fetch` / `XMLHttpRequest` |
| `SourceMapParser` / `createParser` | 依赖 `source-map-js`，通常在服务端解析更合适 |
| React / Vue 集成 | 不适用 |

如果你需要同时在浏览器子包和小程序子包复用代码，请在浏览器侧使用主入口 `aemeath-js`（完整 API），在小程序侧使用本精简入口。二者通过 `package.json` 的 `main` / `miniprogram` 字段自动切换，**业务代码无需判断**。

---

## 3. 接入步骤（原生微信小程序）

### 3.1 安装依赖

在小程序项目根目录（与 `project.config.json` 同级）执行：

```bash
npm install aemeath-js
```

### 3.2 构建 npm

打开微信开发者工具，顶部菜单选择 **工具 → 构建 npm**。构建成功后会在 `miniprogram/` 或项目根下生成 `miniprogram_npm/aemeath-js/index.js`。

> 如果报 "未找到可以构建的 NPM 包"，请确认 `project.config.json` 中 `setting.packNpmManually`、`setting.packNpmRelationList` 的配置；详见 [微信官方文档](https://developers.weixin.qq.com/miniprogram/dev/devtools/npm.html)。

### 3.3 初始化（`app.js`）

```javascript
const { initAemeath, createMiniAppAdapter } = require('aemeath-js');

App({
  onLaunch() {
    initAemeath({
      // 小程序入口要求显式传入 platform，不做自动检测
      platform: createMiniAppAdapter('wechat', wx),

      environment: 'production',
      release: '1.0.0',

      context: {
        appName: 'my-miniprogram',
      },

      upload: (log) => new Promise((resolve) => {
        wx.request({
          url: 'https://your-server.com/api/logs',
          method: 'POST',
          data: log,
          success: () => resolve({ success: true }),
          fail: (err) => resolve({
            success: false,
            shouldRetry: true,
            error: err.errMsg,
          }),
        });
      }),

      network: {
        enabled: true,
        logTypes: ['error', 'slow'],
        slowThreshold: 3000,
      },
    });
  },

  onError(error) {
    // 小程序的 wx.onError 会由 platform 适配器自动转发给 ErrorCapturePlugin
    // 这里的 onError 仍会被调用（SDK 不会吞掉错误）
    console.error('app error:', error);
  },
});
```

### 3.4 在页面中使用

```javascript
const { getAemeath } = require('aemeath-js');

Page({
  onLoad() {
    const logger = getAemeath();
    logger.info('home loaded', { tags: { page: 'home' } });
  },

  async onSubmit() {
    const logger = getAemeath();
    try {
      await submitForm();
    } catch (err) {
      logger.error('submit failed', { error: err });
    }
  },
});
```

---

## 4. 接入步骤（Taro / uni-app）

### 4.1 Taro

Taro 的 `@tarojs/taro` 默认以 **调用方原生 API** 的形式 polyfill `wx` / `my` / `tt`。直接传入 `Taro` 即可：

```javascript
import Taro from '@tarojs/taro';
import { initAemeath, createMiniAppAdapter } from 'aemeath-js';

initAemeath({
  platform: createMiniAppAdapter('wechat', Taro),
  upload: async (log) => {
    const res = await Taro.request({
      url: 'https://your-server.com/api/logs',
      method: 'POST',
      data: log,
    });
    return { success: res.statusCode === 200 };
  },
});
```

> Taro 会自动选用 aemeath-js 的主入口（因为它在 Node 端做 bundle），不会走 `miniprogram` 字段。这也是为什么主入口必须与精简入口 API 命名保持一致 —— 业务代码无需变更。

### 4.2 uni-app

```javascript
import { initAemeath, createMiniAppAdapter } from 'aemeath-js';

initAemeath({
  platform: createMiniAppAdapter('wechat', uni),
  upload: (log) => new Promise((resolve) => {
    uni.request({
      url: 'https://your-server.com/api/logs',
      method: 'POST',
      data: log,
      success: () => resolve({ success: true }),
      fail: (err) => resolve({ success: false, shouldRetry: true, error: err.errMsg }),
    });
  }),
});
```

### 4.3 区分「原生 vs 跨端」的构建路径

| 场景 | 走哪个入口 |
|------|-----------|
| 原生微信小程序（`.js`，微信开发者工具 npm 构建） | `miniprogram` 字段 → `dist-miniprogram/index.js` |
| Taro / uni-app（Node 预编译）| `main` / `module` 字段 → `dist/index.cjs` / `dist/index.js` |
| H5 / 浏览器 | `main` / `module` / `browser` 字段 |

---

## 5. 常见问题

### Q: 为什么 `initAemeath` 要求必须传 `platform`？

因为小程序打包器会把 `aemeath-js` 当作 **运行时不可变的静态引用** 处理。若 SDK 内部自动 `detectPlatform()` 会静态检测 `wx` / `my` / `tt` / `swan` 等全局，这些全局在原生小程序项目里可能未声明，直接导致打包失败。显式传入 `platform` 既保证零运行时开销，又避免把浏览器 / Noop 适配器打进 bundle。

### Q: 原生小程序不支持 `import` / `export` 吗？

微信小程序运行时是 CommonJS。精简入口产物以 CJS 输出，内部也使用 `require` 形式。业务代码使用 `const X = require('aemeath-js')` 即可。

### Q: 产物里是否需要 `source-map-js`？

不需要。小程序侧 SDK 不会主动解析 sourcemap（建议在服务端解析上报的堆栈）。`source-map-js` 被 `external`，不会被打进 `dist-miniprogram/`。

### Q: 小程序侧是否也受 1.x "ES2020 语法崩溃" 的影响？

不会。`dist-miniprogram/index.js` 的构建目标为 ES2017，经过实测可运行在微信小程序基础库 2.0 及以上版本。

### Q: 能不能只用 `NetworkPlugin` 不用 `UploadPlugin`？

可以。所有插件都是按需安装，省略对应字段即可：

```javascript
initAemeath({
  platform: createMiniAppAdapter('wechat', wx),
  // 不传 upload，就不会安装 UploadPlugin
  network: { enabled: true },
});
```

---

## 6. 版本兼容

| `aemeath-js` 版本 | 微信基础库 | 说明 |
|-------------------|-----------|------|
| `< 2.3.0-beta.0`  | 所有     | 需手动配置 Taro/uni-app 打包器或忍受构建失败 |
| `>= 2.3.0-beta.0` | `>= 2.0` | 原生小程序 "构建 npm" 开箱即用 |

---

## 7. 参考

- 主入口 API 文档：[../../README.zh_CN.md](../../README.zh_CN.md)
- 多平台示例：[../../examples/7-multi-platform/README.md](../../examples/7-multi-platform/README.md)
- 微信官方 npm 支持说明：<https://developers.weixin.qq.com/miniprogram/dev/devtools/npm.html>
