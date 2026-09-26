import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'

const root = join(import.meta.dirname, '..', 'dist')
const {
  parseStrykerReport,
  parseMutmutReport,
  parseSimpleReport,
  parseMutationReport,
  createMutationRunner,
  scoreReport,
  verdictForScore,
  hasTestCriteria,
  isSatisfied,
  cliTarget,
} = await import(pathToFileURL(join(root, 'index.js')).href)

// --- report parsing ---

const strykerJson = JSON.stringify({
  duration: 4210,
  mutants: [
    { id: '1', mutatorName: 'ConditionalExpression', status: 'Killed', killedBy: ['t1'], location: { file: 'src/a.ts', start: { line: 4 } } },
    { id: '2', mutatorName: 'ArithmeticOperator', status: 'Survived', killedBy: [], location: { file: 'src/a.ts', start: { line: 9 } } },
    { id: '3', mutatorName: 'BlockStatement', status: 'NoCoverage', killedBy: [], location: { file: 'src/b.ts', start: { line: 2 } } },
    { id: '4', mutatorName: 'ReturnValue', status: 'CompileError', killedBy: [], location: { file: 'src/b.ts', start: { line: 7 } } },
    { id: '5', mutatorName: 'BooleanLiteral', status: 'Timeout', killedBy: [], location: { file: 'src/c.ts', start: { line: 1 } } },
  ],
})

test('a stryker report maps status to meaning', () => {
  const report = parseStrykerReport(strykerJson)
  assert.equal(report.tool, 'stryker')
  assert.equal(report.mutants.length, 5)
  assert.equal(report.mutants[0].status, 'killed')
  assert.equal(report.mutants[1].status, 'survived')
  assert.equal(report.mutants[2].status, 'no_coverage')
  assert.equal(report.mutants[3].status, 'compile_error')
  assert.equal(report.mutants[0].line, 4)
  assert.deepEqual(report.mutants[0].killedBy, ['t1'])
})

test('a report that is not a mutation report yields null rather than throwing', () => {
  assert.equal(parseStrykerReport('not json'), null)
  assert.equal(parseStrykerReport('{"other":true}'), null)
  assert.equal(parseStrykerReport(null), null)
})

test('an unrecognised stryker status is treated as survived, never killed', () => {
  // Defaulting to killed would inflate the score on a format change.
  const report = parseStrykerReport(JSON.stringify({ mutants: [{ id: '1', status: 'Weird' }] }))
  assert.equal(report.mutants[0].status, 'survived')
})

test('a mutmut json-lines report is ingested', () => {
  const report = parseMutmutReport(
    [
      '{"path":"a.py","line":3,"status":"survived","actual":"False"}',
      '{"path":"b.py","line":9,"status":"killed"}',
    ].join('\n'),
  )
  assert.equal(report.tool, 'mutmut')
  assert.equal(report.mutants.length, 2)
  assert.equal(report.mutants[0].status, 'survived')
  assert.equal(report.mutants[1].status, 'killed')
})

test('a simple status-per-line report is ingested', () => {
  const report = parseSimpleReport('KILLED src/a.ts 4\nSURVIVED src/a.ts 9\nNOCOV src/b.ts 2')
  assert.equal(report.mutants[2].status, 'no_coverage')
  assert.equal(report.mutants[1].file, 'src/a.ts')
})

test('format sniffing picks the right parser', () => {
  assert.equal(parseMutationReport(strykerJson, 'auto').tool, 'stryker')
  assert.equal(parseMutationReport('KILLED a.ts 1', 'auto').tool, 'simple')
  assert.equal(parseMutationReport(strykerJson, 'stryker').tool, 'stryker')
})

// --- scoring ---

const criterion = (over = {}) => ({
  id: 'm1',
  type: 'mutation',
  command: ['npx', 'stryker', 'run'],
  reportPath: 'reports/mutation.json',
  ...over,
})

test('compile errors and timeouts are excluded, not charged against the score', () => {
  // A mutant that does not compile is not a defect a test could have caught.
  const score = scoreReport(criterion(), parseStrykerReport(strykerJson))
  assert.equal(score.total, 5)
  assert.equal(score.scorable, 3)
  assert.equal(score.excluded, 2)
  assert.equal(score.killed, 1)
  assert.equal(score.survived, 1)
  assert.equal(score.noCoverage, 1)
  assert.equal(score.killRate, 1 / 3)
})

