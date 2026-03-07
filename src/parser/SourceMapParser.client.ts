/**
 * SourceMap 客户端解析器
 *
 * 简洁稳定的 SourceMap 解析方案
 * 使用 source-map-js 库解析压缩混淆后的代码堆栈
 *
 * 注意：使用 source-map-js 而非 source-map，因为后者需要 WASM 初始化
 */

import { SourceMapConsumer } from 'source-map-js';

// ==================== 调试日志工具 ====================

/**
 * 创建调试日志器
 * @param enabled 是否启用调试模式
 */
function createDebugLogger(enabled: boolean) {
  return {
    log: (...args: unknown[]) => enabled && console.log('[SourceMap]', ...args),
    warn: (...args: unknown[]) =>
      enabled && console.warn('[SourceMap]', ...args),
    error: (...args: unknown[]) => console.error('[SourceMap]', ...args), // 错误始终输出
  };
}

// ==================== 类型定义 ====================

/**
 * 解析后的堆栈帧
 */
export interface ParsedStackFrame {
  /** 原始行内容 */
  raw: string;

  /** 混淆后的位置 */
  minified?: {
    fileName: string;
    line: number;
    column: number;
    functionName?: string;
  };

  /** 原始位置（解析后） */
  original?: {
    fileName: string;
    line: number;
    column: number;
    functionName: string | null;
    source?: string; // 源代码行
  };

  /** 是否成功解析 */
  resolved: boolean;
}

/**
 * 解析结果
 */
export interface ParseResult {
  /** 原始错误信息 */
  message: string;
  /** 原始堆栈 */
  stack: string;
  /** 解析后的堆栈帧 */
  frames: ParsedStackFrame[];
  /** 是否成功 */
  success: boolean;
  /** 错误信息 */
  error?: string;
}

/**
 * SourceMap 内容格式
 */
export interface RawSourceMap {
  version: number;
  sources: string[];
  sourcesContent?: (string | null)[];
  names: string[];
  mappings: string;
  file?: string;
  sourceRoot?: string;
}

// ==================== 核心解析器 ====================

/**
 * SourceMap 解析器配置
 */
export interface SourceMapParserConfig {
  /**
   * SourceMap 基础 URL（完整路径，包含环境和版本）
   *
   * 例如：https://example.com/sourcemaps/dist-test/1.1.3
   *
   * 解析时只拼接相对路径：{sourceMapBaseUrl}/{relativePath}.map
   * 结果：https://example.com/sourcemaps/dist-test/1.1.3/static/js/579.xxx.js.map
   *
   * 注意：环境和版本的拼接应在业务层完成，库不关心具体的路径结构
   */
  sourceMapBaseUrl: string;

  /**
   * 请求超时时间（毫秒）
   * @default 10000
   */
  timeout?: number;

  /**
   * 是否启用缓存
   * @default true
   */
  enableCache?: boolean;

  /**
   * 缓存最大条目数（LRU 策略）
   * @default 50
   */
  maxCacheSize?: number;

  /**
   * 是否启用调试模式（输出详细日志）
   * @default false
   */
  debug?: boolean;
}

/**
 * SourceMap 客户端解析器
 *
 * @example
 * ```typescript
 * // 业务层负责拼接完整路径（包含环境和版本）
 * const parser = new SourceMapParser({
 *   sourceMapBaseUrl: 'https://cdn.example.com/sourcemaps/dist/1.0.0'
 * });
 *
 * const result = await parser.parse(errorStack);
 * console.log(result.frames);
 * ```
 */
/**
 * LRU 缓存条目
 */
interface CacheEntry {
  value: RawSourceMap;
  lastAccess: number;
}

export class SourceMapParser {
  private config: Required<SourceMapParserConfig>;
  private cache = new Map<string, CacheEntry>();
  private debug: ReturnType<typeof createDebugLogger>;

  /** 从 sourceMapBaseUrl 提取的域名（用于判断资源归属） */
  private readonly resourceDomain: string;

  constructor(config: SourceMapParserConfig) {
    this.config = {
      sourceMapBaseUrl: config.sourceMapBaseUrl,
      timeout: config.timeout ?? 10000,
      enableCache: config.enableCache ?? true,
      maxCacheSize: config.maxCacheSize ?? 50,
      debug: config.debug ?? false,
    };
    this.debug = createDebugLogger(this.config.debug);

    // 从 sourceMapBaseUrl 提取域名
    this.resourceDomain = this.extractDomain(config.sourceMapBaseUrl);
  }

