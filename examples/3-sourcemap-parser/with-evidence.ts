import { createParser } from 'aemeath-js/parser';
import type { LogEntry } from 'aemeath-js';

// 为一个环境/release 复用解析器；不会在 import 时发送请求。
// Reuse a parser for one environment/release; importing this file sends no requests.
export function createErrorInspector(sourceMapBaseUrl: string) {
  const parser = createParser({ sourceMapBaseUrl });

  return async function inspectError(entry: LogEntry) {
    if (!entry.error) return undefined;
    const result = await parser.parseError(entry.error);
    return {
      message: result.message,
      status: result.status,
      // mapped 表示至少一帧成功；仍应检查每帧的 resolved。
      // mapped means at least one frame succeeded; inspect each frame's resolved flag.
      frames: result.frames,
      browserLocation: entry.error.evidence?.browserLocation,
      normalizationIssues: entry.error.evidence?.normalization.issues ?? [],
    };
  };
}
