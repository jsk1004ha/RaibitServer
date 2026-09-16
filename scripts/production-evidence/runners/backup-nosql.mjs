#!/usr/bin/env node
import { runFixedStepMain } from '../run-component.mjs';

const { exitCode } = await runFixedStepMain('backup-nosql', process.argv.slice(2));
process.exitCode = exitCode;
