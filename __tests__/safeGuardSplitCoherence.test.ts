/**
 * SafeGuard × 拆分：分组完整性
 *
 * 拆分把 1 条日志变成 N 条上报。凡是能"丢掉其中一条"的环节，都可能给后端留下
 * 拼不回来的碎片 —— 去重、beforeSend、队列淘汰三处已经各自钉过。
 * SafeGuard 是最后一个有丢弃权的环节，这里补上。
 *
 * 结论应该由**执行顺序**保证：SafeGuard 走 beforeLog（EARLY），在日志对象生成
 * 之前就做完了限流、合并和熔断；PayloadSanitizePlugin 走 afterLog，之后才拆分。
 * 所以 SafeGuard 看到的永远是 1 条逻辑日志，丢也是整条丢，不可能只毙掉其中一片。
 * 但顺序这种事光读 priority 容易读错，这里用行为钉死。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AemeathLogger } from '../src/core/Logger';
import { SafeGuardPlugin } from '../src/plugins/SafeGuardPlugin';
import { PayloadSanitizePlugin } from '../src/plugins/PayloadSanitizePlugin';
import { UploadPlugin, type UploadResult } from '../src/plugins/UploadPlugin';
import type { LogEntry } from '../src/types';

/** 大到必然被拆成 3 片的 context */
const fatContext = (): Record<string, string> => ({
  a: 'x'.repeat(1200),
  b: 'y'.repeat(1200),
  c: 'z'.repeat(1200),
});

/** 检查每个 splitId 分组都是完整的 1..total，没有碎片 */
function expectNoFragmentedGroups(logs: LogEntry[]): void {
  const groups = new Map<string, Set<number>>();
  const totals = new Map<string, number>();
  for (const log of logs) {
    const id = log.tags?.splitId as string | undefined;
    if (!id) continue;
    if (!groups.has(id)) groups.set(id, new Set());
    groups.get(id)!.add(log.tags?.splitIndex as number);
    totals.set(id, log.tags?.splitTotal as number);
  }
  expect(groups.size, 'expected at least one split group in this run').toBeGreaterThan(0);
  for (const [id, seen] of groups) {
    expect(seen.size, `split group ${id} arrived fragmented`).toBe(totals.get(id));
  }
}

describe('SafeGuard 不能把拆分组打散', () => {
  let logger: AemeathLogger;

  beforeEach(() => {
    logger = new AemeathLogger({ enableConsole: false });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    logger.destroy();
    vi.mocked(console.warn).mockRestore();
  });

  it('限流真的开始丢日志时，拆分组要么整组发出，要么整组不发', async () => {
    const received: LogEntry[] = [];
    const upload = new UploadPlugin({
      onUpload: (async (log: LogEntry): Promise<UploadResult> => {
        received.push(log);
        return { success: true };
      }) as never,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });

    logger.use(new SafeGuardPlugin({ rateLimit: 2 }));
    logger.use(new PayloadSanitizePlugin({ maxBytes: 2000 }));
    logger.use(upload);

    // 同一条消息重复打：SafeGuard 的合并窗口会真的开始丢弃，
    // 而不是像不同消息那样每条都当"首次出现"放行
    for (let i = 0; i < 12; i++) {
      logger.error('hot loop message', { context: fatContext() });
    }
    await upload.flush();

    // 确实丢了一部分（否则这个用例没有验证力）
    expect(received.length).toBeLessThan(12 * 3);
    expectNoFragmentedGroups(received);
  });

  it('熔断打开后整条日志都不进来，不会留下半组分片', async () => {
    const received: LogEntry[] = [];
    const upload = new UploadPlugin({
      onUpload: (async (log: LogEntry): Promise<UploadResult> => {
        received.push(log);
        return { success: true };
      }) as never,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });

    const guard = new SafeGuardPlugin({ rateLimit: 1, mode: 'strict' });
    logger.use(guard);
    logger.use(new PayloadSanitizePlugin({ maxBytes: 2000 }));
    logger.use(upload);

    for (let i = 0; i < 30; i++) {
      logger.error('burst', { context: fatContext() });
    }
    await upload.flush();

    expectNoFragmentedGroups(received);
  });

  it('拆分不消耗额外的限流配额：限流看的是逻辑日志，不是分片', async () => {
    const seen = new Set<string>();
    const upload = new UploadPlugin({
      onUpload: (async (log: LogEntry): Promise<UploadResult> => {
        seen.add(log.message);
        return { success: true };
      }) as never,
      queue: { offlinePolicy: 'pause', deduplicationDelay: 0 },
      cache: { enabled: false },
      saveOnUnload: false,
    });

    logger.use(new SafeGuardPlugin({ rateLimit: 3 }));
    logger.use(new PayloadSanitizePlugin({ maxBytes: 2000 }));
    logger.use(upload);

    // 三条内容各异、且都会被拆成 3 片的日志。若限流按分片计数（9 > 3），
    // 后两条会整条消失
    for (let i = 0; i < 3; i++) {
      logger.error(`quota-${i}`, { context: fatContext() });
    }
    await upload.flush();

    expect(seen.size).toBe(3);
  });
});
