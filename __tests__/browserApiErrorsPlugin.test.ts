/**
 * BrowserApiErrorsPlugin tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BrowserApiErrorsPlugin } from '../src/plugins/BrowserApiErrorsPlugin';
import { AemeathLogger } from '../src/core/Logger';
import { wrap, _resetIgnoreOnError, shouldIgnoreOnError } from '../src/utils/wrap';

function createExternalError(message: string): Error {
  const error = new Error(message);
  error.stack = `Error: ${message}\n    at UserApp.render (app.js:10:5)\n    at Object.run (main.js:3:12)`;
  return error;
}

/**
 * jsdom re-throws errors from dispatchEvent as uncaught exceptions.
 * We suppress them here so vitest doesn't report false positives.
 */
const suppressedErrors: Error[] = [];
const uncaughtHandler = (err: Error) => {
  suppressedErrors.push(err);
};

describe('BrowserApiErrorsPlugin', () => {
  let logger: AemeathLogger;
  let activePlugin: BrowserApiErrorsPlugin | null = null;

  beforeEach(() => {
    _resetIgnoreOnError();
    suppressedErrors.length = 0;
    process.on('uncaughtException', uncaughtHandler);
    logger = new AemeathLogger({ enableConsole: false });
  });

  afterEach(() => {
    // forceRestore to ensure clean state between tests
    if (activePlugin) {
      activePlugin.forceRestore();
      activePlugin = null;
    }
    logger.destroy();
    process.off('uncaughtException', uncaughtHandler);
  });

  // ==================== Install / Uninstall ====================

  describe('install / uninstall lifecycle', () => {
    it('should install successfully', () => {
      const plugin = new BrowserApiErrorsPlugin();
      activePlugin = plugin;
      logger.use(plugin);
      expect(logger.hasPlugin('browser-api-errors')).toBe(true);
    });

    it('should uninstall successfully', () => {
      const plugin = new BrowserApiErrorsPlugin();
      activePlugin = plugin;
      logger.use(plugin);
      logger.uninstall('browser-api-errors');
      expect(logger.hasPlugin('browser-api-errors')).toBe(false);
    });
  });

  // ==================== addEventListener / removeEventListener ====================

  describe('addEventListener patching', () => {
    it('should patch addEventListener on EventTarget.prototype', () => {
      const originalAdd = EventTarget.prototype.addEventListener;
      const plugin = new BrowserApiErrorsPlugin();
      activePlugin = plugin;
      logger.use(plugin);
      expect(EventTarget.prototype.addEventListener).not.toBe(originalAdd);
      // Soft uninstall keeps the patch in place (pass-through)
      logger.uninstall('browser-api-errors');
      expect(EventTarget.prototype.addEventListener).not.toBe(originalAdd);
      // forceRestore actually restores
      plugin.forceRestore();
      expect(EventTarget.prototype.addEventListener).toBe(originalAdd);
      activePlugin = null;
    });

    it('should capture errors from event listener callbacks', () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      const plugin = new BrowserApiErrorsPlugin();
      activePlugin = plugin;
      logger.use(plugin);

      const div = document.createElement('div');
      const testError = createExternalError('listener error');

      div.addEventListener('click', () => {
        throw testError;
      });

      // jsdom catches errors from dispatchEvent internally and re-throws
      // them as uncaught exceptions, so the throw doesn't propagate
      // synchronously to the caller. We just verify the logger was called.
      try {
        div.dispatchEvent(new Event('click'));
      } catch {
        // may or may not throw depending on environment
      }

      // Allow the uncaught exception to settle
      expect(logListener).toHaveBeenCalled();
      const entry = logListener.mock.calls[0][0];
      expect(entry.level).toBe('error');
    });

    it('should pass through addEventListener options correctly', () => {
      const plugin = new BrowserApiErrorsPlugin();
      activePlugin = plugin;
      logger.use(plugin);

      const div = document.createElement('div');
      const handler = vi.fn();

      div.addEventListener('click', handler, { once: true });
      div.dispatchEvent(new Event('click'));
      div.dispatchEvent(new Event('click'));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should handle null listener gracefully', () => {
      const plugin = new BrowserApiErrorsPlugin();
      activePlugin = plugin;
      logger.use(plugin);

      const div = document.createElement('div');
      expect(() => {
        div.addEventListener('click', null);
      }).not.toThrow();
    });

    it('should handle EventListenerObject with handleEvent', () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      const plugin = new BrowserApiErrorsPlugin();
      activePlugin = plugin;
      logger.use(plugin);

      const div = document.createElement('div');
      const listenerObj = {
        handleEvent() {
          throw createExternalError('handleEvent error');
        },
      };

      div.addEventListener('click', listenerObj);

      try {
        div.dispatchEvent(new Event('click'));
      } catch {
        // jsdom may or may not propagate
      }

      expect(logListener).toHaveBeenCalled();
    });

    it('removeEventListener should work with wrapped listeners', () => {
      const plugin = new BrowserApiErrorsPlugin();
      activePlugin = plugin;
      logger.use(plugin);

      const div = document.createElement('div');
      const handler = vi.fn();

      div.addEventListener('click', handler);
      div.removeEventListener('click', handler);
      div.dispatchEvent(new Event('click'));

      expect(handler).not.toHaveBeenCalled();
    });

    it('normal listeners (no error) should work correctly', () => {
      const plugin = new BrowserApiErrorsPlugin();
      activePlugin = plugin;
      logger.use(plugin);

      const div = document.createElement('div');
      const results: string[] = [];

      div.addEventListener('click', () => results.push('a'));
      div.addEventListener('click', () => results.push('b'));
      div.dispatchEvent(new Event('click'));

      expect(results).toEqual(['a', 'b']);
    });
  });

  // ==================== setTimeout / setInterval ====================

  describe('timer patching', () => {
    it('should patch setTimeout', () => {
      const originalSetTimeout = globalThis.setTimeout;
      const plugin = new BrowserApiErrorsPlugin();
      activePlugin = plugin;
      logger.use(plugin);
      expect(globalThis.setTimeout).not.toBe(originalSetTimeout);
      // Soft uninstall keeps patch in place
      logger.uninstall('browser-api-errors');
      expect(globalThis.setTimeout).not.toBe(originalSetTimeout);
      // forceRestore restores
      plugin.forceRestore();
      expect(globalThis.setTimeout).toBe(originalSetTimeout);
      activePlugin = null;
    });

    it('should wrap setTimeout callbacks with try-catch', () => {
      const origSetTimeout = globalThis.setTimeout;

      // Set up an interceptor as the "original" so we can inspect what gets passed
      let capturedCallback: Function | null = null;
      const interceptor = (cb: Function, ...rest: unknown[]) => {
        capturedCallback = cb;
        return 0 as unknown as ReturnType<typeof setTimeout>;
      };
      (globalThis as unknown as Record<string, unknown>).setTimeout = interceptor;

      const plugin = new BrowserApiErrorsPlugin();
      activePlugin = plugin;
      logger.use(plugin);

      const myFn = () => {};
      globalThis.setTimeout(myFn, 100);

      expect(capturedCallback).not.toBeNull();
      expect(capturedCallback).not.toBe(myFn);
      expect(typeof capturedCallback).toBe('function');

      // Restore
      plugin.forceRestore();
      (globalThis as unknown as Record<string, unknown>).setTimeout = origSetTimeout;
      activePlugin = null;
    });

    it('should patch setInterval', () => {
      const originalSetInterval = globalThis.setInterval;
      const plugin = new BrowserApiErrorsPlugin();
      activePlugin = plugin;
      logger.use(plugin);
      expect(globalThis.setInterval).not.toBe(originalSetInterval);
      plugin.forceRestore();
      expect(globalThis.setInterval).toBe(originalSetInterval);
      activePlugin = null;
    });

    it('setTimeout should work normally when no error', () => {
      vi.useRealTimers();
      const plugin = new BrowserApiErrorsPlugin();
      activePlugin = plugin;
      logger.use(plugin);

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, 0);
      });
    });

    it('should not wrap non-function handlers in setTimeout', () => {
      const plugin = new BrowserApiErrorsPlugin();
      activePlugin = plugin;
      logger.use(plugin);

      // Verify that passing a non-function doesn't cause the plugin to crash
      // Node.js throws for string handlers, so we just verify the plugin
      // code path doesn't add its own error
      let threwFromPlugin = false;
      try {
        // @ts-expect-error testing string handler
        setTimeout('void 0', 0);
      } catch (e: any) {
        // Node.js throws ERR_INVALID_ARG_TYPE — that's expected,
        // but it should NOT be a plugin-related error
        if (e?.message?.includes('BrowserApiErrors')) {
          threwFromPlugin = true;
        }
      }
      expect(threwFromPlugin).toBe(false);
    });
  });

  // ==================== requestAnimationFrame ====================

  describe('requestAnimationFrame patching', () => {
    it('should patch requestAnimationFrame', () => {
      const originalRAF = globalThis.requestAnimationFrame;
      const plugin = new BrowserApiErrorsPlugin();
      activePlugin = plugin;
      logger.use(plugin);
      expect(globalThis.requestAnimationFrame).not.toBe(originalRAF);
      plugin.forceRestore();
      expect(globalThis.requestAnimationFrame).toBe(originalRAF);
      activePlugin = null;
    });

    it('requestAnimationFrame should work normally when no error', () => {
      vi.useRealTimers();
      const plugin = new BrowserApiErrorsPlugin();
      activePlugin = plugin;
      logger.use(plugin);

      return new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });
  });

  // ==================== XMLHttpRequest ====================

  describe('XMLHttpRequest patching', () => {
    it('should patch XMLHttpRequest.prototype.send', () => {
      const originalSend = XMLHttpRequest.prototype.send;
      const plugin = new BrowserApiErrorsPlugin();
      activePlugin = plugin;
      logger.use(plugin);
      expect(XMLHttpRequest.prototype.send).not.toBe(originalSend);
      plugin.forceRestore();
      expect(XMLHttpRequest.prototype.send).toBe(originalSend);
      activePlugin = null;
    });

    it('should wrap XHR callback properties on send', () => {
      const plugin = new BrowserApiErrorsPlugin();
      activePlugin = plugin;
      logger.use(plugin);

      const xhr = new XMLHttpRequest();
      const originalOnload = vi.fn();
      xhr.onload = originalOnload;

      // After send, the onload should be wrapped
      try {
        xhr.open('GET', 'http://localhost/test');
        xhr.send();
      } catch {
        // jsdom may throw for actual network requests
      }

      // The onload property should now be a wrapped version
      expect(xhr.onload).not.toBe(originalOnload);
    });
  });

  // ==================== Configuration options ====================

  describe('configuration options', () => {
    it('eventTarget=false should not patch addEventListener', () => {
      const originalAdd = EventTarget.prototype.addEventListener;
      const plugin = new BrowserApiErrorsPlugin({ eventTarget: false });
      activePlugin = plugin;
      logger.use(plugin);
      expect(EventTarget.prototype.addEventListener).toBe(originalAdd);
    });

    it('timer=false should not patch setTimeout/setInterval', () => {
      const originalSetTimeout = globalThis.setTimeout;
      const originalSetInterval = globalThis.setInterval;
      const plugin = new BrowserApiErrorsPlugin({ timer: false });
      activePlugin = plugin;
      logger.use(plugin);
      expect(globalThis.setTimeout).toBe(originalSetTimeout);
      expect(globalThis.setInterval).toBe(originalSetInterval);
    });

    it('requestAnimationFrame=false should not patch rAF', () => {
      const originalRAF = globalThis.requestAnimationFrame;
      const plugin = new BrowserApiErrorsPlugin({ requestAnimationFrame: false });
      activePlugin = plugin;
      logger.use(plugin);
      expect(globalThis.requestAnimationFrame).toBe(originalRAF);
    });

    it('xhr=false should not patch XMLHttpRequest.send', () => {
      const originalSend = XMLHttpRequest.prototype.send;
      const plugin = new BrowserApiErrorsPlugin({ xhr: false });
      activePlugin = plugin;
      logger.use(plugin);
      expect(XMLHttpRequest.prototype.send).toBe(originalSend);
    });
  });

  // ==================== Uninstall restores all ====================

  describe('soft uninstall and forceRestore', () => {
    it('soft uninstall should keep patches but stop wrapping (pass-through)', () => {
      const logListener = vi.fn();
      logger.on('log', logListener);

      const origAdd = EventTarget.prototype.addEventListener;
      const plugin = new BrowserApiErrorsPlugin();
      activePlugin = plugin;
      logger.use(plugin);

      expect(EventTarget.prototype.addEventListener).not.toBe(origAdd);

      // Soft uninstall — patches stay in place
      logger.uninstall('browser-api-errors');
      expect(EventTarget.prototype.addEventListener).not.toBe(origAdd);

      // But new listeners should NOT be wrapped (pass-through)
      const div = document.createElement('div');
      div.addEventListener('click', () => {
        throw createExternalError('should not be captured');
      });
      try { div.dispatchEvent(new Event('click')); } catch { /* expected */ }

      // The error should NOT have been captured (plugin is disabled)
      expect(logListener).not.toHaveBeenCalled();
    });

    it('forceRestore should restore all patched APIs', () => {
      const origAdd = EventTarget.prototype.addEventListener;
      const origRemove = EventTarget.prototype.removeEventListener;
      const origSetTimeout = globalThis.setTimeout;
      const origSetInterval = globalThis.setInterval;
      const origRAF = globalThis.requestAnimationFrame;
      const origSend = XMLHttpRequest.prototype.send;

      const plugin = new BrowserApiErrorsPlugin();
      activePlugin = plugin;
      logger.use(plugin);

      expect(EventTarget.prototype.addEventListener).not.toBe(origAdd);
      expect(globalThis.setTimeout).not.toBe(origSetTimeout);
      expect(XMLHttpRequest.prototype.send).not.toBe(origSend);

      plugin.forceRestore();

      expect(EventTarget.prototype.addEventListener).toBe(origAdd);
      expect(EventTarget.prototype.removeEventListener).toBe(origRemove);
      expect(globalThis.setTimeout).toBe(origSetTimeout);
      expect(globalThis.setInterval).toBe(origSetInterval);
      expect(globalThis.requestAnimationFrame).toBe(origRAF);
      expect(XMLHttpRequest.prototype.send).toBe(origSend);
      activePlugin = null;
    });
  });

  // ==================== Coordination with ErrorCapturePlugin ====================

  describe('coordination with ErrorCapturePlugin (dedup)', () => {
    it('should set shouldIgnoreOnError flag when wrapped callback throws', () => {
      vi.useRealTimers();
      const plugin = new BrowserApiErrorsPlugin();
      activePlugin = plugin;
      logger.use(plugin);

      const div = document.createElement('div');
      div.addEventListener('click', () => {
        throw createExternalError('dedup test');
      });

      try {
        div.dispatchEvent(new Event('click'));
      } catch {
        // expected
      }

      expect(shouldIgnoreOnError()).toBe(true);
    });
  });

  // ==================== Idempotency ====================

  describe('idempotency', () => {
    it('should not double-install (plugin name uniqueness)', () => {
      const plugin1 = new BrowserApiErrorsPlugin();
      activePlugin = plugin1;
      const plugin2 = new BrowserApiErrorsPlugin();
      logger.use(plugin1);
      logger.use(plugin2);
      expect(logger.getPlugins().filter(p => p.name === 'browser-api-errors')).toHaveLength(1);
    });
  });

  // ==================== Error propagation ====================

  describe('error propagation', () => {
    it('errors should still propagate (re-throw) after being captured', () => {
      const plugin = new BrowserApiErrorsPlugin();
      activePlugin = plugin;
      logger.use(plugin);

      // Test with a direct function call (not via dispatchEvent which
      // has jsdom-specific error swallowing behavior)
      const fn = () => {
        throw createExternalError('propagation test');
      };
      const wrapped = wrap(fn, () => {});

      expect(() => wrapped()).toThrow('propagation test');
    });
  });
});
