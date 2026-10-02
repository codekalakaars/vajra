// The four bench suites, checked without a model.
//
// A suite is only a measurement if three things hold, and none of them needs a
// model to establish: the plan is one `validatePlan` accepts on the evidence a
// bench run builds for it; every task's verify command fails on the fixture and
// passes on the solution, so it proves the task did something; and the
// acceptance tests fail on the fixture and pass on the solution, so a run
// cannot pass by doing nothing. The gate is `node --test` and nothing else.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const protocolUrl = pathToFileURL(
  join(import.meta.dirname, '..', '..', '..', 'packages', 'protocol', 'dist', 'index.js')
).href
const { validatePlan } = await import(protocolUrl)

const SUITES = join(import.meta.dirname, '..', '..', '..', 'bench', 'suites')

/** Every directory under bench/suites that carries a plan is a suite. */
const suiteNames = readdirSync(SUITES, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .filter(name => existsSync(join(SUITES, name, 'plan.json')))
  .sort()

const loadSuite = name => {
  const dir = join(SUITES, name)
  const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'))
  return { name, dir, plan, tasks: plan.tasks }
}

/**
 * The acceptance command, as argv: what `vajra bench` reads out of plan.json and
 * spawns with no shell once the tasks are done. It has to be this and not a glob
 * — a shell is not involved, so a suite names its test files outright.
 */
const acceptanceArgv = plan => [plan.acceptance.command, ...(plan.acceptance.args ?? [])]

/** One task's `verify` entry as argv, the way a run runs it. */
const argv = verify => [verify.command, ...(verify.args ?? [])]

/** `node` in a directory, and nothing else: no model, no network, no lock. */
async function runNode(argv, cwd) {
  // `node` is the only command a suite runs, so it is this process's own binary
  // and not whatever the PATH would reach for.
  const [command, ...args] = argv
  assert.equal(command, 'node', `a suite may only run node, not '${command}'`)
  // These two make a nested `node --test` think it is a test of this file, and
  // hand its output back to us instead of running. A suite runs it as a plain
  // command, so they go.
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_TEST_WORKER_ID
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, { cwd, env })
    return { status: 0, output: `${stdout}${stderr}` }
  } catch (error) {
    return {
      status: typeof error.code === 'number' ? error.code : null,
      output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
    }
  }
}

/**
 * A run directory: the fixture as a run finds it, with the solution laid over
 * it when `solved`, and the acceptance tests copied in either way. They decide
 * the run, and they are the one thing no task is allowed to see.
 */
function stage(name, { solved }) {
  const dir = mkdtempSync(join(tmpdir(), `vajra-bench-${name}-`))
  cpSync(join(SUITES, name, 'fixture'), dir, { recursive: true })
  if (solved) cpSync(join(SUITES, name, 'solution'), dir, { recursive: true, force: true })
  cpSync(join(SUITES, name, 'accept'), join(dir, 'accept'), { recursive: true })
  return dir
}

/** What `developer.ts` does to a structured plan before the runtime sees it. */
const describeEdit = edit =>
  edit.op === 'delete'
    ? `Delete ${edit.path}: ${edit.change}`
    : edit.anchor
      ? `In ${edit.path}, at the text \`${edit.anchor}\`: ${edit.change}`
      : `In ${edit.path}: ${edit.change}`

/**
 * A suite is seventy small node processes, and they only wait on each other to
 * fill the machine: run them side by side rather than one after another.
 */
async function runAll(checks, limit = 8) {
  const results = new Array(checks.length)
  let next = 0
  const take = async () => {
    while (next < checks.length) {
      const index = next++
      results[index] = await runNode(checks[index].argv, checks[index].cwd)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, checks.length) }, take))
  return results
}

test('there are the four suites the plan names', () => {
  assert.deepEqual(suiteNames, ['chain', 'fan', 'mixed', 'wide'])
})

