/** Observe an unsupported async result without applying it to the synchronous pipeline. */
export function ignoreAsyncResult(value: unknown): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  // Read once: then may be an accessor or belong to a Promise from another realm.
  const then = (value as { then?: unknown }).then;
  if (typeof then !== 'function') return false;
  try {
    // Neither outcome is used. Returning undefined from both handlers also keeps
    // a native Promise's derived result fulfilled, without retaining log/context data.
    const ignore = (): void => {};
    Reflect.apply(then, value, [ignore, ignore]);
  } catch {
    // A broken thenable is still an unsupported async result; keep the input log.
  }
  return true;
}
