/**
 * 框架集成入口
 *
 * 注意：框架集成需要单独导入，避免引入不必要的依赖
 *
 * @example
 * ```ts
 * // React
 * import { AemeathErrorBoundary, useAemeath } from 'aemeath-js/react';
 *
 * // Vue
 * import { createAemeathPlugin, useAemeath } from 'aemeath-js/vue';
 * ```
 */

// 这个文件主要用于文档目的
// 实际使用时应该直接从具体框架导入

export const SUPPORTED_FRAMEWORKS = ['react', 'vue'] as const;

export type SupportedFramework = (typeof SUPPORTED_FRAMEWORKS)[number];

/**
 * 框架集成说明
 */
export const FRAMEWORK_DOCS = {
  react: {
    name: 'React',
    import: "aemeath-js/react",
    features: [
      'AemeathErrorBoundary - 错误边界组件',
      'useAemeath - 获取 AemeathJs 实例的 Hook',
      'useErrorCapture - 错误捕获 Hook',
      'withErrorBoundary - 高阶组件',
    ],
  },
  vue: {
    name: 'Vue',
    import: "aemeath-js/vue",
    features: [
      'createAemeathPlugin - Vue 插件',
      'useAemeath - Composition API',
      'useErrorCapture - 错误捕获工具',
    ],
  },
} as const;
