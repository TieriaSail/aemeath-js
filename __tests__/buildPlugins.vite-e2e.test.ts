// @vitest-environment node
//
// 该套件需要真实跑 vite build，esbuild 内部的 TextEncoder 不变量检查与
// jsdom 提供的 TextEncoder 实现不兼容（jsdom 把 Uint8Array 包装成自己的
// 子类，导致 `instanceof Uint8Array` 在 esbuild 视角下为 false）。
// 切到 node 环境绕开此问题；本套件本就不需要 DOM。
/**
 * Vite 端到端集成测试（R20 / 增强 #3）
 *
 * 之前的 buildPlugins.test.ts 只测试 plugin 函数返回值（mock 化的输入输出），
 * 不能保证 Vite 真实 build 流程下脚本会被正确注入到产物 HTML。
 *
 * 这里用 Vite 的 programmatic API（`import('vite').build()`）真实跑一次 build：
 * - 在本包根目录下的 `.vite-e2e-fixtures/` 里搭最小化项目（index.html +
 *   main.ts）——不能使用 OS tmpdir：Rollup 的 HTML emit 不接受绝对路径
 * - 调用 build({ root, plugins: [ameathEarlyErrorPlugin(...)] })
 * - 读取 `dist/index.html`，对其结构做端到端断言
 *
 * **覆盖矩阵**：
 *   - Vite 5（package.json 里固定的 devDep）
 *
 * 对 Vite 2/3/4/6 的兼容性靠 plugin API 本身的稳定性保证：
 * `transformIndexHtml` 返回 `{ html, tags }` + `injectTo: 'head-prepend'` 是
 * Vite 2.0+ 全程支持的官方 API。本测试是这一保证的直接 e2e 验证；如需
 * 跨主版本覆盖，CI 可在 matrix 里 npm i 不同 vite 版本后重跑本套件。
 *
 * 性能：在本机 Vite 5 上一次跑套件约数百 ms～数秒，取决于缓存与磁盘。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 用包内子目录做 fixture 根，避免 Rollup HTML plugin 对 OS tmpdir 绝对路径
// 报「不能是 absolute / relative path」的限制（Rollup 在 emit asset 时
// 要求 fileName 是相对路径）。
const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), '..');

let workRoot: string;

beforeAll(() => {
  workRoot = join(REPO_ROOT, '.vite-e2e-fixtures');
  if (existsSync(workRoot)) {
    rmSync(workRoot, { recursive: true, force: true });
  }
  mkdirSync(workRoot, { recursive: true });
});

afterAll(() => {
  if (workRoot && existsSync(workRoot)) {
    try {
      rmSync(workRoot, { recursive: true, force: true });
    } catch {
      // 清理失败不阻塞测试结果
    }
  }
});

interface BuildOptions {
  /** 测试 case 名（用作子目录名 + cache hash） */
  caseName: string;
  /** 是否启用 nonce */
  nonce?: string;
  /** 自定义 head 写法（验证大小写 / 属性 / 注释） */
  headTemplate?: string;
}

async function runBuild(opts: BuildOptions): Promise<{ html: string; root: string }> {
  const root = join(workRoot, opts.caseName);
  mkdirSync(root, { recursive: true });

  const head = opts.headTemplate ?? '<head><meta charset="UTF-8"><title>e2e</title></head>';
  writeFileSync(
    join(root, 'index.html'),
    `<!doctype html><html>${head}<body><div id="app"></div><script type="module" src="/main.ts"></script></body></html>`,
  );
  writeFileSync(join(root, 'main.ts'), `console.log('e2e ok');\n`);

  const vite = await import('vite');
  const pluginMod = await import('../src/build-plugins/vite');

  const nonceArg = opts.nonce !== undefined ? `, nonce: ${JSON.stringify(opts.nonce)}` : '';
  void nonceArg;

  await vite.build({
    root,
    logLevel: 'silent',
    configFile: false,
    plugins: [
      pluginMod.ameathEarlyErrorPlugin(opts.nonce !== undefined ? { nonce: opts.nonce } : {}),
    ],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      // minify off → 更稳定的 HTML 断言（位置 / 顺序）
      minify: false,
      write: true,
      // ESM 直接 emit；不做 lib mode
      rollupOptions: {
        // 让 Rollup 走默认 entry 推断（index.html 内的 <script src="/main.ts">）
      },
    },
  });

  const htmlPath = join(root, 'dist', 'index.html');
  if (!existsSync(htmlPath)) {
    throw new Error(`Build did not produce dist/index.html: ${htmlPath}`);
  }
  return { html: readFileSync(htmlPath, 'utf8'), root };
}

