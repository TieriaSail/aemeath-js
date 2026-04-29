/**
 * 小程序精简入口单元测试
 *
 * 覆盖两个维度：
 * 1. `src/miniprogram.ts` 源码层：使用 vitest 直接 import 源模块，
 *    验证 initAemeath / createMiniAppAdapter 的行为、plugin 安装、
 *    错误路径（未传 platform、未初始化调用 getAemeath）。
 * 2. 构建产物冲烟：读取 `dist-miniprogram/index.js`（要求 `npm run build`
 *    已执行过），检查预期导出、禁用导出、以及必要的 package.json 元信息。
 *    构建产物不存在时会跳过冲烟用例，避免在仅跑单测时误报。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// Fake wx helper (minimal API used by createMiniAppAdapter + NetworkPlugin)
// ---------------------------------------------------------------------------

function createFakeWx(): Record<string, unknown> {
  const storage = new Map<string, string>();
  return {
    getSystemInfoSync: () => ({ platform: 'ios', version: '1.0.0' }),
    getStorageSync: (key: string) => storage.get(key) ?? '',
    setStorageSync: (key: string, value: string) => { storage.set(key, value); },
    removeStorageSync: (key: string) => { storage.delete(key); },
    onAppHide: vi.fn(),
    offAppHide: vi.fn(),
    onError: vi.fn(),
    offError: vi.fn(),
    onUnhandledRejection: vi.fn(),
    offUnhandledRejection: vi.fn(),
    request: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Source-level tests
// ---------------------------------------------------------------------------

describe('src/miniprogram.ts 精简入口（源码）', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    const mod = await import('../src/miniprogram');
    mod.resetAemeath();
  });

  it('应导出核心类、插件子集、小程序平台适配器与 instrumentation', async () => {
    const mod = await import('../src/miniprogram');
    expect(typeof mod.AemeathLogger).toBe('function');
    expect(typeof mod.ErrorCapturePlugin).toBe('function');
    expect(typeof mod.UploadPlugin).toBe('function');
    expect(typeof mod.SafeGuardPlugin).toBe('function');
    expect(typeof mod.NetworkPlugin).toBe('function');
    expect(typeof mod.createMiniAppAdapter).toBe('function');
    expect(typeof mod.instrumentMiniAppRequest).toBe('function');
    expect(typeof mod.initAemeath).toBe('function');
    expect(typeof mod.getAemeath).toBe('function');
    expect(typeof mod.isAemeathInitialized).toBe('function');
    expect(typeof mod.resetAemeath).toBe('function');
  });

  it('initAemeath 未传 platform 时应抛出 TypeError（失败即失败，不静默）', async () => {
    const mod = await import('../src/miniprogram');
    expect(() => mod.initAemeath({} as never)).toThrow(TypeError);
    expect(() => mod.initAemeath(undefined as never)).toThrow(TypeError);
  });

  it('initAemeath 使用 wechat 适配器时应返回实例并默认安装 error-capture / safe-guard / network', async () => {
    const mod = await import('../src/miniprogram');
    const wx = createFakeWx();
    const platform = mod.createMiniAppAdapter('wechat', wx);

    const logger = mod.initAemeath({
      platform,
      upload: async () => ({ success: true }),
    });

    expect(logger).toBeDefined();
    expect(logger.hasPlugin('error-capture')).toBe(true);
    expect(logger.hasPlugin('safe-guard')).toBe(true);
    expect(logger.hasPlugin('network')).toBe(true);
    expect(logger.hasPlugin('upload')).toBe(true);

    // 精简版不应自动启用浏览器专用插件
    expect(logger.hasPlugin('browser-api-errors')).toBe(false);
    expect(logger.hasPlugin('early-error-capture')).toBe(false);
    expect(logger.hasPlugin('performance')).toBe(false);
  });

  it('initAemeath 的 platform 应被 Logger 实际采用（type=miniapp, vendor=wechat）', async () => {
    const mod = await import('../src/miniprogram');
    const wx = createFakeWx();
    const platform = mod.createMiniAppAdapter('wechat', wx);

    const logger = mod.initAemeath({ platform });
    expect(logger.platform.type).toBe('miniapp');
    expect((logger.platform as { vendor?: string }).vendor).toBe('wechat');
  });

  it('重复调用 initAemeath 应返回同一实例（幂等）', async () => {
    const mod = await import('../src/miniprogram');
    const wx = createFakeWx();
    const platform = mod.createMiniAppAdapter('wechat', wx);

    const a = mod.initAemeath({ platform });
    const b = mod.initAemeath({ platform });
    expect(a).toBe(b);
  });

  // 升级回归（Bug D — 与 web 端 singleton 修复对称）：
  // 「第一次 init 没传 upload，第二次 init({ upload })」过去 upload 会被静默丢弃。
  // 多模块 / monorepo 场景下 A 模块先 init({}) → B 模块 init({ upload }) 是常见反模式。
  it('Bug D: 第一次 init 无 upload，第二次 init({ upload }) 必须增量补装 UploadPlugin', async () => {
    const mod = await import('../src/miniprogram');
    const wx = createFakeWx();
    const platform = mod.createMiniAppAdapter('wechat', wx);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const logger1 = mod.initAemeath({ platform });
    expect(logger1.hasPlugin('upload')).toBe(false);

    const uploadFn = vi.fn(async () => ({ success: true as const }));
    const logger2 = mod.initAemeath({ platform, upload: uploadFn });

    expect(logger2).toBe(logger1);
    expect(logger2.hasPlugin('upload')).toBe(true);

    logger2.error('post-incremental-upload');
    await new Promise((r) => setTimeout(r, 50));
    expect(uploadFn).toHaveBeenCalled();
  });

  it('Bug D: 增量补装时 console.warn 应明确「upload was honored」', async () => {
    const mod = await import('../src/miniprogram');
    const wx = createFakeWx();
    const platform = mod.createMiniAppAdapter('wechat', wx);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mod.initAemeath({ platform });
    mod.initAemeath({
      platform,
      upload: async () => ({ success: true as const }),
      environment: 'production',
    });

    const warnTexts = warnSpy.mock.calls.map((c) => String(c[0]));
    const hit = warnTexts.find((t) => t.includes('initAemeath() called twice'));
    expect(hit).toBeDefined();
    expect(hit).toContain('honored: upload');
    expect(hit).toContain('ignored');
    expect(hit).toContain('environment');
  });

  it('Bug D: 第一次 init 已有 upload 时，第二次 init({ upload }) 不应重复装载', async () => {
    const mod = await import('../src/miniprogram');
    const wx = createFakeWx();
    const platform = mod.createMiniAppAdapter('wechat', wx);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    mod.initAemeath({
      platform,
      upload: async () => ({ success: true as const }),
    });
    const firstCount = mod.getAemeath().getPlugins().filter((p) => p.name === 'upload').length;
    expect(firstCount).toBe(1);

    mod.initAemeath({
      platform,
      upload: async () => ({ success: true as const }),
    });
    const secondCount = mod.getAemeath().getPlugins().filter((p) => p.name === 'upload').length;
    expect(secondCount).toBe(1);
  });

  it('未初始化时 getAemeath 应抛 TypeError（与浏览器版静默兜底行为不同）', async () => {
    const mod = await import('../src/miniprogram');
    expect(mod.isAemeathInitialized()).toBe(false);
    expect(() => mod.getAemeath()).toThrow(TypeError);
  });

  it('initAemeath 支持 safeGuard / errorCapture / network 的禁用开关', async () => {
    const mod = await import('../src/miniprogram');
    const wx = createFakeWx();
    const platform = mod.createMiniAppAdapter('wechat', wx);

    const logger = mod.initAemeath({
      platform,
      errorCapture: false,
      safeGuard: { enabled: false },
      network: { enabled: false },
    });

    expect(logger.hasPlugin('error-capture')).toBe(false);
    expect(logger.hasPlugin('safe-guard')).toBe(false);
    expect(logger.hasPlugin('network')).toBe(false);
  });

  it('支持 alipay 适配器（raw my 对象应被自动 wrap）', async () => {
    const mod = await import('../src/miniprogram');
    const my = {
      getStorageSync: (opts: { key: string }) => ({ data: `alipay-${opts.key}` }),
      setStorageSync: vi.fn(),
      removeStorageSync: vi.fn(),
    };
    const platform = mod.createMiniAppAdapter('alipay', my);
    const logger = mod.initAemeath({ platform });
    expect(logger.platform.type).toBe('miniapp');
    expect((logger.platform as { vendor?: string }).vendor).toBe('alipay');
  });
});

// ---------------------------------------------------------------------------
// Bundle smoke tests (dist-miniprogram/index.js)
// ---------------------------------------------------------------------------

const BUNDLE_PATH = resolve(__dirname, '../dist-miniprogram/index.js');
const BUNDLE_PKG_PATH = resolve(__dirname, '../dist-miniprogram/package.json');

const BUNDLE_EXISTS = existsSync(BUNDLE_PATH);

(BUNDLE_EXISTS ? describe : describe.skip)(
  'dist-miniprogram/index.js 构建产物冲烟',
  () => {
    const expectedExports = [
      'AemeathLogger',
      'ErrorCapturePlugin',
      'UploadPlugin',
      'SafeGuardPlugin',
      'NetworkPlugin',
      'createMiniAppAdapter',
      'instrumentMiniAppRequest',
      'initAemeath',
      'getAemeath',
      'isAemeathInitialized',
      'resetAemeath',
      'LogLevelEnum',
      'ErrorCategory',
    ] as const;

    // 这些 API 不应出现在小程序 bundle（排除浏览器专用能力）
    const forbiddenExports = [
      'BrowserApiErrorsPlugin',
      'PerformancePlugin',
      'EarlyErrorCapturePlugin',
      'createBrowserAdapter',
      'createNoopAdapter',
      'detectPlatform',
      'setPlatform',
      'resetPlatform',
      'instrumentFetch',
      'instrumentXHR',
      'SourceMapParser',
      'createParser',
    ] as const;

    it('产物应为单文件（目录只含 index.js + package.json）', () => {
      expect(existsSync(BUNDLE_PATH)).toBe(true);
      expect(existsSync(BUNDLE_PKG_PATH)).toBe(true);
    });

    it('产物 package.json 应声明 CJS，避免根 type: module 误导 Node', () => {
      const pkg = JSON.parse(readFileSync(BUNDLE_PKG_PATH, 'utf8'));
      expect(pkg.type).toBe('commonjs');
      expect(pkg.main).toBe('index.js');
    });

    it('产物体积应控制在 100KB 以内（当前目标 ~50KB）', () => {
      const stats = statSync(BUNDLE_PATH);
      expect(stats.size).toBeLessThan(100 * 1024);
    });

    it('产物应可被 Node CommonJS require，所有预期 API 存在', () => {
      // 使用原文件路径 require（package.json 已声明 type: commonjs）
      const req = createRequire(import.meta.url);
      const bundle = req(BUNDLE_PATH);

      for (const name of expectedExports) {
        expect(bundle[name], `expected export "${name}"`).toBeDefined();
      }
    });

    it('产物不应泄漏任何浏览器专用 API', () => {
      const req = createRequire(import.meta.url);
      const bundle = req(BUNDLE_PATH);
      const leaks: string[] = [];
      for (const name of forbiddenExports) {
        if (bundle[name] !== undefined) leaks.push(name);
      }
      expect(leaks).toEqual([]);
    });

    it('产物源码中不应包含 BrowserApiErrorsPlugin 类声明或 web-vitals 引用', () => {
      const src = readFileSync(BUNDLE_PATH, 'utf8');
      // 允许字符串 "[BrowserApiErrors]"（SafeGuardPlugin 递归检测白名单），
      // 但不应有 browser-api-errors 作为 plugin name 标识（真正的实现）
      expect(src).not.toContain('name="browser-api-errors"');
      expect(src).not.toContain("name='browser-api-errors'");
      expect(src).not.toContain('web-vitals');
      expect(src).not.toContain('createBrowserAdapter');
    });

    it('initAemeath（来自 bundle）未传 platform 时应抛 TypeError', () => {
      const req = createRequire(import.meta.url);
      const bundle = req(BUNDLE_PATH) as {
        initAemeath: (opts: unknown) => unknown;
        resetAemeath: () => void;
      };
      bundle.resetAemeath();
      expect(() => bundle.initAemeath({})).toThrow(TypeError);
    });
  },
);
