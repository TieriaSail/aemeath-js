/**
 * 早期错误捕获插件
 *
 * 功能：在 React 挂载前捕获错误，与主 Logger 无缝集成
 * 使用：通过构建插件自动注入到 HTML
 */

import type { AemeathInterface, AemeathPlugin } from '../types';
import { RouteMatcher, type RouteMatchConfig } from '../utils/routeMatcher';

// 重新导出 RouteMatchConfig 以保持向后兼容
export type { RouteMatchConfig } from '../utils/routeMatcher';

export interface EarlyError {
  type: 'error' | 'resource' | 'unhandledrejection' | 'compatibility';
  message: string;
  stack: string | null;
  filename?: string;
  lineno?: number;
  colno?: number;
  source?: string;
  timestamp: number;
  device: {
    ua: string;
    lang: string;
    screen: string;
    url: string;
    time: number;
  };
}

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
  public version = '1.1.0';
  public description = 'Capture errors before React mounts';

  private options: Omit<Required<EarlyErrorCaptureOptions>, 'routeMatch'>;
  private readonly routeMatcher: RouteMatcher;
  private logger: AemeathInterface | null = null;

  constructor(options: EarlyErrorCaptureOptions = {}) {
    this.options = {
      enabled: options.enabled !== false,
      maxErrors: options.maxErrors ?? 50,
      fallbackEndpoint: options.fallbackEndpoint ?? '',
      fallbackTimeout: options.fallbackTimeout ?? 30000,
      autoRefreshOnChunkError: options.autoRefreshOnChunkError !== false,
      checkCompatibility: options.checkCompatibility !== false,
    };

    // 使用共享的路由匹配器
    this.routeMatcher = new RouteMatcher({
      config: options.routeMatch,
      debugPrefix: '[EarlyErrorCapture]',
    });
  }

  public install(logger: AemeathInterface): void {
    if (!this.options.enabled) {
      return;
    }

    this.logger = logger;
    this.flushEarlyErrors();
  }

  public uninstall(): void {
    this.logger = null;
  }

  private flushEarlyErrors(): void {
    if (typeof window === 'undefined') {
      return;
    }

    // 🎯 检查路由匹配（使用共享的路由匹配器）
    if (!this.routeMatcher.shouldCapture()) {
      console.debug(
        '[EarlyErrorCapture] 当前路由不在监控范围内，跳过早期错误上报:',
        window.location.pathname,
      );
      // 清空早期错误，避免后续路由切换时重复上报
      const flushFn = (window as any).__flushEarlyErrors__;
      if (typeof flushFn === 'function') {
        flushFn(() => {}); // 清空但不上报
      }
      return;
    }

    const flushFn = (
      window as Window & {
        __flushEarlyErrors__?: (
          callback: (errors: EarlyError[]) => void,
        ) => void;
      }
    ).__flushEarlyErrors__;

    if (typeof flushFn !== 'function') {
      console.warn(
        '[EarlyErrorCapture] Early error capture script not found. Make sure to use the build plugin.',
      );
      return;
    }

    flushFn((errors: EarlyError[]) => {
      if (!this.logger || errors.length === 0) {
        return;
      }

      console.log(`[Logger] Flushed ${errors.length} early errors`);

      errors.forEach((earlyError) => {
        const err = new Error(earlyError.message || 'Early error');
        (err as any).type = earlyError.type;
        (err as any).stack = earlyError.stack;
        (err as any).filename = earlyError.filename;
        (err as any).lineno = earlyError.lineno;
        (err as any).colno = earlyError.colno;
        (err as any).source = earlyError.source;
        (err as any).earlyError = true; // 用于自动识别为早期错误
        (err as any).captureTimestamp = earlyError.timestamp;
        (err as any).device = earlyError.device;

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
  var FALLBACK_ENDPOINT = '${options.fallbackEndpoint}';
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
      message = JSON.stringify(reason);
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
              console.log('[EarlyErrorCapture] Sent ' + errors.length + ' errors via sendBeacon');
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
            console.log('[EarlyErrorCapture] Sent ' + errors.length + ' errors via XHR');
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
