#!/usr/bin/env node

// The sweep: run every arrangement, keep the fastest that always finishes.
//
//   node bench/tune.mjs bench/sweeps/cpu-thresholds.json
//
// A sweep file names the suites, the keys to vary with their values, and how
// many times each combination is repeated. Every combination becomes one whole
// `bench/config.json` candidate — never a patch of it, because bench reads a
// complete file or refuses to start — and every candidate runs against every
// suite, one run at a time, so two runs never share a Worker pool.
//
// Runs speak the bench contract from packages/vajra/src/bench/params.ts:
//
//   <cmd> bench <suite-dir> --config <candidate> --out <result.json>
//
//   exit 0  every task completed and the acceptance command passed
//   exit 1  the run failed
//   exit 2  setup error: no run happened, so there is no result to read
//
// A run that exits 0 or 1 wrote its result file, and that file is the record.
// A run that exits 2, or wrote nothing usable, is recorded as a failure with
// the reason, so every line of the results file has the same shape and a lost
// run cannot silently become a missing one.
//
// This script decides nothing. It writes candidates, collects results and
// prints them. bench/config.json is written by a human, at the end, once a
// sweep has said which arrangement wins.
//
// Exit codes: 0 the sweep completed, 1 it completed without a single
// successful run, 2 setup error (bad sweep file, unreadable config, a suite
// that is not there).

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const CONFIG_RELATIVE = 'bench/config.json'
const SUITES_RELATIVE = 'bench/suites'
const RESULTS_RELATIVE = 'bench/results'

/** The CLI as it is built, so a sweep measures the code and not a stale copy. */
const DEFAULT_BENCH_COMMAND = [process.execPath, join('packages', 'vajra', 'dist', 'cli', 'index.js')]

/** The keys a sweep file may hold. `name` and `base` are optional. */
const SWEEP_KEYS = ['name', 'suites', 'repetitions', 'vary', 'base']

const USAGE = `Usage: node bench/tune.mjs <sweep.json> [options]

Runs every arrangement a sweep file names, one bench run at a time, and prints
the score of each: success rate, median and p90 wallMs, median idleMs. Anything
under 100% success is marked disqualified.

Options:
  --suites <a,b>       run only these suites, whatever the sweep file lists
  --repetitions <n>    repeat each combination n times instead of the file's own
  --bench-cmd <cmd>    the command that speaks 'bench' (default: the built CLI)
  --results <file>     append results here
                       (default: bench/results/<date>-<sweep>.jsonl)
  --candidates <dir>   write candidate configs here (default: a temp dir)
  --keep-candidates    leave that temp directory behind instead of deleting it
  --root <dir>         the repository holding bench/ (default: this one)
  --verbose            let each run's own output through as it happens
  --dry-run            print the runs that would happen, write nothing
  -h, --help           this text

Exit: 0 the sweep completed, 1 no run succeeded, 2 setup error.`

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

/** A setup error: nothing ran, so nothing was measured. */
function fail(message) {
  throw new Error(message)
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function flagValue(argv, index, flag) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('-')) fail(`${flag} needs a value`)
  return value
}

function countValue(raw, flag) {
  const count = Number(raw)
  if (!Number.isInteger(count) || count < 1) fail(`${flag} needs a whole number of at least 1, not '${raw}'`)
  return count
}

/**
 * Parse argv into options. Every flag is optional except the sweep file, and an
 * unknown flag stops the sweep before it spends an hour finding out.
 */
