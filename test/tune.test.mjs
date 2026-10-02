// The sweep script, against a stub `vajra bench`.
//
// A sweep costs hours of machine time and every number it prints comes from a
// real `vajra bench` run, so the wiring is what needs testing: does the sweep
// write a whole candidate config, hand it to one run at a time, in the order it
// says it will, record what came back, and leave bench/config.json alone? Those
// are answerable against a stub that writes canned results, which is what the
// harness below is. The arithmetic behind the report is unit-tested on its own.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  candidateConfig,
  combinations,
  formatDate,
  formatMs,
  loadSweep,
  median,
  parseArgs,
  percentile,
  renderReport,
  summarise,
  valuesLabel,
} from '../scripts/tune.mjs'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const TUNE = join(REPO, 'scripts', 'tune.mjs')
const BENCH_DIR = join(REPO, 'bench')
const BASE_CONFIG = join(BENCH_DIR, 'config.json')

// A bench that never calls a model: it reads the candidate it was given, and the
// candidate alone decides what comes back.
//
//   taskTimeoutSec 1                 exit 2, no result   a setup error
//   retries 99                       exit 0, no result   a run that produced nothing
//   chain + warmSandboxes 1 + exclusive exit 1 with result  a failed run
//   otherwise                        exit 0 with result  a successful run
//
// Wall clock falls with warmSandboxes and with shared read locks, so the report
// has one unambiguous fastest arrangement to find.
const STUB = `import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { basename } from 'node:path'

const args = process.argv.slice(2)
const suite = basename(args[1])
const config = JSON.parse(readFileSync(args[args.indexOf('--config') + 1], 'utf-8'))
const outPath = args[args.indexOf('--out') + 1]
const log = event => process.env.STUB_LOG && appendFileSync(process.env.STUB_LOG, JSON.stringify({ event, suite, config }) + '\\n')

log('start')
const starts = process.env.STUB_LOG ? readFileSync(process.env.STUB_LOG, 'utf-8').split('\\n').filter(Boolean).filter(line => JSON.parse(line).event === 'start').length : 0
if (process.env.STUB_DIE && Number(process.env.STUB_DIE) === starts) process.exit(9)

if (config.taskTimeoutSec === 1) {
  process.stderr.write('bench: taskTimeoutSec: 1 is not a whole number of seconds\\n')
  process.exit(2)
}
if (config.retries === 99) {
  process.stdout.write('bench: nothing to report\\n')
  process.exit(0)
}

const success = !(suite === 'chain' && config.warmSandboxes === 1 && config.readLocks === 'exclusive')
const wallMs = 1000 - config.warmSandboxes * 100 - (config.readLocks === 'shared' ? 50 : 0) + (suite === 'chain' ? 500 : 0)
const result = {
  suite,
  config,
  success,
  ...(success ? {} : { failureReason: 'task-2 failed after 3 attempts' }),
  wallMs: success ? wallMs : 0,
  criticalPathMs: Math.round(wallMs / 2),
  idleMs: Math.round(wallMs / 10),
  tasks: [],
}
writeFileSync(outPath, JSON.stringify(result))
log('end')
process.exit(success ? 0 : 1)
`

function scratch() {
  return mkdtempSync(join(tmpdir(), 'vajra-tune-test-'))
}

/** A repository with a bench/ tree and a stub bench, ready to sweep. */
function fakeRepo() {
  const root = scratch()
  const stub = join(root, 'stub-bench.mjs')
  writeFileSync(stub, STUB)

  mkdirSync(join(root, 'bench', 'suites', 'wide'), { recursive: true })
  mkdirSync(join(root, 'bench', 'suites', 'chain'), { recursive: true })
  writeFileSync(join(root, 'bench', 'config.json'), readFileSync(BASE_CONFIG))
  for (const suite of ['wide', 'chain']) {
    writeFileSync(join(root, 'bench', 'suites', suite, 'plan.json'), JSON.stringify({ tasks: [] }))
  }

  return { root, stub, log: join(root, 'stub.log') }
}

