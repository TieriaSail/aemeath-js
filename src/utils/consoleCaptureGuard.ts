/**
 * Coordinates ErrorCapturePlugin's console.error hook with Logger's own
 * console output. Logger output remains visible but is not a new host error.
 */

let suppressionDepth = 0;

export function isConsoleCaptureSuppressed(): boolean {
  return suppressionDepth > 0;
}

export function runWithoutConsoleCapture<T>(fn: () => T): T {
  suppressionDepth++;
  try {
    return fn();
  } finally {
    suppressionDepth--;
  }
}

