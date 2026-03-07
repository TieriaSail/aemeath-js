/**
 * Rsbuild 早期错误捕获插件
 *
 * 在 HTML head 中注入脚本，捕获 React/Vue 挂载前的错误
 */

import type { RsbuildPlugin } from '@rsbuild/core';
import { getEarlyErrorCaptureScript } from './early-error-script';

export interface EarlyErrorCapturePluginOptions {
  /**
   * 是否启用
   * @default true
   */
  enabled?: boolean;
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
 */
export function ameathEarlyErrorPlugin(
  options: EarlyErrorCapturePluginOptions = {},
): RsbuildPlugin {
  const { enabled = true } = options;

  return {
    name: 'aemeath-early-error-capture',

    setup(api) {
      if (!enabled) return;

      api.modifyHTMLTags(({ headTags, bodyTags }) => {
        const scriptTag = {
          tag: 'script',
          children: getEarlyErrorCaptureScript(),
          attrs: { type: 'text/javascript' },
        };

        return {
          headTags: [scriptTag, ...headTags],
          bodyTags,
        };
      });
    },
  };
}

