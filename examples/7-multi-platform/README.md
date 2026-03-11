# Multi-Platform Usage Examples

# 多平台使用示例

aemeath-js v2.0 supports **browsers** and **miniapps** through the `PlatformAdapter` pattern. This document shows how to use aemeath-js across different platforms.

aemeath-js v2.0 通过 `PlatformAdapter` 模式支持 **浏览器** 和 **小程序**。本文档展示如何在不同平台上使用 aemeath-js。

---

## Table of Contents | 目录

- [1. Browser](#1-browser--浏览器)
- [2. WeChat MiniApp](#2-wechat-miniapp--微信小程序)
- [3. Alipay MiniApp](#3-alipay-miniapp--支付宝小程序)
- [4. Taro](#4-taro--跨平台框架)
- [5. uni-app](#5-uni-app)
- [6. Custom Adapter](#6-custom-adapter--自定义适配器)

---

## 1. Browser | 浏览器

Default platform — no extra config needed. Works out of the box in web browsers.

默认平台 — 无需额外配置。在浏览器中开箱即用。

```javascript
import { initAemeath, getAemeath } from 'aemeath-js';

initAemeath({
  upload: async (log) => ({ success: true }),
});

const logger = getAemeath();
logger.info('Hello from browser');
```

---

## 2. WeChat MiniApp | 微信小程序

Use `createMiniAppAdapter` with WeChat's global `wx` object.

使用 `createMiniAppAdapter` 搭配微信全局对象 `wx`。

```javascript
import { initAemeath, getAemeath, createMiniAppAdapter } from 'aemeath-js';

const platform = createMiniAppAdapter('wechat', wx);

initAemeath({
  platform,
  upload: async (log) => ({ success: true }),
});

const logger = getAemeath();
logger.info('Hello from WeChat MiniApp');
```

---

## 3. Alipay MiniApp | 支付宝小程序

Use `createMiniAppAdapter` with Alipay's global `my` object. The adapter automatically wraps Alipay's storage and network API differences — no manual handling needed.

使用 `createMiniAppAdapter` 搭配支付宝全局对象 `my`。适配器会自动包装支付宝的存储和网络 API 差异 — 无需手动处理。

```javascript
import { initAemeath, getAemeath } from 'aemeath-js';
import { createMiniAppAdapter } from 'aemeath-js';

// Alipay: raw `my` is auto-wrapped to normalize API differences
// 支付宝：原始 `my` 对象会自动包装以统一 API 差异
const platform = createMiniAppAdapter('alipay', my);

initAemeath({
  platform,
  upload: async (log) => ({ success: true }),
});
```

---

## 4. Taro | 跨平台框架

Taro provides a unified API. Pass Taro as the API object when targeting WeChat (or other miniapp vendors).

Taro 提供统一 API。以微信（或其他小程序厂商）为目标时，传入 Taro 作为 API 对象。

```javascript
import Taro from '@tarojs/taro';
import { initAemeath, getAemeath, createMiniAppAdapter } from 'aemeath-js';

// Taro provides a unified API
const platform = createMiniAppAdapter('wechat', Taro);

initAemeath({
  platform,
  upload: async (log) => ({ success: true }),
});

const logger = getAemeath();
logger.info('Hello from Taro');
```

---

## 5. uni-app

uni-app exposes `uni` as the global API. Use it with `createMiniAppAdapter`.

uni-app 将 `uni` 暴露为全局 API。与 `createMiniAppAdapter` 配合使用。

```javascript
import { initAemeath, getAemeath, createMiniAppAdapter } from 'aemeath-js';

// uni-app exposes uni as the global API (cast to any if type mismatch)
const platform = createMiniAppAdapter('wechat', uni);

initAemeath({
  platform,
  upload: async (log) => ({ success: true }),
});

const logger = getAemeath();
logger.info('Hello from uni-app');
```

---

## 6. Custom Adapter | 自定义适配器

For unsupported platforms (e.g. Node.js, custom runtimes), implement the `PlatformAdapter` interface manually.

对于不支持的平台（如 Node.js、自定义运行时），可手动实现 `PlatformAdapter` 接口。

```javascript
import { initAemeath } from 'aemeath-js';
import type { PlatformAdapter } from 'aemeath-js';

const myAdapter: PlatformAdapter = {
  type: 'unknown',
  storage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
  onBeforeExit: () => () => {},
  requestIdle: (cb) => setTimeout(cb, 0),
  getCurrentPath: () => '',
  errorCapture: {
    onGlobalError: () => () => {},
    onUnhandledRejection: () => () => {},
  },
  earlyCapture: {
    hasEarlyErrors: () => false,
    flush: () => {},
  },
};

initAemeath({
  platform: myAdapter,
  upload: async (log) => ({ success: true }),
});
```

### PlatformAdapter Interface | 接口说明

| Field | Description |
|-------|-------------|
| `type` | `'browser' \| 'miniapp' \| 'unknown'` |
| `storage` | Key-value storage for plugins (getItem, setItem, removeItem) |
| `onBeforeExit` | Lifecycle hook before app exits |
| `requestIdle` | Idle scheduling callback |
| `getCurrentPath` | Current route/path |
| `errorCapture` | Global error & unhandled rejection handlers |
| `earlyCapture` | Early error capture (hasEarlyErrors, flush) |
| `nativeAPI?` | (MiniApp only) The underlying API object for instrumentation |

---

## Supported MiniApp Vendors | 支持的小程序厂商

`createMiniAppAdapter` supports:

- `'wechat'` — 微信小程序
- `'alipay'` — 支付宝小程序
- `'tiktok'` — 抖音小程序
- `'baidu'` — 百度小程序
- `'unknown'` — 其他 / 自定义

---

## See Also | 相关文档

- [Quick Start](../../QUICK_START.md) | [快速开始](../../QUICK_START.zh_CN.md)
- [Examples Index](../README.md) | [示例索引](../README.md)
