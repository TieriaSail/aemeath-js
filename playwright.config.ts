import { defineConfig, devices } from '@playwright/test';

/**
 * 真实浏览器测试
 *
 * 只跑 jsdom 测不了的东西：真实 IndexedDB 的事务时序、真实的断网/恢复、
 * 真实的页面卸载时机、WebKit 的存储行为。常规逻辑仍然留在 vitest 里跑，
 * 那边快得多。
 *
 * 需要先 `npm run build`：测试加载的是 dist 里的 IIFE 产物。
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : [['list']],
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // WebKit 是这套测试最有价值的一环：Safari 的存储限制和 IndexedDB
    // 实现与 Chromium 差别最大，也是线上最容易翻车的地方
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
