import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { getEarlyErrorCaptureScript } from '../src/build-plugins/early-error-script';
import { ameathEarlyErrorPlugin } from '../src/build-plugins/vite';

for (const matching of [true, false]) {
  test(`early injection honors response CSP nonce, match=${matching}`, async ({ page }) => {
    const plugin = ameathEarlyErrorPlugin({ nonce: matching ? 'response-nonce' : 'wrong-nonce', checkCompatibility: false, autoRefreshOnChunkError: false });
    const result = (plugin.transformIndexHtml as Function)('<html/>');
    const tag = result.tags[0];
    await page.route('https://nonce.test/', route => route.fulfill({
      contentType: 'text/html', headers: { 'Content-Security-Policy': "script-src 'nonce-response-nonce'" },
      body: `<html><head><script nonce="${tag.attrs.nonce}">${tag.children}</script></head></html>`,
    }));
    await page.goto('https://nonce.test/');
    expect(await page.evaluate(() => typeof (window as any).__flushEarlyErrors__ === 'function')).toBe(matching);
  });
}

test('built v1 IIFE preserves early message/level/context and original stack through upload', async ({ page }) => {
  const early = getEarlyErrorCaptureScript({ checkCompatibility: false, autoRefreshOnChunkError: false });
  const bundle = readFileSync('dist/aemeath-js.global.js', 'utf8');
  await page.route('https://v1.test/', route => route.fulfill({ contentType: 'text/html', body: '<html><head></head></html>' }));
  await page.route('https://v1.test/missing.png', route => route.fulfill({ status: 404, body: '' }));
  await page.goto('https://v1.test/');
  await page.addScriptTag({ content: early });
  await page.evaluate(() => {
    const original = Object.freeze(new TypeError('early original'));
    (window as any).originalStack = original.stack;
    window.dispatchEvent(new ErrorEvent('error', { message: 'early original', filename: 'app.js', lineno: 1, colno: 2, error: original }));
    const img = document.createElement('img'); img.src = 'https://v1.test/missing.png'; document.body.appendChild(img);
    img.dispatchEvent(new Event('error'));
  });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    (window as any).sent = [];
    const sdk = (window as any).AemeathJs;
    const logger = sdk.init({ enableConsole: false, browserApiErrors: false, errorCapture: false, safeGuard: false, offlinePersistence: false,
      upload: (entry: unknown) => { (window as any).sent.push(JSON.parse(JSON.stringify(entry))); return { success: true }; } });
    (window as any).v1 = { hasPlatform: 'platform' in logger, hasExtensions: 'extensions' in logger };
  });
  await expect.poll(() => page.evaluate(() => (window as any).sent.length)).toBeGreaterThanOrEqual(2);
  const out = await page.evaluate(() => ({ sent: (window as any).sent, stack: (window as any).originalStack, v1: (window as any).v1 }));
  const original = out.sent.find((e: any) => e.message === 'early original');
  expect(original.level).toBe('error'); expect(original.error.stack).toBe(out.stack);
  expect(original.error.evidence).toMatchObject({ capturePhase: 'early', stackOrigin: 'original', originalName: 'TypeError' });
  expect(original.context.message).toBe('early original');
  const resource = out.sent.find((e: any) => e.error?.type === 'resource');
  expect(resource.message).toBe('Resource loading failed'); expect(resource.level).toBe('warn');
  expect(resource.error.stack).toBeUndefined(); expect(resource.context.type).toBe('resource');
  expect(out.v1).toEqual({ hasPlatform: false, hasExtensions: false });
  await page.evaluate(() => (window as any).AemeathJs.destroy());
});
