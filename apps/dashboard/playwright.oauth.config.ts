import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const evidence = process.env.RAIBIT_OAUTH_EVIDENCE_DIR;
if (!evidence || !path.isAbsolute(evidence)) throw new Error('external_oauth_evidence_directory_required');
const manifest: { readonly origin: string; readonly ready: boolean } = JSON.parse(fs.readFileSync(path.join(evidence, 'runtime-manifest.json'), 'utf8'));
if (manifest.ready !== true) throw new Error('oauth_fixture_not_ready');

export default defineConfig({
  testDir: './tests/e2e/specs', testMatch: ['github-oauth-transaction.spec.ts', 'github-oauth-abuse.spec.ts'],
  outputDir: path.join(evidence, 'browser'), fullyParallel: false, workers: 1, retries: 0, timeout: 45_000,
  reporter: [['line'], ['json', { outputFile: path.join(evidence, 'browser-results.json') }]],
  use: { baseURL: manifest.origin, browserName: 'chromium', viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true,
    trace: 'off', screenshot: 'off', video: 'off',
    launchOptions: { executablePath: process.env.RAIBIT_OAUTH_CHROMIUM, args: ['--no-sandbox',
      `--host-resolver-rules=MAP github.com 127.0.0.1:${new URL(manifest.origin).port}, MAP console.localhost 127.0.0.1, MAP * ~NOTFOUND`] } },
});
