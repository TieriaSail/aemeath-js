/**
 * Vue 框架集成
 *
 * 提供 Vue 特定的错误捕获能力：
 * - Vue 插件（自动注册 errorHandler）
 * - Composition API（useAemeath）
 *
 * 使用方式：
 * ```ts
 * // Vue 3
 * import { createApp } from 'vue';
 * import { createAemeathPlugin } from 'aemeath-js/vue';
 *
 * const app = createApp(App);
 * app.use(createAemeathPlugin());
 * app.mount('#app');
 *
 * // 在组件中使用
 * import { useAemeath } from 'aemeath-js/vue';
 *
 * const logger = useAemeath();
 * logger.info('Component mounted');
 * ```
 */

import type { AemeathLogger } from '../core/Logger';
import { getAemeath } from '../singleton';

// ==================== 类型定义 ====================

/**
 * Vue App 接口（避免直接依赖 vue）
 */
interface VueApp {
  config: {
    errorHandler?: (
      err: unknown,
      instance: unknown,
      info: string,
    ) => void;
    warnHandler?: (
      msg: string,
      instance: unknown,
      trace: string,
    ) => void;
  };
  provide: (key: string | symbol, value: unknown) => VueApp;
}

/**
 * Vue 3 组件内部实例
 */
interface VueInternalInstance {
  type?: {
    name?: string;
    __file?: string;
  };
}

/**
 * Vue 组件实例接口
 */
interface VueComponentInstance {
  /** Vue 3 Options API 组件选项 */
  $options?: {
    name?: string;
    __file?: string;
  };
  /** Vue 3 Composition API 内部实例 */
  $?: VueInternalInstance;
}

// ==================== 插件配置 ====================

export interface VueAemeathPluginOptions {
  /**
   * 自定义 AemeathJs 实例（可选，默认使用全局单例）
   */
  logger?: AemeathLogger;

  /**
   * 是否捕获 Vue 警告
   * @default false
   */
  captureWarnings?: boolean;

  /**
   * 原始 errorHandler（如果需要保留）
   */
  originalErrorHandler?: (
    err: unknown,
    instance: unknown,
    info: string,
  ) => void;
}

// ==================== Injection Key ====================

export const AEMEATH_INJECTION_KEY = Symbol('aemeath');

// ==================== Vue 插件 ====================

/**
 * 创建 Vue AemeathJs 插件
 *
 * @example
 * ```ts
 * // Vue 3
 * import { createApp } from 'vue';
 * import { createAemeathPlugin } from 'aemeath-js/vue';
 *
 * const app = createApp(App);
 * app.use(createAemeathPlugin({
 *   captureWarnings: true, // 可选：也捕获警告
 * }));
 * app.mount('#app');
 * ```
 */
export function createAemeathPlugin(options: VueAemeathPluginOptions = {}) {
  const {
    logger: customLogger,
    captureWarnings = false,
    originalErrorHandler,
  } = options;

  return {
    install(app: VueApp) {
      const logger = customLogger || getAemeath();

      // 保存原始 errorHandler
      const prevErrorHandler = originalErrorHandler || app.config.errorHandler;

      // 注册错误处理器
      app.config.errorHandler = (
        err: unknown,
        instance: unknown,
        info: string,
      ) => {
        try {
          prevErrorHandler?.(err, instance, info);
        } catch {
          // prevent original handler error from blocking Aemeath reporting
        }

        // 上报错误
        const error =
          err instanceof Error ? err : new Error(String(err));

        // 尝试获取组件名
        const componentName = getComponentName(instance as VueComponentInstance);

        // 增强错误信息
        (error as Error & { vueInfo?: string; componentName?: string }).vueInfo = info;
        (error as Error & { componentName?: string }).componentName = componentName;

        logger.error('Vue component error', {
          error,
          tags: {
            errorCategory: 'vue',
            component: componentName || 'Unknown',
            lifecycle: info,
          },
          context: {
            vueInfo: info,
            componentName,
          },
        });
      };

      // 可选：捕获警告
      if (captureWarnings) {
        const prevWarnHandler = app.config.warnHandler;

        app.config.warnHandler = (
          msg: string,
          instance: unknown,
          trace: string,
        ) => {
          try {
            prevWarnHandler?.(msg, instance, trace);
          } catch {
            // prevent original handler error from blocking Aemeath reporting
          }

          const componentName = getComponentName(instance as VueComponentInstance);

          logger.warn('Vue warning', {
            tags: {
              errorCategory: 'vue',
              component: componentName || 'Unknown',
              type: 'warning',
            },
            context: {
              message: msg,
              trace,
              componentName,
            },
          });
        };
      }

      // 提供 AemeathJs 给 Composition API
      app.provide(AEMEATH_INJECTION_KEY, logger);
    },
  };
}

/**
 * 获取组件名称
 */
function getComponentName(instance: VueComponentInstance | null): string | undefined {
  if (!instance) return undefined;

  // Vue 3 Composition API
  if (instance.$?.type?.name) {
    return instance.$.type.name;
  }

  // Vue 3 Options API
  if (instance.$options?.name) {
    return instance.$options.name;
  }

  // 尝试从文件路径获取
  const file = instance.$?.type?.__file || instance.$options?.__file;
  if (file) {
    const match = file.match(/([^/\\]+)\.vue$/);
    return match?.[1];
  }

  return undefined;
}

// ==================== Composition API ====================

// 模拟 Vue 的 inject 函数签名
type InjectFn = <T>(key: symbol, defaultValue?: T) => T | undefined;

/**
 * 在组件中获取 AemeathJs 实例
 *
 * 需要配合 Vue 的 inject 使用
 *
 * @example
 * ```ts
 * import { inject } from 'vue';
 * import { useAemeath } from 'aemeath-js/vue';
 *
 * export default {
 *   setup() {
 *     const logger = useAemeath(inject);
 *
 *     onMounted(() => {
 *       logger.info('Component mounted');
 *     });
 *
 *     return {};
 *   }
 * }
 * ```
 */
export function useAemeath(inject: InjectFn): AemeathLogger {
  const logger = inject(AEMEATH_INJECTION_KEY) as AemeathLogger | undefined;
  return logger || getAemeath();
}

/**
 * 创建错误捕获工具
 *
 * @example
 * ```ts
 * import { inject } from 'vue';
 * import { useErrorCapture } from 'aemeath-js/vue';
 *
 * export default {
 *   setup() {
 *     const { captureError, captureMessage } = useErrorCapture(inject);
 *
 *     const handleClick = async () => {
 *       try {
 *         await riskyOperation();
 *       } catch (error) {
 *         captureError(error as Error, { action: 'risky-operation' });
 *       }
 *     };
 *
 *     return { handleClick };
 *   }
 * }
 * ```
 */
export function useErrorCapture(inject: InjectFn) {
  const logger = useAemeath(inject);

  const captureError = (error: Error, extra?: Record<string, unknown>) => {
    logger.error(error.message, {
      error,
      tags: {
        errorCategory: 'vue',
        source: 'useErrorCapture',
        ...extra,
      },
    });
  };

  const captureMessage = (
    message: string,
    level: 'info' | 'warn' | 'error' = 'info',
    extra?: Record<string, unknown>,
  ) => {
    logger[level](message, {
      tags: {
        source: 'useErrorCapture',
        ...extra,
      },
    });
  };

  return { captureError, captureMessage, logger };
}
