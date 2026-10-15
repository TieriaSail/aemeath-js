import { initCrashWorker } from 'aemeath-js/crash-worker';
Object.defineProperty(globalThis, 'indexedDB', { value: undefined });
initCrashWorker();
