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

  /**
   * CSP `nonce` 属性（Content-Security-Policy）
   *
   * 当应用启用了严格的 CSP（如 `script-src 'self' 'nonce-xxx'`）时，
   * 内联脚本必须携带匹配的 `nonce` 属性才会被浏览器执行，否则会被 CSP 静默
   * 拦截、整个早期错误捕获机制失能。
   *
   * 提供此选项后，注入的 `<script>` 标签会带上 `nonce="<value>"` 属性。
   *
   * **运行时 nonce 策略**：如果 nonce 由服务端按请求动态生成（典型做法），
   * 推荐两种集成方式：
   *   1. 在 vite.config 中读环境变量：`nonce: process.env.CSP_NONCE`
   *   2. 留空此选项，由 SSR 中间件（或 nginx sub_filter 等）在响应时把
   *      `<script>` 标签的占位符替换为真实 nonce
   *
   * @example
   * ```ts
   * ameathEarlyErrorPlugin({ nonce: process.env.CSP_NONCE })
   * ```
   */
  nonce?: string;
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
  const { enabled = true, nonce, ...scriptOptions } = options;

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
            // nonce 仅在用户显式提供时附加。空字符串 '' 在 CSP 语义下等同于
            // 「没有 nonce」，浏览器仍会拦截，所以也排除。
            attrs: nonce ? { nonce } : {},
            children: getEarlyErrorCaptureScript(scriptOptions),
            injectTo: 'head-prepend' as const,
          },
        ],
      };
    },
  };
}
