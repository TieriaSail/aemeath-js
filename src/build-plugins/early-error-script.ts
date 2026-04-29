/**
 * 早期错误捕获脚本 - 共享模块
 *
 * 所有构建插件（Vite、Webpack、Rsbuild）共用同一份脚本。
 * 支持两种模式：
 * - 无参数：生成基础捕获脚本（仅捕获、缓冲、flush）
 * - 传入 options：生成带 fallback 上报、设备信息、兼容检查等完整功能的脚本
 *
 * @internal
 */

/**
 * Fallback 相关的脚本配置。
 *
 * 当 Logger 在指定时间内未初始化时，脚本可独立将捕获到的早期错误
 * 发送到指定的 fallback 端点。
 */
export interface EarlyErrorScriptOptions {
  /** 最大缓冲错误数（防止内存溢出），默认 50 */
  maxErrors?: number;

  /** Fallback 上报的目标 URL，不传则不启用 fallback */
  fallbackEndpoint?: string;

  /** Logger 未初始化时的超时等待（ms），默认 30000 */
  fallbackTimeout?: number;

  /** chunk 加载失败时是否自动刷新，默认 true */
  autoRefreshOnChunkError?: boolean;

  /** 是否检查浏览器兼容性（Promise/fetch/Map 等），默认 true */
  checkCompatibility?: boolean;

  /**
   * 发送方式偏好
   *
   * - 'auto'：sendBeacon 优先，失败降级到 XHR（默认）
   * - 'xhr'：只用 XHR（需要自定义 header 或确保 Content-Type 时使用）
   * - 'beacon'：只用 sendBeacon（页面卸载场景更可靠，但不支持自定义 header）
   */
  fallbackTransport?: 'auto' | 'xhr' | 'beacon';

  /**
   * 自定义请求头（仅 XHR 模式生效，sendBeacon 不支持自定义 header）
   *
   * Content-Type 默认为 application/json，可覆盖。
   *
   * WARNING: 值会被 JSON.stringify 序列化到内联脚本，必须是字面量。
   */
  fallbackHeaders?: Record<string, string>;

  /**
   * 自定义 payload 格式化函数
   *
   * 接收早期错误数组和设备元信息，返回要发送的数据：
   * - 返回单个对象 → 一次请求发送（适合批量接口）
   * - 返回数组 → 每个元素分别发一次请求（适合单条接口）
   * - 不提供 → 使用默认格式
   *
   * WARNING: 此函数会被 .toString() 序列化注入到 HTML 内联脚本，
   * 不能引用外部变量、闭包或 ES Module。函数体必须是纯 ES5 语法。
   */
  formatPayload?: (errors: unknown[], meta: unknown) => unknown;
}

/**
 * 获取早期错误捕获脚本内容
 *
 * 该脚本用于在应用框架（React/Vue）挂载前捕获错误：
 * - 全局 JS 错误（包括 SyntaxError）
 * - Promise rejection
 * - 资源加载失败（script/link/img）
 *
 * 特性：
 * - 纯 ES5 语法，兼容所有浏览器
 * - Logger 初始化后自动停止捕获
 * - 通过 __flushEarlyErrors__ 回调移交错误
 * - 可选的 fallback 上报能力（传入 options 启用）
 *
 * @param options - 可选的脚本配置，不传则生成基础版脚本
 */
