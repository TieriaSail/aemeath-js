import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  createIndexedDbStore,
  createOfflineStore as createCoordinatedOfflineStore,
  type OfflineCoordinationStore,
  type OfflineRecord,
  type OfflineStore,
} from '../src/plugins/offline/CoordinatedOfflineStore';
import { createOfflineCoordinationStore } from '../src/plugins/offline/OfflineCoordinationStore';
import { coordinatedDatabaseName } from '../src/plugins/offline/OfflineProtocol';
import { createNoopAdapter } from '../src/platform/noop';
import { LogLevel } from '../src/types';

function makeRecord(logId: string, now = 1_000): OfflineRecord {
  return {
    logId,
    storedAt: now,
    capturedAt: now,
    priority: 1,
    bytes: 100,
    replayAttempts: 0,
    log: {
      logId,
      level: LogLevel.ERROR,
      message: logId,
      timestamp: now,
    },
  };
}

type CoordinatedStore = OfflineStore & {
  coordination: OfflineCoordinationStore;
};

function withCoordination(store: OfflineStore): CoordinatedStore {
  return Object.assign(store, {
    coordination: createOfflineCoordinationStore(store),
  });
}

async function createPair(): Promise<[CoordinatedStore, CoordinatedStore]> {
  const dbName = `coordination-${Math.random()}`;
  const stores = await Promise.all([
    createIndexedDbStore(dbName),
    createIndexedDbStore(dbName),
  ]);
  return [withCoordination(stores[0]), withCoordination(stores[1])];
}

