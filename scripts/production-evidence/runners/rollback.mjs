#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { runFixedStepMain } from '../run-component.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runFixedStepMain('rollback', process.argv.slice(2));
  process.exitCode = result.exitCode;
}
