#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { runFixedStepMain } from '../run-component.mjs';

async function main() {
  const result = await runFixedStepMain('cleanup', process.argv.slice(2));
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
