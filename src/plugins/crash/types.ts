import type { LogEntry } from '../../types';
import type { RouteMatchConfig } from '../../utils/routeMatcher';
export type CrashMode = 'recovery' | 'realtime' | 'hybrid';
export interface CrashCheckpoint {
  routeKey?: string;
  operation?: { name: string; phase: 'pending' | 'done' | 'failed' };
}
export interface CrashBreadcrumb { name: string; phase?: 'pending' | 'done' | 'failed' }
export interface CrashDetectionOptions {
  enabled?: boolean;
  namespace: string;
  deliveryScope: string;
  createWorker: () => Worker;
  mode?: CrashMode;
  realtime?: {
    monitorMainThreadStall?: boolean;
    stallThresholdMs?: number;
    coordination?: 'indexeddb' | 'shared-worker';
    createSharedWorker?: () => SharedWorker;
  };
  sampleRate?: number;
  routeMatch?: RouteMatchConfig;
  checkpoint?: {
    collect?: () => CrashCheckpoint;
    sanitize?: (checkpoint: CrashCheckpoint) => CrashCheckpoint | null;
  };
}
export interface CrashStatus {
  state: 'idle' | 'starting' | 'active' | 'disabled' | 'stopped';
  requestedMode: CrashMode;
  mode: 'recovery' | 'none';
  implementedModes: readonly ['recovery'];
  reason?: string;
  capabilities: { worker: boolean; indexedDB: boolean; lifecycle: boolean };
}
export type PageState = 'visible' | 'hidden' | 'frozen' | 'bfcache' | 'ended' | 'unknown';
export interface PageRecord {
  key: string;
  kind: 'page';
  id: string;
  state: PageState;
  started: number;
  seen: number;
  mainSeen: number;
  revision: number;
  eligibleAfter: number;
  beats: number;
  checkpoint: CrashCheckpoint;
  breadcrumbs: Array<CrashBreadcrumb & { timestamp: number }>;
  release?: string;
  environment?: string;
}
export interface CrashEvent {
  key: string;
  kind: 'event';
  id: string;
  pageId: string;
  timestamp: number;
  created: number;
  checkpoint: CrashCheckpoint;
  breadcrumbs: PageRecord['breadcrumbs'];
  release?: string;
  environment?: string;
  prepared?: LogEntry[];
  acknowledged: string[];
  lease?: { token: string; until: number };
  nextEligibleAt: number;
  attempts: number;
}
export interface ClaimedEvent { event: CrashEvent; token: string }
export const HEARTBEAT_MS = 5_000;
export const WARMUP_MS = 30_000;
export const TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const LEASE_MS = 30_000;
export const PROTOCOL = 'aemeath-crash-v1';
export interface CrashRequest { protocol: typeof PROTOCOL; session: string; id: number; op: string; data: unknown }
export interface CrashResponse { protocol: typeof PROTOCOL; session: string; id: number; ok: boolean; data?: unknown; reason?: string }
