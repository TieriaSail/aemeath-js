/**
 * 路由匹配工具
 *
 * 统一的路由匹配逻辑，供各插件共用
 */

/**
 * 路由匹配模式
 */
export type RoutePattern = string | RegExp | ((path: string) => boolean);

/**
 * 路由匹配配置
 */
export interface RouteMatchConfig {
  /**
   * 路由白名单：只监控这些路由
   * 支持字符串精确匹配、正则表达式、函数匹配
   *
   * @example
   * ```typescript
   * // 字符串精确匹配
   * includeRoutes: ['/home', '/about']
   *
   * // 正则表达式匹配
   * includeRoutes: [/^\/product\/\d+$/, /^\/user\/.+/]
   *
   * // 函数匹配
   * includeRoutes: [(path) => path.startsWith('/admin')]
   *
   * // 混合匹配
   * includeRoutes: ['/home', /^\/product/, (path) => path.includes('detail')]
   * ```
   */
  includeRoutes?: RoutePattern[];

  /**
   * 路由黑名单：排除这些路由
   * 优先级高于白名单
   * 支持字符串精确匹配、正则表达式、函数匹配
   *
   * @example
   * ```typescript
   * // 排除测试页面
   * excludeRoutes: ['/logger-test', '/debug']
   *
   * // 排除所有以 /test 开头的路由
   * excludeRoutes: [/^\/test/]
   * ```
   */
  excludeRoutes?: RoutePattern[];
}

/**
 * 路由匹配器
 *
 * 提供统一的路由匹配功能，避免各插件重复实现
 */
export class RouteMatcher {
  private readonly config: RouteMatchConfig | undefined;
  private readonly debugEnabled: boolean;
  private readonly debugPrefix: string;

  constructor(options?: {
    config?: RouteMatchConfig;
    debug?: boolean;
    debugPrefix?: string;
  }) {
    this.config = options?.config;
    this.debugEnabled = options?.debug ?? false;
    this.debugPrefix = options?.debugPrefix ?? '[RouteMatcher]';
  }

  /**
   * 调试日志
   */
  private log(...args: unknown[]): void {
    if (this.debugEnabled) {
      console.log(this.debugPrefix, ...args);
    }
  }

  /**
   * 警告日志
   */
  private warn(...args: unknown[]): void {
    if (this.debugEnabled) {
      console.warn(this.debugPrefix, ...args);
    }
  }

  /**
   * 获取当前路由路径
   */
  private getCurrentPath(): string {
    return typeof window !== 'undefined' ? window.location.pathname : '';
  }

  /**
   * 检查当前路由是否匹配配置
   *
   * @returns true 表示应该监控当前路由，false 表示不监控
   */
  public shouldCapture(): boolean {
    // 如果没有配置路由过滤，默认监控所有路由
    if (!this.config) {
      return true;
    }

    const currentPath = this.getCurrentPath();
    const { excludeRoutes, includeRoutes } = this.config;

    // 1. 检查黑名单（优先级更高）
    if (excludeRoutes && excludeRoutes.length > 0) {
      const isExcluded = excludeRoutes.some((pattern) =>
        this.matchRoute(currentPath, pattern),
      );
      if (isExcluded) {
        this.log('当前路由在黑名单中，不监控:', currentPath);
        return false; // 在黑名单中，不监控
      }
    }

    // 2. 检查白名单
    if (includeRoutes && includeRoutes.length > 0) {
      const isIncluded = includeRoutes.some((pattern) =>
        this.matchRoute(currentPath, pattern),
      );
      if (!isIncluded) {
        this.log('当前路由不在白名单中，不监控:', currentPath);
      }
      return isIncluded; // 只有在白名单中才监控
    }

    // 3. 如果没有配置白名单，默认监控
    return true;
  }

  /**
   * 检查指定路径是否匹配配置
   *
   * @param path 要检查的路径
   * @returns true 表示应该监控该路由，false 表示不监控
   */
  public shouldCapturePath(path: string): boolean {
    // 如果没有配置路由过滤，默认监控所有路由
    if (!this.config) {
      return true;
    }

    const { excludeRoutes, includeRoutes } = this.config;

    // 1. 检查黑名单（优先级更高）
    if (excludeRoutes && excludeRoutes.length > 0) {
      const isExcluded = excludeRoutes.some((pattern) =>
        this.matchRoute(path, pattern),
      );
      if (isExcluded) {
        return false;
      }
    }

    // 2. 检查白名单
    if (includeRoutes && includeRoutes.length > 0) {
      return includeRoutes.some((pattern) => this.matchRoute(path, pattern));
    }

    // 3. 如果没有配置白名单，默认监控
    return true;
  }

  /**
   * 匹配单个路由模式
   *
   * @param path 当前路由路径
   * @param pattern 匹配模式（字符串、正则、函数）
   */
  public matchRoute(path: string, pattern: RoutePattern): boolean {
    try {
      if (typeof pattern === 'string') {
        // 字符串精确匹配
        return path === pattern;
      } else if (pattern instanceof RegExp) {
        // 正则表达式匹配
        return pattern.test(path);
      } else if (typeof pattern === 'function') {
        // 函数匹配
        return pattern(path);
      }
    } catch (err) {
      this.warn('Route match error:', err);
    }
    return false;
  }
}

/**
 * 创建路由匹配器
 *
 * @param config 路由匹配配置
 * @param options 可选配置
 * @returns RouteMatcher 实例
 *
 * @example
 * ```typescript
 * const matcher = createRouteMatcher({
 *   includeRoutes: ['/home', /^\/product/],
 *   excludeRoutes: ['/debug', '/test']
 * });
 *
 * if (matcher.shouldCapture()) {
 *   // 当前路由需要监控
 * }
 * ```
 */
export function createRouteMatcher(
  config?: RouteMatchConfig,
  options?: { debug?: boolean; debugPrefix?: string },
): RouteMatcher {
  return new RouteMatcher({
    config,
    debug: options?.debug,
    debugPrefix: options?.debugPrefix,
  });
}

