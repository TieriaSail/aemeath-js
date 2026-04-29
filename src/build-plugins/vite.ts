/**
 * Vite 早期错误捕获插件
 */

import type { Plugin } from 'vite';
import { getEarlyErrorCaptureScript, type EarlyErrorScriptOptions } from './early-error-script';

// R14.5: 用户在 build 配置中常常需要直接拼装 EarlyErrorScriptOptions（如多环境
// 共享一份基础脚本配置）。从子路径 re-export 让 `import type { EarlyErrorScriptOptions }
// from 'aemeath-js/build-plugins/vite'` 可用，避免用户需要从内部路径深拉。
export type { EarlyErrorScriptOptions } from './early-error-script';

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

    // 使用 vite 官方推荐的 `tags + injectTo` 返回值（vite 2.x+ 都支持），而非
    // `html.replace('<head>', ...)`。旧实现用 String.prototype.replace 字面量
    // 匹配 `<head>`，会在以下场景静默失效：
    //   - `<HEAD>` 大写
    //   - `<head class="x">` / `<head lang="en">` 等带属性
    //   - 模板字符串自定义 head 结构
    // 一旦失效，早期脚本不被注入，整个 fallback / 早期错误捕获机制失能。
    // `injectTo: 'head-prepend'` 由 vite 内部解析 HTML 树，对各种合法 <head> 都成立。
    transformIndexHtml(html: string) {
      if (!enabled) return html;
      return {
        html,
        tags: [
          {
            tag: 'script',
            attrs: {},
            children: getEarlyErrorCaptureScript(scriptOptions),
            injectTo: 'head-prepend' as const,
          },
        ],
      };
    },
  };
}