describe('Vite plugin — e2e build (R20 / 增强 #3)', () => {
  it('真实 build 后 dist/index.html 应包含 inline 早期错误脚本', async () => {
    const { html } = await runBuild({ caseName: 'basic' });

    // 关键 marker：脚本里必然出现这两个全局变量名
    expect(html).toContain('__EARLY_ERRORS__');
    expect(html).toContain('__flushEarlyErrors__');
    // 应该是 inline script（不是 <script src=...>）
    expect(html).toMatch(/<script[^>]*>[^<]*__EARLY_ERRORS__/);
  }, 30000);

  it('inline 脚本应位于 <head> 最前面（head-prepend 语义）', async () => {
    const { html } = await runBuild({ caseName: 'head-prepend' });

    // <head> 的第一个标签必须是我们的 inline <script>，而不是 <meta>/<title>
    // 用 RegExp 匹配 head 开始紧接的第一个标签
    const headMatch = html.match(/<head[^>]*>\s*([\s\S]*?)<\/head>/i);
    expect(headMatch).not.toBeNull();
    const headInner = headMatch![1];
    // 第一个 token 必须是 <script ...>__EARLY_ERRORS__...
    const firstTagMatch = headInner.match(/^\s*<([a-zA-Z]+)/);
    expect(firstTagMatch).not.toBeNull();
    expect(firstTagMatch![1].toLowerCase()).toBe('script');
    // 且这第一个 script 必须是早期错误脚本（含 marker）
    expect(headInner.indexOf('__EARLY_ERRORS__')).toBeLessThan(
      headInner.indexOf('<meta'),
    );
  }, 30000);

  it('提供 nonce 时产物 <script> 必须带 nonce="..." 属性', async () => {
    const { html } = await runBuild({ caseName: 'with-nonce', nonce: 'CSP-NONCE-VITE-E2E' });

    // 找到包含早期错误 marker 的那个 <script> 标签开始
    const scriptStart = html.indexOf('<script');
    expect(scriptStart).toBeGreaterThan(-1);
    // nonce 必须出现在 script 开头标签里（不是出现在 body）
    const scriptOpenEnd = html.indexOf('>', scriptStart);
    const scriptOpenTag = html.slice(scriptStart, scriptOpenEnd + 1);
    expect(scriptOpenTag).toContain('nonce="CSP-NONCE-VITE-E2E"');
    // nonce 不应进入脚本内容本体
    const scriptCloseStart = html.indexOf('</script>', scriptOpenEnd);
    const scriptBody = html.slice(scriptOpenEnd + 1, scriptCloseStart);
    expect(scriptBody).not.toContain('CSP-NONCE-VITE-E2E');
    expect(scriptBody).toContain('__EARLY_ERRORS__');
  }, 30000);

  it('未提供 nonce 时产物 <script> 标签不应带 nonce 属性', async () => {
    const { html } = await runBuild({ caseName: 'no-nonce' });

    // 找到那个早期错误 inline <script> 的开头标签
    const scriptStart = html.indexOf('<script');
    const scriptOpenEnd = html.indexOf('>', scriptStart);
    const scriptOpenTag = html.slice(scriptStart, scriptOpenEnd + 1);
    expect(scriptOpenTag).not.toContain('nonce=');
  }, 30000);

  // Bug E 端到端验证：旧实现的 String.prototype.replace('<head>', ...) 字面量
  // 匹配在以下场景静默失效。新实现走 vite injectTo='head-prepend' 由 vite
  // 内部 HTML parser 处理，这里在真实 build 下复现各种 <head> 写法。
  it('Bug E e2e：head 大小写 / 属性 / 注释场景下都必须成功注入', async () => {
    // 注意：vite 的 HTML 模板要求结构合法；这里覆盖三种合法写法
    const heads = [
      '<head class="x"><meta charset="UTF-8"></head>',
      '<head lang="en"><meta charset="UTF-8"></head>',
      '<head><!-- a comment --><meta charset="UTF-8"></head>',
    ];
    for (let i = 0; i < heads.length; i++) {
      const { html } = await runBuild({ caseName: `bug-e-${i}`, headTemplate: heads[i] });
      expect(html).toContain('__EARLY_ERRORS__');
    }
  }, 60000);
});
