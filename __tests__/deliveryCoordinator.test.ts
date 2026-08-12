import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  DeliveryCoordinator,
  type CrossTabAdapter,
  type CrossTabChannel,
  type DeliveryReceipt,
} from '../src/plugins/offline/DeliveryCoordinator';
import {
  createIndexedDbStore,
  type OfflineCoordinationStore,
  type OfflineRecord,
  type OfflineStore,
} from '../src/plugins/offline/CoordinatedOfflineStore';
import { createOfflineCoordinationStore } from '../src/plugins/offline/OfflineCoordinationStore';
import { LogLevel } from '../src/types';

function record(logId: string): OfflineRecord {
  const now = Date.now();
  return {
    logId,
    storedAt: now,
    capturedAt: now,
    priority: 1,
    bytes: 100,
    replayAttempts: 0,
    log: { logId, level: LogLevel.ERROR, message: logId, timestamp: now },
  };
}

type CoordinatedStore = OfflineStore & { coordination: OfflineCoordinationStore };

async function createCoordinatedStore(dbName: string): Promise<CoordinatedStore> {
  const store = await createIndexedDbStore(dbName);
  return Object.assign(store, { coordination: createOfflineCoordinationStore(store) });
}

function crossTabWithBroadcast(): CrossTabAdapter {
  const listeners = new Map<string, Set<(message: unknown) => void>>();
  const crossTab: CrossTabAdapter = {
    broadcastSupported: true,
    webLocksSupported: false,
    createChannel(name): CrossTabChannel {
      const own = new Set<(message: unknown) => void>();
      listeners.set(name, listeners.get(name) ?? new Set());
      return {
        postMessage(message) {
          queueMicrotask(() => {
            for (const listener of listeners.get(name) ?? []) listener(message);
          });
        },
        onMessage(handler) {
          own.add(handler);
          listeners.get(name)!.add(handler);
          return () => {
            own.delete(handler);
            listeners.get(name)?.delete(handler);
          };
        },
        close() {
          for (const handler of own) listeners.get(name)?.delete(handler);
          own.clear();
        },
      };
    },
    runExclusive(_name, task) {
      return task();
    },
  };
  return crossTab;
}

