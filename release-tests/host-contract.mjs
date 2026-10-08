// Shared by the isolated browser release gate and the Node/jsdom prerequisite.
// In browsers modules are served verbatim from the packed candidate: no rebuild,
// rebundle, pre-bound globals, mocks for IndexedDB, or disabling default hooks.
export async function runHostContract({ mode, loadModule = ref => import(ref), loadScript }) {
  let sdk;
  let plugin;
  let logger;
  const logs = [];
  let reportAttempts = 0;
  const nativeAdd = window.addEventListener;
  const nativeRemove = window.removeEventListener;
  const invalidReceiver = {};
  const callback = () => {};
  function rejection(method) {
    try { Reflect.apply(method, invalidReceiver, ['invalid', callback]); }
    catch (error) { return error.name + ':' + error.message; }
    throw new Error('Native invalid receiver was unexpectedly accepted');
  }
  const nativeRejection = rejection(nativeAdd);
  let db;
  let root;
  function check(value, message) { if (!value) throw new Error(message); }
  try {
    const dependencyFirst = mode === 'singleton-dependency-first'
      ? await loadModule('/deps/dexie.mjs') : undefined;
    if (mode === 'singleton-default' || mode === 'singleton-dependency-first') {
      sdk = await loadModule('/candidate/dist/singleton.js');
      logger = sdk.initAemeath({ enableConsole: false });
      logger.on('log', entry => logs.push(entry));
      plugin = logger.getPluginInstance('browser-api-errors');
    } else if (mode === 'iife-default') {
      await loadScript('/candidate/dist/aemeath-js.global.js');
      logger = window.AemeathJs.init({ enableConsole: false });
      logger.on('log', entry => logs.push(entry));
      plugin = logger.getPluginInstance('browser-api-errors');
    } else if (mode !== 'native') {
      const { BrowserApiErrorsPlugin } = await loadModule('/candidate/dist/plugins/BrowserApiErrorsPlugin.js');
      plugin = new BrowserApiErrorsPlugin();
      plugin.install({ error(_message, { error }) {
        reportAttempts++;
        if (mode === 'reporter-failure') throw new Error('SDK reporting failed');
        logs.push({ error });
      } });
    }
    if (mode !== 'native') check(plugin, 'Default callback instrumentation was not installed');
    check(rejection(window.addEventListener) === nativeRejection, 'Native invalid receiver contract changed');
    let count = 0;
    const listener = () => count++;
    addEventListener('host-contract', listener);
    const add = window.addEventListener;
    add('host-contract', listener);
    window.addEventListener('host-contract', listener);
    dispatchEvent(new Event('host-contract'));
    removeEventListener('host-contract', listener);
    dispatchEvent(new Event('host-contract'));
    check(count === 1, 'Global event registration/deduplication/removal broke');

    // Positive observation control: passing because hooks were skipped is a
    // failure. Expected business exception is observed through native error
    // delivery, including when the SDK's reporter itself throws.
    const businessError = new Error('host business error control');
    const observed = [];
    const suppress = event => { observed.push(event.error); event.preventDefault(); };
    Reflect.apply(nativeAdd, window, ['error', suppress]);
    const throwing = () => { throw businessError; };
    addEventListener('capture-control', throwing);
    dispatchEvent(new Event('capture-control'));
    removeEventListener('capture-control', throwing);
    Reflect.apply(nativeRemove, window, ['error', suppress]);
    check(observed.includes(businessError), 'Original business exception was swallowed/replaced');
    if (mode === 'reporter-failure') check(reportAttempts === 1, 'Failing SDK reporter was not exercised');
    else if (mode !== 'native') check(logs.some(entry => entry.error?.evidence?.captureChannel === 'wrapped'), 'Global wrapper was bypassed or disabled');

    // Dependency evaluation and application mounting happen after SDK init.
    const { default: Dexie } = dependencyFirst || await loadModule('/deps/dexie.mjs');
    db = new Dexie('aemeath-host-release-contract');
    db.version(1).stores({ rows: 'id' });
    await db.table('rows').put({ id: 1, value: 'ok' });
    check((await db.table('rows').get(1)).value === 'ok', 'Business storage failed');
    await db.delete();
    db = undefined;
    await loadScript('/deps/react.js');
    await loadScript('/deps/react-dom.js');
    root = window.ReactDOM.createRoot(document.getElementById('app'));
    root.render(window.React.createElement('button', {
      id: 'business-button', onClick: () => document.getElementById('app').setAttribute('data-clicked', 'yes'),
    }, 'Business mounted'));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const button = document.getElementById('business-button');
    check(button?.textContent === 'Business mounted', 'React application failed to mount');
    button.click();
    check(document.getElementById('app').getAttribute('data-clicked') === 'yes', 'Business interaction failed');
    check((await fetch('/business-api')).ok, 'Business fetch failed');
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/business-api');
      xhr.onload = () => xhr.status === 200 ? resolve() : reject(new Error('Business XHR status failed'));
      xhr.onerror = () => reject(new Error('Business XHR failed'));
      xhr.send();
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    if (plugin) {
      plugin.uninstall();
      const addAfterPause = window.addEventListener;
      addAfterPause('after-pause', listener);
      window.removeEventListener('after-pause', listener);
      window.dispatchEvent(new Event('after-pause'));
      check(count === 1, 'Paused instrumentation broke the host');
    }
    return { mode, mounted: true, clicked: true, storage: true, fetch: true, xhr: true, globalEvents: true, captureControl: true };
  } finally {
    root?.unmount();
    if (db) await db.delete();
    logger?.destroy();
    plugin?.forceRestore();
    sdk?.resetAemeath();
  }
}
