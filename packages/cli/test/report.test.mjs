import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const reportUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'tasks', 'report.js')).href
const { finalReport } = await import(reportUrl)

function status(partial) {
  return {
    total: 4,
    pending: 0,
    assigned: 0,
    running: 0,
    done: 0,
    failed: 0,
    skipped: 0,
    ready: 0,
    ...partial,
  }
}

test('all done is exit 0 and reports counts', () => {
  const report = finalReport(status({ total: 3, done: 3 }))
  assert.equal(report.exitCode, 0)
  assert.equal(report.lines.length, 1)
  assert.match(report.lines[0], /Completed: 3/)
  assert.match(report.lines[0], /Failed: 0/)
  assert.match(report.lines[0], /Pending: 0/)
})

test('failed tasks force exit 1', () => {
  const report = finalReport(status({ total: 3, done: 2, failed: 1 }))
  assert.equal(report.exitCode, 1)
  assert.match(report.lines[0], /Failed: 1/)
})

test('pending (unresolvable dep) forces exit 1', () => {
  const report = finalReport(status({ total: 2, done: 1, pending: 1 }))
  assert.equal(report.exitCode, 1)
  assert.match(report.lines[0], /Pending: 1/)
})

test('running and assigned count toward pending', () => {
  const report = finalReport(status({ total: 3, done: 1, running: 1, assigned: 1 }))
  assert.equal(report.exitCode, 1)
  assert.match(report.lines[0], /Pending: 2/)
})

test('skipped alone does not fail the run', () => {
  const report = finalReport(status({ total: 3, done: 2, skipped: 1 }))
  assert.equal(report.exitCode, 0)
  assert.match(report.lines[0], /Skipped: 1/)
})
