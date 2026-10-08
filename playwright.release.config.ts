import { defineConfig, devices } from '@playwright/test';

// User's local machine must not launch browser automation. Release validation
// runs only in disposable GitHub-hosted runners, and its result blocks publishing.
if (process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('Release browser checks run only in GitHub Actions; do not launch local browsers.');
}
export default defineConfig({
  testDir: './release-tests',
  testMatch: '**/*.spec.ts',
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 30_000,
  reporter: [
    ['list'], ['junit', { outputFile: 'test-results/release-results.xml' }],
    ['json', { outputFile: 'test-results/release-results.json' }],
  ],
  use: { headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', use: devices['Desktop Chrome'] },
    { name: 'firefox', use: devices['Desktop Firefox'] },
    { name: 'webkit', use: devices['Desktop Safari'] },
  ],
});
