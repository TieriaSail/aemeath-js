/**
 * 可选的浏览器多标签可靠补传插件。
 *
 * 它不进入根入口、PlatformAdapter 或小程序入口。只有显式从
 * `aemeath-js/plugins/CrossTabDeliveryPlugin` 导入并安装时，才会建立
 * BroadcastChannel/Web Locks/IndexedDB leader + record lease 协调。
 */

import type { AemeathInterface, AemeathPlugin } from '../types';
import { PluginPriority } from '../types';
import type {
  OfflineCrossTabRecoveryPort,
  OfflinePersistencePlugin,
} from './OfflinePersistencePlugin';
import type { UploadPlugin } from './UploadPlugin';
import { createOfflineStore as createCoordinatedOfflineStore } from './offline/CoordinatedOfflineStore';
import {
  CROSS_TAB_DELIVERY_CAPABILITY,
  type CrossTabDeliveryCapability,
} from './offline/CrossTabCapability';
import { createOfflineCoordinationStore } from './offline/OfflineCoordinationStore';
import {
  DeliveryCoordinator,
  type CrossTabAdapter,
  type CrossTabChannel,
  type DeliveryCoordinationStatus,
} from './offline/DeliveryCoordinator';

export type CrossTabDeliveryState =
  'waiting' | 'active' | 'unsupported' | 'stopped';

export interface CrossTabDeliveryStatus extends DeliveryCoordinationStatus {
  state: CrossTabDeliveryState;
}

export interface CrossTabDeliveryPluginOptions {
  /**
   * 持久交付隔离域。仅跨标签协议使用；省略时由 OfflinePersistence 的 dbName/key 派生。
   */
  namespace?: string;
  /** 输出插件自身的诊断日志。 */
  debug?: boolean;
}

export const CROSS_TAB_DELIVERY_EVENTS = {
  status: 'cross-tab-delivery:status',
  leaderChanged: 'cross-tab-delivery:leader-changed',
  leaseRecovered: 'cross-tab-delivery:lease-recovered',
  degraded: 'cross-tab-delivery:degraded',
  migration: 'cross-tab-delivery:migration',
  staleOutcomeIgnored: 'cross-tab-delivery:stale-outcome-ignored',
} as const;

function unavailableStatus(
  state: Exclude<CrossTabDeliveryState, 'active'>,
  reason: string,
): CrossTabDeliveryStatus {
  return {
    state,
    mode: 'disabled',
    role: 'disabled',
    backend: 'noop',
    leased: 0,
    contentionCount: 0,
    expiredLeaseRecoveries: 0,
    staleOutcomesIgnored: 0,
    mixedVersionRisk: false,
    legacyMigrationCount: 0,
    degradedReason: reason,
  };
}

/** 浏览器原生能力只在该可选插件内探测。 */
function createBrowserCrossTabAdapter(): CrossTabAdapter {
  const broadcastSupported = (() => {
    try {
      return typeof BroadcastChannel === 'function';
    } catch {
      return false;
    }
  })();
  const webLocksSupported = (() => {
    try {
      return (
        typeof navigator !== 'undefined' &&
        navigator.locks != null &&
        typeof navigator.locks.request === 'function'
      );
    } catch {
      return false;
    }
  })();

  return {
    broadcastSupported,
    webLocksSupported,
    createChannel(name: string): CrossTabChannel | null {
      if (!broadcastSupported) return null;
      try {
        const channel = new BroadcastChannel(name);
        return {
          postMessage(message): void {
            try {
              channel.postMessage(message);
            } catch {
              // 唤醒提示丢失不影响正确性；下一轮 IDB lease 扫描仍会收敛。
            }
          },
          onMessage(handler): () => void {
            const listener = (event: MessageEvent<unknown>): void =>
              handler(event.data);
            channel.addEventListener('message', listener);
            return () => channel.removeEventListener('message', listener);
          },
          close(): void {
            try {
              channel.close();
            } catch {
              // 已关闭频道再次 close 不影响持久租约。
            }
          },
        };
      } catch {
        return null;
      }
    },
    async runExclusive<T>(name: string, task: () => Promise<T>): Promise<T> {
      if (!webLocksSupported) return task();
      let taskStarted = false;
      try {
        return await navigator.locks.request(
          name,
          { mode: 'exclusive' },
          () => {
            taskStarted = true;
            return task();
          },
        );
      } catch (error) {
        // A rejection from inside the protected task is not a Web Locks
        // failure. Re-running it outside the lock could duplicate a state
        // transition that committed just before reporting an error.
        if (taskStarted) throw error;
        // Web Locks 只是降低争用，失败时回到 IDB 事务选主。
        return task();
      }
    },
  };
}

