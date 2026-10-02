import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TODAYS_PARAMS } from '../dist/bench/params.js'
import { loadWorkerParams, WorkerParamsError } from '../dist/bench/config.js'

const configPath = fileURLToPath(new URL('../../../bench/config.json', import.meta.url))

// The keys a tuning sweep has settled, so the committed config differs from
// TODAYS_PARAMS (what an interactive session and the replay fixtures use) in
// exactly these and nowhere else. Anything not listed here must still match.
const TUNED = {
  // 5/5 on wide, chain and fan both ways; median wall time down 41-48% and
  // rounds per task roughly halved (bench/results/2026-10-02-context-pack.jsonl).
  contextPack: true,
}

test('bench/config.json is today\'s behaviour except for the keys a sweep has settled', () => {
  const config = JSON.parse(readFileSync(configPath, 'utf-8'))
  assert.deepEqual(config, { ...TODAYS_PARAMS, ...TUNED })
})

// The leases a config's `readLocks` produces are the scheduler's business, and
// leases.test.mjs is where both modes are pinned down.

// ---------------------------------------------------------------------------
// The context keys. Validated by hand in config.ts, and a typo'd one would be
// ignored — a sweep would then compare two candidates that both quietly ran a
// default, which is the one thing a sweep cannot detect afterwards.
// ---------------------------------------------------------------------------

/** The committed config with `patch` on top, written where `loadWorkerParams` can read it. */
function candidate(patch = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-config-'))
  const file = join(dir, 'config.json')
  writeFileSync(
    file,
    `${JSON.stringify({ ...JSON.parse(readFileSync(configPath, 'utf-8')), ...patch }, null, 2)}\n`,
  )
  return file
}

test('the committed context keys are read, not defaulted', () => {
  const params = loadWorkerParams(configPath)
  assert.equal(params.contextPack, true, 'settled by the context-pack sweep')
  assert.equal(params.elision, false)
  assert.equal(params.checkpoints, false)
  assert.equal(params.respawnContext, false)
  assert.equal(params.packWindowShare, 0.35)
  assert.equal(params.anchorContextLines, 12)
  assert.equal(params.elideAt, 0.5)
  assert.equal(params.keepRecentRounds, 3)
  assert.equal(params.elidedTailLines, 20)
  assert.equal(params.compactAt, 0.7)
  assert.equal(params.stuckCheckpointShare, 0.4)
  assert.equal(params.maxCompactionsWithoutProgress, 3)
  assert.equal(params.checkpointDiffChars, 6000)
  assert.equal(params.respawnDiffChars, 8000)
  assert.equal(params.handoffSummaryChars, 800)
})

test('a context switch that is not a boolean is refused and named', () => {
  for (const key of ['contextPack', 'elision', 'checkpoints', 'respawnContext']) {
    const file = candidate({ [key]: 'yes' })
    assert.throws(
      () => loadWorkerParams(file),
      error => error instanceof WorkerParamsError && error.key === key,
      `${key} accepted a string`,
    )
  }
})

test('a missing context key stops the run and names the key', () => {
  const full = JSON.parse(readFileSync(configPath, 'utf-8'))
  delete full.stuckCheckpointShare
  const dir = mkdtempSync(join(tmpdir(), 'vajra-config-'))
  const file = join(dir, 'config.json')
  writeFileSync(file, JSON.stringify(full))
  assert.throws(
    () => loadWorkerParams(file),
    error => error instanceof WorkerParamsError && error.key === 'stuckCheckpointShare',
  )
})

test('an unknown key is refused, so a sweep cannot vary a key that does nothing', () => {
  const file = candidate({ contextPackk: true })
  assert.throws(
    () => loadWorkerParams(file),
    error => error instanceof WorkerParamsError && error.key === 'contextPackk',
  )
})

test('with both rungs on, compactAt must be above elideAt or the cheap one never fires', () => {
  assert.doesNotThrow(() => loadWorkerParams(candidate({ elision: true, checkpoints: true })))
  assert.throws(
    () => loadWorkerParams(candidate({ elision: true, checkpoints: true, compactAt: 0.5, elideAt: 0.5 })),
    error => error instanceof WorkerParamsError && error.key === 'compactAt',
  )
  // One rung on makes the ordering meaningless, so it is not checked.
  assert.doesNotThrow(() => loadWorkerParams(candidate({ elision: true, compactAt: 0.2 })))
})

test('a share outside 0..1 or a count below its floor is refused', () => {
  for (const [patch, key] of [
    [{ packWindowShare: 0 }, 'packWindowShare'],
    [{ packWindowShare: 1.5 }, 'packWindowShare'],
    [{ elideAt: 0 }, 'elideAt'],
    [{ keepRecentRounds: 0 }, 'keepRecentRounds'],
    [{ elidedTailLines: 0 }, 'elidedTailLines'],
    [{ maxCompactionsWithoutProgress: 0 }, 'maxCompactionsWithoutProgress'],
    [{ handoffSummaryChars: 99 }, 'handoffSummaryChars'],
    [{ anchorContextLines: -1 }, 'anchorContextLines'],
  ]) {
    assert.throws(
      () => loadWorkerParams(candidate(patch)),
      error => error instanceof WorkerParamsError && error.key === key,
      `${JSON.stringify(patch)} was accepted`,
    )
  }
})
