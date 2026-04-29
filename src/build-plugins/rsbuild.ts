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
  const { enabled = true, ...scriptOptions } = options;

  return {
    name: 'aemeath-early-error-capture',

    setup(api) {
      if (!enabled) return;

      api.modifyHTMLTags(({ headTags, bodyTags }) => {
        const scriptTag = {
          tag: 'script',
          children: getEarlyErrorCaptureScript(scriptOptions),
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
