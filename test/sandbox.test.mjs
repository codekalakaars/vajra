// Sandbox enforcement.
//
// The capability report is checked everywhere. Actual confinement is checked by
// running a child process that applies the sandbox and then tries to touch a
// file outside the project: a report claiming "enforced" means nothing unless a
// denial is observed. Enforcement is irreversible and process-wide, so it can
// only be exercised in a child.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const native = require('../index.js')

const here = dirname(fileURLToPath(import.meta.url))
const CHILD = join(here, 'fixtures', 'sandbox-child.mjs')

const caps = native.sandboxCapabilities()
const enforces = caps.filesystem !== 'unsupported'

function runChild(job) {
  const stdout = execFileSync(process.execPath, [CHILD, JSON.stringify(job)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return JSON.parse(stdout)
}

test('capabilities report is internally consistent', () => {
  assert.ok(['enforced', 'partial', 'unsupported'].includes(caps.filesystem))
  assert.ok(caps.details.length > 0, 'a report must explain itself')

  // Claiming confinement while naming no mechanism (or vice versa) would
  // mislead a caller about whether the sandbox is real.
  if (caps.filesystem === 'unsupported') {
    assert.equal(caps.mechanism, 'none')
  } else {
    assert.notEqual(caps.mechanism, 'none')
  }

  if (process.platform === 'linux') assert.equal(caps.platform, 'linux')
  if (process.platform === 'darwin') assert.equal(caps.mechanism, 'seatbelt')
  if (process.platform === 'win32') {
    assert.equal(caps.filesystem, 'unsupported')
    assert.equal(caps.abi, null)
  }
})

test('an unenforceable platform refuses rather than pretending', (t) => {
  if (enforces) {
    t.skip('this platform enforces; refusal path not reachable')
    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'vajra-sb-'))
  const result = runChild({
    config: { projectDir: dir },
    probes: {},
  })

  // The dangerous outcome would be a silent success implying confinement.
  assert.equal(result.applied, null)
  assert.match(result.error, /Refusing to continue unconfined/)

  const optedIn = runChild({
    config: { projectDir: dir, allowUnenforced: true },
    probes: {},
  })
  assert.equal(optedIn.applied.enforced, false)
  assert.ok(optedIn.applied.warnings.some((w) => w.includes('NOT SANDBOXED')))

  rmSync(dir, { recursive: true, force: true })
})

test('confines the process to the project directory', (t) => {
  if (!enforces) {
    t.skip(`no enforcement on ${caps.platform}`)
    return
  }

  const project = mkdtempSync(join(tmpdir(), 'vajra-sb-project-'))
  const outside = mkdtempSync(join(tmpdir(), 'vajra-sb-outside-'))

  const inside = join(project, 'app.js')
  const secret = join(outside, 'secret.txt')
  writeFileSync(inside, 'console.log(1)')
  writeFileSync(secret, 'hunter2')

  const result = runChild({
    config: { projectDir: project },
    probes: {
      insideRead: { kind: 'read', path: inside },
      insideWrite: { kind: 'write', path: join(project, 'new.txt') },
      outsideRead: { kind: 'read', path: secret },
      outsideWrite: { kind: 'write', path: join(outside, 'planted.txt') },
    },
  })

  assert.equal(result.error, null, `applySandbox failed: ${result.error}`)
  assert.equal(result.applied.enforced, true)

  // The project stays usable.
  assert.ok(result.probes.insideRead.ok, 'project files must stay readable')
  assert.ok(result.probes.insideWrite.ok, 'project files must stay writable')

  // This is the assertion that makes "enforced" mean something.
  assert.equal(result.probes.outsideRead.ok, false, 'a file outside the project must not be readable')
  assert.equal(result.probes.outsideWrite.ok, false, 'a file outside the project must not be writable')
  assert.ok(!existsSync(join(outside, 'planted.txt')), 'the denied write must not have landed')

  rmSync(project, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

test('per-file permissions deny writes to a read-only file', (t) => {
  if (!enforces) {
    t.skip(`no enforcement on ${caps.platform}`)
    return
  }

  const project = mkdtempSync(join(tmpdir(), 'vajra-sb-perms-'))
  writeFileSync(join(project, 'readable.txt'), 'data')
  writeFileSync(join(project, 'writable.txt'), 'data')

  const permissions = native.defaultPermissions()
  permissions.files['readable.txt'] = { read: true, write: false, edit: false, delete: false }
  permissions.files['writable.txt'] = { read: true, write: true, edit: true, delete: false }

  const result = runChild({
    config: { projectDir: project, permissions },
    probes: {
      readOnlyRead: { kind: 'read', path: join(project, 'readable.txt') },
      readOnlyWrite: { kind: 'write', path: join(project, 'readable.txt') },
      writableWrite: { kind: 'write', path: join(project, 'writable.txt') },
    },
  })

  assert.equal(result.error, null, `applySandbox failed: ${result.error}`)
  assert.ok(result.probes.readOnlyRead.ok, 'a readable file must stay readable')
  assert.equal(result.probes.readOnlyWrite.ok, false, 'a read-only file must not be writable')
  assert.ok(result.probes.writableWrite.ok, 'a writable file must stay writable')

  rmSync(project, { recursive: true, force: true })
})

test('a missing project directory is rejected', (t) => {
  if (!enforces) {
    t.skip(`no enforcement on ${caps.platform}`)
    return
  }

  const result = runChild({
    config: { projectDir: join(tmpdir(), 'vajra-sb-definitely-absent') },
    probes: {},
  })

  assert.equal(result.applied, null)
  assert.match(result.error, /does not exist/)
})