/** Run the sweep script the way a tuning step does. */
function tune(args, env = {}) {
  const run = spawnSync(process.execPath, [TUNE, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  })
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' }
}

function writeSweep(root, name, sweep) {
  const path = join(root, `${name}.json`)
  writeFileSync(path, JSON.stringify(sweep))
  return path
}

function readResults(path) {
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function readLog(path) {
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}

/** Run one run's worth of record, as the sweep appends it. */
function fakeRun(suite, values, repetition, result) {
  return { sweep: 'stub', date: '2026-10-02', suite, repetition, values, exitCode: result.success ? 0 : 1, result }
}

/** Whitespace runs are padding in a table and meaning nowhere else. */
const squeeze = text => text.replace(/[ \t]+/g, ' ').trim()

/** A table row's cells, which are always separated by at least two spaces. */
function cells(line) {
  return line.trim().split(/\s{2,}/)
}

// ---------------------------------------------------------------------------
// the sweep file
// ---------------------------------------------------------------------------

const KNOWN = ['warmSandboxes', 'scheduleOrder', 'readLocks', 'retries', 'taskTimeoutSec']

test('a sweep file names its suites, its varied keys and its repetitions', () => {
  const root = scratch()
  const path = writeSweep(root, 'warmSandboxes', {
    suites: ['wide', 'chain'],
    repetitions: 5,
    vary: { warmSandboxes: [1, 2, 4] },
  })
  const sweep = loadSweep(path, KNOWN)
  assert.equal(sweep.name, 'warmSandboxes', 'the file name names the sweep')
  assert.deepEqual(sweep.suites, ['wide', 'chain'])
  assert.equal(sweep.repetitions, 5)
  assert.deepEqual(sweep.vary, { warmSandboxes: [1, 2, 4] })
})

test('every sweep file in bench/sweeps loads against the committed config', () => {
  const known = Object.keys(JSON.parse(readFileSync(BASE_CONFIG, 'utf-8')))
  const files = readdirSync(join(BENCH_DIR, 'sweeps')).filter(name => name.endsWith('.json')).sort()
  assert.ok(files.length >= 10, `the tuning steps need their sweeps: found ${files.join(', ')}`)
  for (const file of files) {
    const sweep = loadSweep(join(BENCH_DIR, 'sweeps', file), known)
    assert.ok(sweep.suites.length > 0, `${file} runs at least one suite`)
    assert.ok(sweep.repetitions >= 1, `${file} repeats at least once`)
  }
})

test('a sweep file with no varied keys is the base config, which is the baseline', () => {
  const root = scratch()
  const sweep = loadSweep(writeSweep(root, 'baseline', { suites: ['wide'], repetitions: 5, vary: {} }), KNOWN)
  assert.deepEqual(combinations(sweep.vary), [{}])
})

test('a missing or unknown sweep key is refused, and it names the key', () => {
  const root = scratch()
  assert.throws(() => loadSweep(writeSweep(root, 'a', { repetitions: 5, vary: {} }), KNOWN), /missing key 'suites'/)
  assert.throws(() => loadSweep(writeSweep(root, 'b', { suites: ['wide'], vary: {} }), KNOWN), /missing key 'repetitions'/)
  assert.throws(() => loadSweep(writeSweep(root, 'c', { suites: ['wide'], repetitions: 5 }), KNOWN), /missing key 'vary'/)
  assert.throws(() => loadSweep(writeSweep(root, 'd', { suites: [], repetitions: 5, vary: {} }), KNOWN), /'suites' must be a non-empty array/)
  assert.throws(() => loadSweep(writeSweep(root, 'e', { suites: ['wide'], repetitions: 0, vary: {} }), KNOWN), /'repetitions' must be a whole number/)
  assert.throws(() => loadSweep(writeSweep(root, 'f', { suites: ['wide'], repetitions: 5, vary: {}, speed: [1] }), KNOWN), /unknown key\(s\) speed/)
})

test('a sweep varies keys the config does not have, so no candidate using it could load', () => {
  const root = scratch()
  const unknown = writeSweep(root, 'unknown', { suites: ['wide'], repetitions: 1, vary: { parallelReads: [true] } })
  assert.throws(() => loadSweep(unknown, KNOWN), /'parallelReads' is not a key/)

  const empty = writeSweep(root, 'empty', { suites: ['wide'], repetitions: 1, vary: { warmSandboxes: [] } })
  assert.throws(() => loadSweep(empty, KNOWN), /'vary\.warmSandboxes' must be a non-empty array of values/)
})

test('a base that is not an object, or overrides a key that is not there, is refused', () => {
  const root = scratch()
  assert.throws(() => loadSweep(writeSweep(root, 'a', { suites: ['wide'], repetitions: 1, vary: {}, base: 4 }), KNOWN), /'base' must be a JSON object/)
  assert.throws(() => loadSweep(writeSweep(root, 'b', { suites: ['wide'], repetitions: 1, vary: {}, base: { nope: 1 } }), KNOWN), /'base.nope' is not a key/)
  assert.throws(() => loadSweep(join(root, 'missing.json'), KNOWN), /no sweep file at/)
})

// ---------------------------------------------------------------------------
// candidates
// ---------------------------------------------------------------------------

test('combinations is the product of every varied key, first key varying slowest', () => {
  assert.deepEqual(combinations({ warmSandboxes: [1, 4], readLocks: ['exclusive', 'shared'] }), [
    { warmSandboxes: 1, readLocks: 'exclusive' },
    { warmSandboxes: 1, readLocks: 'shared' },
    { warmSandboxes: 4, readLocks: 'exclusive' },
    { warmSandboxes: 4, readLocks: 'shared' },
  ])
  assert.deepEqual(combinations({}), [{}])
})

test('a candidate is a whole config, in the order bench/config.json reads', () => {
  const base = { warmSandboxes: 4, scheduleOrder: 'plan', readLocks: 'exclusive', retries: 2 }
  const candidate = candidateConfig(base, { scheduleOrder: 'critical-path' }, { warmSandboxes: 8, readLocks: 'shared' })
  assert.deepEqual(Object.keys(candidate), ['warmSandboxes', 'scheduleOrder', 'readLocks', 'retries'])
  assert.deepEqual(candidate, {
    warmSandboxes: 8,
    scheduleOrder: 'critical-path',
    readLocks: 'shared',
    retries: 2,
  })
  assert.deepEqual(base, { warmSandboxes: 4, scheduleOrder: 'plan', readLocks: 'exclusive', retries: 2 }, 'the base is untouched')
})

test('values read the same in the report as in the candidate file', () => {
  assert.equal(valuesLabel({}), '(base config)')
  assert.equal(valuesLabel({ warmSandboxes: 4, readLocks: 'shared' }), 'readLocks="shared", warmSandboxes=4')
})

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

test('flags land where the sweep looks for them', () => {
  const options = parseArgs([
    'bench/sweeps/warmSandboxes.json',
    '--suites', 'wide, chain',
    '--repetitions', '3',
    '--bench-cmd', 'node /tmp/stub.mjs',
    '--results', '/tmp/results.jsonl',
    '--candidates', '/tmp/cand',
    '--root', '/tmp/repo',
    '--verbose',
    '--dry-run',
  ])
  assert.equal(options.sweepPath, 'bench/sweeps/warmSandboxes.json')
  assert.deepEqual(options.suites, ['wide', 'chain'])
  assert.equal(options.repetitions, 3)
  assert.deepEqual(options.benchCommand, ['node', '/tmp/stub.mjs'])
  assert.equal(options.results, '/tmp/results.jsonl')
  assert.equal(options.candidates, '/tmp/cand')
  assert.equal(options.root, '/tmp/repo')
  assert.equal(options.verbose, true)
  assert.equal(options.dryRun, true)
})

test('an unknown flag, a missing value or a second sweep file stops the sweep', () => {
  assert.throws(() => parseArgs(['a.json', '--fast']), /unknown option '--fast'/)
  assert.throws(() => parseArgs(['a.json', '--repetitions']), /--repetitions needs a value/)
  assert.throws(() => parseArgs(['a.json', '--repetitions', 'many']), /--repetitions needs a whole number/)
  assert.throws(() => parseArgs(['a.json', 'b.json']), /only one sweep file/)
  assert.throws(() => parseArgs(['a.json', '--suites', ',']), /--suites needs at least one suite name/)
})

test('--help prints the contract and exits 0; no sweep file exits 2', () => {
  const helped = tune(['--help'])
  assert.equal(helped.status, 0)
  assert.match(helped.stdout, /--bench-cmd/)
  assert.match(helped.stdout, /0 the sweep completed, 1 no run succeeded, 2 setup error/)

  const bare = tune([])
  assert.equal(bare.status, 2)
  assert.match(bare.stdout, /Usage: node scripts\/tune.mjs/)
})

// ---------------------------------------------------------------------------
// one run at a time, with a stub bench
// ---------------------------------------------------------------------------

test('a sweep runs every combination against every suite, one at a time, and records each', () => {
  const { root, stub, log } = fakeRepo()
  const sweep = writeSweep(root, 'stub', {
    name: 'stub',
    suites: ['wide', 'chain'],
    repetitions: 3,
    base: { scheduleOrder: 'critical-path' },
    vary: { warmSandboxes: [1, 4], readLocks: ['exclusive', 'shared'] },
  })
  const results = join(root, 'results.jsonl')
  const candidates = join(root, 'kept')

  const run = tune(
    [sweep, '--root', root, '--bench-cmd', `${process.execPath} ${stub}`, '--results', results, '--candidates', candidates],
    { STUB_LOG: log },
  )

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /^candidates kept$/m, 'a kept candidate directory is named in the report')

  // 4 combinations × 2 suites × 3 repetitions, in the order the README states:
  // each arrangement finishes every suite before the next one starts.
  const records = readResults(results)
  assert.equal(records.length, 24)
  assert.deepEqual(
    records.map(record => `${record.suite}/${record.values.warmSandboxes}/${record.values.readLocks}/${record.repetition}`),
    Array.from({ length: 24 }, (_, index) => {
      const combination = Math.floor(index / 6)
      return [
        Math.floor(index / 3) % 2 === 0 ? 'wide' : 'chain',
        combination < 2 ? 1 : 4,
        combination % 2 === 0 ? 'exclusive' : 'shared',
        (index % 3) + 1,
      ].join('/')
    }),
  )

  // Every run got a whole config: the varied keys replaced, the base applied, and
  // every key bench/config.json requires still in it.
  const config = JSON.parse(readFileSync(BASE_CONFIG, 'utf-8'))
  for (const record of records) {
    assert.deepEqual(Object.keys(record.result.config), Object.keys(config), 'a candidate is a whole config, key for key')
    assert.equal(record.result.config.scheduleOrder, 'critical-path', "the sweep's base reached every run")
    assert.equal(record.result.config.warmSandboxes, record.values.warmSandboxes)
    assert.equal(record.result.config.readLocks, record.values.readLocks)
    assert.equal(record.sweep, 'stub')
    assert.match(record.date, /^\d{4}-\d{2}-\d{2}$/)
  }

  // The stub saw the same runs, in the same order, each finished before the next
  // began: no two runs ever shared a machine.
  const seen = readLog(log)
  assert.equal(seen.length, 48)
  assert.deepEqual(
    seen.filter(event => event.event === 'start').map(event => `${event.suite}/${event.config.warmSandboxes}/${event.config.readLocks}`),
    records.map(record => `${record.suite}/${record.values.warmSandboxes}/${record.values.readLocks}`),
  )
  for (let index = 0; index < seen.length; index += 2) {
    assert.equal(seen[index].event, 'start')
    assert.equal(seen[index + 1].event, 'end')
  }

  // The candidate files are on disk, whole, one per combination.
  assert.deepEqual(JSON.parse(readFileSync(join(candidates, 'stub-003.json'), 'utf-8')), records.at(-1).result.config)

  // And the sweep never touched the config it was asked to vary.
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'bench', 'config.json'), 'utf-8')), config)
})

