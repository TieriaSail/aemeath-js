/**
 * 早期错误捕获脚本 - 共享模块
 *
 * 所有构建插件（Vite、Webpack、Rsbuild）共用同一份脚本
 * 避免代码重复和不一致问题
 *
 * @internal
 */

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
 */
export function getEarlyErrorCaptureScript(): string {
  return `(function() {
  window.__EARLY_ERRORS__ = [];
  window.__LOGGER_INITIALIZED__ = false;

  // 捕获全局 JS 错误（包括 SyntaxError）
  window.addEventListener('error', function(event) {
    if (window.__LOGGER_INITIALIZED__) return;
    // 跳过资源加载错误（由下方单独处理）
    if (event.target && event.target !== window && event.target.tagName) return;

    var errorInfo = {
      type: 'error',
      message: event.message || 'Unknown error',
      filename: event.filename || '',
      lineno: event.lineno || 0,
      colno: event.colno || 0,
      error: null,
      timestamp: Date.now()
    };

    if (event.error) {
      errorInfo.error = {
        name: event.error.name || 'Error',
        message: event.error.message || '',
        stack: event.error.stack || ''
      };
    }

    window.__EARLY_ERRORS__.push(errorInfo);
  }, true);

  // 捕获 Promise 错误
  window.addEventListener('unhandledrejection', function(event) {
    if (window.__LOGGER_INITIALIZED__) return;

    var reason = event.reason;
    window.__EARLY_ERRORS__.push({
      type: 'unhandledrejection',
      message: reason ? (reason.message || String(reason)) : 'Unknown rejection',
      stack: reason && reason.stack ? reason.stack : '',
      timestamp: Date.now()
    });
  });

  // 捕获资源加载失败（script/link/img 等）
  window.addEventListener('error', function(event) {
    if (window.__LOGGER_INITIALIZED__) return;
    if (!event.target || event.target === window) return;
    if (!event.target.tagName) return;

    var target = event.target;
    window.__EARLY_ERRORS__.push({
      type: 'resource',
      tagName: target.tagName,
      src: target.src || target.href || '',
      timestamp: Date.now()
    });
  }, true);

  // 刷新早期错误（Logger 初始化后调用）
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
})();`;
}