export function parseArgs(argv) {
  const options = {
    sweepPath: undefined,
    suites: undefined,
    repetitions: undefined,
    benchCommand: undefined,
    results: undefined,
    candidates: undefined,
    keepCandidates: false,
    root: REPO_ROOT,
    verbose: false,
    dryRun: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true
        break
      case '--verbose':
        options.verbose = true
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--keep-candidates':
        options.keepCandidates = true
        break
      case '--suites':
        options.suites = flagValue(argv, i, arg).split(',').map(name => name.trim()).filter(Boolean)
        if (options.suites.length === 0) fail('--suites needs at least one suite name')
        i++
        break
      case '--repetitions':
        options.repetitions = countValue(flagValue(argv, i, arg), arg)
        i++
        break
      case '--bench-cmd': {
        const command = flagValue(argv, i, arg).split(/\s+/).filter(Boolean)
        if (command.length === 0) fail('--bench-cmd needs a command')
        options.benchCommand = command
        i++
        break
      }
      case '--results':
        options.results = flagValue(argv, i, arg)
        i++
        break
      case '--candidates':
        options.candidates = flagValue(argv, i, arg)
        i++
        break
      case '--root':
        options.root = flagValue(argv, i, arg)
        i++
        break
      default:
        if (arg.startsWith('-')) fail(`unknown option '${arg}'`)
        if (options.sweepPath !== undefined) fail(`only one sweep file, and '${options.sweepPath}' is already given`)
        options.sweepPath = arg
    }
  }

  return options
}

// ---------------------------------------------------------------------------
// the sweep file
// ---------------------------------------------------------------------------