export function getEarlyErrorCaptureScript(options?: EarlyErrorScriptOptions): string {
  const maxErrors = options?.maxErrors ?? 50;
  const fallbackEndpoint = options?.fallbackEndpoint ?? '';
  const fallbackTimeout = options?.fallbackTimeout ?? 30000;
  const autoRefresh = options?.autoRefreshOnChunkError !== false;
  const checkCompat = options?.checkCompatibility !== false;
  const transport = options?.fallbackTransport ?? 'auto';
  const headers = options?.fallbackHeaders;
  const formatPayload = options?.formatPayload;

  // When headers are provided but transport is 'auto', prefer xhr
  const effectiveTransport = (headers && transport === 'auto') ? 'xhr' : transport;

  return `(function() {
  'use strict';
  try {

  window.__EARLY_ERRORS__ = [];
  window.__LOGGER_INITIALIZED__ = false;
  var __FALLBACK_TIMER__ = null;

  var MAX_ERRORS = ${maxErrors};

  var deviceInfo = {
    ua: navigator.userAgent,
    lang: navigator.language,
    screen: screen.width + 'x' + screen.height,
    url: location.href,
    time: Date.now()
  };

  function addError(error) {
    if (window.__LOGGER_INITIALIZED__) return;
    if (window.__EARLY_ERRORS__.length >= MAX_ERRORS) return;

    window.__EARLY_ERRORS__.push({
      type: error.type,
      message: error.message,
      stack: error.stack || null,
      filename: error.filename,
      lineno: error.lineno,
      colno: error.colno,
      source: error.source,
      timestamp: Date.now(),
      device: deviceInfo
    });
  }

  window.addEventListener('error', function(event) {
    if (window.__LOGGER_INITIALIZED__) return;
    var target = event.target || event.srcElement;

    if (target !== window && target.tagName && (target.tagName === 'SCRIPT' || target.tagName === 'LINK' || target.tagName === 'IMG')) {
      addError({
        type: 'resource',
        message: 'Resource load failed',
        source: target.src || target.href,
        filename: target.src || target.href,
        stack: null
      });
${autoRefresh ? `
      if (target.tagName === 'SCRIPT' && (target.src || '').indexOf('chunk') !== -1) {
        try {
          var hasRefreshed = sessionStorage.getItem('__chunk_refreshed__');
          if (!hasRefreshed) {
            sessionStorage.setItem('__chunk_refreshed__', '1');
            setTimeout(function() { location.reload(); }, 100);
          }
        } catch (e) {}
      }` : ''}
    } else {
      addError({
        type: 'error',
        message: event.message || 'Unknown error',
        filename: event.filename || '',
        lineno: event.lineno || 0,
        colno: event.colno || 0,
        stack: event.error ? event.error.stack : null
      });
    }
  }, true);

  window.addEventListener('unhandledrejection', function(event) {
    if (window.__LOGGER_INITIALIZED__) return;
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
${checkCompat ? `
  (function() {
    try {
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
    } catch (e) {}
  })();` : ''}

  window.__flushEarlyErrors__ = function(callback) {
    if (typeof callback !== 'function') return;
    window.__LOGGER_INITIALIZED__ = true;
    if (__FALLBACK_TIMER__ !== null) {
      clearTimeout(__FALLBACK_TIMER__);
      __FALLBACK_TIMER__ = null;
    }
    var errors = window.__EARLY_ERRORS__.slice();
    window.__EARLY_ERRORS__ = [];
    try {
      callback(errors);
    } catch (e) {
      console.error('[EarlyErrorCapture] Error in flush callback:', e);
    }
  };
${fallbackEndpoint ? generateFallbackBlock(fallbackEndpoint, fallbackTimeout, effectiveTransport, headers, formatPayload) : ''}
  window.__EARLY_ERROR_CAPTURE_LOADED__ = true;

  } catch (__earlyErr__) {
    try { console.error('[EarlyErrorCapture] Script init error:', __earlyErr__); } catch (e) {}
  }
})();`.trim();
}

