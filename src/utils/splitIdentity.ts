import type { LogEntry } from '../types';

/**
 * 返回 SDK 原子分片的稳定身份。
 *
 * `tags.splitId` 本身仍可作为普通业务关联标签。只有同时出现任一分片坐标时，
 * Logger、Upload、Offline 与持久层才会把它解释为需要全有或全无处理的 SDK 分片。
 * 坐标是否合法由队列准入/完整性校验负责；这里仅统一身份判定边界。
 */
export function getSdkSplitId(log: Pick<LogEntry, 'tags'>): string | undefined {
  const splitId = log.tags?.splitId;
  const hasCoordinates = log.tags?.splitIndex !== undefined
    || log.tags?.splitTotal !== undefined;
  return splitId === undefined || !hasCoordinates ? undefined : String(splitId);
}