test('no coverage and survived are reported apart, because they need different fixes', () => {
  const score = scoreReport(criterion(), parseStrykerReport(strykerJson))
  const statuses = score.undetected.map((u) => u.status).sort()
  assert.deepEqual(statuses, ['no_coverage', 'survived'])
})

test('a fully killed suite scores 1 and satisfies the criterion', () => {
  const report = parseStrykerReport(
    JSON.stringify({ mutants: [{ id: '1', status: 'Killed', killedBy: ['t'] }] }),
  )
  const score = scoreReport(criterion(), report)
  assert.equal(score.killRate, 1)
  assert.equal(verdictForScore(score).satisfied, true)
})

test('the default threshold demands every mutant be caught', () => {
  const score = scoreReport(criterion(), parseStrykerReport(strykerJson))
  assert.equal(score.minKillRate, 1)
  assert.equal(verdictForScore(score).satisfied, false)
})

test('a lower threshold is honoured when the Developer sets one', () => {
  const score = scoreReport(criterion({ minKillRate: 0.3 }), parseStrykerReport(strykerJson))
  assert.equal(verdictForScore(score).satisfied, true)
})

test('an empty scorable set scores 1 rather than dividing by zero', () => {
  const report = parseStrykerReport(JSON.stringify({ mutants: [{ id: '1', status: 'CompileError' }] }))
  const score = scoreReport(criterion(), report)
  assert.equal(score.scorable, 0)
  assert.equal(score.killRate, 1)
})

// --- the green-baseline rule ---

const runnerWith = (baseline, execResult, report) =>
  createMutationRunner(
    { criteria: [criterion()], baseline },
    {
      exec: async () => execResult,
      readFile: async () => report,
    },
  )

const greenBaseline = {
  name: 'baseline',
  version: '1',
  run: async () => ({ tests: [{ id: 't1', ref: 't1', target: cliTarget('x'), status: 'passed' }], durationMs: 1 }),
}
const redBaseline = {
  name: 'baseline',
  version: '1',
  run: async () => ({ tests: [{ id: 't1', ref: 't1', target: cliTarget('x'), status: 'failed', failureKind: 'assertion' }], durationMs: 1 }),
}

test('mutation scoring is refused when the baseline is red', async () => {
  // If the suite already fails, "a test failed on the mutant" cannot be
  // attributed to the mutant. The number would be noise, so it is not produced.
  const runner = runnerWith(redBaseline, { stdout: '', code: 0 }, strykerJson)
  const result = await runner.runMutation([criterion()])
  assert.equal(result.scores[0].applicable, false)
  assert.match(result.scores[0].reason, /not green/)
  assert.equal(result.outcomes[0].status, 'errored')
  // And an errored baseline must never satisfy a Phase One gate.
  assert.equal(isSatisfied('fail_on_assertion', 'failed_environment'), false)
})

test('the baseline runs once, not once per criterion', async () => {
  let calls = 0
  const counting = {
    name: 'b',
    version: '1',
    run: async () => {
      calls += 1
      return { tests: [{ id: 't', ref: 't', target: cliTarget('x'), status: 'passed' }], durationMs: 1 }
    },
  }
  const runner = createMutationRunner(
    { criteria: [criterion(), criterion({ id: 'm2' })], baseline: counting },
    { exec: async () => ({ stdout: '', code: 0 }), readFile: async () => strykerJson },
  )
  await runner.runMutation([criterion(), criterion({ id: 'm2' })])
  assert.equal(calls, 1)
  assert.equal(runner.name, 'mutation')
})

test('a mutation tool that fails is an environment failure, not a low score', async () => {
  const runner = runnerWith(greenBaseline, { stdout: 'Stryker: config error', code: 2 }, strykerJson)
  const result = await runner.runMutation([criterion()])
  assert.equal(result.outcomes[0].status, 'errored')
  assert.match(result.outcomes[0].message, /exited 2/)
  assert.equal(verdictForScore(result.scores[0]).satisfied, false)
})

test('an unparseable report is an environment failure, not a pass', async () => {
  const runner = runnerWith(greenBaseline, { stdout: '', code: 0 }, 'garbage')
  const result = await runner.runMutation([criterion()])
  assert.equal(result.outcomes[0].status, 'errored')
  assert.match(result.outcomes[0].message, /could not parse/)
})

