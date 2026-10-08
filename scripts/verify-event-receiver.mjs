// Run against built entry points in fresh processes. Do not use Vitest's bound
// global event methods: they bypass prototype instrumentation in its jsdom env.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const format = process.argv[2];
const artifactRoot = resolve(process.argv[3] || root);
if (!format) {
  for (const mode of ['native', 'esm', 'cjs', 'iife', 'skip-event']) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), mode, artifactRoot], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(child.status, 0, `${mode} failed: ${child.error || ''}\n${child.stdout}\n${child.stderr}`);
    process.stdout.write(child.stdout);
  }
} else {
  const dom = new JSDOM('', { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window;
  // No test-runner error shim or pre-bound aliases; these are the realm's actual
  // Web IDL methods. The IndexedDB backend is emulated, not a native browser.
  assert.equal(w.addEventListener, w.EventTarget.prototype.addEventListener);
  const originals = new Map();
  function define(name, descriptor) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, ...descriptor });
  }
  const indexedDB = new IDBFactory();
  for (const [name, value] of Object.entries({
    window: w, document: w.document, XMLHttpRequest: w.XMLHttpRequest,
    CustomEvent: w.CustomEvent, indexedDB, IDBKeyRange,
  })) define(name, { value, writable: true });
  for (const name of ['addEventListener', 'removeEventListener', 'dispatchEvent']) {
    define(name, { get: () => w[name] });
  }
  let plugin;
  let db;
  try {
    let BrowserApiErrorsPlugin;
    if (format === 'iife') {
      w.eval(readFileSync(resolve(artifactRoot, 'dist/aemeath-js.global.js'), 'utf8'));
      BrowserApiErrorsPlugin = w.AemeathJs.BrowserApiErrorsPlugin;
    } else if (format !== 'native') {
      const entry = resolve(artifactRoot, `dist/plugins/BrowserApiErrorsPlugin.${format === 'cjs' ? 'cjs' : 'js'}`);
      ({ BrowserApiErrorsPlugin } = format === 'cjs' ? createRequire(import.meta.url)(entry) : await import(pathToFileURL(entry)));
    }
    if (BrowserApiErrorsPlugin) {
      plugin = new BrowserApiErrorsPlugin(format === 'skip-event' ? { eventTarget: false } : {});
      plugin.install({ error() {} });
    }
    let count = 0;
    const listener = () => count++;
    // This is the incident's strict, bare global call, then an extracted call.
    addEventListener('incident', listener);
    const add = w.addEventListener;
    add('incident', listener);
    w.addEventListener('incident', listener);
    dispatchEvent(new w.Event('incident'));
    removeEventListener('incident', listener);
    dispatchEvent(new w.Event('incident'));
    assert.equal(count, 1, 'global registration, deduplication or removal broke');

    for (const addReceiver of [undefined, null, w]) {
      for (const removeReceiver of [undefined, null, w]) {
        let calls = 0;
        const fn = () => calls++;
        Reflect.apply(w.addEventListener, addReceiver, ['mixed', fn]);
        w.dispatchEvent(new w.Event('mixed'));
        Reflect.apply(w.removeEventListener, removeReceiver, ['mixed', fn]);
        w.dispatchEvent(new w.Event('mixed'));
        assert.equal(calls, 1, 'mixed receiver removal broke');
      }
    }
    // Dynamic import occurs after default hooks install, in a fresh process.
    // Use Dexie's real ESM artifact, whose module evaluation registers a global
    // storage event listener, rather than a mock or a pre-imported constructor.
    const dexieEntry = resolve(dirname(createRequire(import.meta.url).resolve('dexie')), 'dexie.mjs');
    const { default: Dexie } = await import(pathToFileURL(dexieEntry));
    db = new Dexie(`aemeath-event-receiver-${format}`);
    db.version(1).stores({ rows: 'id' });
    await db.table('rows').put({ id: 1, value: 'ok' });
    assert.equal((await db.table('rows').get(1)).value, 'ok');
    await db.delete();
    assert.equal((await indexedDB.databases()).some(info => info.name === db.name), false);
    db = undefined;
    console.log(`${format}: global receiver contract + Dexie first import/create/write/read/delete passed`);
  } finally {
    if (db) await db.delete();
    plugin?.forceRestore();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    w.close();
  }
}
