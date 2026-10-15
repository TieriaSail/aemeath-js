import type { CrashBreadcrumb, CrashCheckpoint } from './types';
function label(value: unknown): string | undefined {
  // Semantic identifiers only: URLs, queries, paths, whitespace and arbitrary text are excluded.
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,80}$/.test(value) ? value : undefined;
}
export function checkpointSnapshot(value: unknown): CrashCheckpoint {
  const data = value as CrashCheckpoint | null;
  if (!data || typeof data !== 'object') return {};
  const result: CrashCheckpoint = {};
  const routeKey = label(data.routeKey);
  if (routeKey) result.routeKey = routeKey;
  const operation = breadcrumbSnapshot(data.operation);
  if (operation?.phase) result.operation = { name: operation.name, phase: operation.phase };
  return result;
}
export function breadcrumbSnapshot(value: unknown): CrashBreadcrumb | null {
  const data = value as CrashBreadcrumb | null;
  if (!data || typeof data !== 'object') return null;
  const name = label(data.name);
  if (!name) return null;
  const phase = data.phase;
  return { name, ...(['pending', 'done', 'failed'].includes(phase ?? '') ? { phase } : {}) };
}