test('the report names the fastest arrangement per suite and disqualifies a failing one', () => {
  const { root, stub } = fakeRepo()
  const sweep = writeSweep(root, 'stub', {
    name: 'stub',
    suites: ['wide', 'chain'],
    repetitions: 3,
    vary: { warmSandboxes: [1, 4], readLocks: ['exclusive', 'shared'] },
  })

  const run = tune([sweep, '--root', root, '--bench-cmd', `${process.execPath} ${stub}`, '--results', join(root, 'results.jsonl'), '--candidates', join(root, 'candidates')])
  assert.equal(run.status, 0, run.stderr)

  // More Workers and shared read locks both make the stub faster; the only
  // arrangement that fails is warmSandboxes=1 with exclusive locks on chain.
  assert.match(squeeze(run.stdout), /winners\s+wide readLocks="shared", warmSandboxes=4\s+chain readLocks="shared", warmSandboxes=4/)
  assert.match(
    squeeze(run.stdout),
    /disqualified\s+chain readLocks="exclusive", warmSandboxes=1\s+0\/3 — task-2 failed after 3 attempts/,
  )
  assert.match(squeeze(run.stdout), /ok is successful runs out of repetitions/)
})

test('a run with no result of its own is recorded as a failure, not lost', () => {
  const { root, stub } = fakeRepo()
  const setup = writeSweep(root, 'setup', {
    name: 'setup',
    suites: ['wide'],
    repetitions: 2,
    base: { taskTimeoutSec: 1 },
    vary: { warmSandboxes: [1, 4] },
  })
  const setupResults = join(root, 'setup.jsonl')
  const setupRun = tune([setup, '--root', root, '--bench-cmd', `${process.execPath} ${stub}`, '--results', setupResults, '--candidates', join(root, 'candidates')])

  assert.equal(setupRun.status, 1, 'every run failed, so the sweep has nothing to tune with')
  const setupRecords = readResults(setupResults)
  assert.equal(setupRecords.length, 4)
  for (const record of setupRecords) {
    assert.equal(record.exitCode, 2)
    assert.equal(record.result.success, false)
    assert.match(record.result.failureReason, /^setup error \(exit 2\): bench: taskTimeoutSec/)
    assert.deepEqual(Object.keys(record.result), ['suite', 'config', 'success', 'failureReason', 'wallMs', 'criticalPathMs', 'idleMs', 'seekRatio', 'tasks'])
  }

  // Exit 0 without a result file is a lost run, and says so.
  const silent = writeSweep(root, 'silent', {
    name: 'silent',
    suites: ['wide'],
    repetitions: 1,
    base: { retries: 99 },
    vary: { warmSandboxes: [2] },
  })
  const silentResults = join(root, 'silent.jsonl')
  const silentRun = tune([silent, '--root', root, '--bench-cmd', `${process.execPath} ${stub}`, '--results', silentResults, '--candidates', join(root, 'candidates')])

  assert.equal(silentRun.status, 1)
  const [silentRecord] = readResults(silentResults)
  assert.equal(silentRecord.result.success, false)
  assert.match(silentRecord.result.failureReason, /bench exited 0 without a usable result: bench: nothing to report/)
})

