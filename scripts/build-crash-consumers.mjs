import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { build as viteBuild } from 'vite';
import webpack from 'webpack';
import { createRsbuild } from '@rsbuild/core';
const root = resolve('.');
const candidate = join(root, '.release-candidate');
const workspace = join(candidate, 'crash-consumers');
rmSync(workspace, { recursive: true, force: true }); mkdirSync(workspace, { recursive: true });
const packed = JSON.parse(readFileSync(join(candidate, 'package/package.json')));
const rootLock = JSON.parse(readFileSync(join(root, 'package-lock.json')));
const consumer = { name: 'aemeath-crash-consumer', version: '0.0.0', private: true, type: 'module', dependencies: { 'aemeath-js': 'file:../package.tgz' } };
const packages = {
  '': { name: consumer.name, version: consumer.version, dependencies: consumer.dependencies },
  'node_modules/aemeath-js': {
    version: packed.version, resolved: 'file:../package.tgz',
    integrity: `sha512-${createHash('sha512').update(readFileSync(join(candidate, 'package.tgz'))).digest('base64')}`,
    dependencies: packed.dependencies, peerDependencies: packed.peerDependencies,
    peerDependenciesMeta: packed.peerDependenciesMeta, engines: packed.engines,
  },
};
for (const name of Object.keys(packed.dependencies || {})) {
  const locked = rootLock.packages[`node_modules/${name}`];
  assert.ok(locked, `Missing locked runtime dependency: ${name}`);
  assert.equal(Object.keys(locked.dependencies || {}).length, 0, 'Update the consumer lock closure for new transitive runtime dependencies');
  const { dev, optional, ...runtime } = locked;
  packages[`node_modules/${name}`] = runtime;
}
writeFileSync(join(workspace, 'package.json'), JSON.stringify(consumer));
writeFileSync(join(workspace, 'package-lock.json'), JSON.stringify({ name: consumer.name, version: consumer.version, lockfileVersion: 3, requires: true, packages }));
// Reuse lockfile tarballs populated by npm ci. A cold CI cache need not contain
// registry packuments: the consumer lock pins the actual SDK archive and runtime dependency.
execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', '--offline', '--cache', process.env.npm_config_cache || join(process.env.HOME, '.npm')], { cwd: workspace, stdio: 'pipe', timeout: 60_000 });
assert.equal(JSON.parse(readFileSync(join(workspace, 'node_modules/aemeath-js/package.json'))).version, JSON.parse(readFileSync(join(candidate, 'manifest.json'))).version);
cpSync(join(root, 'release-tests/crash-consumer'), join(workspace, 'src'), { recursive: true });
writeFileSync(join(workspace, 'index.html'), '<!doctype html><html><body><script type="module" src="/src/main.js"></script></body></html>');
const outputs = {};
await viteBuild({ configFile: false, root: workspace, base: '/vite/', logLevel: 'warn', build: { outDir: 'vite', emptyOutDir: true, minify: false } });
await new Promise((resolveBuild, reject) => {
  const compiler = webpack({ mode: 'production', context: workspace, entry: './src/main.js', output: { path: join(workspace, 'webpack'), filename: 'main.js', publicPath: '/webpack/', clean: true }, optimization: { minimize: false }, stats: 'errors-warnings' });
  compiler.run((error, stats) => compiler.close(closeError => { if (error || closeError || stats?.hasErrors()) reject(error || closeError || new Error(stats.toString('errors-only'))); else resolveBuild(); }));
});
writeFileSync(join(workspace, 'webpack/index.html'), '<!doctype html><html><body><script src="/webpack/main.js"></script></body></html>');
const rsbuild = await createRsbuild({ cwd: workspace, rsbuildConfig: { mode: 'production', source: { entry: { index: './src/main.js' } }, output: { distPath: { root: 'rsbuild' }, assetPrefix: '/rsbuild/', minify: false }, performance: { printFileSize: false } } });
await rsbuild.build();
for (const name of ['vite', 'webpack', 'rsbuild']) {
  const files = [];
  function visit(directory) { for (const entry of readdirSync(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) visit(path); else files.push(path); } }
  visit(join(workspace, name));
  assert.ok(files.some(path => path.endsWith('index.html')), `${name}: missing HTML`);
  assert.ok(files.filter(path => /\.js$/.test(path)).length >= 3, `${name}: missing external worker chunks`);
  const content = files.filter(path => /\.js$/.test(path)).map(path => readFileSync(path, 'utf8')).join('\n');
  assert.ok(!/aemeath-js\/crash-worker/.test(content), `${name}: unresolved worker package subpath`);
  assert.ok(!/new Worker\(\s*["']blob:|createObjectURL\(/.test(content), `${name}: unexpected inline/blob worker`);
  outputs[name] = files.map(path => ({ path: path.slice(workspace.length + 1), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }));
}
writeFileSync(join(workspace, 'build-manifest.json'), JSON.stringify({ archiveHash: JSON.parse(readFileSync(join(candidate, 'manifest.json'))).archiveHash, outputs }, null, 2) + '\n');
console.log('Built installed-tarball crash consumers: Vite, Webpack 5, Rsbuild (no browser launch).');
