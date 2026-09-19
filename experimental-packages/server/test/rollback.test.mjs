// Tests for ChangeHistory rollback — restoring modified files.
//
// Verifies that rollback restores a modified file to its original content
// at the correct path.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChangeHistory } from '@codekalakaars/vajra-sandbox'

test('rollback restores a modified file to its original content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-rollback-'))
  try {
    const filePath = 'src/api.ts'
    const fullPath = join(dir, filePath)
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(fullPath, 'original content\n')

    const history = new ChangeHistory(dir)

    // Record original state
    await history.recordBefore('task-1', filePath)
    assert.ok(history.hasChanges('task-1'))

    // Simulate modification
    writeFileSync(fullPath, 'modified content\n')
    assert.equal(readFileSync(fullPath, 'utf8'), 'modified content\n')

    // Rollback
    const result = await history.rollback('task-1')
    assert.ok(result.restored.includes(filePath))
    assert.equal(result.deleted.length, 0)

    // File should be restored
    assert.equal(readFileSync(fullPath, 'utf8'), 'original content\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rollback creates a new file that was created during the task', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-rollback-create-'))
  try {
    const filePath = 'src/new-file.ts'
    const fullPath = join(dir, filePath)
    mkdirSync(join(dir, 'src'), { recursive: true })

    const history = new ChangeHistory(dir)

    // Record original state (file does not exist yet)
    await history.recordBefore('task-1', filePath)
    assert.ok(history.hasChanges('task-1'))

    // Simulate file creation
    writeFileSync(fullPath, 'new content\n')
    assert.ok(readFileSync(fullPath, 'utf8').includes('new content'))

    // Rollback should delete the file
    const result = await history.rollback('task-1')
    assert.ok(result.deleted.includes(filePath))

    // File should be gone
    let exists = true
    try { readFileSync(fullPath, 'utf8') } catch { exists = false }
    assert.ok(!exists, 'file should be deleted after rollback')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rollback without changes is a no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-rollback-noop-'))
  try {
    const history = new ChangeHistory(dir)
    assert.ok(!history.hasChanges('task-1'))

    const result = await history.rollback('task-1')
    assert.equal(result.restored.length, 0)
    assert.equal(result.deleted.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rollback handles multiple files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-rollback-multi-'))
  try {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src/a.ts'), 'content-a\n')
    writeFileSync(join(dir, 'src/b.ts'), 'content-b\n')

    const history = new ChangeHistory(dir)
    await history.recordBefore('task-1', 'src/a.ts')
    await history.recordBefore('task-1', 'src/b.ts')

    writeFileSync(join(dir, 'src/a.ts'), 'modified-a\n')
    writeFileSync(join(dir, 'src/b.ts'), 'modified-b\n')

    const result = await history.rollback('task-1')
    assert.equal(result.restored.length, 2)
    assert.ok(result.restored.includes('src/a.ts'))
    assert.ok(result.restored.includes('src/b.ts'))

    assert.equal(readFileSync(join(dir, 'src/a.ts'), 'utf8'), 'content-a\n')
    assert.equal(readFileSync(join(dir, 'src/b.ts'), 'utf8'), 'content-b\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
