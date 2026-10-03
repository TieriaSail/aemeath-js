import { normalizeCapturedError } from './errorEvidence';
import type { EarlyError } from '../plugins/EarlyErrorCapturePlugin';
import type { AemeathInterface, ErrorInfo } from '../types';

export function normalizeEarlyError(earlyError: EarlyError): ErrorInfo {
  const err = normalizeCapturedError(earlyError.error || {
    message: earlyError.message || 'Early error', stack: earlyError.stack,
  }, {
    channel: earlyError.type === 'error' ? 'global' : earlyError.type,
    phase: 'early', source: earlyError.filename || earlyError.source,
    line: earlyError.lineno, column: earlyError.colno,
  });
  err.type = earlyError.type;
  err.filename = earlyError.filename;
  err.lineno = earlyError.lineno;
  err.colno = earlyError.colno;
  err.source = earlyError.source;
  err.earlyError = true;
  err.captureTimestamp = earlyError.timestamp;
  err.device = earlyError.device;

  return err;
}

export function forwardEarlyError(logger: AemeathInterface, earlyError: EarlyError): void {
  logger.error(`Early ${earlyError.type} error`, { error: normalizeEarlyError(earlyError), tags: { source: 'early-error' } });
}
