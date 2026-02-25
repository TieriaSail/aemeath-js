/**
 * Source Map 解析服务（服务器端）
 *
 * ⚠️ 这是示例代码，需要部署到后端服务器
 *
 * 使用：
 * 1. 安装依赖：npm install source-map
 * 2. 保存 source-map 文件到服务器
 * 3. 部署此服务
 * 4. 配置客户端的解析端点
 */

import { SourceMapConsumer } from 'source-map';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Source Map 解析服务配置
 */
interface ServiceConfig {
  /** Source Map 文件存储目录 */
  sourceMapDir: string;

  /** 是否缓存 SourceMapConsumer */
  cache?: boolean;

  /** 允许的来源（CORS） */
  allowedOrigins?: string[];
}

/**
 * 堆栈帧信息
 */
interface StackFrame {
  raw: string;
  fileName?: string;
  lineNumber?: number;
  columnNumber?: number;
  functionName?: string;
}

/**
 * 解析后的堆栈帧
 */
interface ParsedStackFrame {
  functionName: string | null;
  fileName: string;
  lineNumber: number;
  columnNumber: number;
  source?: string;
  resolved: boolean;
}

/**
 * Source Map 解析服务
 */
export class SourceMapService {
  private config: Required<ServiceConfig>;
  private consumerCache: Map<string, SourceMapConsumer> = new Map();

  constructor(config: ServiceConfig) {
    this.config = {
      sourceMapDir: config.sourceMapDir,
      cache: config.cache !== false,
      allowedOrigins: config.allowedOrigins || ['*'],
    };
  }

  /**
   * 解析错误堆栈
   */
  async parseStack(
    stack: string,
    appVersion?: string,
  ): Promise<ParsedStackFrame[]> {
    const frames = this.extractStackFrames(stack);
    const parsed: ParsedStackFrame[] = [];

    for (const frame of frames) {
      const parsedFrame = await this.parseFrame(frame, appVersion);
      parsed.push(parsedFrame);
    }

    return parsed;
  }

  /**
   * 解析单个堆栈帧
   */
  private async parseFrame(
    frame: StackFrame,
    appVersion?: string,
  ): Promise<ParsedStackFrame> {
    if (!frame.fileName || !frame.lineNumber || !frame.columnNumber) {
      return {
        functionName: frame.functionName || null,
        fileName: frame.fileName || 'unknown',
        lineNumber: frame.lineNumber || 0,
        columnNumber: frame.columnNumber || 0,
        resolved: false,
      };
    }

    try {
      // 获取对应的 source-map 文件
      const sourceMapFile = this.getSourceMapFile(frame.fileName, appVersion);

      if (!sourceMapFile || !fs.existsSync(sourceMapFile)) {
        return {
          functionName: frame.functionName || null,
          fileName: frame.fileName,
          lineNumber: frame.lineNumber,
          columnNumber: frame.columnNumber,
          resolved: false,
        };
      }

      // 加载 SourceMapConsumer
      const consumer = await this.loadSourceMapConsumer(sourceMapFile);

      // 解析位置
      const original = consumer.originalPositionFor({
        line: frame.lineNumber,
        column: frame.columnNumber,
      });

      if (!original.source) {
        return {
          functionName: frame.functionName || null,
          fileName: frame.fileName,
          lineNumber: frame.lineNumber,
          columnNumber: frame.columnNumber,
          resolved: false,
        };
      }

      // 获取原始代码片段
      const sourceContent = consumer.sourceContentFor(original.source);
      let sourceSnippet: string | undefined;

      if (sourceContent && original.line) {
        const lines = sourceContent.split('\n');
        const targetLine = original.line - 1;

        // 获取前后 2 行代码
        const start = Math.max(0, targetLine - 2);
        const end = Math.min(lines.length, targetLine + 3);
        const snippet = lines.slice(start, end);

        sourceSnippet = snippet
          .map((line, index) => {
            const lineNum = start + index + 1;
            const prefix = lineNum === original.line ? '> ' : '  ';
            return `${prefix}${lineNum} | ${line}`;
          })
          .join('\n');
      }

      return {
        functionName: original.name || frame.functionName || null,
        fileName: original.source,
        lineNumber: original.line || 0,
        columnNumber: original.column || 0,
        source: sourceSnippet,
        resolved: true,
      };
    } catch (error) {
      console.error('Failed to parse frame:', error);

      return {
        functionName: frame.functionName || null,
        fileName: frame.fileName,
        lineNumber: frame.lineNumber,
        columnNumber: frame.columnNumber,
        resolved: false,
      };
    }
  }

