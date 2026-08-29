// Applies a sandbox to itself, then probes what it can still reach.
//
// This runs as a child process on purpose: applySandbox is irreversible and
// process-wide, so doing it in the test runner would confine the runner and
// every test after it.
//
// Reads a JSON job from argv[2] and prints a JSON verdict on stdout.

import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const native = require('../../index.js')

const job = JSON.parse(process.argv[2])

function attempt(fn) {
  try {
    fn()
    return { ok: true }
  } catch (e) {
    return { ok: false, code: e.code ?? null }
  }
}

const out = { applied: null, error: null, probes: {} }

try {
  out.applied = native.applySandbox(job.config)
} catch (e) {
  out.error = e.message
  process.stdout.write(JSON.stringify(out))
  process.exit(0)
}

// Every probe runs after enforcement is in place.
for (const [name, probe] of Object.entries(job.probes)) {
  if (probe.kind === 'read') {
    out.probes[name] = attempt(() => readFileSync(probe.path, 'utf8'))
  } else if (probe.kind === 'write') {
    out.probes[name] = attempt(() => writeFileSync(probe.path, 'x'))
  }
}

process.stdout.write(JSON.stringify(out))
