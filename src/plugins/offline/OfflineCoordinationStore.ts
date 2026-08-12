/**
 * IndexedDB 强协调驱动。
 *
 * 只有 CrossTabDeliveryPlugin 导入本模块。默认 OfflinePersistence 和小程序入口
 * 不引用它，因此 leader/lease/fencing 实现可被 tree-shaking。
 */

import { getSdkSplitId } from '../../utils/splitIdentity';
import {
  mergePendingRecord,
  type CoordinatorRecord,
  type LeasedOfflineRecord,
  type OfflineCoordinationStore,
  type OfflineRecord,
  type OfflineStore,
  type SplitDeliveryProgress,
} from './CoordinatedOfflineStore';
import {
  IDB_COORDINATION_STORE_NAME,
  IDB_RECORDS_STORE_NAME,
  IDB_SPLIT_PROGRESS_STORE_NAME,
  MAX_LEADER_LEASE_MS,
  MAX_RECORD_LEASE_MS,
  assertLeadershipRequest,
  createLeaseToken,
  getIndexedDbStoreContext,
  isCoordinatorRecord,
  isOfflineRecord,
  isSplitDeliveryProgress,
  leaseDeadline,
  normalizeOfflineRecord,
  ownsLease,
  requestToPromise,
  splitProgressId,
  validCounter,
  validTimestamp,
} from './OfflineStoreInternals';

