/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  detectPlatform,
  setPlatform,
  resetPlatform,
} from '../../src/platform/detect';
import { createNoopAdapter } from '../../src/platform/noop';
import type { PlatformAdapter } from '../../src/platform/types';

describe('detectPlatform', () => {
  beforeEach(() => {
    resetPlatform();
  });

  afterEach(() => {
    resetPlatform();
    // Clean up any globals we set
    vi.unstubAllGlobals();
  });

  it('node 环境下应回退到 noop 适配器', () => {
    const adapter = detectPlatform();
    expect(adapter.type).toBe('unknown');
  });

  it('连续调用应返回同一实例（缓存）', () => {
    const a = detectPlatform();
    const b = detectPlatform();
    expect(a).toBe(b);
  });

  it('resetPlatform 后应重新检测', () => {
    const a = detectPlatform();
    resetPlatform();
    const b = detectPlatform();
    expect(a).not.toBe(b);
    expect(a.type).toBe(b.type);
  });

  it('setPlatform 应覆盖自动检测', () => {
    const custom: PlatformAdapter = {
      ...createNoopAdapter(),
      type: 'miniapp',
      vendor: 'wechat',
    };
    setPlatform(custom);
    const adapter = detectPlatform();
    expect(adapter).toBe(custom);
    expect(adapter.type).toBe('miniapp');
    expect(adapter.vendor).toBe('wechat');
  });

  it('setPlatform 后 resetPlatform 应恢复自动检测', () => {
    const custom: PlatformAdapter = {
      ...createNoopAdapter(),
      type: 'miniapp',
      vendor: 'alipay',
    };
    setPlatform(custom);
    expect(detectPlatform().type).toBe('miniapp');

    resetPlatform();
    expect(detectPlatform().type).toBe('unknown');
  });

  it('微信小程序全局变量存在时应检测为 miniapp', () => {
    vi.stubGlobal('wx', {
      getSystemInfoSync: vi.fn(),
      getStorageSync: vi.fn().mockReturnValue(''),
      setStorageSync: vi.fn(),
      removeStorageSync: vi.fn(),
    });

    resetPlatform();
    const adapter = detectPlatform();
    expect(adapter.type).toBe('miniapp');
    expect(adapter.vendor).toBe('wechat');
  });

  it('支付宝小程序全局变量存在时应检测为 miniapp', () => {
    vi.stubGlobal('my', {
      getSystemInfoSync: vi.fn(),
      getStorageSync: vi.fn().mockReturnValue(''),
      setStorageSync: vi.fn(),
      removeStorageSync: vi.fn(),
    });

    resetPlatform();
    const adapter = detectPlatform();
    expect(adapter.type).toBe('miniapp');
    expect(adapter.vendor).toBe('alipay');
  });

  it('抖音小程序全局变量存在时应检测为 miniapp', () => {
    vi.stubGlobal('tt', {
      getSystemInfoSync: vi.fn(),
      getStorageSync: vi.fn().mockReturnValue(''),
      setStorageSync: vi.fn(),
      removeStorageSync: vi.fn(),
    });

    resetPlatform();
    const adapter = detectPlatform();
    expect(adapter.type).toBe('miniapp');
    expect(adapter.vendor).toBe('tiktok');
  });

  it('百度小程序全局变量存在时应检测为 miniapp', () => {
    vi.stubGlobal('swan', {
      getSystemInfoSync: vi.fn(),
      getStorageSync: vi.fn().mockReturnValue(''),
      setStorageSync: vi.fn(),
      removeStorageSync: vi.fn(),
    });

    resetPlatform();
    const adapter = detectPlatform();
    expect(adapter.type).toBe('miniapp');
    expect(adapter.vendor).toBe('baidu');
  });

  it('detectPlatform(true) 应跳过缓存重新检测', () => {
    const a = detectPlatform();
    // fresh=true 应返回新实例
    const b = detectPlatform(true);
    expect(a).not.toBe(b);
    expect(b.type).toBe('unknown');
  });

  it('detectPlatform(true) 环境变更后应反映新平台', () => {
    // 首次检测为 noop
    const first = detectPlatform();
    expect(first.type).toBe('unknown');

    // 注入微信全局变量
    vi.stubGlobal('wx', {
      getSystemInfoSync: vi.fn(),
      getStorageSync: vi.fn().mockReturnValue(''),
      setStorageSync: vi.fn(),
      removeStorageSync: vi.fn(),
    });

    // fresh=false 返回缓存（仍是 noop）
    const cached = detectPlatform(false);
    expect(cached.type).toBe('unknown');

    // fresh=true 重新检测（应发现 wx）
    const fresh = detectPlatform(true);
    expect(fresh.type).toBe('miniapp');
    expect(fresh.vendor).toBe('wechat');
  });

  describe('支付宝 wrapAlipayAPI 存储包装', () => {
    it('getStorageSync 应使用 {key} 对象参数并提取 data', () => {
      const myMock = {
        getSystemInfoSync: vi.fn(),
        getStorageSync: vi.fn().mockReturnValue({ data: 'cached-value' }),
        setStorageSync: vi.fn(),
        removeStorageSync: vi.fn(),
      };
      vi.stubGlobal('my', myMock);
      resetPlatform();

      const adapter = detectPlatform();
      expect(adapter.type).toBe('miniapp');
      expect(adapter.vendor).toBe('alipay');

      const result = adapter.storage.getItem('test-key');
      expect(myMock.getStorageSync).toHaveBeenCalledWith({ key: 'test-key' });
      expect(result).toBe('cached-value');
    });

    it('getStorageSync 返回 null/undefined 时应返回 null', () => {
      const myMock = {
        getSystemInfoSync: vi.fn(),
        getStorageSync: vi.fn().mockReturnValue({ data: undefined }),
        setStorageSync: vi.fn(),
        removeStorageSync: vi.fn(),
      };
      vi.stubGlobal('my', myMock);
      resetPlatform();

      const adapter = detectPlatform();
      const result = adapter.storage.getItem('empty-key');
      expect(result).toBeNull();
    });

    it('setStorageSync 应使用 {key, data} 对象参数', () => {
      const myMock = {
        getSystemInfoSync: vi.fn(),
        getStorageSync: vi.fn().mockReturnValue(''),
        setStorageSync: vi.fn(),
        removeStorageSync: vi.fn(),
      };
      vi.stubGlobal('my', myMock);
      resetPlatform();

      const adapter = detectPlatform();
      adapter.storage.setItem('my-key', 'my-value');
      expect(myMock.setStorageSync).toHaveBeenCalledWith({
        key: 'my-key',
        data: 'my-value',
      });
    });

    it('removeStorageSync 应使用 {key} 对象参数', () => {
      const myMock = {
        getSystemInfoSync: vi.fn(),
        getStorageSync: vi.fn().mockReturnValue(''),
        setStorageSync: vi.fn(),
        removeStorageSync: vi.fn(),
      };
      vi.stubGlobal('my', myMock);
      resetPlatform();

      const adapter = detectPlatform();
      adapter.storage.removeItem('old-key');
      expect(myMock.removeStorageSync).toHaveBeenCalledWith({ key: 'old-key' });
    });
  });

  it('小程序检测优先于浏览器', () => {
    // Simulate miniapp WebView with window + wx
    vi.stubGlobal('window', { document: {} });
    vi.stubGlobal('document', {});
    vi.stubGlobal('wx', {
      getSystemInfoSync: vi.fn(),
      getStorageSync: vi.fn().mockReturnValue(''),
      setStorageSync: vi.fn(),
      removeStorageSync: vi.fn(),
    });

    resetPlatform();
    const adapter = detectPlatform();
    expect(adapter.type).toBe('miniapp');
  });
});