test('a bench command that will not start fails every run, with the reason', () => {
  const { root } = fakeRepo()
  const sweep = writeSweep(root, 'missing-bench', { suites: ['wide'], repetitions: 1, vary: { warmSandboxes: [2] } })
  const results = join(root, 'results.jsonl')

  const run = tune([sweep, '--root', root, '--bench-cmd', join(root, 'no-such-bench'), '--results', results, '--candidates', join(root, 'candidates')])

  assert.equal(run.status, 1)
  assert.match(run.stderr, /could not run '.*no-such-bench'/)
  assert.equal(readResults(results)[0].result.success, false)
})

test('a suite that is not there stops the sweep before the first run', () => {
  const { root, stub } = fakeRepo()
  const sweep = writeSweep(root, 'nosuite', { suites: ['wide', 'fan'], repetitions: 1, vary: { warmSandboxes: [2] } })
  const results = join(root, 'results.jsonl')

  const run = tune([sweep, '--root', root, '--bench-cmd', `${process.execPath} ${stub}`, '--results', results, '--candidates', join(root, 'candidates')])

  assert.equal(run.status, 2)
  assert.match(run.stderr, /suite 'fan' is not there/)
  assert.equal(existsSync(results), false, 'nothing ran, so nothing was recorded')
})

test('a candidate config bench could not load stops the sweep, naming the key', () => {
  const { root, stub } = fakeRepo()
  const sweep = writeSweep(root, 'unknown', { suites: ['wide'], repetitions: 1, vary: { parallelReads: [true] } })

  const run = tune([sweep, '--root', root, '--bench-cmd', `${process.execPath} ${stub}`, '--results', join(root, 'results.jsonl'), '--candidates', join(root, 'candidates')])

  assert.equal(run.status, 2)
  assert.match(run.stderr, /'parallelReads' is not a key/)
})

