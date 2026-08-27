/**
 * Coordinates ErrorCapturePlugin's console.error hook with Logger's own
 * console output. Logger output is intentionally still visible, but must not
 * be interpreted as a new host console error.
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

