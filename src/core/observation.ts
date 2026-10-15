import { getSdkSplitId } from '../utils/splitIdentity';
import type { AemeathPlugin, LogEntry, LogLevel, LogOptions } from '../types';

/** Internal optional capability. No ordinary log/listener semantics are changed. */
export const observationMetadata: unique symbol = Symbol.for('aemeath.observation-metadata.v1');
export const observationPreparation: unique symbol = Symbol.for('aemeath.observation-preparation.v1');
export interface ObservationInput {
  logId: string;
  timestamp: number;
  level: LogLevel;
  message: string;
  options: LogOptions;
  release?: string;
  environment?: string;
}
export type ObservationResult =
  | { state: 'prepared'; entries: LogEntry[] }
  | { state: 'filtered' | 'rejected' | 'unavailable' };
export interface ObservationHost {
  [observationMetadata](owner: AemeathPlugin): { release?: string; environment?: string } | null;
  [observationPreparation](owner: AemeathPlugin, input: ObservationInput): ObservationResult;
}
interface Preparation { failed: boolean }
interface PreparationState { active: Preparation | undefined }
const preparationKey = Symbol.for('aemeath.observation-scope.v1');
function sharedState(create = false): PreparationState | null {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, preparationKey);
    if (descriptor) {
      if (!('value' in descriptor) || !descriptor.value || !Object.getOwnPropertyDescriptor(descriptor.value, 'active')?.writable) return null;
      return descriptor.value as PreparationState;
    }
    if (!create) return null;
    const value: PreparationState = { active: undefined };
    Object.defineProperty(globalThis, preparationKey, { value });
    return value;
  } catch { return null; }
}
export function isPreparingObservation(): boolean { return sharedState()?.active !== undefined; }
export function rejectObservation(): void { const active = sharedState()?.active; if (active) active.failed = true; }
export function capturePreparation(prepare: () => LogEntry[] | void): ObservationResult {
  const state = sharedState(true);
  if (!state) return { state: 'rejected' };
  const previous = state.active;
  const scope = { failed: false };
  state.active = scope;
  try {
    const entries = prepare();
    if (scope.failed) return { state: 'rejected' };
    if (!entries?.length) return { state: 'filtered' };
    // Detach from plugin/application mutation before the durable boundary.
    const snapshot: LogEntry[] = JSON.parse(JSON.stringify(entries));
    if (scope.failed) return { state: 'rejected' };
    if (snapshot.some(entry => !entry || typeof entry.logId !== 'string' || !entry.logId || !['debug', 'info', 'track', 'warn', 'error'].includes(entry.level) || typeof entry.message !== 'string' || !Number.isFinite(entry.timestamp))) return { state: 'rejected' };
    if (new Set(snapshot.map(entry => entry.logId)).size !== snapshot.length) return { state: 'rejected' };
    const groups = new Map<string, LogEntry[]>();
    for (const entry of snapshot) { const id = getSdkSplitId(entry); if (id !== undefined) groups.set(id, [...(groups.get(id) ?? []), entry]); }
    for (const group of groups.values()) {
      const total = Number(group[0]!.tags?.splitTotal);
      const indices = group.map(entry => Number(entry.tags?.splitIndex));
      if (total !== group.length || !Number.isSafeInteger(total) || new Set(indices).size !== total || group.some(entry => Number(entry.tags?.splitTotal) !== total) || indices.some(index => !Number.isSafeInteger(index) || index < 1 || index > total)) return { state: 'rejected' };
    }
    return { state: 'prepared', entries: snapshot };
  } catch { return { state: 'rejected' }; }
  finally { state.active = previous; }
}
