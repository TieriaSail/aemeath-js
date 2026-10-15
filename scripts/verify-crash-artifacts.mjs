import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const root = resolve('.release-candidate/package/dist');
// Import the actual archive in a Node/SSR environment without Worker/IndexedDB.
const esm = await import(pathToFileURL(`${root}/index.js`));
const cjs = require(`${root}/index.cjs`);
const { CrashDetectionPlugin } = await import(pathToFileURL(`${root}/plugins/CrashDetectionPlugin.js`));
assert.equal(typeof CrashDetectionPlugin, 'function');
assert.equal(typeof require(`${root}/plugins/CrashDetectionPlugin.cjs`).CrashDetectionPlugin, 'function');
assert.equal(typeof (await import(pathToFileURL(`${root}/crash-worker.js`))).initCrashWorker, 'function');
assert.equal(typeof require(`${root}/crash-worker.cjs`).initCrashWorker, 'function');
assert.equal(esm.CrashDetectionPlugin, undefined); assert.equal(cjs.CrashDetectionPlugin, undefined);
for (const [left, right] of [[esm, cjs], [cjs, esm]]) {
  const a = new left.AemeathLogger({ enableConsole: false }), b = new right.AemeathLogger({ enableConsole: false });
  const hook = new left.BeforeSendPlugin({ beforeSend: entry => ({ ...entry, message: 'sanitized' }) });
  a.use(hook); b.use(hook); assert.equal(a.hasPlugin('before-send'), true); assert.equal(b.hasPlugin('before-send'), false);
  b.uninstall('before-send'); const logs = []; a.on('log', entry => logs.push(entry)); a.warn('secret'); assert.equal(logs[0].message, 'sanitized');
  a.destroy(); b.destroy();
}
for (const [core, hooks] of [[esm, cjs], [cjs, esm]]) {
  const host = new core.AemeathLogger({ enableConsole: false });
  const owner = { name: 'durable-producer', install() {} }; host.use(owner);
  host.use(new hooks.BeforeSendPlugin({ beforeSend: () => { throw new Error('privacy unavailable'); } }));
  const result = host[Symbol.for('aemeath.observation-preparation.v1')](owner, {
    logId: 'mixed-observation', timestamp: 123, level: 'warn', message: 'must not leak', options: {},
  });
  assert.equal(result.state, 'rejected', 'Mixed-copy privacy failure must reject observation publication');
  host.destroy();
}
for (const core of [esm, cjs]) {
  for (const kind of ['rejected', 'entry-shaped', 'rejected-fanout', 'entry-shaped-fanout']) {
    const host = new core.AemeathLogger({ enableConsole: false });
    const owner = { name: 'durable-producer', install() {} }; host.use(owner);
    const input = { logId: 'async-observation', timestamp: 123, level: 'warn', message: 'must not leak', options: {} };
    host.use({ name: 'async-after', install() {}, afterLog: entry => {
      const result = kind.startsWith('rejected') ? Promise.reject(new Error('unsupported async privacy hook')) : Object.assign(Promise.resolve(entry), entry);
      return kind.endsWith('fanout') ? [result] : result;
    } });
    try {
      assert.equal(host[Symbol.for('aemeath.observation-preparation.v1')](owner, input).state, 'rejected');
      // Let an unobserved rejection fail the process; do not suppress it with a
      // process-level handler. These are the actual installed ESM/CJS modules.
      await new Promise(resolveTurn => setTimeout(resolveTurn, 0));
      host.uninstall('async-after');
      const logs = []; host.on('log', entry => logs.push(entry)); host.info('ordinary');
      assert.equal(logs.length, 1);
    } finally { host.destroy(); }
  }
}
console.log('Verified packed crash entry points, inert SSR imports and mixed ESM/CJS object ownership.');