/** bench/config.json, which every candidate is built from. */
export function readBaseConfig(root) {
  const path = join(root, CONFIG_RELATIVE)
  if (!existsSync(path)) fail(`${path} is missing: a sweep varies a complete config, and there is none`)
  let config
  try {
    config = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (error) {
    fail(`${path} is not JSON: ${error.message}`)
  }
  if (!isPlainObject(config)) fail(`${path} must hold a JSON object`)
  return config
}

/**
 * Read a sweep file and hold it to the contract: `suites`, `repetitions` and
 * `vary` are required, unknown keys are refused, and every key it varies or
 * overrides has to be a key bench/config.json already carries — otherwise the
 * candidate would be missing a key and bench would refuse every run of it.
 */
export function loadSweep(path, knownKeys = []) {
  if (!existsSync(path)) fail(`no sweep file at ${path}`)

  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (error) {
    fail(`${path} is not JSON: ${error.message}`)
  }
  if (!isPlainObject(raw)) fail(`${path} must hold a JSON object`)

  const unknown = Object.keys(raw).filter(key => !SWEEP_KEYS.includes(key))
  if (unknown.length > 0) fail(`${path}: unknown key(s) ${unknown.join(', ')}`)
  for (const key of ['suites', 'repetitions', 'vary']) {
    if (raw[key] === undefined) fail(`${path}: missing key '${key}'`)
  }

  if (typeof raw.name === 'string' && raw.name.trim().length > 0) {
    raw.name = raw.name.trim()
  } else {
    raw.name = basename(path, '.json')
  }

  if (!Array.isArray(raw.suites) || raw.suites.length === 0) fail(`${path}: 'suites' must be a non-empty array`)
  raw.suites.forEach(suite => {
    if (typeof suite !== 'string' || suite.trim().length === 0) fail(`${path}: every suite name must be a non-empty string`)
  })
  raw.suites = raw.suites.map(suite => suite.trim())

  if (!Number.isInteger(raw.repetitions) || raw.repetitions < 1) {
    fail(`${path}: 'repetitions' must be a whole number of at least 1`)
  }

  if (!isPlainObject(raw.vary)) fail(`${path}: 'vary' must be an object of keys to values`)
  for (const [key, values] of Object.entries(raw.vary)) {
    if (!knownKeys.includes(key)) {
      fail(`${path}: '${key}' is not a key of ${CONFIG_RELATIVE}, so a candidate using it could not be loaded`)
    }
    if (!Array.isArray(values) || values.length === 0) fail(`${path}: 'vary.${key}' must be a non-empty array of values`)
  }

  if (raw.base !== undefined) {
    if (!isPlainObject(raw.base)) fail(`${path}: 'base' must be a JSON object`)
    for (const key of Object.keys(raw.base)) {
      if (!knownKeys.includes(key)) fail(`${path}: 'base.${key}' is not a key of ${CONFIG_RELATIVE}`)
    }
  }

  return raw
}

// ---------------------------------------------------------------------------
// candidates
// ---------------------------------------------------------------------------

/**
 * The cartesian product of the varied keys, first key varying slowest, so a
 * two-key sweep reads as pairs down the list. An empty `vary` gives the single
 * combination the base config already is — which is what the baseline and the
 * final confirmation are.
 */
export function combinations(vary) {
  let all = [{}]
  for (const [key, values] of Object.entries(vary)) {
    const next = []
    for (const partial of all) {
      for (const value of values) next.push({ ...partial, [key]: value })
    }
    all = next
  }
  return all
}

/** One whole config file: the base, the sweep's overrides, then this combination. */
export function candidateConfig(base, overrides, values) {
  return { ...base, ...(overrides ?? {}), ...values }
}

/** How a combination reads in the report. */
export function valuesLabel(values) {
  const keys = Object.keys(values).sort()
  if (keys.length === 0) return '(base config)'
  return keys.map(key => `${key}=${JSON.stringify(values[key])}`).join(', ')
}

// ---------------------------------------------------------------------------
// one run
// ---------------------------------------------------------------------------

function readResultFile(path) {
  if (!existsSync(path)) return undefined
  try {
    const result = JSON.parse(readFileSync(path, 'utf-8'))
    return isPlainObject(result) && typeof result.success === 'boolean' ? result : undefined
  } catch {
    return undefined
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return {}
  }
}

/** The last few lines of a failed run's output, which is usually the reason. */
function reasonFrom(output) {
  const lines = String(output ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return ''
  return lines.slice(-3).join(' | ').slice(0, 300)
}

/**
 * A result for a run that produced none: no BenchResult, but still a line in the
 * results file, so a bench command that will not start reads as a sweep full of
 * failures rather than as no data at all.
 */
function failedResult(suite, config, failureReason) {
  return {
    suite,
    config,
    success: false,
    failureReason,
    wallMs: 0,
    criticalPathMs: 0,
    idleMs: 0,
    seekRatio: 0,
    tasks: [],
  }
}

/**
 * Run one combination against one suite once, and return what it produced.
 * Nothing here decides anything: the run's own result file is the record, and
 * every path that has no result file becomes a failure that says why.
 */
export function runOnce({ benchCommand, suiteDir, suite, candidatePath, outPath, root, verbose }) {
  const [command, ...prefix] = benchCommand
  const args = [...prefix, 'bench', suiteDir, '--config', candidatePath, '--out', outPath]

  const run = verbose
    ? spawnSync(command, args, { cwd: root, stdio: 'inherit' })
    : spawnSync(command, args, { cwd: root, encoding: 'utf-8' })

  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`

  if (run.error) {
    return {
      exitCode: null,
      result: failedResult(suite, readJson(candidatePath), `could not run '${command}': ${run.error.message}`),
    }
  }

  const exitCode = run.status
  if (exitCode === 2) {
    const detail = reasonFrom(output)
    return {
      exitCode,
      result: failedResult(suite, readJson(candidatePath), `setup error (exit 2)${detail ? `: ${detail}` : ''}`),
    }
  }

  const result = readResultFile(outPath)
  if (result) return { exitCode, result }

  const detail = reasonFrom(output)
  return {
    exitCode,
    result: failedResult(
      suite,
      readJson(candidatePath),
      run.signal
        ? `bench was killed by ${run.signal}${detail ? `: ${detail}` : ''}`
        : `bench exited ${exitCode} without a usable result${detail ? `: ${detail}` : ''}`,
    ),
  }
}

// ---------------------------------------------------------------------------
// the score
// ---------------------------------------------------------------------------

function maxOf(values) {
  return values.length === 0 ? undefined : Math.max(...values)
}

export function median(values) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Nearest-rank percentile: the smallest value at or above the given share of the
 * sorted sample. With five repetitions p90 is the slowest run and with ten it is
 * the second slowest — which is the point of asking for it.
 */
export function percentile(values, share) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil(share * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

/**
 * One row per suite per combination: how often it succeeded, how fast it was
 * when it did. A failed run has no score, so the medians count successes only,
 * and anything that missed a repetition is disqualified however fast it looked.
 */
export function summarise(records) {
  const bySuite = new Map()
  for (const record of records) {
    if (!bySuite.has(record.suite)) bySuite.set(record.suite, new Map())
    const rows = bySuite.get(record.suite)
    const label = valuesLabel(record.values)
    if (!rows.has(label)) rows.set(label, { values: record.values, suite: record.suite, runs: [] })
    rows.get(label).runs.push(record.result)
  }

  const suites = []
  for (const [suite, rows] of bySuite) {
    const summarised = [...rows.values()].map(row => {
      const succeeded = row.runs.filter(result => result.success)
      const walls = succeeded.map(result => result.wallMs).filter(Number.isFinite)
      return {
        suite,
        values: row.values,
        label: valuesLabel(row.values),
        runs: row.runs.length,
        succeeded: succeeded.length,
        medianWallMs: median(walls),
        p90WallMs: percentile(walls, 0.9),
        medianIdleMs: median(succeeded.map(result => result.idleMs).filter(Number.isFinite)),
        // Over every run, failed ones included: a run that overflowed its
        // window is the one this column exists to catch.
        peakContextShare: maxOf(row.runs.map(result => result.peakContextShare).filter(Number.isFinite)),
        // The worst of the run, not the median: one task whose pack was missing
        // everything it wanted is enough to make the arrangement under it wrong.
        seekRatio: maxOf(row.runs.map(result => result.seekRatio).filter(Number.isFinite)),
        reasons: row.runs.filter(result => !result.success).map(result => result.failureReason ?? 'failed'),
      }
    })

    const qualifying = summarised
      .filter(row => row.runs > 0 && row.succeeded === row.runs && row.medianWallMs !== undefined)
      .sort((a, b) => a.medianWallMs - b.medianWallMs)
    const disqualified = summarised
      .filter(row => row.succeeded !== row.runs || row.medianWallMs === undefined)
      .sort((a, b) => a.succeeded - b.succeeded || (a.medianWallMs ?? Infinity) - (b.medianWallMs ?? Infinity))

    const best = qualifying[0]?.medianWallMs
    for (const row of qualifying) row.best = row.medianWallMs === best

    suites.push({ suite, rows: [...qualifying, ...disqualified], winner: qualifying[0], disqualified })
  }

  return suites
}

// ---------------------------------------------------------------------------
// printing
// ---------------------------------------------------------------------------

export function formatMs(ms) {
  if (ms === undefined || !Number.isFinite(ms)) return '—'
  if (Math.abs(ms) < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function formatDate(date = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function table(headers, rows) {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map(row => row[column].length)))
  const line = cells =>
    cells
      .map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column])))
      .join('  ')
      .trimEnd()
  return [line(headers), ...rows.map(line)].join('\n')
}

function rowCells(row) {
  // The reason a run failed is in the disqualified list at the end, not here: a
  // long reason would stretch this column and push the numbers away from it.
  const note = row.best ? 'best' : row.succeeded === row.runs ? '' : 'disqualified'
  return [
    row.label,
    `${row.succeeded}/${row.runs}`,
    formatMs(row.medianWallMs),
    formatMs(row.p90WallMs),
    formatMs(row.medianIdleMs),
    row.peakContextShare === undefined ? '—' : `${Math.round(row.peakContextShare * 100)}%`,
    row.seekRatio === undefined ? '—' : `${Math.round(row.seekRatio * 100)}%`,
    note,
  ]
}

/**
 * The report: per suite, one row per arrangement, qualifying ones first and
 * fastest on top. Everything a tuning step needs to keep a winner is here, and
 * nothing is written to bench/config.json by this or by anything else in this
 * file.
 */
export function renderReport({ sweep, suites, repetitions, arrangements, resultsFile, candidatesDir, records, root }) {
  const lines = []
  lines.push(
    `sweep ${sweep.name} · ${arrangements} arrangement(s) × ${suites.length} suite(s) × ${repetitions} repetition(s)`,
  )
  lines.push(`results   ${relative(root, resultsFile)}`)
  if (candidatesDir) lines.push(`candidates ${relative(root, candidatesDir)}`)
  lines.push('')
  lines.push('ok is successful runs out of repetitions; the medians count successful runs only.')
  lines.push('Anything short of 100% is disqualified, however fast it looked.')
  lines.push('')

  const summary = summarise(records)
  if (summary.length === 0) {
    lines.push('No runs were recorded.')
    return lines.join('\n')
  }

  for (const suite of summary) {
    lines.push(`${suite.suite}`)
    lines.push(
      table(['values', 'ok', 'median', 'p90', 'idle', 'peak ctx', 'seek', ''], suite.rows.map(rowCells)),
    )
    lines.push('')
  }

  lines.push('winners')
  for (const suite of summary) {
    lines.push(`  ${suite.suite.padEnd(10)}${suite.winner ? suite.winner.label : 'nothing qualified'}`)
  }

  const failed = summary.flatMap(suite => suite.disqualified.map(row => ({ suite, row })))
  if (failed.length > 0) {
    lines.push('')
    lines.push('disqualified')
    for (const { suite, row } of failed) {
      lines.push(`  ${suite.suite.padEnd(10)}${row.label}  ${row.succeeded}/${row.runs} — ${row.reasons[0] ?? 'failed'}`)
    }
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// the sweep
// ---------------------------------------------------------------------------

/** Every suite must exist before the first run, not at the first run. */
function suiteDirs(root, suites) {
  return suites.map(suite => {
    const dir = join(root, SUITES_RELATIVE, suite)
    if (!existsSync(dir)) fail(`suite '${suite}' is not there: expected ${dir}`)
    if (!existsSync(join(dir, 'plan.json'))) fail(`suite '${suite}' has no plan.json in ${dir}`)
    return { suite, dir }
  })
}

export function runSweep(options) {
  const root = resolve(options.root ?? REPO_ROOT)
  const base = readBaseConfig(root)
  const sweep = loadSweep(resolve(options.sweepPath), Object.keys(base))
  const suites = options.suites ?? sweep.suites
  const repetitions = options.repetitions ?? sweep.repetitions
  const benchCommand = options.benchCommand ?? DEFAULT_BENCH_COMMAND

  const dirs = suiteDirs(root, suites)
  const candidates = combinations(sweep.vary).map((values, index) => ({
    index,
    values,
    config: candidateConfig(base, sweep.base, values),
  }))
  const total = candidates.length * dirs.length * repetitions

  const date = formatDate()
  const resultsFile = resolve(options.results ?? join(root, RESULTS_RELATIVE, `${date}-${sweep.name}.jsonl`))

  if (options.dryRun) {
    return {
      root,
      sweep,
      suites,
      repetitions,
      candidates,
      total,
      resultsFile,
      candidatesDir: undefined,
      benchCommand,
      records: [],
      report: dryRunReport({ root, sweep, dirs, repetitions, resultsFile, candidatesDir: options.candidates ? resolve(options.candidates) : undefined, total }),
    }
  }

  const candidatesDir = resolve(options.candidates ?? mkdtempSync(join(tmpdir(), 'vajra-tune-')))
  // A temp directory is deleted when the sweep ends; only a directory the
  // operator named or asked to keep is worth naming in the report.
  const keptCandidates = options.keepCandidates || options.candidates !== undefined ? candidatesDir : undefined
  mkdirSync(dirname(resultsFile), { recursive: true })
  mkdirSync(candidatesDir, { recursive: true })

  const records = []
  let done = 0
  const log = line => process.stderr.write(`${line}\n`)

  log(`sweep ${sweep.name}: ${total} run(s), one at a time`)
  log(`results ${relative(root, resultsFile)}`)

  try {
    for (const candidate of candidates) {
      const candidatePath = join(candidatesDir, `${sweep.name}-${String(candidate.index).padStart(3, '0')}.json`)
      writeFileSync(candidatePath, `${JSON.stringify(candidate.config, null, 2)}\n`)

      for (const { suite, dir } of dirs) {
        for (let repetition = 1; repetition <= repetitions; repetition++) {
          done += 1
          const outPath = join(candidatesDir, `${sweep.name}-${String(candidate.index).padStart(3, '0')}-${suite}-r${repetition}.json`)
          const { exitCode, result } = runOnce({
            benchCommand,
            suiteDir: dir,
            suite,
            candidatePath,
            outPath,
            root,
            verbose: options.verbose,
          })

          const record = {
            sweep: sweep.name,
            date,
            suite,
            repetition,
            values: candidate.values,
            exitCode,
            result,
          }
          records.push(record)
          appendFileSync(resultsFile, `${JSON.stringify(record)}\n`)

          const outcome = result.success
            ? formatMs(result.wallMs)
            : `failed: ${result.failureReason ?? 'no reason given'}`
          log(`run ${String(done).padStart(String(total).length)}/${total}  ${suite}  ${valuesLabel(candidate.values)}  rep ${repetition}  → ${outcome}`)
        }
      }
    }
  } finally {
    if (keptCandidates === undefined) rmSync(candidatesDir, { recursive: true, force: true })
  }

  return {
    root,
    sweep,
    suites,
    repetitions,
    candidates,
    total,
    resultsFile,
    candidatesDir: keptCandidates,
    benchCommand,
    records,
    report: renderReport({
      root,
      sweep,
      suites,
      repetitions,
      arrangements: candidates.length,
      resultsFile,
      candidatesDir: keptCandidates,
      records,
    }),
  }
}

function dryRunReport({ root, sweep, dirs, repetitions, resultsFile, candidatesDir, total }) {
  const lines = [
    `sweep ${sweep.name} · ${total} run(s) · dry run, nothing written`,
    `results   ${relative(root, resultsFile)}`,
    `candidates ${candidatesDir ? relative(root, candidatesDir) : 'a temp dir'}`,
    '',
  ]
  for (const [key, values] of Object.entries(sweep.vary)) {
    lines.push(`  ${key.padEnd(20)}${values.map(value => JSON.stringify(value)).join(', ')}`)
  }
  if (Object.keys(sweep.vary).length === 0) lines.push('  (no varied keys: one arrangement, the base config)')
  lines.push('')
  lines.push(`  ${dirs.map(({ suite }) => suite).join(', ')} × ${repetitions} repetition(s)`)
  return lines.join('\n')
}

/** True when at least one run succeeded, which is the difference between 0 and 1. */
function anySucceeded(records) {
  return records.some(record => record.result.success)
}

// ---------------------------------------------------------------------------

function main(argv) {
  const options = parseArgs(argv)
  if (options.help || options.sweepPath === undefined) {
    process.stdout.write(`${USAGE}\n`)
    return options.help ? 0 : 2
  }

  const sweep = runSweep(options)
  process.stdout.write(`${sweep.report}\n`)
  return sweep.records.length === 0 || anySucceeded(sweep.records) ? 0 : 1
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`tune: ${error.message}\n`)
    process.stderr.write(`tune: nothing ran\n`)
    process.exitCode = 2
  }
}