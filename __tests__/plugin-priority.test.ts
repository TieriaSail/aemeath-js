/**
 * 插件优先级与排序测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { PluginPriority } from '../src/types';
import type { AemeathPlugin, BeforeLogResult, LogEntry } from '../src/types';

describe('Plugin Ordering — priority 字段', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    logger = new AemeathLogger({ enableConsole: false });
  });

  it('未声明 priority 的插件按 use 调用顺序执行（向下兼容）', () => {
    const order: string[] = [];
    const a: AemeathPlugin = {
      name: 'a',
      install() {},
      afterLog(entry) {
        order.push('a');
        return entry;
      },
    };
    const b: AemeathPlugin = {
      name: 'b',
      install() {},
      afterLog(entry) {
        order.push('b');
        return entry;
      },
    };
    const c: AemeathPlugin = {
      name: 'c',
      install() {},
      afterLog(entry) {
        order.push('c');
        return entry;
      },
    };
    logger.use(a);
    logger.use(b);
    logger.use(c);
    logger.info('test');
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('priority 数值小的先执行（即使 use 顺序相反）', () => {
    const order: string[] = [];
    const late: AemeathPlugin = {
      name: 'late',
      priority: 100,
      install() {},
      afterLog(entry) {
        order.push('late');
        return entry;
      },
    };
    const early: AemeathPlugin = {
      name: 'early',
      priority: -100,
      install() {},
      afterLog(entry) {
        order.push('early');
        return entry;
      },
    };
    const normal: AemeathPlugin = {
      name: 'normal',
      priority: 0,
      install() {},
      afterLog(entry) {
        order.push('normal');
        return entry;
      },
    };
    logger.use(late);
    logger.use(early);
    logger.use(normal);
    logger.info('test');
    expect(order).toEqual(['early', 'normal', 'late']);
  });

  it('相同 priority 时按 use 调用顺序执行（稳定排序）', () => {
    const order: string[] = [];
    const a: AemeathPlugin = {
      name: 'a',
      priority: 0,
      install() {},
      afterLog(entry) {
        order.push('a');
        return entry;
      },
    };
    const b: AemeathPlugin = {
      name: 'b',
      priority: 0,
      install() {},
      afterLog(entry) {
        order.push('b');
        return entry;
      },
    };
    const c: AemeathPlugin = {
      name: 'c',
      priority: 0,
      install() {},
      afterLog(entry) {
        order.push('c');
        return entry;
      },
    };
    logger.use(c);
    logger.use(b);
    logger.use(a);
    logger.info('test');
    expect(order).toEqual(['c', 'b', 'a']);
  });

  it('混合：未声明 priority（=0）和声明 priority=0 的相对顺序由 use 决定', () => {
    const order: string[] = [];
    const a: AemeathPlugin = {
      name: 'a',
      install() {},
      afterLog(entry) {
        order.push('a');
        return entry;
      },
    };
    const b: AemeathPlugin = {
      name: 'b',
      priority: 0,
      install() {},
      afterLog(entry) {
        order.push('b');
        return entry;
      },
    };
    const c: AemeathPlugin = {
      name: 'c',
      install() {},
      afterLog(entry) {
        order.push('c');
        return entry;
      },
    };
    logger.use(a);
    logger.use(b);
    logger.use(c);
    logger.info('test');
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('PluginPriority 常量梯度生效（EARLIEST < EARLY < NORMAL < LATE < LATEST）', () => {
    const order: string[] = [];
    const make = (name: string, priority: number): AemeathPlugin => ({
      name,
      priority,
      install() {},
      afterLog(entry) {
        order.push(name);
        return entry;
      },
    });
    logger.use(make('latest', PluginPriority.LATEST));
    logger.use(make('normal', PluginPriority.NORMAL));
    logger.use(make('early', PluginPriority.EARLY));
    logger.use(make('late', PluginPriority.LATE));
    logger.use(make('earliest', PluginPriority.EARLIEST));
    logger.info('test');
    expect(order).toEqual(['earliest', 'early', 'normal', 'late', 'latest']);
  });

  it('beforeLog 也按 priority 顺序执行', () => {
    const order: string[] = [];
    const make = (name: string, priority: number): AemeathPlugin => ({
      name,
      priority,
      install() {},
      beforeLog(level, message, options): BeforeLogResult {
        order.push(name);
        return { level, message, options };
      },
    });
    logger.use(make('z', PluginPriority.LATE));
    logger.use(make('a', PluginPriority.EARLY));
    logger.use(make('m', PluginPriority.NORMAL));
    logger.info('test');
    expect(order).toEqual(['a', 'm', 'z']);
  });

  it('getPlugins() 返回顺序 = 实际执行顺序（按 priority 排序）', () => {
    logger.use({ name: 'z', priority: 100, install() {} });
    logger.use({ name: 'a', priority: -100, install() {} });
    logger.use({ name: 'm', priority: 0, install() {} });
    const names = logger.getPlugins().map((p) => p.name);
    expect(names).toEqual(['a', 'm', 'z']);
  });

  it('getPlugins() 返回的元数据包含 priority 字段', () => {
    logger.use({ name: 'p1', priority: 50, install() {} });
    logger.use({ name: 'p2', install() {} });
    const plugins = logger.getPlugins();
    const p1 = plugins.find((p) => p.name === 'p1');
    const p2 = plugins.find((p) => p.name === 'p2');
    expect(p1?.priority).toBe(50);
    expect(p2?.priority).toBe(0);
  });

  it('getPluginInstance(name) 可按名查找插件实例', () => {
    const plugin: AemeathPlugin = {
      name: 'retrievable',
      priority: 10,
      install() {},
    };
    logger.use(plugin);
    expect(logger.getPluginInstance('retrievable')).toBe(plugin);
    expect(logger.getPluginInstance('non-existent')).toBeUndefined();
  });

  it('uninstall 后 getPluginInstance 应返回 undefined', () => {
    const plugin: AemeathPlugin = {
      name: 'temp',
      priority: 0,
      install() {},
      uninstall() {},
    };
    logger.use(plugin);
    expect(logger.getPluginInstance('temp')).toBe(plugin);
    logger.uninstall('temp');
    expect(logger.getPluginInstance('temp')).toBeUndefined();
  });

  it('uninstall 后剩余插件相对顺序保持稳定', () => {
    const order: string[] = [];
    const make = (name: string, priority: number): AemeathPlugin => ({
      name,
      priority,
      install() {},
      uninstall() {},
      afterLog(entry: LogEntry) {
        order.push(name);
        return entry;
      },
    });
    logger.use(make('a', -100));
    logger.use(make('b', 0));
    logger.use(make('c', 0));
    logger.use(make('d', 100));
    logger.uninstall('b');
    logger.info('test');
    expect(order).toEqual(['a', 'c', 'd']);
  });

  it('内置插件的 priority 应符合预期梯度', async () => {
    const { BrowserApiErrorsPlugin } = await import('../src/plugins/BrowserApiErrorsPlugin');
    const { ErrorCapturePlugin } = await import('../src/plugins/ErrorCapturePlugin');
    const { SafeGuardPlugin } = await import('../src/plugins/SafeGuardPlugin');
    const { NetworkPlugin } = await import('../src/plugins/NetworkPlugin');
    const { UploadPlugin } = await import('../src/plugins/UploadPlugin');

    expect(new BrowserApiErrorsPlugin().priority).toBe(PluginPriority.EARLIEST);
    expect(new ErrorCapturePlugin().priority).toBe(PluginPriority.EARLY);
    expect(new SafeGuardPlugin().priority).toBe(PluginPriority.EARLY);
    expect(new NetworkPlugin().priority).toBe(PluginPriority.NORMAL);
    expect(
      new UploadPlugin({ onUpload: async () => ({ success: true }) }).priority,
    ).toBe(PluginPriority.LATE);
  });

  // 8-plugin-ordering.md Q3/Q5 文档示例的编译时回归
  // 父类 priority 必须是 `number` 类型（而非 literal const），子类才能重声明任意值。
  // 如果未来谁误把内置插件的 priority 收紧成 literal type，本 it 会编译失败。
  it('内置插件的 priority 字段类型为 number，允许子类重声明（文档 Q3/Q5）', async () => {
    const { NetworkPlugin } = await import('../src/plugins/NetworkPlugin');
    const { UploadPlugin } = await import('../src/plugins/UploadPlugin');

    class EarlyNetworkPlugin extends NetworkPlugin {
      override readonly priority = -50;
    }
    class CustomUpload extends UploadPlugin {
      override readonly priority = 50;
    }

    expect(new EarlyNetworkPlugin().priority).toBe(-50);
    expect(
      new CustomUpload({ onUpload: async () => ({ success: true }) }).priority,
    ).toBe(50);
  });
});
