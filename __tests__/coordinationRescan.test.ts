/**
 * 协调核心的对抗复扫：针对现有套件未覆盖的协调器级并发交错。
 *
 * - 派发（onClaim）抛出后租约必须回到可领取状态，下一轮能重新领取
 * - beginAttempt 与 stop() 交错时绝不把 attempt 交给网络层，且租约归还
 * - stop 之后晚到的 succeed() 仍能提交持久成功事实（成功不属于任何 lease）
 * - 心跳续租失败必须立刻放弃 leader 角色
 * - stop 之后成功提交重试链必须收敛，不得对已关库无限空转
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  DeliveryCoordinator,
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

type CoordinatedStore = OfflineStore & {
  coordination: OfflineCoordinationStore;
};

async function createCoordinatedStore(
  dbName: string,
): Promise<CoordinatedStore> {
  const store = await createIndexedDbStore(dbName);
  return Object.assign(store, {
    coordination: createOfflineCoordinationStore(store),
  });
}

async function settle(rounds = 10): Promise<void> {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('coordination core adversarial rescan', () => {
  beforeEach(() => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it('returns leases to the shared queue when dispatch throws, so the next round can re-claim', async () => {
    const store = await createCoordinatedStore(`dispatch-fail-${Math.random()}`);
    await store.put(record('re-claimable'));
    const claimBatches: DeliveryReceipt[][] = [];
    const coordinator = new DeliveryCoordinator({
      store,
      coordination: store.coordination,
      namespace: 'project-a',
      replayBatchSize: 10,
      getCandidateGroups: () => [['re-claimable']],
      onClaim: (items) => {
        claimBatches.push(items.map((item) => item.receipt));
        if (claimBatches.length === 1) {
          throw new Error('simulated requeueCoordinated failure');
        }
      },
    });
    coordinator.start();
    await settle(20);

    // 第一次派发失败：回执被协调器释放（settled），记录回到 pending
    expect(claimBatches.length).toBeGreaterThanOrEqual(2);
    expect(claimBatches[0]![0]!.isSettled()).toBe(true);

    // 第二次领取拿到新的可用回执，整条链路可正常送达。
    // 首次派发在任何 beginAttempt 之前失败，持久 attempt 计数不应被消耗。
    const second = claimBatches[1]![0]!;
    expect(second.isSettled()).toBe(false);
    await expect(second.beginAttempt()).resolves.toBe(1);
    await expect(second.succeed()).resolves.toBe(true);
    expect(await store.get('re-claimable')).toBeNull();

    await coordinator.stop();
    store.close();
  });

  it('never hands an attempt to the network when stop() crosses the durable attempt fence', async () => {
    const store = await createCoordinatedStore(`begin-stop-${Math.random()}`);
    await store.put(record('crossing'));
    const receipts: DeliveryReceipt[] = [];
    let coordinator: DeliveryCoordinator;
    let stopped: Promise<void> | null = null;
    // 在 attempt fence 的持久事务提交后、beginAttempt 返回前触发 stop()
    const coordination: OfflineCoordinationStore = {
      ...store.coordination,
      incrementDeliveryAttempt: async (request) => {
        const result = await store.coordination.incrementDeliveryAttempt(request);
        stopped = coordinator.stop();
        await stopped;
        return result;
      },
    };
    coordinator = new DeliveryCoordinator({
      store,
      coordination,
      namespace: 'project-a',
      replayBatchSize: 10,
      getCandidateGroups: () => [['crossing']],
      onClaim: (items) => {
        for (const item of items) receipts.push(item.receipt);
      },
    });
    coordinator.start();
    await settle();
    expect(receipts).toHaveLength(1);

    // stop 与 attempt fence 并发：即使持久计数已递增，也不得把 attempt 交给网络层
    await expect(receipts[0]!.beginAttempt()).resolves.toBeNull();
    expect(stopped).not.toBeNull();
    expect(receipts[0]!.isSettled()).toBe(true);

    // 租约必须已归还：记录回到无租约状态，持久 attempt 计数单调保留
    const remaining = await store.get('crossing');
    expect(remaining).not.toBeNull();
    expect(remaining!.state).not.toBe('leased');
    expect(remaining!.leaseOwner).toBeUndefined();
    expect(remaining!.deliveryAttempt).toBe(1);

    store.close();
  });

  it('commits a late success after stop() because success is a global fact, not a lease right', async () => {
    const store = await createCoordinatedStore(`late-success-${Math.random()}`);
    await store.put(record('late-win'));
    const receipts: DeliveryReceipt[] = [];
    const coordinator = new DeliveryCoordinator({
      store,
      coordination: store.coordination,
      namespace: 'project-a',
      replayBatchSize: 10,
      getCandidateGroups: () => [['late-win']],
      onClaim: (items) => {
        for (const item of items) receipts.push(item.receipt);
      },
    });
    coordinator.start();
    await settle();
    expect(receipts).toHaveLength(1);
    await expect(receipts[0]!.beginAttempt()).resolves.toBe(1);

    // 网络请求在飞行中，stop() 不得释放它的租约
    await coordinator.stop();
    expect(receipts[0]!.isSettled()).toBe(false);

    // 请求晚到成功：持久成功事实仍必须提交，防止下一任重复投递
    await expect(receipts[0]!.succeed()).resolves.toBe(true);
    expect(await store.get('late-win')).toBeNull();

    store.close();
  });

  it('drops leadership immediately when heartbeat renewal is fenced out', async () => {
    const store = await createCoordinatedStore(`heartbeat-loss-${Math.random()}`);
    let renewAllowed = true;
    const coordination: OfflineCoordinationStore = {
      ...store.coordination,
      renewLeadership: async (request) =>
        renewAllowed ? store.coordination.renewLeadership(request) : false,
    };
    const coordinator = new DeliveryCoordinator({
      store,
      coordination,
      namespace: 'project-a',
      replayBatchSize: 10,
      getCandidateGroups: () => [],
      onClaim: () => undefined,
    });
    coordinator.start();
    await settle();
    expect(coordinator.getStatus().role).toBe('leader');

    // 模拟另一标签接管后本 leader 的续租被 fencing 拒绝
    renewAllowed = false;
    await (
      coordinator as unknown as { heartbeat(): Promise<void> }
    ).heartbeat();
    expect(coordinator.getStatus().role).toBe('follower');
    expect(coordinator.getStatus().leaderEpoch).toBeUndefined();

    await coordinator.stop();
    store.close();
  });

  it('recovers leadership from an implausible corrupt-clock lease instead of locking out forever', async () => {
    const store = await createCoordinatedStore(`corrupt-clock-${Math.random()}`);
    const namespace = 'project-a';
    // 拥有坏时钟的标签把租约写到了遥远的未来；正常时钟标签必须能接管
    const poisoned = await store.coordination.tryAcquireLeadership({
      namespace,
      ownerId: 'bad-clock-tab',
      now: Date.now() + 365 * 24 * 3600 * 1000,
      leaseMs: 60_000,
    });
    expect(poisoned).not.toBeNull();

    const takeover = await store.coordination.tryAcquireLeadership({
      namespace,
      ownerId: 'healthy-tab',
      now: Date.now(),
      leaseMs: 15_000,
    });
    expect(takeover).not.toBeNull();
    expect(takeover!.ownerId).toBe('healthy-tab');
    expect(takeover!.epoch).toBe(poisoned!.epoch + 1);

    // 坏时钟持有者的旧 epoch 从此被 fencing 挡住
    await expect(
      store.coordination.renewLeadership({
        namespace,
        ownerId: 'bad-clock-tab',
        epoch: poisoned!.epoch,
        now: Date.now() + 365 * 24 * 3600 * 1000,
        leaseMs: 60_000,
      }),
    ).resolves.toBe(false);

    store.close();
  });

  it('stops retrying success commits after stop() instead of spinning against a closed store', async () => {
    const store = await createCoordinatedStore(`success-spin-${Math.random()}`);
    await store.put(record('spin'));
    let deleteCalls = 0;
    const coordination: OfflineCoordinationStore = {
      ...store.coordination,
      deleteDelivered: async () => {
        deleteCalls++;
        throw new Error('simulated closed database');
      },
    };
    const receipts: DeliveryReceipt[] = [];
    const coordinator = new DeliveryCoordinator({
      store,
      coordination,
      namespace: 'project-a',
      replayBatchSize: 10,
      getCandidateGroups: () => [['spin']],
      onClaim: (items) => {
        for (const item of items) receipts.push(item.receipt);
      },
    });
    coordinator.start();
    await settle();
    expect(receipts).toHaveLength(1);
    await expect(receipts[0]!.beginAttempt()).resolves.toBe(1);

    // 成功提交失败会武装自动重试链
    await expect(receipts[0]!.succeed()).rejects.toThrow(
      'simulated closed database',
    );
    const internal = receipts[0] as unknown as {
      successRetryTimer: ReturnType<typeof setTimeout> | null;
    };
    expect(internal.successRetryTimer).not.toBeNull();

    // stop 之后重试链必须收敛：定时器清空，也不再产生新的提交尝试
    await coordinator.stop();
    expect(internal.successRetryTimer).toBeNull();
    const callsAtStop = deleteCalls;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(deleteCalls).toBe(callsAtStop);

    // 记录仍带着有期限的租约留在盘上，由下一任在到期后接管重投
    expect(await store.get('spin')).not.toBeNull();

    store.close();
  });
});
