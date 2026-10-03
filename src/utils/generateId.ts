/**
 * Lightweight unique ID generator for log tracking.
 *
 * Uses crypto.randomUUID() when available (modern browsers),
 * falls back to timestamp + random string for older environments.
 */
export function generateId(): string {
  try {
    const provider = typeof crypto === 'undefined' ? undefined : crypto;
    const randomUUID = provider?.randomUUID;
    if (typeof randomUUID === 'function') return randomUUID.call(provider);
  } catch {
    // Some host bridges expose crypto but throw on access or invocation.
    // Keep the existing fallback available in those environments too.
  }
  return `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
}
