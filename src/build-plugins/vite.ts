/**
 * Vite 早期错误捕获插件
 */

import type { Plugin } from 'vite';
import { getEarlyErrorCaptureScript } from './early-error-script';

export interface EarlyErrorCaptureVitePluginOptions {
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
 */
export function ameathEarlyErrorPlugin(
  options: EarlyErrorCaptureVitePluginOptions = {},
): Plugin {
  const { enabled = true } = options;

  return {
    name: 'aemeath-early-error-capture',

    transformIndexHtml(html) {
      if (!enabled) return html;

      const script = `<script>${getEarlyErrorCaptureScript()}</script>`;
      return html.replace('<head>', `<head>\n${script}`);
    },
  };
}
