import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The bench's checkpoint log: what it prints, what it keeps, and where. The
 * file is the record of a run, so these are about it being there and being
 * written as the run goes, not at the end.
 */

const dist = join(import.meta.dirname, '..', 'dist')
const { createPlanLog, describeAgentEvent } = await import(pathToFileURL(join(dist, 'bench', 'plan-log.js')).href)

const agent = { role: 'developer' }

function setup(t) {
  const caseDir = mkdtempSync(join(tmpdir(), 'vajra-case-log-'))
  t.after(() => rmSync(caseDir, { recursive: true, force: true }))
  let clock = 1_000_000
  const printed = []
  const log = createPlanLog({ caseDir, stamp: '2026-10-05T00-00-00-000Z', write: line => printed.push(line), now: () => clock })
  return { caseDir, log, printed, advance: ms => (clock += ms) }
}

test('the log is a file under the case, never in the project the Developer plans in', t => {
  const { caseDir, log } = setup(t)
  assert.equal(log.path, join(caseDir, 'runs', '2026-10-05T00-00-00-000Z.log'))
  assert.equal(existsSync(log.path), true, 'created before the first checkpoint, so a run that dies at once still leaves one')
})

test('each checkpoint is printed and written, with the seconds since the run began', t => {
  const { log, printed, advance } = setup(t)
  log.note('sandbox started')
  advance(12_340)
  log.event({ type: 'tool-start', agent, callId: 'c1', tool: 'read_file', summary: 'README.md' })
  advance(500)
  log.event({ type: 'tool-end', agent, callId: 'c1', tool: 'read_file', ok: true, ms: 500, detail: '0.1 KB' })

  const written = readFileSync(log.path, 'utf-8').trimEnd().split('\n')
  assert.deepEqual(written, printed, 'the terminal and the file say the same thing')
  assert.match(written[0], /^\+\s+0\.0s {2}sandbox started$/)
  assert.match(written[1], /^\+\s+12\.3s {2}-> read_file README\.md$/)
  assert.match(written[2], /^\+\s+12\.8s {5}ok read_file 0\.5s {2}0\.1 KB$/)
})

test('it is written a line at a time, so a killed run leaves what it had reached', t => {
  const { log } = setup(t)
  log.note('one')
  assert.equal(readFileSync(log.path, 'utf-8').includes('one'), true, 'there before anything closes the file')
})

test('a rejected plan, a stall and a failed tool are each said, with their reasons', () => {
  assert.match(
    describeAgentEvent({ type: 'warning', agent, text: 'plan rejected (attempt 1): file never read' }),
    /plan rejected \(attempt 1\): file never read/,
  )
  assert.match(describeAgentEvent({ type: 'llm-stall', agent, round: 3, afterMs: 45_000 }), /quiet for 45s in round 3/)
  assert.match(
    describeAgentEvent({ type: 'tool-end', agent, callId: 'c', tool: 'run_baseline', ok: false, ms: 2000, detail: 'rejected' }),
    /FAILED run_baseline 2\.0s {2}rejected/,
  )
  assert.match(
    describeAgentEvent({ type: 'llm-end', agent, round: 2, ms: 8200, budget: 20, usage: { promptTokens: 900, completionTokens: 120, totalTokens: 1020 } }),
    /model round 2\/20: 8\.2s, 900 in \/ 120 out/,
  )
})

test('a baseline that exits non-zero is an observation, not a failure', () => {
  assert.match(describeAgentEvent({ type: 'tool-end', agent, callId: 'c', tool: 'run_baseline', ok: false, ms: 10, detail: 'exit 1 (expected)' }), /^ {3}ok run_baseline/)
  assert.match(describeAgentEvent({ type: 'tool-end', agent, callId: 'c', tool: 'run_baseline', ok: false, ms: 10, detail: 'rejected · Permission denied' }), /^ {3}FAILED run_baseline/)
})

test('events that add nothing are dropped', t => {
  const { log, printed } = setup(t)
  log.event({ type: 'llm-start', agent, round: 1 })
  log.event({ type: 'heartbeat', agent, elapsedMs: 5000 })
  assert.deepEqual(printed, [])
})

test('a quiet run says how long it has been quiet, but a short silence is not worth a line', t => {
  const { log, printed, advance } = setup(t)
  log.note('start')
  advance(5_000)
  log.quiet()
  assert.equal(printed.length, 1, 'five seconds is a model thinking')
  advance(20_000)
  log.quiet()
  assert.match(printed[1], /waiting, 25s since the last checkpoint/)
  log.quiet()
  assert.equal(printed.length, 2, 'saying it counts as a checkpoint, so it is not repeated at once')
})