for (const name of suiteNames) {
  test(`suite ${name}`, async t => {
    const { tasks, dir, plan } = loadSuite(name)
    const fixtureDir = stage(name, { solved: false })
    const solutionDir = stage(name, { solved: true })
    t.after(() => {
      rmSync(fixtureDir, { recursive: true, force: true })
      rmSync(solutionDir, { recursive: true, force: true })
    })

    // Both sides of every command the suite runs: the acceptance tests, and
    // each task's own test. The fixture side is what a bench run has to earn
    // as a baseline before it starts; the solution side is the proof that the
    // reference result satisfies the plan.
    const accept = acceptanceArgv(plan)
    const checks = [
      { what: 'accept on the fixture', argv: accept, cwd: fixtureDir, passes: false },
      { what: 'accept on the solution', argv: accept, cwd: solutionDir, passes: true },
    ]
    for (const task of tasks) {
      task.verify.forEach((verify, i) => {
        const what = `${task.id} verify[${i}]`
        checks.push({
          what: `${what} on the fixture`,
          argv: argv(verify),
          cwd: fixtureDir,
          passes: false,
          baseline: `${task.id}#${i}`,
        })
        checks.push({ what: `${what} on the solution`, argv: argv(verify), cwd: solutionDir, passes: true })
      })
    }
    const results = await runAll(checks)

    // `planParallel` reads writeFile and readFile even though the structured
    // form carries them too, so the baselines are keyed the way it wants them.
    const baselines = new Map()
    checks.forEach((check, i) => {
      const { status, output } = results[i]
      const verdict = check.passes ? status === 0 : status !== 0
      assert.equal(verdict, true, `${check.what}: ${check.passes ? 'failed' : 'passed'}\n${output}`)
      if (check.baseline) baselines.set(check.baseline, status)
    })

    t.test('the plan says how the run is judged', () => {
      assert.deepEqual(
        acceptanceArgv(plan),
        ['node', '--test', `accept/${name}.test.mjs`],
        'the acceptance command, and nothing a shell would have to expand'
      )
      assert.equal(plan.acceptance.timeoutMs > 0, true)
    })

    t.test('the acceptance tests fail on the fixture', () => {
      const { status, output } = results[0]
      assert.notEqual(status, 0, `accept passed on an untouched fixture:\n${output}`)
    })

    t.test('the acceptance tests pass on the solution', () => {
      const { status, output } = results[1]
      assert.equal(status, 0, `accept failed on the solution:\n${output}`)
    })

    t.test('every task is decided by its own test', () => {
      for (const task of tasks) {
        assert.equal(task.verify.length, 1, `${task.id} has ${task.verify.length} verify commands`)
        const [verify] = task.verify
        const own = `tests/task-${task.id}.test.mjs`
        assert.equal(verify.kind, 'proves-change', task.id)
        assert.deepEqual(argv(verify), ['node', '--test', own], task.id)
        assert.ok(existsSync(join(dir, 'fixture', own)), `${task.id} has no test file`)
        assert.deepEqual(task.validation, [`node --test ${own}`], task.id)
        assert.equal(task.readFile.includes(own), true, `${task.id} cannot read its test`)
        // Only its own test is a test: the other reads each say what they are
        // for, which is what `validatePlan` insists a reason is for.
        const aboutTests = (task.context ?? []).filter(ref => /test/.test(ref.reason))
        assert.deepEqual(
          aboutTests.map(ref => ref.path),
          [own],
          `${task.id} gives the same reason for a file that is not its test`
        )
      }
    })

    t.test('the plan is one validatePlan accepts on the evidence a run builds', () => {
      // What `vajra bench` hands it: every file in the working copy, because no
      // Developer turn read anything, and the measured exit code of every verify
      // command against the fixture it was handed.
      const filesRead = new Map()
      for (const file of readdirSync(fixtureDir, { recursive: true })) {
        const full = join(fixtureDir, file)
        if (!statSync(full).isFile()) continue
        filesRead.set(file.split(sep).join('/'), readFileSync(full, 'utf8'))
      }
      const result = validatePlan(tasks, { filesRead, baselines }, fixtureDir)
      assert.equal(result.ok, true, result.ok ? '' : result.errors.join('\n'))
    })

    t.test('the plan carries the same plan twice: structured, and lowered', () => {
      // The scheduler, the locks and the Worker's prompt read the flat fields;
      // the Developer's plan shape is the structured ones. A suite whose two
      // forms disagree would bench a plan the runtime never sees.
      for (const task of tasks) {
        assert.deepEqual(task.readFile, (task.context ?? []).map(ref => ref.path), task.id)
        assert.deepEqual(
          task.writeFile,
          (task.edits ?? []).filter(edit => edit.op !== 'delete').map(edit => edit.path),
          task.id
        )
        assert.deepEqual(
          task.deleteFile,
          (task.edits ?? []).filter(edit => edit.op === 'delete').map(edit => edit.path),
          task.id
        )
        assert.deepEqual(task.createDir, [], task.id)
        assert.deepEqual(task.instructions, (task.edits ?? []).map(describeEdit), task.id)
      }
    })

    t.test('no task can see the acceptance tests', () => {
      const underAccept = path => path === 'accept' || path.startsWith('accept/')
      for (const task of tasks) {
        const leased = [
          ...task.readFile,
          ...task.writeFile,
          ...task.deleteFile,
          ...task.createDir,
        ]
        for (const path of leased) {
          assert.equal(underAccept(path), false, `${task.id} reaches for ${path}`)
        }
      }
      assert.equal(existsSync(join(dir, 'fixture', 'accept')), false)
    })
  })
}