  /**
   * 提取堆栈帧信息
   */
  private extractStackFrames(stack: string): StackFrame[] {
    const frames: StackFrame[] = [];
    const lines = stack.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // 匹配格式：at functionName (file:line:column)
      let match = trimmed.match(/at\s+([^\s]+)\s+\((.+?):(\d+):(\d+)\)/);

      if (match) {
        frames.push({
          raw: trimmed,
          functionName: match[1],
          fileName: match[2],
          lineNumber: parseInt(match[3], 10),
          columnNumber: parseInt(match[4], 10),
        });
        continue;
      }

      // 匹配格式：at file:line:column
      match = trimmed.match(/at\s+(.+?):(\d+):(\d+)/);
      if (match) {
        frames.push({
          raw: trimmed,
          fileName: match[1],
          lineNumber: parseInt(match[2], 10),
          columnNumber: parseInt(match[3], 10),
        });
        continue;
      }

      // 无法解析的行
      frames.push({
        raw: trimmed,
      });
    }

    return frames;
  }

  /**
   * 获取 source-map 文件路径
   */
  private getSourceMapFile(
    fileName: string,
    appVersion?: string,
  ): string | null {
    // 从文件名提取 chunk 名称
    // 例如：https://cdn.example.com/app/1.0.0/main.abc123.js
    // -> main.abc123.js.map

    const url = new URL(fileName, 'http://localhost');
    const pathParts = url.pathname.split('/');
    const file = pathParts[pathParts.length - 1];

    if (!file) return null;

    // 构建 source-map 文件路径
    // 支持版本号子目录：sourceMapDir/{version}/{file}.map
    const sourceMapFile = appVersion
      ? path.join(this.config.sourceMapDir, appVersion, `${file}.map`)
      : path.join(this.config.sourceMapDir, `${file}.map`);

    return sourceMapFile;
  }

  /**
   * 加载 SourceMapConsumer
   */
  private async loadSourceMapConsumer(
    file: string,
  ): Promise<SourceMapConsumer> {
    // 检查缓存
    if (this.config.cache && this.consumerCache.has(file)) {
      return this.consumerCache.get(file)!;
    }

    // 读取 source-map 文件
    const rawSourceMap = fs.readFileSync(file, 'utf-8');
    const sourceMap = JSON.parse(rawSourceMap);

    // 创建 SourceMapConsumer
    const consumer = await new SourceMapConsumer(sourceMap);

    // 缓存
    if (this.config.cache) {
      this.consumerCache.set(file, consumer);
    }

    return consumer;
  }

  /**
   * 清理缓存
   */
  clearCache(): void {
    for (const consumer of this.consumerCache.values()) {
      consumer.destroy();
    }
    this.consumerCache.clear();
  }
}

/**
 * Express 中间件示例
 */
export function createSourceMapMiddleware(service: SourceMapService) {
  return async (req: any, res: any) => {
    try {
      const { message, stack, name: _name, context } = req.body;

      if (!stack) {
        return res.status(400).json({
          success: false,
          error: 'Missing stack in request body',
        });
      }

      // 解析堆栈
      const parsed = await service.parseStack(stack, context?.appVersion);

      // 返回结果
      res.json({
        original: {
          message,
          stack,
        },
        parsed,
        success: true,
      });
    } catch (error) {
      console.error('Source map parsing error:', error);

      res.status(500).json({
        success: false,
        error: (error as Error).message,
      });
    }
  };
}

/**
 * 使用示例
 */
/*
// 1. 创建服务
const service = new SourceMapService({
  sourceMapDir: '/path/to/sourcemaps',
  cache: true,
  allowedOrigins: ['https://yourdomain.com']
});

// 2. 在 Express 中使用
import express from 'express';

const app = express();
app.use(express.json());

app.post('/api/parse-error', createSourceMapMiddleware(service));

app.listen(3000, () => {
  console.log('Source map service running on port 3000');
});

// 3. 客户端配置
import { createSourceMapParser } from 'aemeath-js/parser';

// 方式1：使用简化的配置
const parser = createSourceMapParser({
  url: 'https://your-backend.com/api/parse-error'
});

// 方式2：完全自定义（与 UploadPlugin 统一）
const parser2 = createSourceMapParser({
  onParse: async (errorData) => {
    const response = await fetch('https://your-backend.com/api/parse-error', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getToken()}`
      },
      body: JSON.stringify(errorData)
    });
    return response.json();
  }
});

// 4. 解析错误
const result = await parser.parse(logEntry);
console.log('Parsed stack:', result.parsed);
*/
