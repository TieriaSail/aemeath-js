import {
  normalizeCapturedError,
  getCaptureDiagnostics,
  type AemeathInterface,
} from 'aemeath-js';

// 手动上报 catch 中的 unknown；自动捕获无需额外调用。
// Report an unknown caught value; automatic capture needs no extra call.
export function reportCaughtError(logger: AemeathInterface, reason: unknown) {
  const error = normalizeCapturedError(reason, { channel: 'manual' });
  logger.error('Operation failed', { error });
  return error;
}

// 读取本模块的采集失败计数；不重置、不自动上报。
// Read this module's capture failures without resetting or uploading them.
export function readCaptureHealth() {
  return getCaptureDiagnostics();
}
