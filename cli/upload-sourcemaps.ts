#!/usr/bin/env node
/**
 * Source Map 上传命令行工具
 *
 * 用法：
 * node upload-sourcemaps.js dist/ --url https://api.com/sourcemaps --token xxx
 */

import {
  uploadSourceMaps,
  type SourceMapFile,
} from '../build-plugins/sourcemap-uploader';
import * as path from 'path';
import * as fs from 'fs';

interface CliOptions {
  url?: string;
  token?: string;
  version?: string;
  dir?: string;
}

async function main() {
  const args = process.argv.slice(2);

  // 解析参数
  const options: CliOptions = {};
  let distDir = 'dist';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--url' || arg === '-u') {
      options.url = args[++i];
    } else if (arg === '--token' || arg === '-t') {
      options.token = args[++i];
    } else if (arg === '--version' || arg === '-v') {
      options.version = args[++i];
    } else if (arg === '--dir' || arg === '-d') {
      options.dir = args[++i];
    } else if (arg && !arg.startsWith('-')) {
      distDir = arg;
    }
  }

  // 验证参数
  if (!options.url && !options.dir) {
    console.error('Error: Must specify --url or --dir');
    console.log('\nUsage:');
    console.log(
      '  node upload-sourcemaps.js <dist-dir> --url <url> --token <token>',
    );
    console.log('  node upload-sourcemaps.js <dist-dir> --dir <target-dir>');
    console.log('\nExamples:');
    console.log('  # Upload to HTTP API');
    console.log(
      '  node upload-sourcemaps.js dist/ --url https://api.com/sourcemaps --token xxx',
    );
    console.log('\n  # Save to local directory');
    console.log('  node upload-sourcemaps.js dist/ --dir ./sourcemaps');
    process.exit(1);
  }

  // 解析目录
  const fullDistDir = path.resolve(process.cwd(), distDir);

  console.log(`[SourceMap] Uploading from: ${fullDistDir}`);

  try {
    if (options.url) {
      const uploadUrl = options.url;
      const authToken = options.token;

      // 上传到 HTTP API
      await uploadSourceMaps(fullDistDir, {
        version: options.version,
        onUpload: async (file: SourceMapFile) => {
          // 构建 multipart/form-data 请求
          const boundary =
            '----FormBoundary' + Math.random().toString(36).substring(2);
          const body = buildMultipartBody(file, boundary);

          const headers: Record<string, string> = {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
          };

          if (authToken) {
            headers['Authorization'] = `Bearer ${authToken}`;
          }

          const response = await fetch(uploadUrl, {
            method: 'POST',
            headers,
            body,
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }
        },
      });
    } else if (options.dir) {
      // 保存到本地目录
      const targetDir = path.resolve(process.cwd(), options.dir);

      await uploadSourceMaps(fullDistDir, {
        version: options.version,
        deleteAfterUpload: false,
        onUpload: async (file: SourceMapFile) => {
          const versionDir = path.join(targetDir, file.version);
          const targetPath = path.join(versionDir, file.filename);

          // 确保目录存在
          const targetFileDir = path.dirname(targetPath);
          fs.mkdirSync(targetFileDir, { recursive: true });
          fs.copyFileSync(file.path, targetPath);
        },
      });
    }

    console.log('[SourceMap] ✅ Upload completed');
  } catch (error) {
    console.error('[SourceMap] ❌ Upload failed:', error);
    process.exit(1);
  }
}

/**
 * 构建 multipart/form-data 请求体
 */
function buildMultipartBody(file: SourceMapFile, boundary: string): string {
  const parts: string[] = [];

  // 文件字段
  parts.push(`--${boundary}`);
  parts.push(
    `Content-Disposition: form-data; name="file"; filename="${file.filename}"`,
  );
  parts.push('Content-Type: application/json');
  parts.push('');
  parts.push(file.content);

  // 版本字段
  parts.push(`--${boundary}`);
  parts.push('Content-Disposition: form-data; name="version"');
  parts.push('');
  parts.push(file.version);

  // 文件名字段
  parts.push(`--${boundary}`);
  parts.push('Content-Disposition: form-data; name="filename"');
  parts.push('');
  parts.push(file.filename);

  // 结束边界
  parts.push(`--${boundary}--`);

  return parts.join('\r\n');
}

main();
