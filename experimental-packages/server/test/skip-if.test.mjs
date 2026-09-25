// Tests for skipIf evaluation in agent/master.ts.
//
// Every branch used to be inverted against its own documentation, so tasks
// ran when they should have been skipped and skipped when they should have
// run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { evaluateSkipIf } from '../dist/agent/master.js'

function projectWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-skipif-'))
  for (const name of files) {
    writeFileSync(join(dir, name), '// present\n')
  }
  return dir
}

/** A worker handle whose run_command succeeds or throws, like the real one. */
function handleWhereCommands(succeed) {
  return {
    async callTool(tool) {
      assert.equal(tool, 'run_command')
      if (!succeed) throw new Error('Command failed (exit 1): boom')
      return 'ok'
    },
    stop() {},
  }
}

test('"file exists" skips when the file is there', async (t) => {
  const dir = projectWith(['present.ts'])
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  assert.equal(await evaluateSkipIf(['file exists: present.ts'], dir), true)
})

test('"file exists" does not skip when the file is missing', async (t) => {
  const dir = projectWith([])
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  assert.equal(await evaluateSkipIf(['file exists: absent.ts'], dir), false)
})

test('"file missing" skips when the file is absent', async (t) => {
  const dir = projectWith([])
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  assert.equal(await evaluateSkipIf(['file missing: absent.ts'], dir), true)
})

test('"file missing" does not skip when the file is there', async (t) => {
  const dir = projectWith(['present.ts'])
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  assert.equal(await evaluateSkipIf(['file missing: present.ts'], dir), false)
})

test('"command passes" skips only when the command exits 0', async (t) => {
  const dir = projectWith([])
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  assert.equal(await evaluateSkipIf(['command passes: true'], dir, handleWhereCommands(true)), true)
  assert.equal(await evaluateSkipIf(['command passes: false'], dir, handleWhereCommands(false)), false)
})

test('"command fails" skips only when the command exits non-zero', async (t) => {
  const dir = projectWith([])
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  assert.equal(await evaluateSkipIf(['command fails: false'], dir, handleWhereCommands(false)), true)
  assert.equal(await evaluateSkipIf(['command fails: true'], dir, handleWhereCommands(true)), false)
})

test('command conditions are ignored without a worker handle', async (t) => {
  const dir = projectWith([])
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  assert.equal(await evaluateSkipIf(['command passes: true'], dir), false)
})

test('any satisfied condition skips the task', async (t) => {
  const dir = projectWith(['present.ts'])
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  assert.equal(
    await evaluateSkipIf(['file missing: present.ts', 'file exists: present.ts'], dir),
    true,
  )
})

test('no conditions means no skip', async (t) => {
  const dir = projectWith([])
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  assert.equal(await evaluateSkipIf([], dir), false)
})
