/**
 * Source Map 上传核心
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Source Map 文件信息
 */
export interface SourceMapFile {
  /** 文件绝对路径 */
  path: string;
  /** 相对路径（用于上传） */
  filename: string;
  /** 文件内容 */
  content: string;
  /** 版本号 */
  version: string;
}

/**
 * Source Map 上传配置
 */
export interface SourceMapUploadConfig {
  /**
   * 版本号（可选，默认使用时间戳）
   */
  version?: string;

  /**
   * 自定义上传函数
   *
   * @example
   * ```javascript
   * onUpload: async (file) => {
   *   await fetch('/api/sourcemaps', {
   *     method: 'POST',
   *     headers: {
   *       'X-File-Path': file.filename,
   *       'X-Version': file.version
   *     },
   *     body: file.content
   *   });
   * }
   * ```
   */
  onUpload: (file: SourceMapFile) => Promise<void>;

  /**
   * 上传后是否删除 Source Map 文件
   * @default true
   */
  deleteAfterUpload?: boolean;

  /**
   * 静默模式，不输出进度日志（错误仍会输出）
   * @default false
   */
  silent?: boolean;
}

/**
 * 上传 Source Maps
 *
 * @param outputPath 构建输出目录
 * @param config 上传配置
 */
export async function uploadSourceMaps(
  outputPath: string,
  config: SourceMapUploadConfig,
): Promise<void> {
  const { onUpload, deleteAfterUpload = true, version, silent = false } = config;
  const log = silent ? () => {} : console.log.bind(console);
  const resolvedVersion = version || new Date().toISOString().replace(/[:.]/g, '-');
  try {
    const mapFiles = findSourceMapFiles(outputPath);

    if (mapFiles.length === 0) {
      log('[Aemeath] No source map files found');
      return;
    }

    log(`[Aemeath] Found ${mapFiles.length} source map files`);

    for (const filePath of mapFiles) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const relativePath = path.relative(outputPath, filePath);

        const file: SourceMapFile = {
          path: filePath,
          filename: relativePath,
          content,
          version: resolvedVersion,
        };

        await onUpload(file);

        log(`[Aemeath] Uploaded: ${relativePath}`);

        if (deleteAfterUpload) {
          fs.unlinkSync(filePath);
          log(`[Aemeath] Deleted: ${relativePath}`);
        }
      } catch (error) {
        console.error(`[Aemeath] Failed to upload ${filePath}:`, error);
      }
    }

    log('[Aemeath] Source map upload completed');
  } catch (error) {
    console.error('[Aemeath] Source map upload failed:', error);
  }
}

/**
 * 查找所有 Source Map 文件
 * @internal
 */
function findSourceMapFiles(dir: string): string[] {
  const results: string[] = [];

  function scan(currentDir: string) {
    if (!fs.existsSync(currentDir)) return;

    const files = fs.readdirSync(currentDir);

    for (const file of files) {
      const filePath = path.join(currentDir, file);
      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        scan(filePath);
      } else if (file.endsWith('.map')) {
        results.push(filePath);
      }
    }
  }

  scan(dir);
  return results;
}
