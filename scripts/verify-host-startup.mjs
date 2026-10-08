import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { runHostContract } from '../release-tests/host-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
const candidate = join(root, '.release-candidate/package');
if (!mode) {
  for (const profile of ['native', 'plugin-default', 'singleton-default', 'singleton-dependency-first', 'iife-default', 'reporter-failure']) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), profile], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(child.status, 0, `${profile}: ${child.error || ''}\n${child.stdout}\n${child.stderr}`);
    process.stdout.write(child.stdout);
  }
  const control = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'disabled-hook-control'], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(control.error, undefined);
  assert.equal(control.status, 1, 'Disabled-hook negative control must fail');
  assert.match(control.stderr, /Global wrapper was bypassed or disabled/);
  console.log('Host gate correctly rejected disabled callback instrumentation');
} else {
  const require = createRequire(import.meta.url);
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'https://aemeath-release.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  for (const [name, value] of Object.entries({ window: w, document: w.document, XMLHttpRequest: w.XMLHttpRequest,
    Event: w.Event, CustomEvent: w.CustomEvent, indexedDB: new IDBFactory(), IDBKeyRange })) {
    Object.defineProperty(globalThis, name, { value, configurable: true });
    if (name === 'indexedDB' || name === 'IDBKeyRange') w[name] = value;
  }
  for (const name of ['addEventListener', 'removeEventListener', 'dispatchEvent', 'requestAnimationFrame']) {
    Object.defineProperty(globalThis, name, { get: () => w[name], configurable: true });
  }
  const deps = {
    '/deps/dexie.mjs': join(dirname(require.resolve('dexie')), 'dexie.mjs'),
    '/deps/react.js': join(dirname(require.resolve('react')), 'umd/react.production.min.js'),
    '/deps/react-dom.js': join(dirname(require.resolve('react-dom')), 'umd/react-dom.production.min.js'),
  };
  const businessResponse = async () => new Response('{}', { status: 200 });
  w.fetch = businessResponse;
  globalThis.fetch = businessResponse;
  // jsdom prerequisite emulates network; the browser gate uses real fetch/XHR
  // against fulfilled browser requests, and native IndexedDB.
  w.XMLHttpRequest.prototype.send = function() {
    Object.defineProperty(this, 'status', { value: 200 });
    this.onload?.(new w.Event('load'));
  };
  try {
    const result = await runHostContract({ mode: mode === 'disabled-hook-control' ? 'plugin-default' : mode,
      loadModule: async ref => {
        const exports = await import(pathToFileURL(deps[ref] || join(candidate, ref.slice('/candidate/'.length))));
        if (mode === 'disabled-hook-control' && exports.BrowserApiErrorsPlugin) {
          return { ...exports, BrowserApiErrorsPlugin: class extends exports.BrowserApiErrorsPlugin {
            constructor() { super({ eventTarget: false }); }
          } };
        }
        return exports;
      },
      loadScript: async ref => w.eval(readFileSync(deps[ref] || join(candidate, ref.slice('/candidate/'.length)), 'utf8')),
    });
    console.log(`Packed host startup ${mode}: ${JSON.stringify(result)}`);
  } finally { w.close(); }
}
