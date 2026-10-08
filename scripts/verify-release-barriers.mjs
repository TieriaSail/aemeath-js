// The release gate itself must demonstrably reject missing, stale and corrupted
// evidence. Mutate private copies only, never the candidate that will be tested.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBrowserResults } from './verify-browser-results.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidate = join(root, '.release-candidate');
for (const fault of ['archive', 'commit', 'version', 'lockfile', 'dirty-worktree', 'missing-manifest', 'missing-package']) {
  const scratch = mkdtempSync(join(tmpdir(), 'aemeath-barrier-'));
  try {
    cpSync(join(candidate, 'package.tgz'), join(scratch, 'package.tgz'));
    const manifest = JSON.parse(readFileSync(join(candidate, 'manifest.json'), 'utf8'));
    if (fault === 'archive') appendFileSync(join(scratch, 'package.tgz'), 'corruption');
    if (fault === 'commit') manifest.commit = '0'.repeat(40);
    if (fault === 'version') manifest.version = '0.0.0';
    if (fault === 'lockfile') manifest.lockHash = '0'.repeat(64);
    if (fault === 'dirty-worktree') manifest.workspaceClean = false;
    if (fault !== 'missing-manifest') writeFileSync(join(scratch, 'manifest.json'), JSON.stringify(manifest));
    if (fault === 'missing-package') rmSync(join(scratch, 'package.tgz'));
    const args = [join(root, 'scripts/release-candidate.mjs'), 'verify', scratch];
    if (fault === 'dirty-worktree') args.push('--require-clean');
    const result = spawnSync(process.execPath, args, {
      cwd: root, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.error, undefined, `${fault}: test runner failed`);
    assert.notEqual(result.status, 0, `${fault}: release barrier incorrectly accepted bad candidate`);
    const expected = {
      archive: /Candidate checksum mismatch/, commit: /Candidate commit mismatch/,
      version: /Candidate version mismatch/, lockfile: /Candidate lockfile mismatch/,
      'dirty-worktree': /Candidate contains uncommitted work/,
      'missing-manifest': /ENOENT.*manifest\.json/s, 'missing-package': /ENOENT.*package\.tgz/s,
    }[fault];
    assert.match(result.stderr, expected, `${fault}: rejected for an unrelated reason`);
    console.log(`Release barrier correctly rejected ${fault}`);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

// Synthetic reports verify only the result validator, never browser behavior.
const report = {
  errors: [], stats: { expected: 6, unexpected: 0, flaky: 0, skipped: 0 },
  config: { projects: [{ name: 'chromium', retries: 0, repeatEach: 1 }] },
  suites: [{ specs: ['native', 'plugin-default', 'singleton-default',
    'singleton-dependency-first', 'iife-default', 'reporter-failure'].map(mode => ({
    title: `packed candidate preserves business startup: ${mode}`,
    file: 'release-tests/host-startup.spec.ts', ok: true,
    tests: [{ projectName: 'chromium', expectedStatus: 'passed', status: 'expected',
      results: [{ status: 'passed', retry: 0, errors: [] }] }],
  })) }],
};
verifyBrowserResults(report, 'chromium');
const faults = {
  skipped: copy => { copy.suites[0].specs[0].tests[0].results[0].status = 'skipped'; },
  'expected-failure': copy => { copy.suites[0].specs[0].tests[0].expectedStatus = 'failed'; },
  missing: copy => { copy.suites[0].specs.pop(); },
  duplicate: copy => { copy.suites[0].specs[1].title = copy.suites[0].specs[0].title; },
  'wrong-browser': copy => { copy.suites[0].specs[0].tests[0].projectName = 'webkit'; },
  'retry-enabled': copy => { copy.config.projects[0].retries = 1; },
  timeout: copy => { copy.suites[0].specs[0].tests[0].results[0].status = 'timedOut'; },
  'runner-error': copy => { copy.errors.push({ message: 'setup failed' }); },
};
for (const [fault, mutate] of Object.entries(faults)) {
  const copy = structuredClone(report);
  mutate(copy);
  assert.throws(() => verifyBrowserResults(copy, 'chromium'), { name: 'AssertionError' }, `${fault}: browser gate accepted incomplete evidence`);
  console.log(`Browser result validator correctly rejected ${fault} (synthetic report)`);
}
