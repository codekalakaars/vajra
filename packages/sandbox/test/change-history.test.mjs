import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ChangeHistory } from '../dist/index.js'

function project(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-history-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('a modified file is restored to what it was before the first change', async t => {
  const dir = project(t)
  writeFileSync(join(dir, 'a.txt'), 'original')
  const history = new ChangeHistory(dir)

  await history.recordBefore('run', 'a.txt')
  writeFileSync(join(dir, 'a.txt'), 'changed once')
  await history.recordBefore('run', 'a.txt') // a second write must not replace the original
  writeFileSync(join(dir, 'a.txt'), 'changed twice')

  const result = await history.rollback('run')
  assert.deepEqual(result, { restored: ['a.txt'], deleted: [] })
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf-8'), 'original')
})

test('a file that did not exist is deleted on rollback, whether it was seen first or declared created', async t => {
  const dir = project(t)
  const history = new ChangeHistory(dir)

  await history.recordBefore('run', 'new.txt') // absent: recorded as to-be-deleted
  writeFileSync(join(dir, 'new.txt'), 'x')
  writeFileSync(join(dir, 'made.txt'), 'y')
  history.recordCreated('run', 'made.txt')

  const result = await history.rollback('run')
  assert.deepEqual(result.deleted.sort(), ['made.txt', 'new.txt'])
  assert.equal(existsSync(join(dir, 'new.txt')), false)
  assert.equal(existsSync(join(dir, 'made.txt')), false)
})

test('changes are kept apart by run, and a rolled-back run is forgotten', async t => {
  const dir = project(t)
  writeFileSync(join(dir, 'a.txt'), 'A')
  writeFileSync(join(dir, 'b.txt'), 'B')
  const history = new ChangeHistory(dir)
  await history.recordBefore('one', 'a.txt')
  await history.recordBefore('two', 'b.txt')
  writeFileSync(join(dir, 'a.txt'), 'A2')
  writeFileSync(join(dir, 'b.txt'), 'B2')

  await history.rollback('one')
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf-8'), 'A')
  assert.equal(readFileSync(join(dir, 'b.txt'), 'utf-8'), 'B2', 'the other run is untouched')
  assert.equal(history.hasChanges('one'), false)
  assert.deepEqual(history.getActiveTaskIds(), ['two'])
})

test('a path that resolves outside the project is refused, not recorded', async t => {
  const dir = project(t)
  const history = new ChangeHistory(dir)
  await assert.rejects(() => history.recordBefore('run', '../outside.txt'), /outside project directory/)
})
