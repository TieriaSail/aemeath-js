import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { getEarlyErrorCaptureScript } from '../src/build-plugins/early-error-script';

let bundle: string;
test.beforeAll(async () => {
  const result = await build({
    stdin: { contents: `
      import { AemeathLogger } from './src/core/Logger';
      import { ErrorCapturePlugin } from './src/plugins/ErrorCapturePlugin';
      import { EarlyErrorCapturePlugin } from './src/plugins/EarlyErrorCapturePlugin';
      import { createBrowserAdapter } from './src/platform/browser';
      const records = [];
      const logger = new AemeathLogger({ enableConsole: false });
      logger.on('log', entry => records.push(entry));
      logger.use(new ErrorCapturePlugin());
      Object.assign(window, { evidenceTest: { records, logger, createBrowserAdapter, AemeathLogger, ErrorCapturePlugin, EarlyErrorCapturePlugin } });
    `, resolveDir: resolve('.'), loader: 'ts' },
    bundle: true, write: false, format: 'iife', target: 'es2019',
  });
  bundle = result.outputFiles[0].text;
});

test.beforeEach(async ({ page }) => {
  await page.route('https://evidence.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Evidence</title>' }));
  await page.goto('https://evidence.test/');
  await page.addScriptTag({ content: bundle });
});

for (const cors of [false, true]) {
  test(`real cross-origin exception: CORS ${cors}`, async ({ page }) => {
    await page.route('https://foreign.test/fault.js', route => route.fulfill({
      contentType: 'application/javascript',
      headers: cors ? { 'access-control-allow-origin': '*' } : {},
      body: 'throw new TypeError("foreign-script-failed");',
    }));
    await page.evaluate(cors => {
      const script = document.createElement('script');
      if (cors) script.crossOrigin = 'anonymous';
      script.src = 'https://foreign.test/fault.js';
      document.head.append(script);
    }, cors);
    await expect.poll(() => page.evaluate(() => (window as any).evidenceTest.records.length)).toBe(1);
    const error = await page.evaluate(() => (window as any).evidenceTest.records[0].error);
    if (cors) {
      expect(error.value).toContain('foreign-script-failed');
      expect(error.evidence.originalName).toBe('TypeError');
      expect(error.evidence.stackOrigin).toBe('original');
      expect(error.stack).toContain('foreign.test/fault.js');
    } else {
      expect(error.value).toBe('Script error.');
      expect(error.stack).toBeUndefined();
      expect(error.evidence.missingStackReason).toBe('browser-redacted');
    }
  });
}

test('iframe plain rejection retains nested business fields', async ({ page }) => {
  await page.evaluate(() => {
    const frame = document.createElement('iframe'); document.body.append(frame);
    const reason = (frame.contentWindow as any).JSON.parse(
      '{"status":503,"detail":{"message":"payment failed","requestId":"r-1"}}',
    );
    Promise.reject(reason);
  });
  await expect.poll(() => page.evaluate(() => (window as any).evidenceTest.records.length)).toBe(1);
  const error = await page.evaluate(() => (window as any).evidenceTest.records[0].error);
  const reason = { status: 503, detail: { message: 'payment failed', requestId: 'r-1' } };
  expect(error.reason).toEqual(reason);
  expect(JSON.parse(error.value)).toEqual(reason);
  expect(error.evidence.normalization.issues).toEqual([]);
});

test('real promise rejection keeps frozen cross-realm error and late handling semantics', async ({ page }) => {
  await page.evaluate(() => {
    const frame = document.createElement('iframe'); document.body.append(frame);
    const error = Object.freeze(Object.assign(new (frame.contentWindow as any).TypeError('iframe-rejection'), {
      status: 503, requestId: 'r-42', detail: { operation: 'pay' },
    }));
    const promise = Promise.reject(error);
    const state = (window as any).evidenceTest;
    state.reason = error;
    window.addEventListener('unhandledrejection', event => {
      if (event.promise !== promise) return;
      state.samePromise = true;
      setTimeout(() => promise.catch(reason => { state.sameReason = reason === error; }), 20);
    });
    window.addEventListener('rejectionhandled', event => {
      if (event.promise === promise) state.handled = true;
    });
  });
  await expect.poll(() => page.evaluate(() => (window as any).evidenceTest.handled)).toBe(true);
  const state = await page.evaluate(() => {
    const s = (window as any).evidenceTest;
    return { error: s.records[0].error, samePromise: s.samePromise, sameReason: s.sameReason, mutated: 'type' in s.reason };
  });
  expect(state).toMatchObject({ samePromise: true, sameReason: true, mutated: false,
    error: { value: 'iframe-rejection', status: 503, requestId: 'r-42', detail: { operation: 'pay' },
      evidence: { originalName: 'TypeError', stackOrigin: 'original' } } });
});