function generateFallbackBlock(
  endpoint: string,
  timeout: number,
  transport: 'auto' | 'xhr' | 'beacon',
  headers?: Record<string, string>,
  formatPayload?: (errors: unknown[], meta: unknown) => unknown,
): string {
  const headersJson = headers ? JSON.stringify(headers) : 'null';

  return `

  var FALLBACK_ENDPOINT = ${JSON.stringify(endpoint)};
  var FALLBACK_TIMEOUT = ${timeout};
  var FALLBACK_TRANSPORT = ${JSON.stringify(transport)};
  var FALLBACK_HEADERS = ${headersJson};
  var formatPayload = ${formatPayload ? formatPayload.toString() : 'null'};

  // sendPayload 接收 errorsBatch 仅用于失败时的告警计数；不再尝试"重新入栈重传"。
  // 旧实现把 errors 写回 __EARLY_ERRORS__ 但 __LOGGER_INITIALIZED__ 已为 true，
  // 没人会再消费 → 等于静默丢失。同时旧实现里 xhr.onerror 引用了 sendPayload 作用域
  // 之外的 errors 变量，触发时直接 ReferenceError，让 fallback 通道彻底崩盘。
  function sendPayload(data, errorsBatch) {
    var payloadStr = JSON.stringify(data);
    var lostCount = (errorsBatch && errorsBatch.length) || 0;

    if (FALLBACK_TRANSPORT === 'beacon' || (FALLBACK_TRANSPORT === 'auto' && typeof navigator.sendBeacon === 'function')) {
      try {
        var blob = new Blob([payloadStr], { type: 'application/json' });
        var sent = navigator.sendBeacon(FALLBACK_ENDPOINT, blob);
        if (sent) return true;
      } catch (e) {}
      if (FALLBACK_TRANSPORT === 'beacon') {
        try { console.warn('[EarlyErrorCapture] Fallback beacon failed; ' + lostCount + ' early errors are lost.'); } catch (e) {}
        return false;
      }
    }

    if (FALLBACK_TRANSPORT === 'xhr' || FALLBACK_TRANSPORT === 'auto') {
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', FALLBACK_ENDPOINT, true);
        var finalHeaders = { 'Content-Type': 'application/json' };
        if (FALLBACK_HEADERS) {
          for (var key in FALLBACK_HEADERS) {
            if (FALLBACK_HEADERS.hasOwnProperty(key)) {
              finalHeaders[key] = FALLBACK_HEADERS[key];
            }
          }
        }
        for (var h in finalHeaders) {
          if (finalHeaders.hasOwnProperty(h)) {
            xhr.setRequestHeader(h, finalHeaders[h]);
          }
        }
        xhr.onerror = function() {
          // 不再把 errors 重新写回 __EARLY_ERRORS__：__LOGGER_INITIALIZED__ 已为 true，
          // 早期脚本的 listener 全部 early-return，写回去也没人取，只是制造"重传幻觉"。
          // fallback 通道明确为 best-effort 一次性 send。
          try { console.warn('[EarlyErrorCapture] Fallback XHR failed; ' + lostCount + ' early errors are lost.'); } catch (e) {}
        };
        xhr.send(payloadStr);
        return true;
      } catch (e) {}
    }

    try { console.warn('[EarlyErrorCapture] Fallback transport unavailable; ' + lostCount + ' early errors are lost.'); } catch (e) {}
    return false;
  }

  function doFallback() {
    if (window.__LOGGER_INITIALIZED__) return;
    if (window.__EARLY_ERRORS__.length === 0) return;

    window.__LOGGER_INITIALIZED__ = true;
    console.warn('[EarlyErrorCapture] Logger not initialized after ' + FALLBACK_TIMEOUT + 'ms, using fallback endpoint');

    var errors = window.__EARLY_ERRORS__.slice();
    window.__EARLY_ERRORS__ = [];

    try {
      var result;
      if (typeof formatPayload === 'function') {
        try {
          result = formatPayload(errors, deviceInfo);
        } catch (e) {
          console.error('[EarlyErrorCapture] formatPayload error, using default format:', e);
          result = null;
        }
      }

      if (result == null) {
        result = { errors: errors, device: deviceInfo, type: 'early-error-fallback', timestamp: Date.now() };
      }

      if (Array.isArray(result)) {
        // formatPayload 返回数组时 1:1 映射 errors[i]，落单的告警计数置 1
        for (var i = 0; i < result.length; i++) {
          sendPayload(result[i], errors[i] ? [errors[i]] : []);
        }
      } else {
        sendPayload(result, errors);
      }
    } catch (e) {
      // 同 sendPayload xhr.onerror 的修复：不再 reassign __EARLY_ERRORS__
      try { console.error('[EarlyErrorCapture] Fallback send error:', e); } catch (ee) {}
    }
  }

  __FALLBACK_TIMER__ = setTimeout(doFallback, FALLBACK_TIMEOUT);`;
}