test('--dry-run reports the runs and writes nothing', () => {
  const { root, stub } = fakeRepo()
  const sweep = writeSweep(root, 'stub', { suites: ['wide', 'chain'], repetitions: 3, vary: { warmSandboxes: [1, 4] } })
  const results = join(root, 'results.jsonl')

  const run = tune([sweep, '--root', root, '--bench-cmd', `${process.execPath} ${stub}`, '--results', results, '--candidates', join(root, 'candidates'), '--dry-run'])

  assert.equal(run.status, 0)
  assert.match(squeeze(run.stdout), /12 run\(s\) · dry run, nothing written/)
  assert.match(squeeze(run.stdout), /warmSandboxes 1, 4/)
  assert.equal(existsSync(results), false)
})

test('--repetitions and --suites cut a sweep down without editing its file', () => {
  const { root, stub } = fakeRepo()
  const sweep = writeSweep(root, 'stub', { suites: ['wide', 'chain'], repetitions: 3, vary: { warmSandboxes: [1, 4] } })
  const results = join(root, 'results.jsonl')

  const run = tune([sweep, '--root', root, '--bench-cmd', `${process.execPath} ${stub}`, '--results', results, '--candidates', join(root, 'candidates'), '--suites', 'wide', '--repetitions', '1'])

  assert.equal(run.status, 0, run.stderr)
  const records = readResults(results)
  assert.equal(records.length, 2)
  assert.deepEqual([...new Set(records.map(record => record.suite))], ['wide'])
})

