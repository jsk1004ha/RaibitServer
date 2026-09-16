import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { tmpdir } from 'node:os';

const dashboardPort = 3410;
const outputDirectory = process.env.RAIBITSERVER_PLAYWRIGHT_OUTPUT_DIR ?? process.env.PLAYWRIGHT_OUTPUT_DIR ?? path.join(tmpdir(), `raibitserver-dashboard-playwright-${process.pid}`);
const reportPath = process.env.RAIBITSERVER_PLAYWRIGHT_REPORT_PATH ?? path.join(outputDirectory, 'results.json');

if (!path.isAbsolute(outputDirectory) || !path.isAbsolute(reportPath)) throw new Error('dashboard_playwright_output_paths_must_be_absolute');

export default defineConfig({
  testDir: './tests/e2e/specs',
  outputDir: path.join(outputDirectory, 'artifacts'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['line'], ['json', { outputFile: reportPath }]],
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
