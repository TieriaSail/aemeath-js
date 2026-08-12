/**
 * OfflineStore 与可选 IndexedDB 协调驱动共享的私有实现。
 *
 * 本文件没有 package entry，不构成公共 API。
 */

import type { LogEntry } from '../../types';
import { getSdkSplitId } from '../../utils/splitIdentity';
import type {
  CoordinatorRecord,
  LeadershipRequest,
  LeasedRecordFence,
  OfflineRecord,
  OfflineRecordMeta,
  OfflineRecordState,
  OfflineStore,
  SplitDeliveryProgress,
} from './CoordinatedOfflineStore';

export const IDB_RECORDS_STORE_NAME = 'records-v2';
export const IDB_COORDINATION_STORE_NAME = 'coordination-v2';
export const IDB_SPLIT_PROGRESS_STORE_NAME = 'split-progress-v2';
export const IDB_NAMESPACE_STORE_NAME = 'namespace-v2';
export const MAX_LEADER_LEASE_MS = 60_000;
export const MAX_RECORD_LEASE_MS = 5 * 60_000;

let fallbackLeaseTokenCounter = 0;

export function createLeaseToken(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    /* fall through to a process-local unique token */
  }
  fallbackLeaseTokenCounter = (fallbackLeaseTokenCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${fallbackLeaseTokenCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

export function splitProgressId(namespace: string, splitId: string): string {
  return `${namespace.length}:${namespace}${splitId}`;
}

export function validCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function validTimestamp(value: unknown): value is number {
  return Number.isFinite(value) && (value as number) >= 0;
}

export function isSplitDeliveryProgress(
  value: unknown,
  namespace?: string,
  splitId?: string,
): value is SplitDeliveryProgress {
  if (value == null || typeof value !== 'object') return false;
  const progress = value as Partial<SplitDeliveryProgress>;
  return typeof progress.id === 'string'
    && typeof progress.namespace === 'string'
    && typeof progress.splitId === 'string'
    && (namespace === undefined || progress.namespace === namespace)
    && (splitId === undefined || progress.splitId === splitId)
    && Number.isSafeInteger(progress.splitTotal)
    && progress.splitTotal! > 0
    && progress.complete === true
    && Array.isArray(progress.deliveredIndices)
    && progress.deliveredIndices.every((index) =>
      Number.isSafeInteger(index) && index > 0 && index <= progress.splitTotal!)
    && new Set(progress.deliveredIndices).size === progress.deliveredIndices.length
    && validTimestamp(progress.updatedAt);
}

export function leaseDeadline(now: number, leaseMs: number, maximum: number): number {
  if (!validTimestamp(now) || !Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new Error('invalid coordination lease deadline');
  }
  return now + Math.min(Math.max(1, Math.floor(leaseMs)), maximum);
}

export function normalizeOfflineRecord(record: OfflineRecord): OfflineRecord {
  const nextEligibleAt = Math.max(
    validTimestamp(record.nextEligibleAt) ? record.nextEligibleAt : 0,
    validTimestamp(record.notBefore) ? record.notBefore : 0,
    validTimestamp(record.serverNotBefore) ? record.serverNotBefore : 0,
  );
  let state: OfflineRecordState = record.state === 'leased'
    || record.state === 'parked'
    || record.state === 'pending'
    ? record.state
    : validCounter(record.parkCount) && record.parkCount > 0
      ? 'parked'
      : 'pending';
  const hasCompleteLease = typeof record.leaseOwner === 'string'
    && record.leaseOwner.length > 0
    && typeof record.leaseToken === 'string'
    && record.leaseToken.length > 0
    && validTimestamp(record.leaseUntil)
    && validCounter(record.leaderEpoch)
    && record.leaderEpoch > 0;
  if (state === 'leased' && !hasCompleteLease) state = 'pending';
  return {
    ...record,
    schemaVersion: 2,
    replayAttempts: validCounter(record.replayAttempts) ? record.replayAttempts : 0,
    deliveryAttempt: validCounter(record.deliveryAttempt) ? record.deliveryAttempt : 0,
    state,
    nextEligibleAt,
    leaseOwner: state === 'leased' ? record.leaseOwner : undefined,
    leaseToken: state === 'leased' ? record.leaseToken : undefined,
    leaseUntil: state === 'leased' ? record.leaseUntil : undefined,
    leaderEpoch: state === 'leased' ? record.leaderEpoch : undefined,
  };
}
export function isOfflineRecordMeta(value: unknown): value is OfflineRecordMeta {
  if (value == null || typeof value !== 'object') return false;
  const meta = value as Partial<OfflineRecordMeta>;
  return typeof meta.logId === 'string'
    && meta.logId.length > 0
    && Number.isFinite(meta.storedAt)
    && meta.storedAt! >= 0
    && Number.isFinite(meta.capturedAt)
    && meta.capturedAt! >= 0
    && Number.isFinite(meta.priority)
    && Number.isSafeInteger(meta.bytes)
    && meta.bytes! >= 0
    && Number.isSafeInteger(meta.replayAttempts)
    && meta.replayAttempts! >= 0
    && (meta.schemaVersion === undefined || meta.schemaVersion === 2)
    && (meta.deliveryAttempt === undefined || validCounter(meta.deliveryAttempt))
    && (meta.state === undefined
      || meta.state === 'pending'
      || meta.state === 'leased'
      || meta.state === 'parked')
    && (meta.nextEligibleAt === undefined || validTimestamp(meta.nextEligibleAt))
    && (meta.leaseOwner === undefined || typeof meta.leaseOwner === 'string')
    && (meta.leaseToken === undefined || typeof meta.leaseToken === 'string')
    && (meta.leaseUntil === undefined || validTimestamp(meta.leaseUntil))
    && (meta.leaderEpoch === undefined || validCounter(meta.leaderEpoch))
    && (meta.splitId === undefined || meta.splitId === null || typeof meta.splitId === 'string')
    && (meta.notBefore === undefined || Number.isFinite(meta.notBefore))
    && (meta.serverNotBefore === undefined || Number.isFinite(meta.serverNotBefore))
    && (meta.parkCount === undefined
      || (Number.isSafeInteger(meta.parkCount) && meta.parkCount >= 0))
    && (meta.lastRetryReason === undefined || typeof meta.lastRetryReason === 'string')
    && (meta.terminal === undefined || typeof meta.terminal === 'boolean');
}

export function isOfflineRecord(value: unknown, expectedLogId?: string): value is OfflineRecord {
  if (value == null || typeof value !== 'object') return false;
  const record = value as Partial<OfflineRecord>;
  if (!isOfflineRecordMeta(record)) return false;
  const recordWithLog = value as Partial<OfflineRecord>;
  if (
    (expectedLogId !== undefined && record.logId !== expectedLogId) ||
    recordWithLog.log == null ||
    typeof recordWithLog.log !== 'object'
  ) {
    return false;
  }
  const log = recordWithLog.log as Partial<LogEntry>;
  const logSplitId = getSdkSplitId(log as LogEntry);
  const rawBusinessSplitId = log.tags && typeof log.tags === 'object'
    ? (log.tags as Record<string, unknown>)['splitId']
    : undefined;
  // 兼容旧版本把裸业务 splitId 冗余进 record.splitId 的副本；hydrate 会把它
  // 规范化为 null。新写入只有真正带坐标的 SDK 分片才允许非空 splitId。
  const legacyBareSplit = logSplitId === undefined
    && rawBusinessSplitId !== undefined
    && record.splitId === String(rawBusinessSplitId);
  const splitIdentityMatches = logSplitId === undefined
    ? record.splitId === undefined || record.splitId === null || legacyBareSplit
    : record.splitId === undefined || record.splitId === logSplitId;
  return log.logId === record.logId
    && typeof log.message === 'string'
    && (log.level === 'debug'
      || log.level === 'info'
      || log.level === 'track'
      || log.level === 'warn'
      || log.level === 'error')
    && Number.isFinite(log.timestamp)
    && log.timestamp! >= 0
    && record.capturedAt === log.timestamp
    && splitIdentityMatches
    && (log.requestId === undefined || typeof log.requestId === 'string')
    && (log.tags === undefined || (log.tags !== null && typeof log.tags === 'object'));
}

export function isCoordinatorRecord(value: unknown, namespace?: string): value is CoordinatorRecord {
  if (value == null || typeof value !== 'object') return false;
  const record = value as Partial<CoordinatorRecord>;
  return record.protocolVersion === 2
    && typeof record.namespace === 'string'
    && record.namespace.length > 0
    && (namespace === undefined || record.namespace === namespace)
    && typeof record.ownerId === 'string'
    && validCounter(record.epoch)
    && record.epoch > 0
    && validTimestamp(record.leaseUntil)
    && validTimestamp(record.heartbeatAt);
}
export function assertLeadershipRequest(request: LeadershipRequest): void {
  if (
    typeof request.namespace !== 'string'
    || request.namespace.length === 0
    || typeof request.ownerId !== 'string'
    || request.ownerId.length === 0
    || !validTimestamp(request.now)
  ) {
    throw new Error('invalid coordination leadership request');
  }
  leaseDeadline(request.now, request.leaseMs, MAX_LEADER_LEASE_MS);
}

export function ownsLease(record: OfflineRecord, request: LeasedRecordFence): boolean {
  return record.state === 'leased'
    && record.logId === request.logId
    && record.leaseOwner === request.ownerId
    && record.leaseToken === request.leaseToken
    && record.leaderEpoch === request.epoch;
}
export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * 可选协调插件取得同一 IDB 连接的内部能力。WeakMap 避免把数据库句柄暴露在
 * OfflineStore 公共对象上；没有显式导入协调插件时，租约实现可被构建器删除。
 */
export interface IndexedDbStoreContext {
  withStores<T>(
    storeNames: readonly string[],
    mode: IDBTransactionMode,
    run: (tx: IDBTransaction) => Promise<T> | T,
  ): Promise<T>;
  withRecordStore<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => Promise<T> | T,
  ): Promise<T>;
}

const INDEXED_DB_STORE_CONTEXTS = new WeakMap<OfflineStore, IndexedDbStoreContext>();

export function getIndexedDbStoreContext(store: OfflineStore): IndexedDbStoreContext | null {
  return INDEXED_DB_STORE_CONTEXTS.get(store) ?? null;
}

export function setIndexedDbStoreContext(
  store: OfflineStore,
  context: IndexedDbStoreContext,
): void {
  INDEXED_DB_STORE_CONTEXTS.set(store, context);
}

export function deleteIndexedDbStoreContext(store: OfflineStore): void {
  INDEXED_DB_STORE_CONTEXTS.delete(store);
}
