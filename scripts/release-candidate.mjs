import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(process.argv[3] || join(root, '.release-candidate'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const workspaceClean = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() === '';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const lockHash = digest(readFileSync(join(root, 'package-lock.json')));
const archivePath = join(directory, 'package.tgz');
const manifestPath = join(directory, 'manifest.json');

if (process.argv[2] === 'create') {
  if (process.env.GITHUB_ACTIONS === 'true') assert.ok(workspaceClean, 'CI candidate must come from a clean checkout');
  assert.ok(existsSync(join(root, 'dist/plugins/BrowserApiErrorsPlugin.js')), 'Build must complete before packaging');
  mkdirSync(directory, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), 'aemeath-pack-'));
  try {
    const metadata = JSON.parse(execFileSync('npm', [
      'pack', '--ignore-scripts', '--json', '--cache', join(scratch, 'cache'), '--pack-destination', scratch,
    ], { cwd: root, encoding: 'utf8' }))[0];
    assert.equal(metadata.name, pkg.name);
    assert.equal(metadata.version, pkg.version);
    assert.ok(metadata.files.every(file => !/^(?:__tests__|release-tests|e2e|\.github|\.release-candidate)\//.test(file.path)), 'Test or release infrastructure leaked into package');
    renameSync(join(scratch, metadata.filename), archivePath);
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1, name: pkg.name, version: pkg.version, commit, lockHash, workspaceClean,
      archiveHash: digest(readFileSync(archivePath)),
    }, null, 2) + '\n');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
} else {
  assert.equal(process.argv[2], 'verify', 'Use create or verify');
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
assert.equal(manifest.schemaVersion, 1, 'Candidate manifest version mismatch');
assert.equal(manifest.name, pkg.name, 'Candidate name mismatch');
assert.equal(manifest.version, pkg.version, 'Candidate version mismatch');
assert.equal(manifest.commit, commit, 'Candidate commit mismatch');
assert.equal(manifest.lockHash, lockHash, 'Candidate lockfile mismatch');
assert.equal(digest(readFileSync(archivePath)), manifest.archiveHash, 'Candidate checksum mismatch');
if (process.env.GITHUB_ACTIONS === 'true' || process.argv.includes('--require-clean')) {
  assert.equal(manifest.workspaceClean, true, 'Candidate contains uncommitted work');
}
// Extract only after identity and byte checks. Artifact comes from this exact
// workflow run; test processes and publishing consume this same archive.
rmSync(join(directory, 'package'), { recursive: true, force: true });
execFileSync('tar', ['-xzf', archivePath, '-C', directory]);
const packed = JSON.parse(readFileSync(join(directory, 'package/package.json'), 'utf8'));
assert.equal(packed.name, pkg.name, 'Packed name mismatch');
assert.equal(packed.version, pkg.version, 'Packed version mismatch');
console.log(`Verified candidate: ${pkg.name}@${pkg.version}, commit ${commit}, sha256 ${manifest.archiveHash}`);
