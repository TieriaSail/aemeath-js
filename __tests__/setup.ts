/**
 * 全局测试 setup
 *
 * 在每个测试文件执行前运行
 */

import { vi, afterEach } from 'vitest';

// Mock localStorage（jsdom 已内置，但确保行为一致）
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
  };
})();

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
  writable: true,
});

// 每个测试后清理
afterEach(() => {
  localStorageMock.clear();
  vi.restoreAllMocks();
  vi.clearAllTimers();
});

