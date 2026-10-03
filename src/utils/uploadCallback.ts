import type { UploadResult } from '../plugins/UploadPlugin';

/** External callbacks can reject with any JS value, including hostile accessors. */
export function readUploadField(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try { return (value as Record<string, unknown>)[key]; } catch { return undefined; }
}

export function uploadErrorText(value: unknown, fallback = 'Unknown upload error'): string {
  if (value === undefined) return fallback;
  try { return String(value); } catch { return fallback; }
}

/** Read the callback's decision once, while still inside the attempt's catch boundary. */
export function snapshotUploadResult(value: unknown): UploadResult {
  // Preserve the existing no-retry interpretation of missing result objects.
  if (value === null || typeof value !== 'object') return { success: false };
  const input = value as UploadResult;
  const success = input.success;
  if (success !== undefined && typeof success !== 'boolean') throw new Error('Invalid upload result: success must be boolean');
  if (success === true) return { success: true };
  // Either explicit permanent decision is sufficient, even if the other
  // optional decision field is unreadable. Never let unused deadlines turn
  // a known terminal response into a retryable callback error.
  let shouldRetry: UploadResult['shouldRetry'];
  let retryReason: UploadResult['retryReason'];
  let unreadableDecision = false;
  try { shouldRetry = input.shouldRetry; } catch { unreadableDecision = true; }
  try { retryReason = input.retryReason; } catch { unreadableDecision = true; }
  const error = uploadErrorText(readUploadField(input, 'error'), 'Unknown error');
  if (shouldRetry === false || retryReason === 'payload') {
    return { success: false, shouldRetry: false,
      retryReason: typeof retryReason === 'string' ? retryReason : undefined, error };
  }
  if (unreadableDecision) throw new Error('Unreadable upload retry decision');
  if (shouldRetry !== undefined && typeof shouldRetry !== 'boolean') throw new Error('Invalid upload retry intent');
  if (retryReason !== undefined && typeof retryReason !== 'string') throw new Error('Invalid upload retry reason');
  const result: UploadResult = { success: false, shouldRetry, retryReason, error };
  if (shouldRetry !== true && retryReason === undefined) return result;

  const retryAfterMs = readUploadField(input, 'retryAfterMs');
  if (typeof retryAfterMs === 'number') result.retryAfterMs = retryAfterMs;
  // Match normalizeRetryAfterMs: a valid millisecond deadline has precedence,
  // including zero and fractional values that round up to a safe integer.
  const hasMilliseconds = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)
    && retryAfterMs >= 0 && Number.isSafeInteger(Math.ceil(retryAfterMs));
  if (!hasMilliseconds) {
    const retryAfter = readUploadField(input, 'retryAfter');
    if (typeof retryAfter === 'string' || retryAfter === null) result.retryAfter = retryAfter;
  }
  return result;
}