  /**
   * 从 URL 中提取域名部分
   */
  private extractDomain(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.hostname; // 例如 cdn.example.com
    } catch {
      return '';
    }
  }

  /**
   * 解析错误堆栈
   *
   * @param stack 错误堆栈字符串
   * @returns 解析结果
   */
  async parse(stack: string): Promise<ParseResult> {
    if (!stack) {
      return {
        message: '',
        stack: '',
        frames: [],
        success: false,
        error: '堆栈为空',
      };
    }

    try {
      const lines = stack.split('\n');
      const frames: ParsedStackFrame[] = [];

      // 提取错误消息（第一行）
      const message = lines[0] || '';

      for (const line of lines) {
        const frame = await this.parseStackLine(line);
        frames.push(frame);
      }

      return {
        message,
        stack,
        frames,
        success: true,
      };
    } catch (error) {
      return {
        message: '',
        stack,
        frames: [],
        success: false,
        error: error instanceof Error ? error.message : '解析失败',
      };
    }
  }

  /**
   * 解析单行堆栈
   */
  private async parseStackLine(line: string): Promise<ParsedStackFrame> {
    const trimmed = line.trim();

    // 提取位置信息
    const location = this.extractLocation(trimmed);

    if (!location) {
      // 无法提取位置信息，返回原始行
      return { raw: trimmed, resolved: false };
    }

    // 检查是否是我们的资源文件
    if (!this.isOurResource(location.fileName)) {
      return {
        raw: trimmed,
        minified: location,
        resolved: false,
      };
    }

    try {
      // 加载 SourceMap
      const sourceMap = await this.loadSourceMap(location.fileName);

      if (!sourceMap) {
        return {
          raw: trimmed,
          minified: location,
          resolved: false,
        };
      }

      // 解析原始位置（同步）
      const original = this.resolvePosition(
        sourceMap,
        location.line,
        location.column,
      );

      if (!original) {
        return {
          raw: trimmed,
          minified: location,
          resolved: false,
        };
      }

      return {
        raw: trimmed,
        minified: location,
        original,
        resolved: true,
      };
    } catch (error) {
      this.debug.warn('解析失败:', error);
      return {
        raw: trimmed,
        minified: location,
        resolved: false,
      };
    }
  }

  /**
   * 提取堆栈行中的位置信息
   */
  private extractLocation(line: string): {
    fileName: string;
    line: number;
    column: number;
    functionName?: string;
  } | null {
    // 格式1: at functionName (https://xxx/file.js:1:22595)
    const match1 = line.match(/at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/);
    if (match1 && match1[1] && match1[2] && match1[3] && match1[4]) {
      return {
        functionName: match1[1],
        fileName: match1[2],
        line: parseInt(match1[3], 10),
        column: parseInt(match1[4], 10),
      };
    }

    // 格式2: at https://xxx/file.js:1:22595
    const match2 = line.match(/at\s+(.+?):(\d+):(\d+)/);
    if (match2 && match2[1] && match2[2] && match2[3]) {
      return {
        fileName: match2[1],
        line: parseInt(match2[2], 10),
        column: parseInt(match2[3], 10),
      };
    }

    return null;
  }

  /**
   * 检查是否是需要解析的资源文件
   * 匹配从 sourceMapBaseUrl 提取的域名，或 localhost（开发环境）
   */
  private isOurResource(fileName: string): boolean {
    return (
      (this.resourceDomain && fileName.includes(this.resourceDomain)) ||
      fileName.includes('localhost')
    );
  }

  /**
   * 加载 SourceMap
   */
  private async loadSourceMap(fileUrl: string): Promise<RawSourceMap | null> {
    // 提取相对路径：.../static/js/index.xxx.js -> static/js/index.xxx.js
    const staticMatch = fileUrl.match(/\/static\/(js|css)\/([^?#]+)/);
    if (!staticMatch) {
      this.debug.warn('无法提取文件路径:', fileUrl);
      return null;
    }

    const relativePath = `static/${staticMatch[1]}/${staticMatch[2]}`;
    // 直接拼接：{sourceMapBaseUrl}/{relativePath}.map
    // sourceMapBaseUrl 已包含完整路径（环境、版本等由业务层拼接）
    const sourceMapUrl = `${this.config.sourceMapBaseUrl}/${relativePath}.map`;

    // 检查缓存（LRU 策略）
    if (this.config.enableCache) {
      const cached = this.cache.get(sourceMapUrl);
      if (cached) {
        // 更新最后访问时间
        cached.lastAccess = Date.now();
        return cached.value;
      }
    }

    try {
      this.debug.log('加载:', sourceMapUrl);

      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.config.timeout,
      );

      const response = await fetch(sourceMapUrl, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        this.debug.warn('请求失败:', response.status, sourceMapUrl);
        return null;
      }

      const sourceMap: RawSourceMap = await response.json();

      // 调试：检查 SourceMap 结构
      this.debug.log('SourceMap 结构:', {
        version: sourceMap.version,
        sourcesCount: sourceMap.sources?.length,
        sourcesContentCount: sourceMap.sourcesContent?.length,
        hasSourcesContent: !!sourceMap.sourcesContent,
        firstSourceContentLength: sourceMap.sourcesContent?.[0]?.length,
        names: sourceMap.names?.length,
      });

      // 缓存（带 LRU 淘汰）
      if (this.config.enableCache) {
        this.addToCache(sourceMapUrl, sourceMap);
      }

      return sourceMap;
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        this.debug.warn('请求超时:', sourceMapUrl);
      } else {
        this.debug.error('加载失败:', error);
      }
      return null;
    }
  }

  /**
   * 添加到缓存（LRU 策略）
   */
  private addToCache(key: string, value: RawSourceMap): void {
    // 如果缓存已满，移除最久未访问的条目
    if (this.cache.size >= this.config.maxCacheSize) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;

      this.cache.forEach((entry, entryKey) => {
        if (entry.lastAccess < oldestTime) {
          oldestTime = entry.lastAccess;
          oldestKey = entryKey;
        }
      });

      if (oldestKey) {
        this.debug.log('缓存已满，移除最久未访问的条目:', oldestKey);
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, {
      value,
      lastAccess: Date.now(),
    });
  }

  /**
   * 解析原始位置
   *
   * 注意：source-map-js 是同步 API，不需要 await
   */
  private resolvePosition(
    sourceMap: RawSourceMap,
    line: number,
    column: number,
  ): {
    fileName: string;
    line: number;
    column: number;
    functionName: string | null;
    source?: string;
  } | null {
    try {
      // source-map-js 的 SourceMapConsumer 是同步构造的
      const consumer = new SourceMapConsumer(sourceMap as any);

      const pos = consumer.originalPositionFor({ line, column });

      if (!pos.source) {
        return null;
      }

      // 获取源代码片段（上下文各 3 行）
      let source: string | undefined;
      const contextLines = 3;
      try {
        this.debug.log('获取源码 - source:', pos.source, 'line:', pos.line);
        const content = consumer.sourceContentFor(pos.source, true);
        this.debug.log(
          'sourceContentFor 返回:',
          content ? `${content.length} 字符` : 'null/undefined',
        );

        if (content && pos.line) {
          const allLines = content.split('\n');
          const startLine = Math.max(0, pos.line - contextLines - 1);
          const endLine = Math.min(allLines.length, pos.line + contextLines);

          // 返回带上下文的代码片段（已格式化，带行号和高亮标记）
          const snippet = allLines
            .slice(startLine, endLine)
            .map((codeLine, index) => {
              const currentLineNum = startLine + index + 1;
              const marker = currentLineNum === pos.line ? '>' : ' ';
              const lineNumStr = String(currentLineNum).padStart(4, ' ');
              return `${marker} ${lineNumStr} | ${codeLine}`;
            });

          source = snippet.join('\n');
          this.debug.log('提取的源码片段:', source?.substring(0, 200));
        } else {
          this.debug.log(
            '无法提取源码: content=',
            !!content,
            'line=',
            pos.line,
          );
        }
      } catch (e) {
        this.debug.log('获取源码失败:', e);
      }

      return {
        fileName: pos.source,
        line: pos.line ?? 0,
        column: pos.column ?? 0,
        functionName: pos.name ?? null,
        source,
      };
    } catch (error) {
      this.debug.error('位置解析失败:', error);
      return null;
    }
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.cache.clear();
  }
}

// ==================== 便捷工厂函数 ====================

/**
 * 创建 SourceMap 解析器
 *
 * @param config 配置选项
 * @returns SourceMapParser 实例
 *
 * @example
 * ```typescript
 * // 业务层负责拼接完整路径
 * const parser = createParser({
 *   sourceMapBaseUrl: 'https://example.com/sourcemaps/dist/1.0.0',
 *   debug: true,
 * });
 * const result = await parser.parse(stack);
 * ```
 */
export function createParser(config: SourceMapParserConfig): SourceMapParser {
  return new SourceMapParser(config);
}