export class CrossTabDeliveryPlugin implements AemeathPlugin {
  readonly name = 'cross-tab-delivery';
  readonly version = '2.6.0';
  readonly priority: number = PluginPriority.LATE + 2;
  readonly description = '浏览器多标签页单一补传协调（显式启用）';

  readonly [CROSS_TAB_DELIVERY_CAPABILITY]: CrossTabDeliveryCapability;

  private readonly debugEnabled: boolean;
  private logger: AemeathInterface | null = null;
  private port: OfflineCrossTabRecoveryPort | null = null;
  private coordinator: DeliveryCoordinator | null = null;
  private handlers: Array<{ event: string; fn: (...args: unknown[]) => void }> =
    [];
  private attachTask: Promise<void> | null = null;
  private detachTask: Promise<void> | null = null;
  private rerunAttach = false;
  private generation = 0;
  private status: CrossTabDeliveryStatus = unavailableStatus(
    'stopped',
    'not-installed',
  );

  constructor(options: CrossTabDeliveryPluginOptions = {}) {
    this.debugEnabled = options.debug === true;
    this[CROSS_TAB_DELIVERY_CAPABILITY] = {
      createStore: createCoordinatedOfflineStore,
      createCoordination: createOfflineCoordinationStore,
      namespace: options.namespace?.trim() || undefined,
    };
  }

  install(logger: AemeathInterface): void {
    this.generation++;
    this.logger = logger;
    this.status = unavailableStatus('waiting', 'dependencies-initializing');

    const onInstall = (...args: unknown[]): void => {
      if (args[0] === 'upload' || args[0] === 'offline-persistence') {
        this.generation++;
        this.scheduleAttach();
      }
    };
    const onUninstall = (...args: unknown[]): void => {
      if (args[0] === 'upload' || args[0] === 'offline-persistence') {
        this.generation++;
        this.scheduleDetach(
          args[0] === 'upload'
            ? 'upload-plugin-uninstalled'
            : 'offline-plugin-uninstalled',
        );
      }
    };
    this.handlers.push(
      { event: 'plugin:install', fn: onInstall },
      { event: 'plugin:uninstall', fn: onUninstall },
    );
    logger.on('plugin:install', onInstall);
    logger.on('plugin:uninstall', onUninstall);
    this.scheduleAttach();
  }

  uninstall(logger?: AemeathInterface): void {
    const host = logger ?? this.logger;
    this.generation++;
    for (const { event, fn } of this.handlers) {
      try {
        host?.off(event, fn);
      } catch {
        // 一个宿主监听器异常不能阻断租约释放。
      }
    }
    this.handlers = [];
    this.logger = null;
    this.scheduleDetach('plugin-uninstalled');
  }

  getStatus(): CrossTabDeliveryStatus {
    return { ...this.status };
  }

  private scheduleAttach(): void {
    if (!this.logger || this.coordinator) return;
    if (this.detachTask) {
      this.rerunAttach = true;
      return;
    }
    if (this.attachTask) {
      this.rerunAttach = true;
      return;
    }
    const generation = this.generation;
    const task = this.attach(generation);
    this.attachTask = task;
    void task.finally(() => {
      if (this.attachTask === task) this.attachTask = null;
      if (this.rerunAttach) {
        this.rerunAttach = false;
        this.scheduleAttach();
      }
    });
  }

  private scheduleDetach(reason: string): void {
    const generation = this.generation;
    if (this.detachTask) {
      const previous = this.detachTask;
      const task = previous
        .catch(() => undefined)
        .then(() => this.detach(reason, generation));
      this.detachTask = task;
      void task.finally(() => {
        if (this.detachTask !== task) return;
        this.detachTask = null;
        if (this.rerunAttach) {
          this.rerunAttach = false;
          this.scheduleAttach();
        }
      });
      return;
    }
    const task = this.detach(reason, generation);
    this.detachTask = task;
    void task.finally(() => {
      if (this.detachTask !== task) return;
      this.detachTask = null;
      if (this.rerunAttach) {
        this.rerunAttach = false;
        this.scheduleAttach();
      }
    });
  }