test('a report with no mutants is not a pass', async () => {
  const runner = runnerWith(greenBaseline, { stdout: '', code: 0 }, JSON.stringify({ mutants: [] }))
  const result = await runner.runMutation([criterion()])
  assert.match(result.outcomes[0].message, /no mutants/)
})

test('a surviving mutant is a per-test assertion failure, visible in the list', async () => {
  const runner = runnerWith(greenBaseline, { stdout: '', code: 0 }, strykerJson)
  const result = await runner.runMutation([criterion()])
  const survived = result.outcomes.find((o) => o.message.includes('ArithmeticOperator'))
  assert.equal(survived.status, 'failed')
  assert.equal(survived.failureKind, 'assertion')
  assert.match(survived.message, /survived/)
  const killed = result.outcomes.find((o) => o.message.includes('ConditionalExpression'))
  assert.equal(killed.status, 'passed')
  // Every message names the mutant and where, so a reader can tell forty
  // mutants apart in the per-test list.
  for (const outcome of result.outcomes) {
    assert.match(outcome.message, /at \S+/)
  }
  assert.match(killed.message, /killed by t1/)
})

// --- criterion type wiring ---

test('a mutation criterion is one only a run can settle', () => {
  assert.equal(hasTestCriteria({ successCriteria: [{ type: 'mutation' }] }), true)
  assert.equal(hasTestCriteria({ successCriteria: [{ type: 'review' }] }), false)
})

// --- end to end with a real mutation tool over a real suite ---

