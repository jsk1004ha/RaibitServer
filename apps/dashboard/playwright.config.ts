import { defineConfig } from '@playwright/test';

const dashboardPort = 3410;

export default defineConfig({
  testDir: './tests/e2e/specs',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['line'], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
    baseURL: `http://console.localhost:${dashboardPort}`,
    browserName: 'chromium',
    screenshot: 'only-on-failure',
    trace: 'on',
  },
  webServer: {
    command: 'node tests/e2e/fixture/serve.mjs',
    url: `http://127.0.0.1:${dashboardPort}/healthz`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