test('the default results file is bench/results/<date>-<sweep>.jsonl, and no temp dir is left behind', () => {
  const { root, stub } = fakeRepo()
  const sweep = writeSweep(root, 'stub', { name: 'stub', suites: ['wide'], repetitions: 1, vary: { warmSandboxes: [4] } })

  const run = tune([sweep, '--root', root, '--bench-cmd', `${process.execPath} ${stub}`])

  assert.equal(run.status, 0, run.stderr)
  const results = join(root, 'bench', 'results', `${formatDate()}-stub.jsonl`)
  assert.equal(existsSync(results), true, 'the operator names neither path and still gets a results file')
  assert.equal(readResults(results).length, 1)
  assert.match(run.stdout, new RegExp(`results {3}bench/results/${formatDate()}-stub\\.jsonl`))
  assert.doesNotMatch(run.stdout, /^candidates /m, 'a temp candidate directory is deleted, so it is not named')
})

test('a second sweep on the same day appends to the same results file', () => {
  const { root, stub } = fakeRepo()
  const sweep = writeSweep(root, 'stub', { name: 'stub', suites: ['wide'], repetitions: 1, vary: { warmSandboxes: [1, 4] } })
  const results = join(root, 'results.jsonl')
  const args = [sweep, '--root', root, '--bench-cmd', `${process.execPath} ${stub}`, '--results', results, '--candidates', join(root, 'candidates')]

  assert.equal(tune(args).status, 0)
  assert.equal(tune(args).status, 0)

  const records = readResults(results)
  assert.equal(records.length, 4)
  assert.deepEqual(records.map(record => record.values.warmSandboxes), [1, 4, 1, 4])
})

