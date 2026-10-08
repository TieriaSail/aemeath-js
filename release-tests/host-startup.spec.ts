import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = resolve('.');
const candidate = join(root, '.release-candidate/package');
const deps: Record<string, string> = {
  '/deps/dexie.mjs': join(dirname(require.resolve('dexie')), 'dexie.mjs'),
  '/deps/react.js': join(dirname(require.resolve('react')), 'umd/react.production.min.js'),
  '/deps/react-dom.js': join(dirname(require.resolve('react-dom')), 'umd/react-dom.production.min.js'),
  '/host-contract.mjs': join(root, 'release-tests/host-contract.mjs'),
};
for (const mode of ['native', 'plugin-default', 'singleton-default', 'singleton-dependency-first', 'iife-default', 'reporter-failure']) {
  test(`packed candidate preserves business startup: ${mode}`, async ({ page }) => {
    const errors: string[] = [];
    const outsideRequests: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'https://aemeath-release.test') {
        outsideRequests.push(url.href);
        await route.abort();
        return;
      }
      if (url.pathname === '/') {
        await route.fulfill({ contentType: 'text/html', body: `<!doctype html><div id="app"></div>
          <script type="module">
            import { runHostContract } from '/host-contract.mjs';
            try {
              window.releaseResult = await runHostContract({ mode: ${JSON.stringify(mode)},
                loadScript: src => new Promise((resolve, reject) => {
                  const script = document.createElement('script'); script.src = src;
                  script.onload = resolve; script.onerror = reject; document.head.append(script);
                }) });
            } catch (error) { window.releaseFailure = String(error.stack || error); throw error; }
          </script>` });
      } else if (url.pathname === '/business-api') {
        await route.fulfill({ contentType: 'application/json', body: '{}' });
      } else {
        const path = deps[url.pathname] || (url.pathname.startsWith('/candidate/dist/')
          ? join(candidate, url.pathname.slice('/candidate/'.length)) : undefined);
        if (!path) { await route.abort(); return; }
        await route.fulfill({ contentType: 'application/javascript', body: readFileSync(path) });
      }
    });
    await page.goto('https://aemeath-release.test/');
    await expect.poll(async () => page.evaluate(() => {
      const state = window as unknown as { releaseResult?: unknown; releaseFailure?: string };
      return state.releaseFailure || (state.releaseResult ? 'passed' : 'pending');
    }), { timeout: 25_000 }).toBe('passed');
    expect(errors).toEqual([]);
    expect(outsideRequests).toEqual([]);
    const result = await page.evaluate(() => (window as unknown as { releaseResult: Record<string, unknown> }).releaseResult);
    expect(result).toEqual({ mode, mounted: true, clicked: true, storage: true, fetch: true, xhr: true, globalEvents: true, captureControl: true });
  });
}
