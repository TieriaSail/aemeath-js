/**
 * Vue 集成模块测试
 *
 * 测试内容：
 * - createAemeathPlugin (Vue 插件)
 * - useAemeath (Composition API)
 * - useErrorCapture (Composition API)
 * - getComponentName 逻辑
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createAemeathPlugin,
  useAemeath,
  useErrorCapture,
  AEMEATH_INJECTION_KEY,
} from '../../src/integrations/vue';
import { AemeathLogger } from '../../src/core/Logger';
import * as singletonModule from '../../src/singleton';

// ==================== Mock VueApp ====================

/**
 * 创建一个模拟的 Vue App 对象
 * 不需要真正的 Vue 运行时，只需要接口一致
 */
function createMockApp() {
  const providers = new Map<string | symbol, unknown>();

  return {
    config: {
      errorHandler: undefined as
        | ((err: unknown, instance: unknown, info: string) => void)
        | undefined,
      warnHandler: undefined as
        | ((msg: string, instance: unknown, trace: string) => void)
        | undefined,
    },
    provide(key: string | symbol, value: unknown) {
      providers.set(key, value);
      return this;
    },
    // 辅助方法：获取 provide 的值
    _getProvided(key: string | symbol) {
      return providers.get(key);
    },
  };
}

// ==================== 测试 ====================