// ---------------------------------------------------------------------------
// the score
// ---------------------------------------------------------------------------

test('a median is the middle value, and a p90 is the slowest of five and the second slowest of ten', () => {
  assert.equal(median([5, 1, 3]), 3)
  assert.equal(median([1, 2, 3, 4]), 2.5)
  assert.equal(median([]), undefined)

  assert.equal(percentile([1, 2, 3, 4, 5], 0.9), 5)
  assert.equal(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.9), 90)
  assert.equal(percentile([], 0.9), undefined)
})

test('the medians count successful runs only, and one failure disqualifies the arrangement', () => {
  // wide: warmSandboxes=4 succeeds three times out of four. The failed run's zero
  // wall clock must not drag the median, and 3/4 must still disqualify it.
  const records = [
    fakeRun('wide', { warmSandboxes: 1 }, 1, { success: true, wallMs: 900, idleMs: 90 }),
    fakeRun('wide', { warmSandboxes: 1 }, 2, { success: true, wallMs: 910, idleMs: 91 }),
    fakeRun('wide', { warmSandboxes: 4 }, 1, { success: true, wallMs: 600, idleMs: 60 }),
    fakeRun('wide', { warmSandboxes: 4 }, 2, { success: true, wallMs: 620, idleMs: 62 }),
    fakeRun('wide', { warmSandboxes: 4 }, 3, { success: false, wallMs: 0, idleMs: 0, failureReason: 'task-2 failed after 3 attempts' }),
    fakeRun('wide', { warmSandboxes: 4 }, 4, { success: true, wallMs: 640, idleMs: 64 }),
  ]

  const [suite] = summarise(records)
  assert.equal(suite.suite, 'wide')
  assert.deepEqual(suite.rows.map(row => row.label), ['warmSandboxes=1', 'warmSandboxes=4'], 'qualifying first, disqualified last')

  const [best, partial] = suite.rows
  assert.equal(best.label, 'warmSandboxes=1')
  assert.equal(best.succeeded, 2)
  assert.equal(best.runs, 2)
  assert.equal(best.medianWallMs, 905)
  assert.equal(best.p90WallMs, 910)
  assert.equal(best.medianIdleMs, 90.5)
  assert.equal(best.best, true)

  assert.equal(partial.label, 'warmSandboxes=4')
  assert.equal(partial.succeeded, 3)
  assert.equal(partial.runs, 4)
  assert.equal(partial.medianWallMs, 620, 'the failed run contributes no wall clock')
  assert.equal(partial.p90WallMs, 640)
  assert.equal(partial.best, undefined)
  assert.deepEqual(partial.reasons, ['task-2 failed after 3 attempts'])
  assert.equal(suite.winner.label, 'warmSandboxes=1')
  assert.equal(suite.disqualified.length, 1)
})

test('an arrangement where every run failed has no score at all', () => {
  const records = [
    fakeRun('wide', { warmSandboxes: 8 }, 1, { success: false, wallMs: 0, idleMs: 0, failureReason: 'exit 2' }),
    fakeRun('wide', { warmSandboxes: 8 }, 2, { success: false, wallMs: 0, idleMs: 0, failureReason: 'exit 2' }),
  ]
  const [suite] = summarise(records)
  assert.equal(suite.winner, undefined)
  assert.equal(suite.rows.length, 1)
  assert.equal(suite.rows[0].medianWallMs, undefined)
  assert.equal(suite.rows[0].succeeded, 0)
})

