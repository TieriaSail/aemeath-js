import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// An exit code alone can be green with skipped or expected-failure tests.
// Require each planned host contract to have actually passed without retries.
export function verifyBrowserResults(report, browser) {
  assert.ok(['chromium', 'firefox', 'webkit'].includes(browser), 'Unknown acceptance browser');
  assert.deepEqual(report.errors, [], 'Browser runner reported errors');
  const expected = new Set([
    'native', 'plugin-default', 'singleton-default', 'singleton-dependency-first',
    'iife-default', 'reporter-failure',
  ].map(mode => `packed candidate preserves business startup: ${mode}`));
  for (const name of ['unexpected', 'flaky', 'skipped']) {
    assert.equal(report.stats[name], 0, `Browser report contains ${name} tests`);
  }
  assert.equal(report.stats.expected, expected.size, 'Browser report is missing planned tests');
  const project = report.config.projects.find(project => project.name === browser);
  assert.ok(project, 'Browser report is missing requested project');
  assert.equal(project.retries, 0, 'Browser acceptance must not retry failures');
  assert.equal(project.repeatEach, 1, 'Browser acceptance must run each contract once');
  const cases = [];
  function visit(suite) {
    cases.push(...suite.specs);
    for (const child of suite.suites || []) visit(child);
  }
  for (const suite of report.suites) visit(suite);
  assert.equal(cases.length, expected.size, 'Browser report case count mismatch');
  for (const spec of cases) {
    assert.ok(expected.delete(spec.title), `Unexpected or duplicate browser contract: ${spec.title}`);
    assert.equal(spec.file.replaceAll('\\', '/').split('/').pop(), 'host-startup.spec.ts', 'Wrong browser contract file');
    assert.equal(spec.ok, true, 'Browser contract did not pass');
    assert.equal(spec.tests.length, 1, 'Browser contract has unexpected project results');
    const test = spec.tests[0];
    assert.equal(test.projectName, browser, 'Browser result belongs to another project');
    assert.equal(test.expectedStatus, 'passed', 'Expected failures/skips cannot satisfy acceptance');
    assert.equal(test.status, 'expected', 'Browser contract has unexpected outcome');
    assert.equal(test.results.length, 1, 'Browser contract was missing or retried');
    assert.equal(test.results[0].status, 'passed', 'Browser contract did not actually execute successfully');
    assert.equal(test.results[0].retry, 0, 'Browser result came from a retry');
    assert.deepEqual(test.results[0].errors, [], 'Browser contract reported errors');
  }
  assert.equal(expected.size, 0, 'Browser report is missing a planned contract');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const browser = process.argv[2];
  const report = JSON.parse(readFileSync(process.argv[3] || 'test-results/release-results.json', 'utf8'));
  verifyBrowserResults(report, browser);
  console.log(`Verified all six native-browser host contracts: ${browser}`);
}