describe('OfflineStore v2 cross-tab coordination protocol', () => {
  beforeEach(() => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it('serializes concurrent leader election and preserves a monotonic epoch after release', async () => {
    const [tabA, tabB] = await createPair();
    const now = 10_000;
    const [leaderA, leaderB] = await Promise.all([
      tabA.coordination!.tryAcquireLeadership({
        namespace: 'project-a',
        ownerId: 'tab-a',
        now,
        leaseMs: 15_000,
      }),
      tabB.coordination!.tryAcquireLeadership({
        namespace: 'project-a',
        ownerId: 'tab-b',
        now,
        leaseMs: 15_000,
      }),
    ]);
    const elected = [leaderA, leaderB].filter((leader) => leader !== null);
    expect(elected).toHaveLength(1);
    expect(elected[0]!.epoch).toBe(1);

    const winner = elected[0]!;
    const winnerStore = winner.ownerId === 'tab-a' ? tabA : tabB;
    const followerStore = winner.ownerId === 'tab-a' ? tabB : tabA;
    await expect(
      winnerStore.coordination!.releaseLeadership({
        namespace: 'project-a',
        ownerId: winner.ownerId,
        epoch: winner.epoch,
        now: now + 1,
      }),
    ).resolves.toBe(true);
    const successor = await followerStore.coordination!.tryAcquireLeadership({
      namespace: 'project-a',
      ownerId: winner.ownerId === 'tab-a' ? 'tab-b' : 'tab-a',
      now: now + 2,
      leaseMs: 15_000,
    });
    expect(successor?.epoch).toBe(2);

    tabA.close();
    tabB.close();
  });

  it('persistently binds one physical IndexedDB resource to one delivery namespace', async () => {
    const dbName = `namespace-binding-${Math.random()}`;
    const projectA = await createIndexedDbStore(dbName, 'project-a');

    await expect(createIndexedDbStore(dbName, 'project-b')).rejects.toThrow(
      /already bound to namespace "project-a"/,
    );
    await projectA.clear();
    projectA.close();

    // clear 只清投递状态，不解除项目身份；否则另一个标签可在原项目仍活跃时抢占库。
    await expect(createIndexedDbStore(dbName, 'project-b')).rejects.toThrow(
      /already bound to namespace "project-a"/,
    );
    const reopened = await createIndexedDbStore(dbName, 'project-a');
    reopened.close();
  });

  it('claims complete groups atomically and never returns an actively leased sibling group', async () => {
    const [tabA, tabB] = await createPair();
    await Promise.all([
      tabA.put(makeRecord('split-1')),
      tabA.put(makeRecord('split-2')),
      tabA.put(makeRecord('single')),
    ]);
    const leader = await tabA.coordination!.tryAcquireLeadership({
      namespace: 'project-a',
      ownerId: 'tab-a',
      now: 2_000,
      leaseMs: 15_000,
    });
    expect(leader).not.toBeNull();

    const first = await tabA.coordination!.claimBatch({
      namespace: 'project-a',
      ownerId: 'tab-a',
      epoch: leader!.epoch,
      now: 2_000,
      leaseMs: 60_000,
      limit: 2,
      candidateGroups: [['split-1', 'split-2'], ['single']],
    });
    expect(first.status).toBe('claimed');
    expect(first.records.map((record) => record.logId)).toEqual([
      'split-1',
      'split-2',
    ]);
    expect(new Set(first.records.map((record) => record.leaseToken)).size).toBe(
      2,
    );

    const second = await tabB.coordination!.claimBatch({
      namespace: 'project-a',
      ownerId: 'tab-b',
      epoch: leader!.epoch,
      now: 2_001,
      leaseMs: 60_000,
      limit: 3,
      candidateGroups: [['split-1', 'split-2'], ['single']],
    });
    expect(second).toEqual({
      status: 'not-leader',
      records: [],
      expiredLeaseRecoveries: 0,
    });

    const remaining = await tabA.coordination!.claimBatch({
      namespace: 'project-a',
      ownerId: 'tab-a',
      epoch: leader!.epoch,
      now: 2_001,
      leaseMs: 60_000,
      limit: 3,
      candidateGroups: [['split-1', 'split-2'], ['single']],
    });
    expect(remaining.records.map((record) => record.logId)).toEqual(['single']);

    tabA.close();
    tabB.close();
  });

  it('recovers an expired lease after leader takeover and fences the old callback', async () => {
    const [tabA, tabB] = await createPair();
    await tabA.put(makeRecord('crash-window'));
    const leaderA = await tabA.coordination!.tryAcquireLeadership({
      namespace: 'project-a',
      ownerId: 'tab-a',
      now: 5_000,
      leaseMs: 100,
    });
    const first = await tabA.coordination!.claimBatch({
      namespace: 'project-a',
      ownerId: 'tab-a',
      epoch: leaderA!.epoch,
      now: 5_000,
      leaseMs: 1_000,
      limit: 1,
      candidateGroups: [['crash-window']],
    });
    const oldLease = first.records[0]!;

    const leaderB = await tabB.coordination!.tryAcquireLeadership({
      namespace: 'project-a',
      ownerId: 'tab-b',
      now: 5_101,
      leaseMs: 15_000,
    });
    expect(leaderB?.epoch).toBe(2);
    const tooEarly = await tabB.coordination!.claimBatch({
      namespace: 'project-a',
      ownerId: 'tab-b',
      epoch: leaderB!.epoch,
      now: 5_999,
      leaseMs: 1_000,
      limit: 1,
      candidateGroups: [['crash-window']],
    });
    expect(tooEarly.records).toEqual([]);

    const recovered = await tabB.coordination!.claimBatch({
      namespace: 'project-a',
      ownerId: 'tab-b',
      epoch: leaderB!.epoch,
      now: 6_001,
      leaseMs: 1_000,
      limit: 1,
      candidateGroups: [['crash-window']],
    });
    expect(recovered.expiredLeaseRecoveries).toBe(1);
    expect(recovered.records).toHaveLength(1);
    expect(recovered.records[0]!.leaseToken).not.toBe(oldLease.leaseToken);

    await expect(
      tabA.coordination!.releaseLeasedRecord({
        namespace: 'project-a',
        ownerId: 'tab-a',
        epoch: leaderA!.epoch,
        logId: oldLease.logId,
        leaseToken: oldLease.leaseToken,
        state: 'parked',
        nextEligibleAt: 20_000,
      }),
    ).resolves.toBe(false);
    expect((await tabB.get('crash-window'))?.state).toBe('leased');

    tabA.close();
    tabB.close();
  });

  it('accepts a real success from any attempt but token-fences terminal failure', async () => {
    const [tabA, tabB] = await createPair();
    await tabA.put(makeRecord('uncertain-result'));
    const leader = await tabA.coordination!.tryAcquireLeadership({
      namespace: 'project-a',
      ownerId: 'tab-a',
      now: 8_000,
      leaseMs: 15_000,
    });
    const claim = await tabA.coordination!.claimBatch({
      namespace: 'project-a',
      ownerId: 'tab-a',
      epoch: leader!.epoch,
      now: 8_000,
      leaseMs: 1_000,
      limit: 1,
      candidateGroups: [['uncertain-result']],
    });
    const lease = claim.records[0]!;
    await expect(
      tabB.coordination!.deleteLeasedRecord({
        namespace: 'project-a',
        ownerId: 'tab-b',
        epoch: leader!.epoch,
        logId: lease.logId,
        leaseToken: lease.leaseToken,
      }),
    ).resolves.toBe(false);
    await expect(
      tabB.coordination!.deleteDelivered('project-a', lease.logId),
    ).resolves.toBe(true);
    await expect(tabA.get(lease.logId)).resolves.toBeNull();

    tabA.close();
    tabB.close();
  });

  it('increments deliveryAttempt only while both leader and record fences are current', async () => {
    const [tabA, tabB] = await createPair();
    await tabA.put(makeRecord('attempts'));
    const leader = await tabA.coordination!.tryAcquireLeadership({
      namespace: 'project-a',
      ownerId: 'tab-a',
      now: 9_000,
      leaseMs: 15_000,
    });
    const claim = await tabA.coordination!.claimBatch({
      namespace: 'project-a',
      ownerId: 'tab-a',
      epoch: leader!.epoch,
      now: 9_000,
      leaseMs: 60_000,
      limit: 1,
      candidateGroups: [['attempts']],
    });
    const lease = claim.records[0]!;
    const fence = {
      namespace: 'project-a',
      ownerId: 'tab-a',
      epoch: leader!.epoch,
      logId: lease.logId,
      leaseToken: lease.leaseToken,
      now: 9_001,
    };
    await expect(
      tabA.coordination!.incrementDeliveryAttempt(fence),
    ).resolves.toBe(1);
    await expect(
      tabA.coordination!.incrementDeliveryAttempt({
        ...fence,
        leaseToken: 'stale-token',
        now: 9_002,
      }),
    ).resolves.toBeNull();
    expect((await tabB.get('attempts'))?.deliveryAttempt).toBe(1);

    tabA.close();
    tabB.close();
  });

  it('persists split success proof atomically so a successor can distinguish residual work from corruption', async () => {
    const [tabA, tabB] = await createPair();
    const first = makeRecord('split-proof-1');
    first.splitId = 'split-proof';
    first.log.tags = { splitId: 'split-proof', splitIndex: 1, splitTotal: 2 };
    const second = makeRecord('split-proof-2');
    second.splitId = 'split-proof';
    second.log.tags = { splitId: 'split-proof', splitIndex: 2, splitTotal: 2 };
    await Promise.all([tabA.put(first), tabA.put(second)]);
    await tabA.coordination!.markSplitComplete('project-a', 'split-proof', 2);
    await expect(
      tabA.coordination!.deleteDelivered('project-a', first.logId),
    ).resolves.toBe(true);
    await expect(
      tabB.coordination!.getSplitProgress('project-a', 'split-proof'),
    ).resolves.toMatchObject({
      splitTotal: 2,
      deliveredIndices: [1],
      complete: true,
    });
    await expect(tabB.get(second.logId)).resolves.not.toBeNull();

    await expect(
      tabB.coordination!.deleteDelivered('project-a', second.logId),
    ).resolves.toBe(true);
    await expect(
      tabA.coordination!.getSplitProgress('project-a', 'split-proof'),
    ).resolves.toBeNull();

    tabA.close();
    tabB.close();
  });

  it('never TTL-deletes a live leased record and deletes it only after lease expiry', async () => {
    const store = withCoordination(
      await createIndexedDbStore(`ttl-lease-${Math.random()}`),
    );
    const value = makeRecord('ttl-leased', 1_000);
    await store.put(value);
    const leader = await store.coordination!.tryAcquireLeadership({
      namespace: 'project-a',
      ownerId: 'tab-a',
      now: 10_000,
      leaseMs: 15_000,
    });
    expect(leader).not.toBeNull();
    const claimed = await store.coordination!.claimBatch({
      namespace: 'project-a',
      ownerId: 'tab-a',
      epoch: leader!.epoch,
      now: 10_000,
      leaseMs: 60_000,
      candidateGroups: [['ttl-leased']],
      limit: 10,
    });
    expect(claimed.records).toHaveLength(1);

    await expect(
      store.coordination!.deleteExpiredGroup(
        'project-a',
        ['ttl-leased'],
        20_000,
        1_000,
      ),
    ).resolves.toEqual([]);
    await expect(store.get('ttl-leased')).resolves.toMatchObject({
      state: 'leased',
    });

    await expect(
      store.coordination!.deleteExpiredGroup(
        'project-a',
        ['ttl-leased'],
        70_001,
        1_000,
      ),
    ).resolves.toHaveLength(1);
    await expect(store.get('ttl-leased')).resolves.toBeNull();
    store.close();
  });

  it('publishes a split group atomically when one member cannot be stored', async () => {
    const store = await createIndexedDbStore(`atomic-put-${Math.random()}`);
    const first = makeRecord('atomic-first');
    const invalid = {
      ...makeRecord('atomic-invalid'),
      log: null,
    } as unknown as OfflineRecord;
    await expect(store.putMany!([first, invalid])).rejects.toThrow(
      'record is invalid',
    );
    await expect(store.get(first.logId)).resolves.toBeNull();
    store.close();
  });

  it('migrates canonical v1 records only after binding an independent v2 database', async () => {
    const dbName = `migration-${Math.random()}`;
    const legacyRecord = makeRecord('legacy');
    const legacyDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore('records', {
          keyPath: 'logId',
        });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = legacyDb.transaction('records', 'readwrite');
      tx.objectStore('records').put(legacyRecord);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    legacyDb.close();

    const keyPrefix = '__aemeath_offline__';
    const namespace = `${dbName}:${keyPrefix}`;
    const store = withCoordination(
      await createCoordinatedOfflineStore({
        preference: 'indexeddb',
        platform: createNoopAdapter(),
        dbName,
        keyPrefix,
        namespace,
        allowFallback: false,
      }),
    );
    expect(store.legacyMigrationCount).toBe(1);
    await expect(store.get('legacy')).resolves.toMatchObject({
      schemaVersion: 2,
      state: 'pending',
      deliveryAttempt: 0,
      logId: 'legacy',
    });

    const inspectLegacyDb = await new Promise<IDBDatabase>(
      (resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      },
    );
    const legacyCount = await new Promise<number>((resolve, reject) => {
      const request = inspectLegacyDb
        .transaction('records', 'readonly')
        .objectStore('records')
        .count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(legacyCount).toBe(0);
    expect(inspectLegacyDb.version).toBe(1);
    inspectLegacyDb.close();
    const inspectV2Db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(coordinatedDatabaseName(dbName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(inspectV2Db.version).toBe(2);
    expect(Array.from(inspectV2Db.objectStoreNames)).toContain('records-v2');
    inspectV2Db.close();
    store.close();
  });

  it('merges a repeated v1 snapshot without regressing an existing v2 lease', async () => {
    const dbName = `migration-lease-${Math.random()}`;
    const keyPrefix = '__aemeath_offline__';
    const namespace = `${dbName}:${keyPrefix}`;
    const legacyRecord: OfflineRecord = {
      ...makeRecord('legacy-live-lease', 1_000),
      log: {
        ...makeRecord('legacy-live-lease', 1_000).log,
        tags: { first: 1, second: 2 },
      },
    };
    const writeLegacy = async (record: OfflineRecord): Promise<void> => {
      const legacyDb = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore('records', {
            keyPath: 'logId',
          });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = legacyDb.transaction('records', 'readwrite');
        tx.objectStore('records').put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      legacyDb.close();
    };
    await writeLegacy(legacyRecord);
    const first = withCoordination(
      await createCoordinatedOfflineStore({
        preference: 'indexeddb',
        platform: createNoopAdapter(),
        dbName,
        keyPrefix,
        namespace,
        allowFallback: false,
      }),
    );
    const leader = await first.coordination.tryAcquireLeadership({
      namespace,
      ownerId: 'tab-a',
      now: 2_000,
      leaseMs: 60_000,
    });
    expect(leader).not.toBeNull();
    const claimed = await first.coordination.claimBatch({
      namespace,
      ownerId: 'tab-a',
      epoch: leader!.epoch,
      now: 2_000,
      leaseMs: 60_000,
      limit: 1,
      candidateGroups: [['legacy-live-lease']],
    });
    expect(claimed.status).toBe('claimed');
    const leaseToken = claimed.records[0]?.leaseToken;

    // A still-running 2.5 tab writes the same durable body back with newer
    // retry state after the first migration removed its snapshot.
    await writeLegacy({
      ...legacyRecord,
      replayAttempts: 7,
      notBefore: 50_000,
      serverNotBefore: 40_000,
      log: { ...legacyRecord.log, tags: { second: 2, first: 1 } },
    });
    const second = await createCoordinatedOfflineStore({
      preference: 'indexeddb',
      platform: createNoopAdapter(),
      dbName,
      keyPrefix,
      namespace,
      allowFallback: false,
    });
    await expect(second.get('legacy-live-lease')).resolves.toMatchObject({
      state: 'leased',
      leaseOwner: 'tab-a',
      leaseToken,
      leaderEpoch: leader!.epoch,
      replayAttempts: 7,
      nextEligibleAt: 50_000,
      notBefore: 50_000,
      serverNotBefore: 40_000,
    });

    first.close();
    second.close();
  });

  it('does not read or migrate an unbound v1 body into a custom namespace', async () => {
    const dbName = `migration-isolation-${Math.random()}`;
    const legacyDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore('records', {
          keyPath: 'logId',
        });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = legacyDb.transaction('records', 'readwrite');
      tx.objectStore('records').put(makeRecord('project-a-secret'));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    legacyDb.close();

    const store = await createCoordinatedOfflineStore({
      preference: 'indexeddb',
      platform: createNoopAdapter(),
      dbName,
      keyPrefix: '__aemeath_offline__',
      namespace: 'project-b',
      allowFallback: false,
    });
    expect(store.legacyMigrationCount).toBe(0);
    await expect(store.get('project-a-secret')).resolves.toBeNull();
    const inspectLegacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = await new Promise<number>((resolve, reject) => {
      const request = inspectLegacy
        .transaction('records', 'readonly')
        .objectStore('records')
        .count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(count).toBe(1);
    inspectLegacy.close();
    store.close();
  });

  it('uses one read-modify-write transaction so a stale pending snapshot cannot overwrite a live lease', async () => {
    const [tabA, tabB] = await createPair();
    const initial = makeRecord('atomic-merge', 1_000);
    await tabA.coordination.mergePendingRecords([initial]);
    const leader = await tabA.coordination.tryAcquireLeadership({
      namespace: 'project-a',
      ownerId: 'tab-a',
      now: 2_000,
      leaseMs: 60_000,
    });
    const claim = await tabA.coordination.claimBatch({
      namespace: 'project-a',
      ownerId: 'tab-a',
      epoch: leader!.epoch,
      now: 2_000,
      leaseMs: 60_000,
      limit: 1,
      candidateGroups: [['atomic-merge']],
    });
    const lease = claim.records[0]!;
    await expect(
      tabA.coordination.incrementDeliveryAttempt({
        namespace: 'project-a',
        ownerId: 'tab-a',
        epoch: leader!.epoch,
        logId: lease.logId,
        leaseToken: lease.leaseToken,
        now: 2_001,
      }),
    ).resolves.toBe(1);

    const staleSnapshot = {
      ...initial,
      replayAttempts: 7,
      notBefore: 50_000,
    };
    await tabB.coordination.mergePendingRecords([staleSnapshot]);
    await expect(tabA.get('atomic-merge')).resolves.toMatchObject({
      state: 'leased',
      leaseOwner: 'tab-a',
      leaseToken: lease.leaseToken,
      leaderEpoch: leader!.epoch,
      deliveryAttempt: 1,
      replayAttempts: 7,
      notBefore: 50_000,
    });

    tabA.close();
    tabB.close();
  });

  it('transactionally refuses quota-style group deletion when any member has a live lease', async () => {
    const [tabA, tabB] = await createPair();
    const first = makeRecord('quota-group-1', 1_000);
    first.splitId = 'quota-group';
    first.log.tags = { splitId: 'quota-group', splitIndex: 1, splitTotal: 2 };
    const second = makeRecord('quota-group-2', 1_000);
    second.splitId = 'quota-group';
    second.log.tags = { splitId: 'quota-group', splitIndex: 2, splitTotal: 2 };
    await tabA.coordination.mergePendingRecords([first, second]);
    const leader = await tabA.coordination.tryAcquireLeadership({
      namespace: 'project-a',
      ownerId: 'tab-a',
      now: 2_000,
      leaseMs: 60_000,
    });
    await tabA.coordination.claimBatch({
      namespace: 'project-a',
      ownerId: 'tab-a',
      epoch: leader!.epoch,
      now: 2_000,
      leaseMs: 60_000,
      limit: 2,
      candidateGroups: [['quota-group-1', 'quota-group-2']],
    });

    await expect(
      tabB.coordination.deleteUnleasedGroup(
        'project-a',
        ['quota-group-1', 'quota-group-2'],
        2_001,
      ),
    ).resolves.toEqual([]);
    await expect(tabA.get('quota-group-1')).resolves.toMatchObject({
      state: 'leased',
    });
    await expect(tabA.get('quota-group-2')).resolves.toMatchObject({
      state: 'leased',
    });

    tabA.close();
    tabB.close();
  });
});