test('the report is a table per suite, then the winners, then what was disqualified', () => {
  const records = [
    fakeRun('wide', { warmSandboxes: 8 }, 1, { success: false, wallMs: 0, idleMs: 0, failureReason: 'task-1 timed out' }),
    fakeRun('wide', { warmSandboxes: 2 }, 1, { success: true, wallMs: 800, idleMs: 80, peakContextShare: 0.42, seekRatio: 0.18 }),
    fakeRun('wide', { warmSandboxes: 2 }, 2, { success: true, wallMs: 820, idleMs: 80, peakContextShare: 0.4, seekRatio: 0.12 }),
    fakeRun('chain', {}, 1, { success: true, wallMs: 5000, idleMs: 4000, seekRatio: 0 }),
  ]

  const report = renderReport({
    root: '/repo',
    sweep: { name: 'warmSandboxes' },
    suites: ['wide', 'chain'],
    repetitions: 2,
    arrangements: 2,
    resultsFile: '/repo/bench/results/2026-10-02-warmSandboxes.jsonl',
    candidatesDir: undefined,
    records,
  })

  assert.match(report, /^sweep warmSandboxes · 2 arrangement\(s\) × 2 suite\(s\) × 2 repetition\(s\)/)
  assert.match(report, /^results {3}bench\/results\/2026-10-02-warmSandboxes\.jsonl$/m)

  // One table per suite: values, success rate, median, p90, idle, peak context, seek.
  const lines = report.split('\n')
  const wide = lines.indexOf('wide')
  assert.deepEqual(cells(lines[wide + 1]), ['values', 'ok', 'median', 'p90', 'idle', 'peak ctx', 'seek'])
  assert.deepEqual(cells(lines[wide + 2]), ['warmSandboxes=2', '2/2', '810ms', '820ms', '80ms', '42%', '18%', 'best'])
  assert.deepEqual(cells(lines[wide + 3]), ['warmSandboxes=8', '0/1', '—', '—', '—', '—', '—', 'disqualified'])
  const chain = lines.indexOf('chain')
  assert.deepEqual(cells(lines[chain + 2]), ['(base config)', '1/1', '5.00s', '5.00s', '4.00s', '—', '0%', 'best'])

  assert.match(squeeze(report), /winners\s+wide warmSandboxes=2\s+chain \(base config\)/)
  assert.match(squeeze(report), /disqualified\s+wide warmSandboxes=8\s+0\/1 — task-1 timed out/)
})

test('milliseconds read as milliseconds and anything slower as seconds', () => {
  assert.equal(formatMs(0), '0ms')
  assert.equal(formatMs(940), '940ms')
  assert.equal(formatMs(1000), '1.00s')
  assert.equal(formatMs(4210.5), '4.21s')
  assert.equal(formatMs(undefined), '—')
})

test('an empty sweep says so rather than printing an empty table', () => {
  const report = renderReport({
    root: '/repo',
    sweep: { name: 'baseline' },
    suites: ['wide'],
    repetitions: 5,
    arrangements: 1,
    resultsFile: '/repo/bench/results/2026-10-02-baseline.jsonl',
    records: [],
  })
  assert.match(report, /No runs were recorded\.$/)
})

// ---------------------------------------------------------------------------
// the append-only log
// ---------------------------------------------------------------------------

test('a run that dies mid-sweep is still one line, and the rest of the sweep goes on', () => {
  const { root, stub, log } = fakeRepo()
  const sweep = writeSweep(root, 'stub', { name: 'stub', suites: ['wide'], repetitions: 2, vary: { warmSandboxes: [1, 4] } })
  const results = join(root, 'results.jsonl')

  // The stub dies on its third run, which is the second run of the second
  // arrangement: one lost run must not cost the sweep the other three.
  const run = tune(
    [sweep, '--root', root, '--bench-cmd', `${process.execPath} ${stub}`, '--results', results, '--candidates', join(root, 'candidates')],
    { STUB_LOG: log, STUB_DIE: '3' },
  )

  assert.equal(run.status, 0, 'three of the four runs succeeded')
  const records = readResults(results)
  assert.equal(records.length, 4)
  assert.equal(records[2].exitCode, 9)
  assert.match(records[2].result.failureReason, /bench exited 9 without a usable result/)
  assert.deepEqual(records.map(record => record.result.success), [true, true, false, true])
})