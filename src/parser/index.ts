/**
 * SourceMap 解析模块
 *
 * 使用方法：
 * ```typescript
 * import { createParser } from '@/utils/logger-modular/parser';
 *
 * // 业务层负责拼接完整路径（包含环境和版本）
 * const parser = createParser({
 *   sourceMapBaseUrl: 'https://example.com/sourcemaps/dist-test/1.1.1'
 * });
 *
 * const result = await parser.parse(errorStack);
 *
 * result.frames.forEach(frame => {
 *   if (frame.resolved && frame.original) {
 *     console.log(`${frame.original.fileName}:${frame.original.line}`);
 *   }
 * });
 * ```
 */

export { SourceMapParser, createParser } from './SourceMapParser.client';

export type {
  ParsedStackFrame,
  ParseResult,
  RawSourceMap,
  SourceMapParserConfig,
} from './SourceMapParser.client';