describe('Vue Integration', () => {
  let logger: AemeathLogger;
  let logSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = new AemeathLogger({ enableConsole: false });
    logSpy = vi.fn();
    logger.on('log', logSpy);

    vi.spyOn(singletonModule, 'getAemeath').mockReturnValue(logger);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ==================== createAemeathPlugin ====================

  describe('createAemeathPlugin', () => {
    it('应返回包含 install 方法的对象', () => {
      const plugin = createAemeathPlugin();
      expect(plugin).toBeDefined();
      expect(typeof plugin.install).toBe('function');
    });

    it('install 应注册 errorHandler', () => {
      const app = createMockApp();
      const plugin = createAemeathPlugin({ logger });

      expect(app.config.errorHandler).toBeUndefined();
      plugin.install(app);
      expect(app.config.errorHandler).toBeDefined();
      expect(typeof app.config.errorHandler).toBe('function');
    });

    it('install 应通过 provide 注入 Logger', () => {
      const app = createMockApp();
      const plugin = createAemeathPlugin({ logger });

      plugin.install(app);

      const provided = app._getProvided(AEMEATH_INJECTION_KEY);
      expect(provided).toBe(logger);
    });

    it('errorHandler 应捕获 Error 并上报', () => {
      const app = createMockApp();
      const plugin = createAemeathPlugin({ logger });
      plugin.install(app);

      // 模拟 Vue 触发错误
      const error = new Error('Vue 组件报错');
      app.config.errorHandler!(error, null, 'mounted hook');

      expect(logSpy).toHaveBeenCalledTimes(1);
      const logEntry = logSpy.mock.calls[0][0];
      expect(logEntry.level).toBe('error');
      expect(logEntry.message).toBe('Vue component error');
      expect(logEntry.tags?.errorCategory).toBe('vue');
      expect(logEntry.tags?.lifecycle).toBe('mounted hook');
      expect(logEntry.context?.vueInfo).toBe('mounted hook');
    });

    it('errorHandler 应将非 Error 对象包装为 Error', () => {
      const app = createMockApp();
      const plugin = createAemeathPlugin({ logger });
      plugin.install(app);

      // 传入字符串而非 Error
      app.config.errorHandler!('字符串错误', null, 'render');

      expect(logSpy).toHaveBeenCalledTimes(1);
      const logEntry = logSpy.mock.calls[0][0];
      expect(logEntry.level).toBe('error');
    });

    it('errorHandler 应尝试获取组件名', () => {
      const app = createMockApp();
      const plugin = createAemeathPlugin({ logger });
      plugin.install(app);

      // 模拟 Vue 3 组件实例 (Options API)
      const mockInstance = {
        $options: { name: 'MyComponent' },
      };

      app.config.errorHandler!(new Error('test'), mockInstance, 'setup');

      const logEntry = logSpy.mock.calls[0][0];
      expect(logEntry.tags?.component).toBe('MyComponent');
      expect(logEntry.context?.componentName).toBe('MyComponent');
    });

    it('errorHandler 应从 Composition API 实例获取组件名', () => {
      const app = createMockApp();
      const plugin = createAemeathPlugin({ logger });
      plugin.install(app);

      // 模拟 Vue 3 Composition API 内部实例
      const mockInstance = {
        $: {
          type: { name: 'CompositionComponent' },
        },
      };

      app.config.errorHandler!(new Error('test'), mockInstance, 'setup');

      const logEntry = logSpy.mock.calls[0][0];
      expect(logEntry.tags?.component).toBe('CompositionComponent');
    });

    it('errorHandler 应从 __file 推断组件名', () => {
      const app = createMockApp();
      const plugin = createAemeathPlugin({ logger });
      plugin.install(app);

      // 模拟从文件路径获取组件名
      const mockInstance = {
        $options: {
          __file: '/src/components/UserCard.vue',
        },
      };

      app.config.errorHandler!(new Error('test'), mockInstance, 'render');

      const logEntry = logSpy.mock.calls[0][0];
      expect(logEntry.tags?.component).toBe('UserCard');
    });

    it('errorHandler 应调用原始 errorHandler', () => {
      const app = createMockApp();
      const originalHandler = vi.fn();
      const plugin = createAemeathPlugin({
        logger,
        originalErrorHandler: originalHandler,
      });
      plugin.install(app);

      const error = new Error('test');
      app.config.errorHandler!(error, null, 'render');

      expect(originalHandler).toHaveBeenCalledWith(error, null, 'render');
      expect(logSpy).toHaveBeenCalled(); // Logger 也记录了
    });

    it('errorHandler 应保留 app 上已有的 errorHandler', () => {
      const app = createMockApp();
      const existingHandler = vi.fn();
      app.config.errorHandler = existingHandler;

      const plugin = createAemeathPlugin({ logger });
      plugin.install(app);

      app.config.errorHandler!(new Error('test'), null, 'render');

      // 原有的 handler 应该被调用
      expect(existingHandler).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalled();
    });

    it('captureWarnings=true 时应注册 warnHandler', () => {
      const app = createMockApp();
      const plugin = createAemeathPlugin({
        logger,
        captureWarnings: true,
      });
      plugin.install(app);

      expect(app.config.warnHandler).toBeDefined();
    });

    it('captureWarnings=false 时不应注册 warnHandler', () => {
      const app = createMockApp();
      const plugin = createAemeathPlugin({
        logger,
        captureWarnings: false,
      });
      plugin.install(app);

      expect(app.config.warnHandler).toBeUndefined();
    });

    it('warnHandler 应捕获警告', () => {
      const app = createMockApp();
      const plugin = createAemeathPlugin({
        logger,
        captureWarnings: true,
      });
      plugin.install(app);

      app.config.warnHandler!('组件属性类型错误', null, 'at <App>');

      expect(logSpy).toHaveBeenCalledTimes(1);
      const logEntry = logSpy.mock.calls[0][0];
      expect(logEntry.level).toBe('warn');
      expect(logEntry.message).toBe('Vue warning');
      expect(logEntry.tags?.type).toBe('warning');
      expect(logEntry.context?.message).toBe('组件属性类型错误');
      expect(logEntry.context?.trace).toBe('at <App>');
    });

    it('未传 logger 时应使用全局单例', () => {
      const app = createMockApp();
      const plugin = createAemeathPlugin();
      plugin.install(app);

      app.config.errorHandler!(new Error('test'), null, 'render');

      expect(singletonModule.getAemeath).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalled();
    });
  });

  // ==================== useAemeath ====================

  describe('useAemeath', () => {
    it('有 inject 值时应返回注入的 Logger', () => {
      // 模拟 Vue 的 inject 函数
      const mockInject = vi.fn().mockReturnValue(logger);

      const result = useAemeath(mockInject);

      expect(mockInject).toHaveBeenCalledWith(AEMEATH_INJECTION_KEY);
      expect(result).toBe(logger);
    });

    it('无 inject 值时应使用全局单例', () => {
      const mockInject = vi.fn().mockReturnValue(undefined);

      const result = useAemeath(mockInject);

      expect(singletonModule.getAemeath).toHaveBeenCalled();
      expect(result).toBe(logger);
    });
  });

  // ==================== useErrorCapture ====================

  describe('useErrorCapture', () => {
    it('captureError 应上报错误', () => {
      const mockInject = vi.fn().mockReturnValue(logger);
      const { captureError } = useErrorCapture(mockInject);

      captureError(new Error('手动捕获'), { action: 'click' });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const logEntry = logSpy.mock.calls[0][0];
      expect(logEntry.level).toBe('error');
      expect(logEntry.message).toBe('手动捕获');
      expect(logEntry.tags?.errorCategory).toBe('vue');
      expect(logEntry.tags?.source).toBe('useErrorCapture');
      expect(logEntry.tags?.action).toBe('click');
    });

    it('captureMessage 应上报指定级别消息', () => {
      const mockInject = vi.fn().mockReturnValue(logger);
      const { captureMessage } = useErrorCapture(mockInject);

      captureMessage('操作成功', 'info', { page: 'home' });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const logEntry = logSpy.mock.calls[0][0];
      expect(logEntry.level).toBe('info');
      expect(logEntry.message).toBe('操作成功');
      expect(logEntry.tags?.page).toBe('home');
    });

    it('captureMessage 默认级别为 info', () => {
      const mockInject = vi.fn().mockReturnValue(logger);
      const { captureMessage } = useErrorCapture(mockInject);

      captureMessage('默认级别');

      const logEntry = logSpy.mock.calls[0][0];
      expect(logEntry.level).toBe('info');
    });

    it('应返回 logger 实例', () => {
      const mockInject = vi.fn().mockReturnValue(logger);
      const result = useErrorCapture(mockInject);

      expect(result.logger).toBe(logger);
    });
  });
});

