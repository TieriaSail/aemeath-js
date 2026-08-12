import type {
  CoordinatorRecord,
  LeasedOfflineRecord,
  LeasedRecordFence,
  OfflineCoordinationStore,
  OfflineStore,
  ReleaseLeasedRecordRequest,
} from './CoordinatedOfflineStore';
import type { DurableDeliveryReceipt, DurableDeliveryUpdate } from '../UploadPlugin';
import { generateId } from '../../utils/generateId';

const PROTOCOL_VERSION = 2;
const LEADER_LEASE_MS = 15_000;
const HEARTBEAT_MS = 5_000;
const RECORD_LEASE_MS = 60_000;
const IDLE_RELEASE_MS = 2_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * 浏览器标签间的可选优化能力。
 *
 * 该接口属于 CrossTabDeliveryPlugin，不进入 PlatformAdapter。BroadcastChannel
 * 只负责唤醒，Web Locks 只减少选主争用；正确性始终由 IndexedDB fencing 保证。
 */
export interface CrossTabChannel {
  postMessage(message: unknown): void;
  onMessage(handler: (message: unknown) => void): () => void;
  close(): void;
}

export interface CrossTabAdapter {
  readonly broadcastSupported: boolean;
  readonly webLocksSupported: boolean;
  createChannel(name: string): CrossTabChannel | null;
  runExclusive<T>(name: string, task: () => Promise<T>): Promise<T>;
}

export interface DeliveryCoordinationStatus {
  mode: 'strong' | 'strong-slower' | 'none' | 'disabled';
  role: 'leader' | 'follower' | 'standalone' | 'disabled';
  backend: 'indexeddb' | 'localstorage' | 'noop';
  leaderEpoch?: number;
  leaderLeaseUntil?: number;
  leased: number;
  contentionCount: number;
  expiredLeaseRecoveries: number;
  staleOutcomesIgnored: number;
  mixedVersionRisk: boolean;
  legacyMigrationCount: number;
  degradedReason?: string;
}

type CoordinatorMessageType =
  | 'work-available'
  | 'leader-changed'
  | 'delivered'
  | 'store-cleared';

interface CoordinatorMessage {
  protocolVersion: 2;
  namespaceHash: string;
  senderId: string;
  type: CoordinatorMessageType;
  logId?: string;
}

export interface ClaimedDelivery {
  record: LeasedOfflineRecord;
  receipt: DeliveryReceipt;
}

export interface DeliveryCoordinatorOptions {
  store: OfflineStore;
  coordination: OfflineCoordinationStore;
  crossTab?: CrossTabAdapter;
  namespace: string;
  replayBatchSize: number;
  getCandidateGroups():
    | readonly (readonly string[])[]
    | Promise<readonly (readonly string[])[]>;
  onClaim(deliveries: readonly ClaimedDelivery[]): Promise<void> | void;
  onDelivered?(logId: string): Promise<void> | void;
  onStatus?(status: DeliveryCoordinationStatus): void;
  onStaleOutcome?(logId: string, outcome: string): void;
}

