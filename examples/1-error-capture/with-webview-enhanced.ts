/**
 * 模块1：错误捕获 - WebView 增强捕获示例
 *
 * 在 iOS WKWebView / Android WebView 等跨域受限环境中，
 * window.onerror 可能只能获取到 "Script error."。
 * BrowserApiErrorsPlugin 在已包裹的回调入口捕获原始异常；无法恢复浏览器未暴露的信息。
 * Supported hooks capture original exceptions before global redaction; coverage is not universal.
 */

import { initAemeath, getAemeath, classifyHttpUploadResponse } from 'aemeath-js';

// ==================== 基础用法（默认启用） ====================

initAemeath({
  upload: async (log) => {
    const res = await fetch('/api/logs', {
      method: 'POST',
      body: JSON.stringify(log),
    });
    return classifyHttpUploadResponse(res.status, res.headers.get('Retry-After'));
  },
  // browserApiErrors 默认为 true，无需显式设置
});

const logger = getAemeath();

// ==================== 已启用 hook 覆盖的回调场景 / Supported callback hooks ====================

// 场景 1：事件监听器中的错误
document.getElementById('btn')?.addEventListener('click', () => {
  // 在 WebView 中，这个错误以前只能看到 "Script error."
  // 已安装的 hook 可保留该 Error 提供的原始信息和堆栈
  throw new Error('Button click handler error');
});

// 场景 2：定时器中的错误
setTimeout(() => {
  JSON.parse('invalid json'); // SyntaxError 的原始信息会被 hook 捕获
}, 1000);

// 场景 3：XHR 回调中的错误
const xhr = new XMLHttpRequest();
xhr.onload = () => {
  const data = JSON.parse(xhr.responseText);
  if (!data.valid) {
    throw new Error('Invalid response data');
  }
};
xhr.open('GET', '/api/data');
xhr.send();

// ==================== 自定义配置 ====================

// 如果只需要部分 API 的增强捕获：
/*
initAemeath({
  upload: async (log) => { return { success: true }; },
  browserApiErrors: {
    eventTarget: true,           // patch addEventListener
    timer: true,                 // patch setTimeout/setInterval
    requestAnimationFrame: false, // 不 patch rAF（性能敏感场景）
    xhr: true,                   // patch XMLHttpRequest.send
  },
});
*/

// 如果确定不需要增强捕获（纯同域环境）：
/*
initAemeath({
  upload: async (log) => { return { success: true }; },
  browserApiErrors: false,
});
*/

export default logger;