async function settle(rounds = 10): Promise<void> {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('DeliveryCoordinator', () => {
  beforeEach(() => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it('elects one recovery owner and issues only one network-capable receipt across tabs', async () => {
    const dbName = `coordinator-${Math.random()}`;
    const [storeA, storeB] = await Promise.all([
      createCoordinatedStore(dbName),
      createCoordinatedStore(dbName),
    ]);
    await storeA.put(record('only-once'));
    const crossTab = crossTabWithBroadcast();
    const claims: Array<{ tab: string; receipt: DeliveryReceipt }> = [];
    const remoteDeliveredA = vi.fn();
    const remoteDeliveredB = vi.fn();
    const make = (tab: string, store: typeof storeA, onDelivered: (id: string) => void) =>
      new DeliveryCoordinator({
        store,
        coordination: store.coordination,
        crossTab,
        namespace: 'project-a',
        replayBatchSize: 10,
        getCandidateGroups: () => [['only-once']],
        onClaim: (items) => {
          for (const item of items) claims.push({ tab, receipt: item.receipt });
        },
        onDelivered,
      });
    const coordinatorA = make('a', storeA, remoteDeliveredA);
    const coordinatorB = make('b', storeB, remoteDeliveredB);
    coordinatorA.start();
    coordinatorB.start();
    await settle();

    expect(claims).toHaveLength(1);
    await expect(claims[0]!.receipt.beginAttempt()).resolves.toBe(1);
    await expect(claims[0]!.receipt.succeed()).resolves.toBe(true);
    await settle();
    expect(remoteDeliveredA.mock.calls.length + remoteDeliveredB.mock.calls.length).toBe(1);
    expect(await storeA.get('only-once')).toBeNull();

    await Promise.all([coordinatorA.stop(), coordinatorB.stop()]);
    storeA.close();
    storeB.close();
  });

  it('retries a failed success-proof transaction without issuing another delivery claim', async () => {
    const store = await createCoordinatedStore(`success-proof-${Math.random()}`);
    await store.put(record('committed-remotely'));
    const originalDelete = store.coordination!.deleteDelivered.bind(store.coordination);
    const deleteSpy = vi.spyOn(store.coordination!, 'deleteDelivered')
      .mockRejectedValueOnce(new Error('transient transaction failure'))
      .mockImplementation(originalDelete);
    const claims: DeliveryReceipt[] = [];
    const coordinator = new DeliveryCoordinator({
      store,
      coordination: store.coordination,
      namespace: 'project-a',
      replayBatchSize: 10,
      getCandidateGroups: () => [['committed-remotely']],
      onClaim: (items) => {
        claims.push(...items.map((item) => item.receipt));
      },
    });
    coordinator.start();
    await settle();
    expect(claims).toHaveLength(1);
    await expect(claims[0]!.beginAttempt()).resolves.toBe(1);
    await expect(claims[0]!.succeed()).rejects.toThrow('transient transaction failure');
    expect(await store.get('committed-remotely')).not.toBeNull();

    await settle(230);
    expect(deleteSpy).toHaveBeenCalledTimes(2);
    expect(await store.get('committed-remotely')).toBeNull();
    expect(claims).toHaveLength(1);

    await coordinator.stop();
    store.close();
  }, 5000);

  it('waits for an atomic claim crossing stop and releases it without network dispatch', async () => {
    const store = await createCoordinatedStore(`stop-claim-${Math.random()}`);
    await store.put(record('claimed-during-stop'));
    const coordination = store.coordination!;
    const originalClaim = coordination.claimBatch.bind(coordination);
    let releaseClaim!: () => void;
    const claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    let reportClaimed!: () => void;
    const claimCommitted = new Promise<void>((resolve) => {
      reportClaimed = resolve;
    });
    vi.spyOn(coordination, 'claimBatch').mockImplementation(async (request) => {
      const result = await originalClaim(request);
      reportClaimed();
      await claimGate;
      return result;
    });
    const onClaim = vi.fn();
    const coordinator = new DeliveryCoordinator({
      store,
      coordination: store.coordination,
      namespace: 'project-a',
      replayBatchSize: 10,
      getCandidateGroups: () => [['claimed-during-stop']],
      onClaim,
    });
    coordinator.start();
    await claimCommitted;

    const stopping = coordinator.stop();
    releaseClaim();
    await stopping;

    expect(onClaim).not.toHaveBeenCalled();
    await expect(store.get('claimed-during-stop')).resolves.toMatchObject({
      state: 'pending',
      leaseOwner: undefined,
      leaseToken: undefined,
    });
    await expect(coordination.getLeadership('project-a')).resolves.toMatchObject({
      leaseUntil: 0,
    });
    store.close();
  });

  it('treats replayBatchSize as a soft limit for one indivisible split group', async () => {
    const store = await createCoordinatedStore(`large-split-${Math.random()}`);
    const ids = Array.from({ length: 12 }, (_, index) => `large-split-${index + 1}`);
    const records = ids.map((logId, index) => {
      const value = record(logId);
      value.splitId = 'large-split';
      value.log.tags = { splitId: 'large-split', splitIndex: index + 1, splitTotal: ids.length };
      return value;
    });
    await store.putMany!(records);
    const claims: DeliveryReceipt[] = [];
    const coordinator = new DeliveryCoordinator({
      store,
      coordination: store.coordination,
      namespace: 'project-a',
      replayBatchSize: 10,
      getCandidateGroups: () => [ids],
      onClaim: (items) => {
        claims.push(...items.map((item) => item.receipt));
      },
    });
    coordinator.start();
    await settle();

    expect(claims).toHaveLength(12);
    await coordinator.stop();
    store.close();
  });

  it('does not release a receipt while its real network attempt is live', async () => {
    const dbName = `stop-live-attempt-${Math.random()}`;
    const [storeA, storeB] = await Promise.all([
      createCoordinatedStore(dbName),
      createCoordinatedStore(dbName),
    ]);
    await storeA.put(record('live-attempt'));
    const claimsA: DeliveryReceipt[] = [];
    const coordinatorA = new DeliveryCoordinator({
      store: storeA,
      coordination: storeA.coordination,
      namespace: 'project-a',
      replayBatchSize: 10,
      getCandidateGroups: () => [['live-attempt']],
      onClaim: (items) => {
        claimsA.push(...items.map((item) => item.receipt));
      },
    });
    coordinatorA.start();
    await settle();
    expect(claimsA).toHaveLength(1);
    await expect(claimsA[0]!.beginAttempt()).resolves.toBe(1);
    await coordinatorA.stop();

    const claimsB: DeliveryReceipt[] = [];
    const coordinatorB = new DeliveryCoordinator({
      store: storeB,
      coordination: storeB.coordination,
      namespace: 'project-a',
      replayBatchSize: 10,
      getCandidateGroups: () => [['live-attempt']],
      onClaim: (items) => {
        claimsB.push(...items.map((item) => item.receipt));
      },
    });
    coordinatorB.start();
    await settle();

    expect(claimsB).toHaveLength(0);
    await expect(storeB.get('live-attempt')).resolves.toMatchObject({
      state: 'leased',
      deliveryAttempt: 1,
    });
    await coordinatorB.stop();
    storeA.close();
    storeB.close();
  });
});
