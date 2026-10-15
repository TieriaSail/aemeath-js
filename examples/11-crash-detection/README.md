# Crash recovery / 崩溃恢复

Use `basic.ts` as a browser entry and `crash.worker.ts` as its sibling worker entry.
Vite, Webpack 5 and Rsbuild recognize the literal `new Worker(new URL(..., import.meta.url))` form.
Keep that expression inside the supplied factory. Configure the worker's public base and CSP in the host application.
The release gate builds all three from an installed copy of the same npm archive, using
`node scripts/build-crash-consumers.mjs` after candidate creation. This command builds assets only.
Native worker execution is restricted to isolated GitHub Actions browser jobs.

将 `basic.ts` 用作浏览器入口，`crash.worker.ts` 放在同级目录。保留工厂中的静态 Worker URL
表达式；部署路径与 CSP 由宿主应用配置。发版门禁使用同一 npm 候选包安装后分别构建
Vite、Webpack 5、Rsbuild 示例。本地命令只构建资源；原生浏览器运行由隔离 CI 承担。

[English guide](../../docs/en/12-crash-detection.md) · [中文文档](../../docs/zh/12-crash-detection.md)