test('a real seeded defect in real code turns a real check red', async () => {
  // The point of mutation scoring: a hand-written expectation that passes every
  // other time proves nothing on its own. What gives the suite teeth is that
  // breaking the code makes it go red. Here a real defect is seeded into real
  // source and a real check script is run against each, so the loop is
  // exercised end to end with no dependency.
  //
  // The check is a plain script rather than a nested `node --test`: a test
  // runner spawned from inside a test runner silently runs nothing, which
  // would report every mutant as survived.
  const dir = await mkdtemp(join(tmpdir(), 'vajra-mut-'))
  try {
    const SOURCE = 'export function isAdult(age) {\n  return age >= 18 && age < 130\n}\n'
    await writeFile(join(dir, 'sum.mjs'), SOURCE)
    // A real check: it asserts both bounds of the rule, so both mutants that
    // remove a bound must be caught.
    await writeFile(
      join(dir, 'check.mjs'),
      `import assert from 'node:assert/strict'
import { isAdult } from './sum.mjs'
assert.equal(isAdult(20), true)
assert.equal(isAdult(10), false)
assert.equal(isAdult(130), false)
assert.equal(isAdult(5), false)
`,
    )

    const exec = (argv) =>
      new Promise((resolve) => {
        const child = spawn(argv[0], argv.slice(1), { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        child.stdout?.on('data', (c) => {
          stdout += String(c)
        })
        child.on('close', (code) => resolve({ stdout, code }))
      })

    const baseline = {
      name: 'check',
      version: '1',
      run: async () => {
        const r = await exec(['node', 'check.mjs'])
        return {
          tests: [
            {
              id: 'isAdult',
              ref: 'check.mjs',
              target: cliTarget('check.mjs'),
              status: r.code === 0 ? 'passed' : 'failed',
              ...(r.code === 0 ? {} : { failureKind: 'assertion' }),
              message: r.stdout.slice(0, 200),
            },
          ],
          durationMs: 1,
        }
      },
    }

    const mutants = [
      { id: 'drop-upper-bound', mutator: 'ConditionalExpression', line: 2, source: 'export function isAdult(age) {\n  return age >= 18\n}\n' },
      { id: 'drop-lower-bound', mutator: 'ConditionalExpression', line: 2, source: 'export function isAdult(age) {\n  return age < 130\n}\n' },
      { id: 'invert', mutator: 'ConditionalExpression', line: 2, source: 'export function isAdult(age) {\n  return !(age >= 18 && age < 130)\n}\n' },
    ]

    const reportPath = join(dir, 'report.json')
    const toolExec = async () => {
      const killed = []
      for (const mutant of mutants) {
        await writeFile(join(dir, 'sum.mjs'), mutant.source)
        const run = await exec(['node', 'check.mjs'])
        if (run.code !== 0) killed.push(mutant.id)
      }
      await writeFile(join(dir, 'sum.mjs'), SOURCE)
      await writeFile(
        reportPath,
        JSON.stringify({
          mutants: mutants.map((m) => ({
            id: m.id,
            mutatorName: m.mutator,
            status: killed.includes(m.id) ? 'Killed' : 'Survived',
            killedBy: killed.includes(m.id) ? ['isAdult'] : [],
            location: { file: 'sum.mjs', start: { line: m.line } },
          })),
        }),
      )
      return { stdout: 'done', code: 0 }
    }

    const runner = createMutationRunner({ criteria: [criterion({ reportPath })], baseline }, {
      exec: toolExec,
      readFile: async () => (await import('node:fs/promises')).readFile(reportPath, 'utf8'),
    })

    const result = await runner.runMutation([criterion({ reportPath })])
    const score = result.scores[0]
    assert.equal(score.applicable, true)
    assert.equal(score.total, 3)
    // The check asserts both bounds, so every seeded defect is caught. A
    // surviving mutant here would mean the scoring loop is not looking.
    assert.equal(score.survived, 0, JSON.stringify(score.undetected))
    assert.equal(score.noCoverage, 0, JSON.stringify(score.undetected))
    assert.equal(score.killRate, 1)
    assert.equal(verdictForScore(score).satisfied, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a check that misses a bound lets that mutant survive, and the score says so', async () => {
  // The same loop with a weaker check. This is the failure mode mutation
  // scoring exists to expose: the suite is green, and useless.
  const dir = await mkdtemp(join(tmpdir(), 'vajra-mut-'))
  try {
    const SOURCE = 'export function isAdult(age) {\n  return age >= 18 && age < 130\n}\n'
    await writeFile(join(dir, 'sum.mjs'), SOURCE)
    // Only asserts the lower bound, so dropping the upper bound goes unnoticed.
    await writeFile(
      join(dir, 'check.mjs'),
      `import assert from 'node:assert/strict'
import { isAdult } from './sum.mjs'
assert.equal(isAdult(20), true)
assert.equal(isAdult(10), false)
`,
    )

    const exec = (argv) =>
      new Promise((resolve) => {
        const child = spawn(argv[0], argv.slice(1), { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
        child.on('close', (code) => resolve({ code }))
      })

    const mutants = [
      { id: 'drop-upper-bound', source: 'export function isAdult(age) {\n  return age >= 18\n}\n' },
      { id: 'invert', source: 'export function isAdult(age) {\n  return !(age >= 18 && age < 130)\n}\n' },
    ]

    const reportPath = join(dir, 'report.json')
    const runner = createMutationRunner(
      {
        criteria: [criterion({ reportPath })],
        baseline: {
          name: 'check',
          version: '1',
          run: async () => ({
            tests: [{ id: 'isAdult', ref: 'check.mjs', target: cliTarget('check.mjs'), status: 'passed' }],
            durationMs: 1,
          }),
        },
      },
      {
        exec: async () => {
          const killed = []
          for (const m of mutants) {
            await writeFile(join(dir, 'sum.mjs'), m.source)
            if ((await exec(['node', 'check.mjs'])).code !== 0) killed.push(m.id)
          }
          await writeFile(join(dir, 'sum.mjs'), SOURCE)
          await writeFile(
            reportPath,
            JSON.stringify({
              mutants: mutants.map((m) => ({
                id: m.id,
                mutatorName: 'ConditionalExpression',
                status: killed.includes(m.id) ? 'Killed' : 'Survived',
                killedBy: [],
                location: { file: 'sum.mjs', start: { line: 2 } },
              })),
            }),
          )
          return { stdout: '', code: 0 }
        },
        readFile: async () => (await import('node:fs/promises')).readFile(reportPath, 'utf8'),
      },
    )

    const result = await runner.runMutation([criterion({ reportPath })])
    const score = result.scores[0]
    assert.equal(score.survived, 1)
    assert.equal(score.killed, 1)
    assert.equal(score.killRate, 0.5)
    // And the task must not verify: the tests are green and cannot tell right
    // from wrong.
    assert.equal(verdictForScore(score).satisfied, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
