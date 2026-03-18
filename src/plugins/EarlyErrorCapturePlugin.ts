/**
 * 早期错误捕获插件
 *
 * 功能：在 React 挂载前捕获错误，与主 Logger 无缝集成
 * 使用：通过构建插件自动注入到 HTML
 */

import type { AemeathInterface, AemeathPlugin } from '../types';
import type { PlatformAdapter } from '../platform/types';
import { RouteMatcher, type RouteMatchConfig } from '../utils/routeMatcher';

interface EarlyErrorExtended extends Error {
  type?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  source?: string;
  earlyError?: boolean;
  captureTimestamp?: number;
  device?: unknown;
}

// 重新导出 RouteMatchConfig 以保持向后兼容
export type { RouteMatchConfig } from '../utils/routeMatcher';

export type { EarlyError } from '../platform/types';

export interface EarlyErrorCaptureOptions {
  enabled?: boolean;
  maxErrors?: number;
  fallbackEndpoint?: string;
  fallbackTimeout?: number;
  autoRefreshOnChunkError?: boolean;
  checkCompatibility?: boolean;

  /**
   * 路由匹配配置
   * 控制在哪些路由下启用早期错误监控
   */
  routeMatch?: RouteMatchConfig;
}

export class EarlyErrorCapturePlugin implements AemeathPlugin {
  public name = 'EarlyErrorCapture';
  public version = '2.0.0';
  public description = 'Capture errors before React mounts';

  private options: Omit<Required<EarlyErrorCaptureOptions>, 'routeMatch'>;
  private routeMatcher!: RouteMatcher;
  private readonly pluginRouteMatch: RouteMatchConfig | undefined;
  private logger: AemeathInterface | null = null;
  private platform!: PlatformAdapter;

  constructor(options: EarlyErrorCaptureOptions = {}) {
    this.options = {
      enabled: options.enabled !== false,
      maxErrors: options.maxErrors ?? 50,
      fallbackEndpoint: options.fallbackEndpoint ?? '',
      fallbackTimeout: options.fallbackTimeout ?? 30000,
      autoRefreshOnChunkError: options.autoRefreshOnChunkError !== false,
      checkCompatibility: options.checkCompatibility !== false,
    };

    this.pluginRouteMatch = options.routeMatch;
  }

  public install(logger: AemeathInterface): void {
    if (!this.options.enabled) {
      return;
    }

    this.logger = logger;
    this.platform = logger.platform;

    // Compose global matcher with plugin-level routeMatch
    this.routeMatcher = RouteMatcher.compose(
      logger.routeMatcher,
      this.pluginRouteMatch,
      { debugPrefix: '[EarlyErrorCapture]' },
    );

    this.flushEarlyErrors();
  }

  public uninstall(): void {
    this.logger = null;
  }

  private flushEarlyErrors(): void {
    // 🎯 检查路由匹配（使用共享的路由匹配器）
    if (!this.routeMatcher.shouldCapture(this.platform.getCurrentPath())) {
      this.platform.earlyCapture.flush(() => {});
      return;
    }

    if (!this.platform.earlyCapture.hasEarlyErrors()) {
      return;
    }

    this.platform.earlyCapture.flush((errors) => {
      if (!this.logger || errors.length === 0) {
        return;
      }

      errors.forEach((earlyError) => {
        const err = new Error(earlyError.message || 'Early error') as EarlyErrorExtended;
        err.type = earlyError.type;
        err.stack = earlyError.stack ?? undefined;
        err.filename = earlyError.filename;
        err.lineno = earlyError.lineno;
        err.colno = earlyError.colno;
        err.source = earlyError.source;
        err.earlyError = true;
        err.captureTimestamp = earlyError.timestamp;
        err.device = earlyError.device;

        this.logger!.error(`Early ${earlyError.type} error`, { error: err });
      });
    });
  }

  public getConfig(): EarlyErrorCaptureOptions {
    return { ...this.options };
  }
}

/**
 * 生成早期错误捕获脚本（供构建插件使用）
 */
