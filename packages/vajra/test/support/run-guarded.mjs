#!/usr/bin/env node
// Test-only: run a command through the guard with options given as JSON, so a test can set the ones the
// public command does not have. The guard confines this process, so it must run as its own process.
import { runGuarded } from '../../dist/guard/launch.js'

const options = JSON.parse(process.argv[2] ?? '{}')
process.exitCode = await runGuarded({
  allowRead: [],
  allowWrite: [],
  dryRun: false,
  quiet: true,
  write: line => process.stderr.write(`${line}\n`),
  ...options,
})
