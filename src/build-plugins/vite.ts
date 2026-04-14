/**
 * Vite 早期错误捕获插件
 */

import type { Plugin } from 'vite';
import { getEarlyErrorCaptureScript, type EarlyErrorScriptOptions } from './early-error-script';

export interface EarlyErrorCaptureVitePluginOptions extends EarlyErrorScriptOptions {
  /**
   * 是否启用
   * @default true
   */
  enabled?: boolean;
}

/**
 * Aemeath 早期错误捕获插件（Vite）
 *
 * @example
 * ```javascript
 * import { ameathEarlyErrorPlugin } from 'aemeath-js/build-plugins/vite';
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
 *   fallbackHeaders: { 'X-App-Name': 'my-app' },
 * })
 * ```
 */
export function ameathEarlyErrorPlugin(
  options: EarlyErrorCaptureVitePluginOptions = {},
): Plugin {
  const { enabled = true, ...scriptOptions } = options;

  return {
    name: 'aemeath-early-error-capture',

    transformIndexHtml(html) {
      if (!enabled) return html;

      const script = `<script>${getEarlyErrorCaptureScript(scriptOptions)}</script>`;
      return html.replace('<head>', `<head>\n${script}`);
    },
  };
}