export function createOfflineCoordinationStore(store: OfflineStore): OfflineCoordinationStore {
  if (store.backend !== 'indexeddb') {
    throw new Error('cross-tab delivery requires an IndexedDB offline store');
  }
  const context = getIndexedDbStoreContext(store);
  if (!context) {
    throw new Error('offline IndexedDB store is closed or does not support coordination');
  }
  const { withStores, withRecordStore } = context;
  const coordination: OfflineCoordinationStore = {
    mode: 'strong',
  
    getLeadership(namespace) {
      if (typeof namespace !== 'string' || namespace.length === 0) {
        return Promise.reject(new Error('invalid coordination namespace'));
      }
      return withStores([IDB_COORDINATION_STORE_NAME], 'readonly', async (tx) => {
        const value = await requestToPromise<unknown>(
          tx.objectStore(IDB_COORDINATION_STORE_NAME).get(namespace),
        );
        if (value === undefined) return null;
        if (!isCoordinatorRecord(value, namespace)) {
          throw new Error('offline coordinator record is corrupted');
        }
        return value;
      });
    },
  
    tryAcquireLeadership(request) {
      try {
        assertLeadershipRequest(request);
      } catch (error) {
        return Promise.reject(error);
      }
      return withStores([IDB_COORDINATION_STORE_NAME], 'readwrite', async (tx) => {
        const store = tx.objectStore(IDB_COORDINATION_STORE_NAME);
        const value = await requestToPromise<unknown>(store.get(request.namespace));
        let current: CoordinatorRecord | null = null;
        if (value !== undefined) {
          if (!isCoordinatorRecord(value, request.namespace)) {
            throw new Error('offline coordinator record is corrupted');
          }
          current = value;
        }
        const leaseIsPlausible = current !== null
          && current.leaseUntil <= request.now + MAX_LEADER_LEASE_MS;
        if (current && leaseIsPlausible && current.leaseUntil > request.now) {
          return current.ownerId === request.ownerId ? current : null;
        }
        const nextEpoch = (current?.epoch ?? 0) + 1;
        if (!Number.isSafeInteger(nextEpoch)) {
          throw new Error('offline coordinator epoch exhausted');
        }
        const next: CoordinatorRecord = {
          namespace: request.namespace,
          protocolVersion: 2,
          ownerId: request.ownerId,
          epoch: nextEpoch,
          leaseUntil: leaseDeadline(request.now, request.leaseMs, MAX_LEADER_LEASE_MS),
          heartbeatAt: request.now,
        };
        await requestToPromise(store.put(next));
        return next;
      });
    },
  
    renewLeadership(request) {
      try {
        assertLeadershipRequest(request);
        if (!validCounter(request.epoch) || request.epoch <= 0) {
          throw new Error('invalid coordination epoch');
        }
      } catch (error) {
        return Promise.reject(error);
      }
      return withStores([IDB_COORDINATION_STORE_NAME], 'readwrite', async (tx) => {
        const store = tx.objectStore(IDB_COORDINATION_STORE_NAME);
        const value = await requestToPromise<unknown>(store.get(request.namespace));
        if (value === undefined) return false;
        if (!isCoordinatorRecord(value, request.namespace)) {
          throw new Error('offline coordinator record is corrupted');
        }
        if (
          value.ownerId !== request.ownerId
          || value.epoch !== request.epoch
          || value.leaseUntil <= request.now
          || value.leaseUntil > request.now + MAX_LEADER_LEASE_MS
        ) {
          return false;
        }
        const next: CoordinatorRecord = {
          ...value,
          heartbeatAt: request.now,
          leaseUntil: leaseDeadline(request.now, request.leaseMs, MAX_LEADER_LEASE_MS),
        };
        await requestToPromise(store.put(next));
        return true;
      });
    },
  
    releaseLeadership(request) {
      if (
        typeof request.namespace !== 'string'
        || request.namespace.length === 0
        || typeof request.ownerId !== 'string'
        || request.ownerId.length === 0
        || !validCounter(request.epoch)
        || request.epoch <= 0
        || !validTimestamp(request.now)
      ) {
        return Promise.reject(new Error('invalid coordination release request'));
      }
      return withStores([IDB_COORDINATION_STORE_NAME], 'readwrite', async (tx) => {
        const store = tx.objectStore(IDB_COORDINATION_STORE_NAME);
        const value = await requestToPromise<unknown>(store.get(request.namespace));
        if (value === undefined) return false;
        if (!isCoordinatorRecord(value, request.namespace)) {
          throw new Error('offline coordinator record is corrupted');
        }
        if (value.ownerId !== request.ownerId || value.epoch !== request.epoch) return false;
        await requestToPromise(store.put({ ...value, leaseUntil: 0, heartbeatAt: request.now }));
        return true;
      });
    },
  
    claimBatch(request) {
      try {
        assertLeadershipRequest({
          namespace: request.namespace,
          ownerId: request.ownerId,
          now: request.now,
          leaseMs: request.leaseMs,
        });
        if (!validCounter(request.epoch) || request.epoch <= 0) {
          throw new Error('invalid coordination epoch');
        }
        if (!Number.isSafeInteger(request.limit) || request.limit <= 0) {
          throw new Error('invalid coordination claim limit');
        }
        const seen = new Set<string>();
        for (const group of request.candidateGroups) {
          if (group.length === 0) throw new Error('coordination claim group cannot be empty');
          for (const logId of group) {
            if (typeof logId !== 'string' || logId.length === 0 || seen.has(logId)) {
              throw new Error('coordination claim candidates must contain unique logIds');
            }
            seen.add(logId);
          }
        }
      } catch (error) {
        return Promise.reject(error);
      }
      const limit = Math.max(
        request.limit,
        ...request.candidateGroups.map((group) => group.length),
      );
      return withStores(
        [IDB_COORDINATION_STORE_NAME, IDB_RECORDS_STORE_NAME],
        'readwrite',
        async (tx) => {
          const coordinatorStore = tx.objectStore(IDB_COORDINATION_STORE_NAME);
          const recordsStore = tx.objectStore(IDB_RECORDS_STORE_NAME);
          const leaderValue = await requestToPromise<unknown>(
            coordinatorStore.get(request.namespace),
          );
          if (leaderValue === undefined) {
            return { status: 'not-leader', records: [], expiredLeaseRecoveries: 0 };
          }
          if (!isCoordinatorRecord(leaderValue, request.namespace)) {
            throw new Error('offline coordinator record is corrupted');
          }
          if (
            leaderValue.ownerId !== request.ownerId
            || leaderValue.epoch !== request.epoch
            || leaderValue.leaseUntil <= request.now
            || leaderValue.leaseUntil > request.now + MAX_LEADER_LEASE_MS
          ) {
            return { status: 'not-leader', records: [], expiredLeaseRecoveries: 0 };
          }
  
          const claimed: LeasedOfflineRecord[] = [];
          let expiredLeaseRecoveries = 0;
          for (const group of request.candidateGroups) {
            if (claimed.length + group.length > limit) continue;
            const values = await Promise.all(
              group.map((logId) => requestToPromise<unknown>(recordsStore.get(logId))),
            );
            if (values.some((value) => value === undefined)) continue;
            const records: OfflineRecord[] = [];
            let claimable = true;
            let groupExpiredRecoveries = 0;
            for (let index = 0; index < values.length; index++) {
              const value = values[index];
              const logId = group[index]!;
              if (!isOfflineRecord(value, logId)) {
                throw new Error(`offline IndexedDB record is corrupted: ${logId}`);
              }
              const normalized = normalizeOfflineRecord(value);
              if (normalized.terminal === true || (normalized.nextEligibleAt ?? 0) > request.now) {
                claimable = false;
                break;
              }
              if (value.state === 'leased') {
                const activeLease = typeof value.leaseOwner === 'string'
                  && value.leaseOwner.length > 0
                  && typeof value.leaseToken === 'string'
                  && value.leaseToken.length > 0
                  && validTimestamp(value.leaseUntil)
                  && value.leaseUntil > request.now
                  && value.leaseUntil <= request.now + MAX_RECORD_LEASE_MS
                  && validCounter(value.leaderEpoch)
                  && value.leaderEpoch > 0;
                if (activeLease) {
                  claimable = false;
                  break;
                }
                groupExpiredRecoveries++;
              }
              records.push(normalized);
            }
            if (!claimable || records.length !== group.length) continue;
  
            const leaseUntil = leaseDeadline(request.now, request.leaseMs, MAX_RECORD_LEASE_MS);
            const leased = records.map<LeasedOfflineRecord>((record) => ({
              ...record,
              schemaVersion: 2,
              deliveryAttempt: record.deliveryAttempt ?? 0,
              state: 'leased',
              nextEligibleAt: record.nextEligibleAt ?? 0,
              leaseOwner: request.ownerId,
              leaseToken: createLeaseToken(),
              leaseUntil,
              leaderEpoch: request.epoch,
            }));
            const writes = leased.map((record) => requestToPromise(recordsStore.put(record)));
            await Promise.all(writes);
            claimed.push(...leased);
            expiredLeaseRecoveries += groupExpiredRecoveries;
          }
          return { status: 'claimed', records: claimed, expiredLeaseRecoveries };
        },
      );
    },
  
    renewRecordLease(request) {
      let nextLeaseUntil: number;
      try {
        nextLeaseUntil = leaseDeadline(request.now, request.leaseMs, MAX_RECORD_LEASE_MS);
      } catch (error) {
        return Promise.reject(error);
      }
      return withStores(
        [IDB_COORDINATION_STORE_NAME, IDB_RECORDS_STORE_NAME],
        'readwrite',
        async (tx) => {
          const coordinatorStore = tx.objectStore(IDB_COORDINATION_STORE_NAME);
          const recordsStore = tx.objectStore(IDB_RECORDS_STORE_NAME);
          const leader = await requestToPromise<unknown>(coordinatorStore.get(request.namespace));
          if (!isCoordinatorRecord(leader, request.namespace)) return false;
          if (
            leader.ownerId !== request.ownerId
            || leader.epoch !== request.epoch
            || leader.leaseUntil <= request.now
            || leader.leaseUntil > request.now + MAX_LEADER_LEASE_MS
          ) {
            return false;
          }
          const value = await requestToPromise<unknown>(recordsStore.get(request.logId));
          if (!isOfflineRecord(value, request.logId)) return false;
          const record = normalizeOfflineRecord(value);
          if (!ownsLease(record, request)) return false;
          await requestToPromise(recordsStore.put({ ...record, leaseUntil: nextLeaseUntil }));
          return true;
        },
      );
    },
  
    incrementDeliveryAttempt(request) {
      if (!validTimestamp(request.now)) {
        return Promise.reject(new Error('invalid delivery attempt timestamp'));
      }
      return withStores(
        [IDB_COORDINATION_STORE_NAME, IDB_RECORDS_STORE_NAME],
        'readwrite',
        async (tx) => {
          const coordinatorStore = tx.objectStore(IDB_COORDINATION_STORE_NAME);
          const recordsStore = tx.objectStore(IDB_RECORDS_STORE_NAME);
          const leader = await requestToPromise<unknown>(coordinatorStore.get(request.namespace));
          if (!isCoordinatorRecord(leader, request.namespace)) return null;
          if (
            leader.ownerId !== request.ownerId
            || leader.epoch !== request.epoch
            || leader.leaseUntil <= request.now
            || leader.leaseUntil > request.now + MAX_LEADER_LEASE_MS
          ) {
            return null;
          }
          const value = await requestToPromise<unknown>(recordsStore.get(request.logId));
          if (!isOfflineRecord(value, request.logId)) return null;
          const record = normalizeOfflineRecord(value);
          if (!ownsLease(record, request)) return null;
          const deliveryAttempt = (record.deliveryAttempt ?? 0) + 1;
          if (!Number.isSafeInteger(deliveryAttempt)) {
            throw new Error('delivery attempt counter exhausted');
          }
          await requestToPromise(recordsStore.put({ ...record, deliveryAttempt }));
          return deliveryAttempt;
        },
      );
    },
  
    updateLeasedRecord(request) {
      if (
        !validTimestamp(request.nextEligibleAt)
        || (request.serverNotBefore !== undefined && !validTimestamp(request.serverNotBefore))
      ) {
        return Promise.reject(new Error('invalid leased record schedule'));
      }
      return withRecordStore('readwrite', async (store) => {
        const value = await requestToPromise<unknown>(store.get(request.logId));
        if (!isOfflineRecord(value, request.logId)) return false;
        const record = normalizeOfflineRecord(value);
        if (!ownsLease(record, request)) return false;
        const nextEligibleAt = Math.max(
          record.nextEligibleAt ?? 0,
          request.nextEligibleAt,
          request.serverNotBefore ?? 0,
        );
        const replayAttempts = validCounter(request.replayAttempts)
          ? Math.max(record.replayAttempts, request.replayAttempts)
          : record.replayAttempts;
        await requestToPromise(store.put({
          ...record,
          nextEligibleAt,
          notBefore: Math.max(record.notBefore ?? 0, request.nextEligibleAt),
          serverNotBefore: Math.max(record.serverNotBefore ?? 0, request.serverNotBefore ?? 0)
            || undefined,
          replayAttempts,
          lastRetryReason: request.lastRetryReason ?? record.lastRetryReason,
        }));
        return true;
      });
    },
  
    releaseLeasedRecord(request) {
      if (
        !validTimestamp(request.nextEligibleAt)
        || (request.serverNotBefore !== undefined && !validTimestamp(request.serverNotBefore))
      ) {
        return Promise.reject(new Error('invalid next eligible timestamp'));
      }
      return withRecordStore('readwrite', async (store) => {
        const value = await requestToPromise<unknown>(store.get(request.logId));
        if (!isOfflineRecord(value, request.logId)) return false;
        const record = normalizeOfflineRecord(value);
        if (!ownsLease(record, request)) return false;
        const replayAttempts = validCounter(request.replayAttempts)
          ? Math.max(record.replayAttempts, request.replayAttempts)
          : record.replayAttempts;
        const parkCount = validCounter(request.parkCount)
          ? Math.max(record.parkCount ?? 0, request.parkCount)
          : record.parkCount;
        await requestToPromise(store.put({
          ...record,
          state: request.state,
          nextEligibleAt: request.nextEligibleAt,
          notBefore: Math.max(record.notBefore ?? 0, request.nextEligibleAt),
          serverNotBefore: Math.max(record.serverNotBefore ?? 0, request.serverNotBefore ?? 0)
            || undefined,
          replayAttempts,
          parkCount,
          lastRetryReason: request.lastRetryReason ?? record.lastRetryReason,
          leaseOwner: undefined,
          leaseToken: undefined,
          leaseUntil: undefined,
          leaderEpoch: undefined,
        }));
        return true;
      });
    },
  
    deleteLeasedRecord(request) {
      return withStores(
        [IDB_RECORDS_STORE_NAME, IDB_SPLIT_PROGRESS_STORE_NAME],
        'readwrite',
        async (tx) => {
        const store = tx.objectStore(IDB_RECORDS_STORE_NAME);
        const value = await requestToPromise<unknown>(store.get(request.logId));
        if (!isOfflineRecord(value, request.logId)) return false;
        if (!ownsLease(normalizeOfflineRecord(value), request)) return false;
        await requestToPromise(store.delete(request.logId));
        const splitId = getSdkSplitId(value.log);
        if (splitId !== undefined) {
          await requestToPromise(
            tx.objectStore(IDB_SPLIT_PROGRESS_STORE_NAME)
              .delete(splitProgressId(request.namespace, splitId)),
          );
        }
        return true;
      });
    },

    mergePendingRecords(records) {
      if (records.length === 0) return Promise.resolve([]);
      let normalized: OfflineRecord[];
      try {
        normalized = records.map((record) => {
          if (!isOfflineRecord(record)) {
            throw new Error('invalid coordinated pending record');
          }
          return normalizeOfflineRecord(record);
        });
        const ids = new Set(normalized.map((record) => record.logId));
        if (ids.size !== normalized.length) {
          throw new Error('coordinated pending batch contains duplicate logIds');
        }
      } catch (error) {
        return Promise.reject(error);
      }
      return withRecordStore('readwrite', async (store) => {
        const currentValues = await Promise.all(
          normalized.map((record) =>
            requestToPromise<unknown>(store.get(record.logId)),
          ),
        );
        const merged = normalized.map((record, index) => {
          const current = currentValues[index];
          if (current === undefined) return record;
          if (!isOfflineRecord(current, record.logId)) {
            throw new Error(
              `offline IndexedDB record is corrupted: ${record.logId}`,
            );
          }
          return mergePendingRecord(current, record);
        });
        await Promise.all(
          merged.map((record) => requestToPromise(store.put(record))),
        );
        return merged;
      });
    },

    deleteUnleasedGroup(namespace, logIds, now) {
      if (
        typeof namespace !== 'string' ||
        namespace.length === 0 ||
        logIds.length === 0 ||
        new Set(logIds).size !== logIds.length ||
        logIds.some((logId) => typeof logId !== 'string' || logId.length === 0) ||
        !validTimestamp(now)
      ) {
        return Promise.reject(new Error('invalid unleased record group request'));
      }
      return withStores(
        [IDB_RECORDS_STORE_NAME, IDB_SPLIT_PROGRESS_STORE_NAME],
        'readwrite',
        async (tx) => {
          const recordsStore = tx.objectStore(IDB_RECORDS_STORE_NAME);
          const progressStore = tx.objectStore(IDB_SPLIT_PROGRESS_STORE_NAME);
          const values = await Promise.all(
            logIds.map((logId) =>
              requestToPromise<unknown>(recordsStore.get(logId)),
            ),
          );
          // 分组删除是全有或全无。候选快照过期时由调用方重新扫描事实源。
          if (values.some((value) => value === undefined)) return [];
          const current: OfflineRecord[] = [];
          for (let index = 0; index < values.length; index++) {
            const logId = logIds[index]!;
            const value = values[index];
            if (!isOfflineRecord(value, logId)) {
              throw new Error(`offline IndexedDB record is corrupted: ${logId}`);
            }
            const record = normalizeOfflineRecord(value);
            if (
              record.state === 'leased' &&
              (!validTimestamp(record.leaseUntil) || record.leaseUntil! > now)
            ) {
              return [];
            }
            current.push(record);
          }
          const splitIds = new Set<string>();
          for (const record of current) {
            await requestToPromise(recordsStore.delete(record.logId));
            const splitId = getSdkSplitId(record.log);
            if (splitId !== undefined) splitIds.add(splitId);
          }
          for (const splitId of splitIds) {
            await requestToPromise(
              progressStore.delete(splitProgressId(namespace, splitId)),
            );
          }
          return current;
        },
      );
    },

    deleteExpiredGroup(namespace, logIds, now, ttl) {
      if (
        typeof namespace !== 'string'
        || namespace.length === 0
        || logIds.length === 0
        || new Set(logIds).size !== logIds.length
        || logIds.some((logId) => typeof logId !== 'string' || logId.length === 0)
        || !validTimestamp(now)
        || !Number.isFinite(ttl)
        || ttl < 0
      ) {
        return Promise.reject(new Error('invalid expired record group request'));
      }
      return withStores(
        [IDB_RECORDS_STORE_NAME, IDB_SPLIT_PROGRESS_STORE_NAME],
        'readwrite',
        async (tx) => {
          const recordsStore = tx.objectStore(IDB_RECORDS_STORE_NAME);
          const progressStore = tx.objectStore(IDB_SPLIT_PROGRESS_STORE_NAME);
          const values = await Promise.all(
            logIds.map((logId) => requestToPromise<unknown>(recordsStore.get(logId))),
          );
          if (values.some((value) => value === undefined)) return [];
          const records: OfflineRecord[] = [];
          for (let index = 0; index < values.length; index++) {
            const logId = logIds[index]!;
            const value = values[index];
            if (!isOfflineRecord(value, logId)) {
              throw new Error(`offline IndexedDB record is corrupted: ${logId}`);
            }
            const record = normalizeOfflineRecord(value);
            const expired = record.storedAt > now + 5 * 60 * 1000
              || now - record.storedAt >= ttl;
            if (!expired) return [];
            if (
              record.state === 'leased'
              && validTimestamp(record.leaseUntil)
              && record.leaseUntil! > now
            ) {
              return [];
            }
            records.push(record);
          }
          const splitIds = new Set<string>();
          for (const record of records) {
            await requestToPromise(recordsStore.delete(record.logId));
            const splitId = getSdkSplitId(record.log);
            if (splitId !== undefined) splitIds.add(splitId);
          }
          for (const splitId of splitIds) {
            await requestToPromise(progressStore.delete(splitProgressId(namespace, splitId)));
          }
          return records;
        },
      );
    },

    deleteDelivered(namespace, logId) {
      if (
        typeof namespace !== 'string' || namespace.length === 0
        || typeof logId !== 'string' || logId.length === 0
      ) {
        return Promise.reject(new Error('invalid delivered logId'));
      }
      return withStores(
        [IDB_RECORDS_STORE_NAME, IDB_SPLIT_PROGRESS_STORE_NAME],
        'readwrite',
        async (tx) => {
        const store = tx.objectStore(IDB_RECORDS_STORE_NAME);
        const value = await requestToPromise<unknown>(store.get(logId));
        if (value === undefined) return false;
        if (!isOfflineRecord(value, logId)) {
          throw new Error(`offline IndexedDB record is corrupted: ${logId}`);
        }
        const splitId = getSdkSplitId(value.log);
        if (splitId !== undefined) {
          const splitIndex = Number(value.log.tags?.splitIndex);
          const splitTotal = Number(value.log.tags?.splitTotal);
          if (
            !Number.isSafeInteger(splitIndex)
            || !Number.isSafeInteger(splitTotal)
            || splitIndex <= 0
            || splitTotal <= 0
            || splitIndex > splitTotal
          ) {
            throw new Error('delivered split record has invalid coordinates');
          }
          const progressStore = tx.objectStore(IDB_SPLIT_PROGRESS_STORE_NAME);
          const id = splitProgressId(namespace, splitId);
          const raw = await requestToPromise<unknown>(progressStore.get(id));
          let deliveredIndices: number[] = [];
          if (raw !== undefined) {
            if (!isSplitDeliveryProgress(raw, namespace, splitId) || raw.splitTotal !== splitTotal) {
              throw new Error('split delivery progress is corrupted');
            }
            deliveredIndices = raw.deliveredIndices;
          }
          const nextIndices = Array.from(new Set([...deliveredIndices, splitIndex]))
            .sort((a, b) => a - b);
          if (nextIndices.length < splitTotal) {
            await requestToPromise(progressStore.put({
              id,
              namespace,
              splitId,
              splitTotal,
              complete: true,
              deliveredIndices: nextIndices,
              updatedAt: Date.now(),
            } satisfies SplitDeliveryProgress));
          } else {
            await requestToPromise(progressStore.delete(id));
          }
        }
        await requestToPromise(store.delete(logId));
        return true;
      });
    },
  
    getSplitProgress(namespace, splitId) {
      if (!namespace || !splitId) return Promise.reject(new Error('invalid split progress key'));
      return withStores([IDB_SPLIT_PROGRESS_STORE_NAME], 'readonly', async (tx) => {
        const raw = await requestToPromise<unknown>(
          tx.objectStore(IDB_SPLIT_PROGRESS_STORE_NAME).get(splitProgressId(namespace, splitId)),
        );
        if (raw === undefined) return null;
        if (!isSplitDeliveryProgress(raw, namespace, splitId)) {
          throw new Error('split delivery progress is corrupted');
        }
        return raw;
      });
    },
  
    markSplitComplete(namespace, splitId, splitTotal) {
      if (!namespace || !splitId || !Number.isSafeInteger(splitTotal) || splitTotal <= 0) {
        return Promise.reject(new Error('invalid complete split group'));
      }
      return withStores([IDB_SPLIT_PROGRESS_STORE_NAME], 'readwrite', async (tx) => {
        const store = tx.objectStore(IDB_SPLIT_PROGRESS_STORE_NAME);
        const id = splitProgressId(namespace, splitId);
        const raw = await requestToPromise<unknown>(store.get(id));
        if (raw !== undefined) {
          if (!isSplitDeliveryProgress(raw, namespace, splitId) || raw.splitTotal !== splitTotal) {
            throw new Error('split delivery progress conflicts with complete group');
          }
          return;
        }
        await requestToPromise(store.put({
          id,
          namespace,
          splitId,
          splitTotal,
          complete: true,
          deliveredIndices: [],
          updatedAt: Date.now(),
        } satisfies SplitDeliveryProgress));
      });
    },
  
    clearSplitProgress(namespace, splitId) {
      if (!namespace || !splitId) return Promise.reject(new Error('invalid split progress key'));
      return withStores([IDB_SPLIT_PROGRESS_STORE_NAME], 'readwrite', (tx) =>
        requestToPromise(
          tx.objectStore(IDB_SPLIT_PROGRESS_STORE_NAME)
            .delete(splitProgressId(namespace, splitId)),
        ).then(() => undefined));
    },
  };
  return coordination;
}
