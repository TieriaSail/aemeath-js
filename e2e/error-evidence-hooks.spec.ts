// Cross-origin callbacks execute before browser error-report redaction.
// Assert serialized UploadPlugin output, not merely a local catch result.
import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

test('a synchronous object throw retains wrapped provenance through upload', async ({ page }) => {
  const bundle = await build({ stdin: { resolveDir: resolve('.'), loader: 'ts', contents: `
    import { AemeathLogger } from './src/core/Logger';
    import { ErrorCapturePlugin } from './src/plugins/ErrorCapturePlugin';
    import { BrowserApiErrorsPlugin } from './src/plugins/BrowserApiErrorsPlugin';
    import { UploadPlugin } from './src/plugins/UploadPlugin';
    const sent = [];
    const logger = new AemeathLogger({ enableConsole: false });
    logger.use(new BrowserApiErrorsPlugin());
    logger.use(new ErrorCapturePlugin());
    logger.use(new UploadPlugin({ onUpload: async entry => { sent.push(JSON.parse(JSON.stringify(entry))); return { success: true }; }, cache: { enabled: false }, saveOnUnload: false, queue: { deduplicationDelay: 1 } }));
    window.probe = { sent, logger };
  ` }, bundle: true, format: 'iife', write: false });
  await page.route('https://probe.test/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
  await page.route('https://external.test/fault.js', route => route.fulfill({ contentType: 'application/javascript',
    body: 'setTimeout(function businessFault() { throw {status:503, requestId:"r-42"}; }, 0);' }));
  await page.goto('https://probe.test/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.addScriptTag({ url: 'https://external.test/fault.js' });
  await expect.poll(() => page.evaluate(() => (window as any).probe.sent.some(
    (entry: any) => entry.error?.evidence?.captureChannel === 'wrapped',
  ))).toBe(true);
  const entry = await page.evaluate(() => (window as any).probe.sent.find(
    (entry: any) => entry.error?.evidence?.captureChannel === 'wrapped',
  ));
  expect(entry.tags.errorCategory).toBe('manual');
  expect(entry.error.reason).toEqual({ status: 503, requestId: 'r-42' });
  expect(JSON.parse(entry.error.value)).toEqual(entry.error.reason);
  expect(entry.error.stack).toBeUndefined();
  await page.evaluate(() => (window as any).probe.logger.destroy());
});

for (const kind of ['timer', 'event']) {
  for (const hooked of [false, true]) {
    test(`${kind} callback without CORS; hook=${hooked}`, async ({ page }) => {
      const bundle = await build({ stdin: { resolveDir: resolve('.'), loader: 'ts', contents: `
        import { AemeathLogger } from './src/core/Logger';
        import { ErrorCapturePlugin } from './src/plugins/ErrorCapturePlugin';
        import { BrowserApiErrorsPlugin } from './src/plugins/BrowserApiErrorsPlugin';
        import { UploadPlugin } from './src/plugins/UploadPlugin';
        const sent = [];
        const logger = new AemeathLogger({ enableConsole: false });
        ${hooked ? 'logger.use(new BrowserApiErrorsPlugin());' : ''}
        logger.use(new ErrorCapturePlugin());
        logger.use(new UploadPlugin({ onUpload: async entry => { sent.push(JSON.parse(JSON.stringify(entry))); return { success: true }; }, cache: { enabled: false }, saveOnUnload: false, queue: { deduplicationDelay: 1 } }));
        window.probe = { sent, logger };
      ` }, bundle: true, format: 'iife', write: false });
      await page.route('https://probe.test/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><button id="fault">fault</button>' }));
      await page.route('https://external.test/fault.js', route => route.fulfill({ contentType: 'application/javascript', body: kind === 'timer'
        ? 'setTimeout(function businessFault() {\n  throw new TypeError("real-business-fault");\n}, 0);'
        : 'document.getElementById("fault").addEventListener("click", function businessFault() {\n  throw new TypeError("real-business-fault");\n});' }));
      await page.goto('https://probe.test/');
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.addScriptTag({ url: 'https://external.test/fault.js' });
      if (kind === 'event') await page.click('#fault');
      await expect.poll(() => page.evaluate(() => (window as any).probe.sent.length)).toBeGreaterThan(0);
      const records = await page.evaluate(() => (window as any).probe.sent);
      if (hooked) {
        const wrapped = records.find((entry: any) => entry.error?.evidence?.captureChannel === 'wrapped');
        expect(wrapped.error.value).toBe('real-business-fault');
        expect(wrapped.error.evidence.originalName).toBe('TypeError');
        expect(wrapped.error.evidence.stackOrigin).toBe('original');
        expect(wrapped.error.stack).toContain('https://external.test/fault.js:2:');
      } else {
        expect(records[0].error.value).toBe('Script error.');
        expect(records[0].error.stack).toBeUndefined();
      }
      console.log(JSON.stringify({ kind, hooked, observations: records.map((e: any) => ({ channel: e.error.evidence.captureChannel, value: e.error.value, origin: e.error.evidence.stackOrigin, firstFrames: e.error.stack?.split('\n').slice(0, 3) })) }));
      await page.evaluate(() => (window as any).probe.logger.destroy());
    });
  }
}
