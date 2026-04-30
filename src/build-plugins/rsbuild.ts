/**
 * Rsbuild 早期错误捕获插件
 *
 * 在 HTML head 中注入脚本，捕获 React/Vue 挂载前的错误
 */

import type { RsbuildPlugin } from '@rsbuild/core';
import { getEarlyErrorCaptureScript, type EarlyErrorScriptOptions } from './early-error-script';

// R14.5: re-export EarlyErrorScriptOptions 让用户可从子路径直接 import，
// 避免依赖内部路径 './early-error-script'。
export type { EarlyErrorScriptOptions } from './early-error-script';

export interface EarlyErrorCapturePluginOptions extends EarlyErrorScriptOptions {
  /**
   * 是否启用
   * @default true
   */
  enabled?: boolean;

  /**
   * CSP `nonce` 属性（Content-Security-Policy）
   *
   * 当应用启用了严格的 CSP（如 `script-src 'self' 'nonce-xxx'`）时，
   * 内联脚本必须携带匹配的 `nonce` 属性才会被浏览器执行，否则会被 CSP 静默
   * 拦截、整个早期错误捕获机制失能。
   *
   * 提供此选项后，注入的 `<script>` 标签会带上 `nonce="<value>"` 属性。
   *
   * @example
   * ```js
   * ameathEarlyErrorPlugin({ nonce: process.env.CSP_NONCE })
   * ```
   */
  nonce?: string;
}

/**
 * Aemeath 早期错误捕获插件（Rsbuild）
 *
 * @example
 * ```javascript
 * import { ameathEarlyErrorPlugin } from 'aemeath-js/build-plugins/rsbuild';
 *
 * export default {
 *   plugins: [
 *     ameathEarlyErrorPlugin({ enabled: true })
 *   ]
 * };
 * ```
 *
 * @example
 * ```javascript
 * // 启用 fallback 上报
 * ameathEarlyErrorPlugin({
 *   fallbackEndpoint: 'https://example.com/api/logs',
 *   fallbackTimeout: 10000,
 *   fallbackTransport: 'xhr',
 * })
 * ```
 */
export function ameathEarlyErrorPlugin(
  options: EarlyErrorCapturePluginOptions = {},
): RsbuildPlugin {
  const { enabled = true, nonce, ...scriptOptions } = options;

  return {
    name: 'aemeath-early-error-capture',

    setup(api) {
      if (!enabled) return;

      api.modifyHTMLTags(({ headTags, bodyTags }) => {
        // nonce 仅在用户显式提供时附加。空字符串在 CSP 语义下等同于
        // 「没有 nonce」，浏览器仍会拦截，所以也排除。
        const baseAttrs: Record<string, string> = { type: 'text/javascript' };
        if (nonce) {
          baseAttrs.nonce = nonce;
        }
        const scriptTag = {
          tag: 'script',
          children: getEarlyErrorCaptureScript(scriptOptions),
          attrs: baseAttrs,
        };

        return {
          headTags: [scriptTag, ...headTags],
          bodyTags,
        };
      });
    },
  };
}
