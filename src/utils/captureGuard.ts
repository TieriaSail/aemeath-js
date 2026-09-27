/** Bounded, non-recursive diagnostics; never re-enters logger/console. */
let failures = 0;
let lastChannel: string | undefined;
let depth = 0;
export function runCapture(channel: string, action: () => void): void {
  if (depth > 0) return;
  depth++;
  try { action(); }
  catch { failures = Math.min(Number.MAX_SAFE_INTEGER, failures + 1); lastChannel = channel; }
  finally { depth--; }
}
export function getCaptureDiagnostics(): Readonly<{ failures: number; lastChannel?: string }> {
  return { failures, lastChannel };
}
