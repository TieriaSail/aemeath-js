/**
 * RouteMatcher 路由匹配器测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { RouteMatcher, createRouteMatcher } from '../src/utils/routeMatcher';

describe('RouteMatcher', () => {
  // ==================== matchRoute 基础匹配 ====================

  describe('matchRoute - 基础匹配', () => {
    let matcher: RouteMatcher;

    beforeEach(() => {
      matcher = new RouteMatcher();
    });

    it('字符串精确匹配', () => {
      expect(matcher.matchRoute('/home', '/home')).toBe(true);
      expect(matcher.matchRoute('/home', '/about')).toBe(false);
      expect(matcher.matchRoute('/home/', '/home')).toBe(false); // 严格匹配
    });

    it('正则表达式匹配', () => {
      expect(matcher.matchRoute('/product/123', /^\/product\/\d+$/)).toBe(true);
      expect(matcher.matchRoute('/product/abc', /^\/product\/\d+$/)).toBe(false);
      expect(matcher.matchRoute('/user/john', /^\/user\/.+/)).toBe(true);
    });

    it('函数匹配', () => {
      const fn = (path: string) => path.startsWith('/admin');
      expect(matcher.matchRoute('/admin/dashboard', fn)).toBe(true);
      expect(matcher.matchRoute('/home', fn)).toBe(false);
    });

    it('匹配函数抛出异常时应返回 false', () => {
      const badFn = () => {
        throw new Error('boom');
      };
      expect(matcher.matchRoute('/any', badFn)).toBe(false);
    });
  });

  // ==================== shouldCapturePath ====================

  describe('shouldCapturePath', () => {
    it('无配置时应返回 true（监控所有）', () => {
      const matcher = new RouteMatcher();
      expect(matcher.shouldCapturePath('/anything')).toBe(true);
    });

    it('白名单内的路由应返回 true', () => {
      const matcher = new RouteMatcher({
        config: { includeRoutes: ['/home', '/about'] },
      });
      expect(matcher.shouldCapturePath('/home')).toBe(true);
      expect(matcher.shouldCapturePath('/about')).toBe(true);
      expect(matcher.shouldCapturePath('/other')).toBe(false);
    });

    it('黑名单内的路由应返回 false', () => {
      const matcher = new RouteMatcher({
        config: { excludeRoutes: ['/debug', '/test'] },
      });
      expect(matcher.shouldCapturePath('/debug')).toBe(false);
      expect(matcher.shouldCapturePath('/test')).toBe(false);
      expect(matcher.shouldCapturePath('/home')).toBe(true);
    });

    it('黑名单优先级高于白名单', () => {
      const matcher = new RouteMatcher({
        config: {
          includeRoutes: ['/admin', '/admin/settings'],
          excludeRoutes: ['/admin/settings'],
        },
      });
      expect(matcher.shouldCapturePath('/admin')).toBe(true);
      expect(matcher.shouldCapturePath('/admin/settings')).toBe(false); // 黑名单优先
    });

    it('支持正则表达式混合使用', () => {
      const matcher = new RouteMatcher({
        config: {
          includeRoutes: [/^\/product/, '/home'],
        },
      });
      expect(matcher.shouldCapturePath('/product/123')).toBe(true);
      expect(matcher.shouldCapturePath('/product/abc')).toBe(true);
      expect(matcher.shouldCapturePath('/home')).toBe(true);
      expect(matcher.shouldCapturePath('/about')).toBe(false);
    });

    it('支持函数混合使用', () => {
      const matcher = new RouteMatcher({
        config: {
          includeRoutes: [(path) => path.includes('detail')],
        },
      });
      expect(matcher.shouldCapturePath('/product/detail')).toBe(true);
      expect(matcher.shouldCapturePath('/order/detail/123')).toBe(true);
      expect(matcher.shouldCapturePath('/home')).toBe(false);
    });
  });

  // ==================== shouldCapture (使用 window.location) ====================

  describe('shouldCapture - 基于 window.location', () => {
    it('无配置时应返回 true', () => {
      const matcher = new RouteMatcher();
      expect(matcher.shouldCapture()).toBe(true);
    });

    it('应基于当前 pathname 判断', () => {
      // jsdom 默认 pathname 是 '/'
      const matcher = new RouteMatcher({
        config: { includeRoutes: ['/'] },
      });
      expect(matcher.shouldCapture()).toBe(true);
    });

    it('当前路径不在白名单应返回 false', () => {
      const matcher = new RouteMatcher({
        config: { includeRoutes: ['/special-page'] },
      });
      // jsdom 默认是 '/'，不在白名单中
      expect(matcher.shouldCapture()).toBe(false);
    });
  });

  // ==================== createRouteMatcher 工厂函数 ====================

  describe('createRouteMatcher', () => {
    it('应返回 RouteMatcher 实例', () => {
      const matcher = createRouteMatcher({ includeRoutes: ['/home'] });
      expect(matcher).toBeInstanceOf(RouteMatcher);
    });

    it('无参数应创建无限制的匹配器', () => {
      const matcher = createRouteMatcher();
      expect(matcher.shouldCapturePath('/any')).toBe(true);
    });

    it('应支持 debug 选项', () => {
      const matcher = createRouteMatcher(
        { excludeRoutes: ['/test'] },
        { debug: true, debugPrefix: '[MyPlugin]' },
      );
      expect(matcher).toBeInstanceOf(RouteMatcher);
      expect(matcher.shouldCapturePath('/test')).toBe(false);
    });
  });

  // ==================== compose 组合匹配 ====================

  describe('compose', () => {
    it('child 无配置时应返回 parent 本身', () => {
      const parent = new RouteMatcher({ config: { excludeRoutes: ['/debug'] } });
      const composed = RouteMatcher.compose(parent, undefined);
      expect(composed).toBe(parent);
    });

    it('parent 拒绝时，组合后也应拒绝', () => {
      const parent = new RouteMatcher({ config: { excludeRoutes: ['/debug'] } });
      const composed = RouteMatcher.compose(parent, { includeRoutes: ['/debug'] });
      expect(composed.shouldCapture('/debug')).toBe(false);
    });

    it('parent 通过但 child 拒绝时，组合后应拒绝', () => {
      const parent = new RouteMatcher({ config: { includeRoutes: [/^\/app/] } });
      const composed = RouteMatcher.compose(parent, { excludeRoutes: ['/app/internal'] });
      expect(composed.shouldCapture('/app/dashboard')).toBe(true);
      expect(composed.shouldCapture('/app/internal')).toBe(false);
    });

    it('parent 和 child 都通过时，组合后应通过', () => {
      const parent = new RouteMatcher({ config: { includeRoutes: [/^\/app/] } });
      const composed = RouteMatcher.compose(parent, { includeRoutes: ['/app/checkout'] });
      expect(composed.shouldCapture('/app/checkout')).toBe(true);
      expect(composed.shouldCapture('/app/dashboard')).toBe(false);
    });

    it('parent 无配置（全通过）+ child 有配置应仅受 child 控制', () => {
      const parent = new RouteMatcher();
      const composed = RouteMatcher.compose(parent, { excludeRoutes: ['/admin'] });
      expect(composed.shouldCapture('/home')).toBe(true);
      expect(composed.shouldCapture('/admin')).toBe(false);
    });

    it('parent 不匹配的路由，child 无法覆盖', () => {
      const parent = new RouteMatcher({ config: { includeRoutes: ['/app'] } });
      const composed = RouteMatcher.compose(parent, { includeRoutes: ['/other'] });
      expect(composed.shouldCapture('/other')).toBe(false);
      expect(composed.shouldCapture('/app')).toBe(false); // child 限制了只要 /other
    });
  });
});