  private async attach(generation: number): Promise<void> {
    const logger = this.logger;
    if (!logger || logger.platform.type !== 'browser') {
      this.updateStatus(unavailableStatus('unsupported', 'browser-only'));
      return;
    }
    const upload = logger.getPluginInstance('upload') as
      UploadPlugin | undefined;
    const offline = logger.getPluginInstance('offline-persistence') as
      | (OfflinePersistencePlugin & {
          reserveCrossTabRecovery?: OfflinePersistencePlugin['reserveCrossTabRecovery'];
        })
      | undefined;
    if (!upload || typeof offline?.reserveCrossTabRecovery !== 'function') {
      this.updateStatus(
        unavailableStatus('waiting', 'upload-and-offline-plugins-required'),
      );
      return;
    }

    let port: OfflineCrossTabRecoveryPort | null = null;
    try {
      port = await offline.reserveCrossTabRecovery(
        this[CROSS_TAB_DELIVERY_CAPABILITY],
      );
      if (generation !== this.generation || this.logger !== logger) {
        return;
      }
      if (!port || port.store.backend !== 'indexeddb') {
        this.updateStatus(
          unavailableStatus('unsupported', 'indexeddb-required'),
        );
        return;
      }

      const coordination = port.coordination;
      const coordinator = new DeliveryCoordinator({
        store: port.store,
        coordination,
        crossTab: createBrowserCrossTabAdapter(),
        namespace: port.namespace,
        replayBatchSize: port.replayBatchSize,
        getCandidateGroups: () => port!.getCandidateGroups(),
        onClaim: (deliveries) => port!.acceptClaims(deliveries),
        onDelivered: (logId) => port!.acknowledgeRemoteDelivery(logId),
        onStatus: (status) => this.updateCoordinatorStatus(status),
        onStaleOutcome: (logId, outcome) =>
          this.emit(CROSS_TAB_DELIVERY_EVENTS.staleOutcomeIgnored, {
            logId,
            outcome,
          }),
      });
      this.port = port;
      this.coordinator = coordinator;
      port.connect(coordinator);
      coordinator.start();
      this.updateCoordinatorStatus(coordinator.getStatus());
    } catch (error) {
      this.debug('failed to attach cross-tab recovery:', error);
      if (generation === this.generation) {
        this.updateStatus(
          unavailableStatus(
            'unsupported',
            'coordination-initialization-failed',
          ),
        );
      }
    }
  }

  private async detach(reason: string, generation: number): Promise<void> {
    const coordinator = this.coordinator;
    const port = this.port;
    this.coordinator = null;
    this.port = null;
    try {
      await coordinator?.stop();
    } catch (error) {
      this.debug('failed to stop cross-tab coordinator:', error);
    } finally {
      if (coordinator) port?.disconnect(coordinator);
    }
    if (generation === this.generation) {
      this.updateStatus(unavailableStatus('stopped', reason));
    }
  }

  private updateCoordinatorStatus(next: DeliveryCoordinationStatus): void {
    const previous = this.status;
    const status: CrossTabDeliveryStatus = { ...next, state: 'active' };
    this.updateStatus(status);
    if (
      previous.role !== status.role ||
      previous.leaderEpoch !== status.leaderEpoch
    ) {
      this.emit(CROSS_TAB_DELIVERY_EVENTS.leaderChanged, status);
    }
    if (status.expiredLeaseRecoveries > previous.expiredLeaseRecoveries) {
      this.emit(CROSS_TAB_DELIVERY_EVENTS.leaseRecovered, {
        count: status.expiredLeaseRecoveries - previous.expiredLeaseRecoveries,
        total: status.expiredLeaseRecoveries,
      });
    }
    if (
      status.degradedReason &&
      (previous.degradedReason !== status.degradedReason ||
        previous.mode !== status.mode)
    ) {
      this.emit(CROSS_TAB_DELIVERY_EVENTS.degraded, {
        mode: status.mode,
        reason: status.degradedReason,
      });
    }
    if (status.legacyMigrationCount > previous.legacyMigrationCount) {
      this.emit(CROSS_TAB_DELIVERY_EVENTS.migration, {
        legacyRecords: status.legacyMigrationCount,
      });
    }
  }

  private updateStatus(status: CrossTabDeliveryStatus): void {
    this.status = status;
    this.emit(CROSS_TAB_DELIVERY_EVENTS.status, status);
  }

  private emit(event: string, payload: unknown): void {
    try {
      this.logger?.emit(event, payload);
    } catch {
      // 观测回调永远不能改变协调结果。
    }
  }

  private debug(message: string, error?: unknown): void {
    if (!this.debugEnabled || typeof console === 'undefined' || !console.debug)
      return;
    console.debug(`[Aemeath:CrossTabDelivery] ${message}`, error ?? '');
  }
}

export type {
  CrossTabAdapter,
  CrossTabChannel,
  DeliveryCoordinationStatus,
} from './offline/DeliveryCoordinator';