test('SDK failure preserves the native cancellation result of onerror', async ({ page }) => {
  const values = await page.evaluate(() => {
    const s = (window as any).evidenceTest;
    s.logger.destroy();
    const result: boolean[] = [];
    for (const value of [true, false, undefined]) {
      window.onerror = () => value;
      const off = s.createBrowserAdapter().errorCapture.onGlobalError(() => { throw Error('capture failure'); });
      const event = new ErrorEvent('error', { cancelable: true, message: 'host' });
      window.dispatchEvent(event); result.push(event.defaultPrevented); off();
    }
    return result;
  });
  expect(values).toEqual([true, false, false]);
});


test('early script prevents recursive ErrorEvent capture and honors maxErrors', async ({ page }) => {
  await page.evaluate(() => (window as any).evidenceTest.logger.destroy());
  await page.addScriptTag({ content: getEarlyErrorCaptureScript({ maxErrors: 2, autoRefreshOnChunkError: false, checkCompatibility: false }) });
  const result = await page.evaluate(() => {
    const w = window as any;
    let reads = 0;
    const emit = (error: unknown) => window.dispatchEvent(new ErrorEvent('error', { message: 'native', error }));
    const raw = { name: 'Error', get message() { if (++reads <= 20) emit(raw); return 'original'; } };
    emit(raw);
    const firstCount = w.__EARLY_ERRORS__.length;
    emit(new Error('next')); emit(new Error('over capacity'));
    return { reads, firstCount, count: w.__EARLY_ERRORS__.length };
  });
  expect(result).toEqual({ reads: 1, firstCount: 1, count: 2 });
});

test('Logger initialization from an error getter transfers the current early error once', async ({ page }) => {
  await page.evaluate(() => (window as any).evidenceTest.logger.destroy());
  await page.addScriptTag({ content: getEarlyErrorCaptureScript({ maxErrors: 2, autoRefreshOnChunkError: false, checkCompatibility: false }) });
  const result = await page.evaluate(() => {
    const w = window as any; const s = w.evidenceTest;
    const logger = new s.AemeathLogger({ enableConsole: false });
    const records: any[] = []; logger.on('log', (entry: any) => records.push(entry));
    window.dispatchEvent(new ErrorEvent('error', { message: 'native', error: {
      name: 'Error', get message() { logger.use(new s.EarlyErrorCapturePlugin()); return 'handoff'; },
    } }));
    logger.destroy();
    return { records, remaining: w.__EARLY_ERRORS__.length, initialized: w.__LOGGER_INITIALIZED__ };
  });
  expect(result.records).toHaveLength(1);
  expect(result.records[0]).toMatchObject({ error: { value: 'handoff' }, tags: { errorCategory: 'early' } });
  expect(result.remaining).toBe(0);
  expect(result.initialized).toBe(true);
});

test('existing subtype and private-field filter configurations still suppress expected errors', async ({ page }) => {
  // Keep native private fields inside the browser; page.evaluate serializes no transpiler helpers.
  await page.addScriptTag({ content: 'window.evidenceTest.ExpectedError = class extends TypeError { #expected = true; isExpected() { return this.#expected; } };' });
  const result = await page.evaluate(() => {
    const s = (window as any).evidenceTest;
    s.logger.uninstall('error-capture');
    const ExpectedError = s.ExpectedError;
    const raw = new ExpectedError('expected'); let same = false;
    s.logger.use(new s.ErrorCapturePlugin({ errorFilter(error: Error) {
      same = error === raw;
      return !(error instanceof ExpectedError && error.isExpected());
    } }));
    window.dispatchEvent(new ErrorEvent('error', { message: raw.message, error: raw }));
    return { same, count: s.records.length, mutated: Object.prototype.hasOwnProperty.call(raw, 'type') };
  });
  expect(result).toEqual({ same: true, count: 0, mutated: false });
});
