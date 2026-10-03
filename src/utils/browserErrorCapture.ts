import { runCapture } from './captureGuard';

interface GlobalErrorInfo {
  message: string | Event;
  source?: string;
  lineno?: number;
  colno?: number;
  error?: Error | null;
}
interface UnhandledRejectionInfo { reason: unknown; promise: Promise<unknown>; }
const errorHandlers = new WeakMap<Function, { previous: OnErrorEventHandler; active: boolean }>();
/** Internal browser lifecycle hooks; keeps the v1 public Logger API unchanged. */
export const browserErrorCapture = {
      onGlobalError(
        handler: (info: GlobalErrorInfo) => void,
      ): () => void {
        const prev = window.onerror;
        const state = { previous: prev, active: true };
        const wrappedHandler: OnErrorEventHandler = (message, source, lineno, colno, error) => {
          if (state.active) runCapture('global', () => handler({ message, source, lineno, colno, error }));
          if (typeof prev === 'function') {
            return (prev as Function).call(window, message, source, lineno, colno, error);
          }
        };
        errorHandlers.set(wrappedHandler, state);
        window.onerror = wrappedHandler;
        return () => {
          state.active = false;
          let current = window.onerror;
          while (typeof current === 'function') {
            const node = errorHandlers.get(current);
            if (!node || node.active) break;
            current = node.previous;
          }
          if (current !== window.onerror) window.onerror = current;
        };
      },

      onUnhandledRejection(
        handler: (info: UnhandledRejectionInfo) => void,
      ): () => void {
        const listener = (event: PromiseRejectionEvent) => {
          runCapture('unhandledrejection', () => handler({ reason: event.reason, promise: event.promise }));
        };
        window.addEventListener('unhandledrejection', listener);
        return () => window.removeEventListener('unhandledrejection', listener);
      },

      onResourceError(handler: (event: Event) => void): () => void {
        const listener = (event: Event) => runCapture('resource', () => handler(event));
        window.addEventListener('error', listener, true);
        return () => window.removeEventListener('error', listener, true);
      },

};