function hashNamespace(value: string): string {
  // FNV-1a 32-bit：这里只需要稳定且不暴露原 namespace 的频道名，不用于安全边界。
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function isCoordinatorMessage(value: unknown, namespaceHash: string): value is CoordinatorMessage {
  if (value == null || typeof value !== 'object') return false;
  const message = value as Partial<CoordinatorMessage>;
  return message.protocolVersion === PROTOCOL_VERSION
    && message.namespaceHash === namespaceHash
    && typeof message.senderId === 'string'
    && (message.type === 'work-available'
      || message.type === 'leader-changed'
      || message.type === 'delivered'
      || message.type === 'store-cleared')
    && (message.logId === undefined || typeof message.logId === 'string');
}

/**
 * 一条已领取记录的持久回执。
 *
 * 回执本身不拥有正确性：每个方法都会重新进入 OfflineStore 的 fencing 事务。
 * 本地 settled 标记只负责防止同一 UploadPlugin 回调被重复消费。
 */
export class DeliveryReceipt implements DurableDeliveryReceipt {
  readonly logId: string;
  readonly leaseToken: string;
  readonly leaderEpoch: number;
  private settled = false;
  private phase:
    | 'claimed'
    | 'beginning'
    | 'in-flight'
    | 'retry-wait'
    | 'shutdown-release'
    | 'success-commit'
    = 'claimed';
  private successRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private successRetryDelay = 0;
  private commitRetriesCancelled = false;

  constructor(
    private readonly coordination: OfflineCoordinationStore,
    private readonly fence: LeasedRecordFence,
    private readonly canStartNetworkAttempt: () => boolean,
    private readonly onSettled: (receipt: DeliveryReceipt) => void,
    private readonly onDelivered: (logId: string) => void,
    private readonly onStale: (logId: string, outcome: string) => void,
  ) {
    this.logId = fence.logId;
    this.leaseToken = fence.leaseToken;
    this.leaderEpoch = fence.epoch;
  }

  isSettled(): boolean {
    return this.settled;
  }

  async beginAttempt(now = Date.now()): Promise<number | null> {
    if (this.settled) return null;
    if (!this.canStartNetworkAttempt()) return null;
    if (this.phase !== 'claimed' && this.phase !== 'retry-wait') return null;
    const previousPhase = this.phase;
    // This transition is synchronous so stop() cannot release the lease while
    // the durable attempt fence is being committed.
    this.phase = 'beginning';
    let attempt: number | null;
    try {
      attempt = await this.coordination.incrementDeliveryAttempt({
        ...this.fence,
        now,
      });
    } catch (error) {
      if (!this.settled && this.phase === 'beginning') this.phase = previousPhase;
      throw error;
    }
    if (attempt === null) {
      this.finishStale('attempt');
    } else if (!this.canStartNetworkAttempt()) {
      // 依赖卸载可能与 attempt fence 的事务提交并发。控制器一旦失活，旧 Upload
      // 即使拿到了 deliveryAttempt 也不得再跨越网络边界；尽力归还 lease，失败则
      // 停止续租并交给硬过期接管。
      this.phase = 'shutdown-release';
      try {
        await this.retry({
          nextEligibleAt: now,
          lastRetryReason: 'coordinator-stopped-before-request',
        });
      } catch {
        // 调用者只需要看到 null 并 fail closed；lease 有硬截止时间。
      }
      return null;
    } else {
      this.phase = 'in-flight';
    }
    return attempt;
  }

  async renew(now = Date.now()): Promise<boolean> {
    if (this.settled) return false;
    const renewed = await this.coordination.renewRecordLease({
      ...this.fence,
      now,
      leaseMs: RECORD_LEASE_MS,
    });
    if (!renewed) this.finishStale('renew');
    return renewed;
  }

  async succeed(): Promise<boolean> {
    if (this.settled) return false;
    this.phase = 'success-commit';
    try {
      return await this.commitSuccess();
    } catch (error) {
      this.scheduleSuccessRetry();
      throw error;
    }
  }

  async retry(update: DurableDeliveryUpdate): Promise<boolean> {
    return this.release({ ...update, state: 'pending' });
  }

  async retryScheduled(update: DurableDeliveryUpdate): Promise<boolean> {
    if (this.settled) return false;
    const updated = await this.coordination.updateLeasedRecord({
      ...this.fence,
      ...update,
    });
    if (!updated) this.finishStale('retry-scheduled');
    else this.phase = 'retry-wait';
    return updated;
  }

  /** Clean shutdown may release only receipts that cannot have a live request. */
  async releaseIfIdle(update: DurableDeliveryUpdate): Promise<boolean> {
    if (this.settled) return false;
    if (this.phase !== 'claimed' && this.phase !== 'retry-wait') return false;
    // Block a retry timer synchronously before the release transaction starts.
    // Otherwise beginAttempt() and releaseLeasedRecord() can cross and permit a
    // request after ownership was already returned to the shared queue.
    this.phase = 'shutdown-release';
    return this.retry(update);
  }

  async park(update: DurableDeliveryUpdate): Promise<boolean> {
    return this.release({ ...update, state: 'parked' });
  }

  async terminal(): Promise<boolean> {
    if (this.settled) return false;
    const deleted = await this.coordination.deleteLeasedRecord(this.fence);
    if (!deleted) {
      this.finishStale('terminal');
      return false;
    }
    this.settled = true;
    this.clearSuccessRetry();
    this.onSettled(this);
    return true;
  }

  private async release(update: Omit<ReleaseLeasedRecordRequest, keyof LeasedRecordFence>): Promise<boolean> {
    if (this.settled) return false;
    const released = await this.coordination.releaseLeasedRecord({
      ...this.fence,
      ...update,
    });
    if (!released) {
      this.finishStale(update.state);
      return false;
    }
    this.settled = true;
    this.clearSuccessRetry();
    this.onSettled(this);
    return true;
  }

  private finishStale(outcome: string): void {
    if (this.settled) return;
    this.settled = true;
    this.clearSuccessRetry();
    this.onStale(this.logId, outcome);
    this.onSettled(this);
  }

  private async commitSuccess(): Promise<boolean> {
    if (this.settled) return false;
    const deleted = await this.coordination.deleteDelivered(
      this.fence.namespace,
      this.logId,
    );
    this.finishDelivered();
    return deleted;
  }

  private finishDelivered(): void {
    if (this.settled) return;
    this.settled = true;
    this.clearSuccessRetry();
    this.onDelivered(this.logId);
    this.onSettled(this);
  }

  /**
   * 协调器停止后本标签的存储连接随时会被关闭，成功提交的自动重试链必须收敛。
   * 晚到的 `succeed()` 仍会直接尝试一次提交；提交不成时由 lease 硬过期交给
   * 下一任重投，服务端按 logId 去重。
   */
  cancelCommitRetries(): void {
    this.commitRetriesCancelled = true;
    this.clearSuccessRetry();
  }

  private scheduleSuccessRetry(): void {
    if (this.settled || this.commitRetriesCancelled || this.successRetryTimer)
      return;
    this.successRetryDelay = this.successRetryDelay === 0
      ? 1000
      : Math.min(this.successRetryDelay * 2, 60_000);
    this.successRetryTimer = setTimeout(() => {
      this.successRetryTimer = null;
      void this.commitSuccess().catch(() => this.scheduleSuccessRetry());
    }, this.successRetryDelay);
  }

  private clearSuccessRetry(): void {
    if (this.successRetryTimer) clearTimeout(this.successRetryTimer);
    this.successRetryTimer = null;
  }
}

export class DeliveryCoordinator {
  private readonly instanceId = generateId();
  private readonly namespaceHash: string;
  private readonly channelName: string;
  private readonly lockName: string;
  private readonly activeReceipts = new Map<string, DeliveryReceipt>();
  private channel: CrossTabChannel | null = null;
  private removeChannelListener: (() => void) | null = null;
  private leader: CoordinatorRecord | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private idleReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private runTask: Promise<void> | null = null;
  private running = false;
  private rerun = false;
  private started = false;
  private contentionCount = 0;
  private expiredLeaseRecoveries = 0;
  private staleOutcomesIgnored = 0;
  private coordinationError = false;
  private retryDelayMs = 0;

  constructor(private readonly options: DeliveryCoordinatorOptions) {
    if (typeof options.namespace !== 'string' || options.namespace.length === 0) {
      throw new Error('delivery coordination namespace is required');
    }
    this.namespaceHash = hashNamespace(options.namespace);
    this.channelName = `aemeath-delivery-v2-${this.namespaceHash}`;
    this.lockName = `aemeath-delivery-leader-${this.namespaceHash}`;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.channel = this.options.crossTab?.createChannel(this.channelName) ?? null;
    if (this.channel) {
      this.removeChannelListener = this.channel.onMessage((message) => {
        void this.handleMessage(message);
      });
    }
    this.emitStatus();
    this.wake('start');
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.clearTimers();
    this.removeChannelListener?.();
    this.removeChannelListener = null;
    this.channel?.close();
    this.channel = null;
    const runTask = this.runTask;
    if (runTask) {
      try {
        await runTask;
      } catch {
        // run() 自身会收敛异常；此处仅保证未来实现变化也不跳过租约释放。
      }
    }
    const leader = this.leader;
    this.leader = null;
    const receipts = [...this.activeReceipts.values()];
    await Promise.all(receipts.map(async (receipt) => {
      try {
        await receipt.releaseIfIdle({
          nextEligibleAt: Date.now(),
          lastRetryReason: 'coordinator-stopped',
        });
      } catch {
        // 无法释放时保留有期限的 lease，由下一任在到期后接管。
      }
    }));
    // 未能释放的（含飞行中）回执不再自动重试成功提交：store 即将随 Offline
    // 卸载关闭，留下的定时器只会永久对已关库空转。
    for (const receipt of this.activeReceipts.values()) {
      receipt.cancelCommitRetries();
    }
    if (leader) {
      try {
        await this.options.coordination.releaseLeadership({
          namespace: this.options.namespace,
          ownerId: this.instanceId,
          epoch: leader.epoch,
          now: Date.now(),
        });
      } catch {
        // 租约本身有期限；关闭失败不会永久阻塞接管。
      }
    }
    this.activeReceipts.clear();
    this.emitStatus();
  }

  getStatus(): DeliveryCoordinationStatus {
    const broadcast = this.channel !== null;
    const mode = broadcast ? 'strong' : 'strong-slower';
    return {
      mode,
      role: this.leader ? 'leader' : 'follower',
      backend: this.options.store.backend,
      leaderEpoch: this.leader?.epoch,
      leaderLeaseUntil: this.leader?.leaseUntil,
      leased: this.activeReceipts.size,
      contentionCount: this.contentionCount,
      expiredLeaseRecoveries: this.expiredLeaseRecoveries,
      staleOutcomesIgnored: this.staleOutcomesIgnored,
      mixedVersionRisk: this.options.store.mixedVersionRisk === true
        || (this.options.store.legacyMigrationCount ?? 0) > 0,
      legacyMigrationCount: this.options.store.legacyMigrationCount ?? 0,
      degradedReason: this.coordinationError
        ? 'coordination-storage-error'
        : broadcast ? undefined : 'broadcast-channel-unavailable',
    };
  }

  wake(_reason = 'work-available'): void {
    if (!this.started) return;
    this.post('work-available');
    this.scheduleWake();
  }

  private scheduleWake(): void {
    if (!this.started) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    if (this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.launchRun();
    }, 0);
  }

  private launchRun(): void {
    if (!this.started || this.runTask) return;
    const task = this.run();
    this.runTask = task;
    void task.then(
      () => {
        if (this.runTask === task) this.runTask = null;
      },
      () => {
        if (this.runTask === task) this.runTask = null;
      },
    );
  }

  notifyStoreCleared(): void {
    this.post('store-cleared');
    this.scheduleWake();
  }

  private async run(): Promise<void> {
    if (!this.started || this.running) return;
    this.running = true;
    try {
      do {
        this.rerun = false;
        await this.runOnce();
      } while (this.started && this.rerun);
      this.coordinationError = false;
      this.retryDelayMs = 0;
    } catch {
      // 协调存储故障必须 fail-closed：本轮不产生网络请求，并以有界退避重试。
      this.coordinationError = true;
      this.retryDelayMs = this.retryDelayMs === 0
        ? 1000
        : Math.min(this.retryDelayMs * 2, 60_000);
      this.emitStatus();
      this.armWakeTimer(this.retryDelayMs);
    } finally {
      this.running = false;
    }
  }

  private async runOnce(): Promise<void> {
    const coordination = this.options.coordination;
    const now = Date.now();
    let leader = this.leader;
    if (!leader || leader.leaseUntil <= now) {
      const acquire = () => coordination.tryAcquireLeadership({
        namespace: this.options.namespace,
        ownerId: this.instanceId,
        now,
        leaseMs: LEADER_LEASE_MS,
      });
      leader = this.options.crossTab
        ? await this.options.crossTab.runExclusive(this.lockName, acquire)
        : await acquire();
      if (!this.started) {
        if (leader) {
          try {
            await coordination.releaseLeadership({
              namespace: this.options.namespace,
              ownerId: this.instanceId,
              epoch: leader.epoch,
              now: Date.now(),
            });
          } catch {
            // 租约有硬截止时间，停止路径不能因释放失败重新启动协调器。
          }
        }
        return;
      }
      if (!leader) {
        this.contentionCount++;
        this.leader = null;
        this.emitStatus();
        await this.armFollowerWake();
        return;
      }
      this.leader = leader;
      this.post('leader-changed');
      this.armHeartbeat();
      this.emitStatus();
    }

    const groups = await this.options.getCandidateGroups();
    if (!this.started) return;
    if (groups.length === 0) {
      if (this.activeReceipts.size === 0) this.armIdleRelease();
      return;
    }
    this.clearIdleRelease();
    const result = await coordination.claimBatch({
      namespace: this.options.namespace,
      ownerId: this.instanceId,
      epoch: leader.epoch,
      now: Date.now(),
      leaseMs: RECORD_LEASE_MS,
      candidateGroups: groups,
      // replayBatchSize is a soft throughput target.  One logical split group
      // must always fit as an indivisible unit or it would starve forever.
      limit: Math.max(
        this.options.replayBatchSize,
        ...groups.map((group) => group.length),
      ),
    });
    if (!this.started) {
      const deliveries = result.records.map((record) => this.createDelivery(record));
      await Promise.all(deliveries.map(async ({ receipt }) => {
        try {
          await receipt.retry({
            nextEligibleAt: Date.now(),
            lastRetryReason: 'coordinator-stopped',
          });
        } catch {
          // 失败时保留有限 lease；绝不在停止边界后把它交给网络层。
        }
      }));
      return;
    }
    if (result.status === 'not-leader') {
      this.loseLeadership();
      return;
    }
    this.expiredLeaseRecoveries += result.expiredLeaseRecoveries;
    if (result.records.length === 0) {
      if (this.activeReceipts.size === 0) this.armIdleRelease();
      this.emitStatus();
      return;
    }
    const deliveries = result.records.map((record) => this.createDelivery(record));
    try {
      await this.options.onClaim(deliveries);
    } catch {
      await Promise.all(deliveries.map(({ receipt }) => receipt.retry({
        nextEligibleAt: Date.now(),
        lastRetryReason: 'coordinator-dispatch-failed',
      })));
    }
    if (result.records.length >= this.options.replayBatchSize) this.rerun = true;
    this.emitStatus();
  }

  private createDelivery(record: LeasedOfflineRecord): ClaimedDelivery {
    const fence: LeasedRecordFence = {
      namespace: this.options.namespace,
      ownerId: this.instanceId,
      epoch: record.leaderEpoch,
      logId: record.logId,
      leaseToken: record.leaseToken,
    };
    const receipt = new DeliveryReceipt(
      this.options.coordination,
      fence,
      () => this.started,
      (settled) => {
        if (this.activeReceipts.get(settled.logId) === settled) {
          this.activeReceipts.delete(settled.logId);
        }
        this.emitStatus();
        this.scheduleWake();
      },
      (logId) => {
        this.post('delivered', logId);
      },
      (logId, outcome) => {
        this.staleOutcomesIgnored++;
        this.options.onStaleOutcome?.(logId, outcome);
      },
    );
    this.activeReceipts.set(record.logId, receipt);
    return { record, receipt };
  }

  private armHeartbeat(): void {
    if (!this.started || this.heartbeatTimer) return;
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      void this.heartbeat();
    }, HEARTBEAT_MS);
  }

  private async heartbeat(): Promise<void> {
    const coordination = this.options.coordination;
    const leader = this.leader;
    if (!this.started || !leader) return;
    const now = Date.now();
    let renewed = false;
    try {
      renewed = await coordination.renewLeadership({
        namespace: this.options.namespace,
        ownerId: this.instanceId,
        epoch: leader.epoch,
        now,
        leaseMs: LEADER_LEASE_MS,
      });
    } catch {
      renewed = false;
    }
    if (!this.started || this.leader !== leader) return;
    if (!renewed) {
      this.loseLeadership();
      return;
    }
    this.leader = { ...leader, heartbeatAt: now, leaseUntil: now + LEADER_LEASE_MS };
    await Promise.all([...this.activeReceipts.values()].map(async (receipt) => {
      try {
        await receipt.renew(now);
      } catch {
        // 下一次 heartbeat 或 lease expiry 会收敛；存储错误由状态层观测。
      }
    }));
    this.emitStatus();
    this.armHeartbeat();
  }

  private async armFollowerWake(): Promise<void> {
    const coordination = this.options.coordination;
    if (!this.started) return;
    try {
      const current = await coordination.getLeadership(this.options.namespace);
      if (!current) {
        this.scheduleWake();
        return;
      }
      const delay = Math.max(50, current.leaseUntil - Date.now() + 5);
      this.armWakeTimer(delay);
    } catch {
      this.armWakeTimer(HEARTBEAT_MS);
    }
  }

  private armIdleRelease(): void {
    if (!this.started || this.idleReleaseTimer || !this.leader) return;
    this.idleReleaseTimer = setTimeout(() => {
      this.idleReleaseTimer = null;
      void this.releaseIdleLeadership();
    }, IDLE_RELEASE_MS);
  }

  private async releaseIdleLeadership(): Promise<void> {
    const coordination = this.options.coordination;
    const leader = this.leader;
    if (!this.started || !leader || this.activeReceipts.size > 0) return;
    try {
      await coordination.releaseLeadership({
        namespace: this.options.namespace,
        ownerId: this.instanceId,
        epoch: leader.epoch,
        now: Date.now(),
      });
    } catch {
      // 租约有硬截止时间；释放失败不会永久阻塞接班，也不能制造未处理 rejection。
    } finally {
      this.loseLeadership();
      this.post('leader-changed');
    }
  }

  private loseLeadership(): void {
    this.leader = null;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.emitStatus();
    if (this.started) void this.armFollowerWake();
  }

  private armWakeTimer(delay: number): void {
    if (!this.started || this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.scheduleWake();
    }, Math.min(Math.max(0, delay), MAX_TIMER_DELAY_MS));
  }

  private clearIdleRelease(): void {
    if (this.idleReleaseTimer) clearTimeout(this.idleReleaseTimer);
    this.idleReleaseTimer = null;
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    if (this.idleReleaseTimer) clearTimeout(this.idleReleaseTimer);
    this.heartbeatTimer = null;
    this.wakeTimer = null;
    this.idleReleaseTimer = null;
  }

  private post(type: CoordinatorMessageType, logId?: string): void {
    this.channel?.postMessage({
      protocolVersion: PROTOCOL_VERSION,
      namespaceHash: this.namespaceHash,
      senderId: this.instanceId,
      type,
      logId,
    } satisfies CoordinatorMessage);
  }

  private async handleMessage(value: unknown): Promise<void> {
    if (!isCoordinatorMessage(value, this.namespaceHash) || value.senderId === this.instanceId) {
      return;
    }
    if (value.type === 'delivered' && value.logId) {
      // Broadcast 只是提示。只有事实源确认正文已不存在，才撤销当前标签的副本。
      try {
        if (await this.options.store.get(value.logId) === null) {
          await this.options.onDelivered?.(value.logId);
        }
      } catch {
        /* storage read failure cannot be interpreted as delivered */
      }
      return;
    }
    this.scheduleWake();
  }

  private emitStatus(): void {
    try {
      this.options.onStatus?.(this.getStatus());
    } catch {
      /* observability callbacks never change coordination outcomes */
    }
  }
}
