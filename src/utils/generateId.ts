/**
 * Lightweight unique ID generator for log tracking.
 *
 * Uses crypto.randomUUID() when available (modern browsers),
 * falls back to timestamp + random string for older environments.
 */
export function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
}