export function generateEarlyErrorScript(
  options: Required<EarlyErrorCaptureOptions>,
): string {
  return `
(function() {
  'use strict';
  
  window.__EARLY_ERRORS__ = [];
  
  var MAX_ERRORS = ${options.maxErrors};
  var FALLBACK_ENDPOINT = ${JSON.stringify(options.fallbackEndpoint)};
  var FALLBACK_TIMEOUT = ${options.fallbackTimeout};
  var AUTO_REFRESH = ${options.autoRefreshOnChunkError};
  var CHECK_COMPAT = ${options.checkCompatibility};
  
  var deviceInfo = {
    ua: navigator.userAgent,
    lang: navigator.language,
    screen: screen.width + 'x' + screen.height,
    url: location.href,
    time: Date.now()
  };
  
  function addError(error) {
    if (window.__EARLY_ERRORS__.length >= MAX_ERRORS) {
      return;
    }
    
    window.__EARLY_ERRORS__.push({
      type: error.type,
      message: error.message,
      stack: error.stack,
      filename: error.filename,
      lineno: error.lineno,
      colno: error.colno,
      source: error.source,
      timestamp: Date.now(),
      device: deviceInfo
    });
  }
  
  window.addEventListener('error', function(event) {
    var target = event.target || event.srcElement;
    
    if (target !== window && (target.tagName === 'SCRIPT' || target.tagName === 'LINK' || target.tagName === 'IMG')) {
      addError({
        type: 'resource',
        message: 'Resource load failed',
        source: target.src || target.href,
        filename: target.src || target.href,
        stack: null
      });
      
      if (AUTO_REFRESH && target.tagName === 'SCRIPT' && (target.src || '').indexOf('chunk') !== -1) {
        var hasRefreshed = sessionStorage.getItem('__chunk_refreshed__');
        if (!hasRefreshed) {
          sessionStorage.setItem('__chunk_refreshed__', '1');
          setTimeout(function() { location.reload(); }, 100);
        }
      }
    } else {
      addError({
        type: 'error',
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error ? event.error.stack : null
      });
    }
  }, true);
  
  window.addEventListener('unhandledrejection', function(event) {
    var reason = event.reason;
    var message = 'Unhandled Promise Rejection';
    var stack = null;
    
    if (reason instanceof Error) {
      message = reason.message;
      stack = reason.stack;
    } else if (typeof reason === 'string') {
      message = reason;
    } else if (reason) {
      try { message = JSON.stringify(reason); } catch (e) { message = String(reason); }
    }
    
    addError({
      type: 'unhandledrejection',
      message: message,
      stack: stack
    });
  });
  
  if (CHECK_COMPAT) {
    (function() {
      var issues = [];
      
      if (!window.Promise) issues.push('Promise');
      if (!window.fetch) issues.push('fetch');
      if (!Array.prototype.includes) issues.push('Array.includes');
      if (!Object.assign) issues.push('Object.assign');
      if (!window.Map) issues.push('Map');
      if (!window.Set) issues.push('Set');
      
      if (issues.length > 0) {
        addError({
          type: 'compatibility',
          message: 'Browser compatibility issues: ' + issues.join(', '),
          stack: null
        });
      }
    })();
  }
  
  window.__flushEarlyErrors__ = function(callback) {
    if (typeof callback !== 'function') return;
    
    window.__LOGGER_INITIALIZED__ = true;
    
    var errors = window.__EARLY_ERRORS__.slice();
    window.__EARLY_ERRORS__ = [];
    
    try {
      callback(errors);
    } catch (e) {
      console.error('[EarlyErrorCapture] Error in flush callback:', e);
    }
  };
  
  if (FALLBACK_ENDPOINT) {
    setTimeout(function() {
      if (window.__LOGGER_INITIALIZED__) {
        return;
      }
      
      if (window.__EARLY_ERRORS__.length > 0) {
        console.warn('[EarlyErrorCapture] Logger not initialized after ' + FALLBACK_TIMEOUT + 'ms, using fallback endpoint');
        
        var errors = window.__EARLY_ERRORS__.slice();
        window.__EARLY_ERRORS__ = [];
        
        var payload = JSON.stringify({
          errors: errors,
          type: 'early-error-fallback',
          timestamp: Date.now()
        });
        
        if (navigator.sendBeacon) {
          try {
            var sent = navigator.sendBeacon(FALLBACK_ENDPOINT, payload);
            if (sent) {
              console.debug('[EarlyErrorCapture] Sent ' + errors.length + ' errors via sendBeacon');
            } else {
              fallbackXHR();
            }
          } catch (e) {
            fallbackXHR();
          }
        } else {
          fallbackXHR();
        }
        
        function fallbackXHR() {
          try {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', FALLBACK_ENDPOINT, true);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.send(payload);
            console.debug('[EarlyErrorCapture] Sent ' + errors.length + ' errors via XHR');
          } catch (e) {
            console.error('[EarlyErrorCapture] Failed to send via fallback:', e);
          }
        }
      }
    }, FALLBACK_TIMEOUT);
  }
  
  window.__EARLY_ERROR_CAPTURE_LOADED__ = true;
})();
`.trim();
}
