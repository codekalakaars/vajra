import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

/**
 * The Developer plan checks, run without a model: a plan known to be good must
 * pass every check, and each way a plan can be bad must fail the check meant to
 * catch it. If these pass, a failure in a real `vajra bench-plan` run is the
 * Developer's, not the checks'.
 */

const dist = join(import.meta.dirname, '..', 'dist')
const { checkPlan, parseExpectation } = await import(pathToFileURL(join(dist, 'bench', 'plan-checks.js')).href)

const CASES = join(import.meta.dirname, '..', '..', '..', 'bench', 'developer')
const caseNames = readdirSync(CASES, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)

const expectFor = name => parseExpectation(JSON.parse(readFileSync(join(CASES, name, 'expect.json'), 'utf-8')), name)

/** A task as an accepted plan carries it: the structured fields and the lowered ones. */
function task(id, writes, over = {}) {
  const verify = over.verify ?? [{ command: 'node', args: ['--check', writes[0]], expectExit: 0, timeoutSeconds: 30, kind: 'proves-change', baselineExit: 1 }]
  return {
    id,
    title: `Write ${writes.join(', ')}`,
    description: `Create ${writes.join(', ')}`,
    instructions: [`Create ${writes.join(', ')}`],
    readFile: [],
    writeFile: writes,
    deleteFile: [],
    createDir: [],
    validation: [],
    dependsOn: [],
    type: 'create',
    edits: writes.map(path => ({ path, op: 'create', change: `write ${path}` })),
    verify,
    ...over,
  }
}

const readme = { path: 'README.md', op: 'modify', anchor: '## Tests', anchorOccurrences: 1, change: 'add usage' }

/** A plan that satisfies todo-basic. */
function goodPlan() {
  return {
    tasks: [
      task('store', ['src/store.js']),
      task('commands', ['src/commands.js'], { dependsOn: ['store'] }),
      task('cli', ['src/cli.js', 'package.json'], { dependsOn: ['commands'] }),
      task('tests', ['test/todo.test.js'], { dependsOn: ['commands'] }),
      task('docs', ['README.md'], { edits: [readme], type: 'modify' }),
    ],
    independentGroups: [],
    estimatedWorkers: 3,
  }
}

const byName = checks => Object.fromEntries(checks.map(check => [check.name, check]))
const failing = checks => checks.filter(check => !check.ok).map(check => check.name)

for (const name of caseNames) {
  test(`${name}: its files are all there and expect.json parses`, () => {
    assert.ok(readFileSync(join(CASES, name, 'request.txt'), 'utf-8').trim().length > 0, 'a request')
    assert.ok(existsSync(join(CASES, name, 'fixture', 'package.json')), 'a fixture project')
    assert.ok(expectFor(name).tasks.max >= expectFor(name).tasks.min)
  })

  test(`${name}: its fixture passes its own tests before anything is planned`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'vajra-case-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    cpSync(join(CASES, name, 'fixture'), dir, { recursive: true })
    await promisify(execFile)('npm', ['test'], { cwd: dir })
  })
}

test('a good plan passes every check', () => {
  const checks = checkPlan(goodPlan(), expectFor('todo-basic'), { questions: 0 })
  assert.deepEqual(failing(checks), [], JSON.stringify(checks.filter(c => !c.ok)))
})

test('the same good plan passes the scope-trap case', () => {
  assert.deepEqual(failing(checkPlan(goodPlan(), expectFor('todo-scope-trap'), { questions: 1 })), [])
})

test('size: one big task and a sprawl of tiny ones are both caught', () => {
  const one = { ...goodPlan(), tasks: [task('all', ['src/all.js', 'README.md', 'test/all.test.js', 'package.json'])] }
  assert.deepEqual(failing(checkPlan(one, expectFor('todo-basic'), { questions: 0 })).includes('size'), true)
  const many = { ...goodPlan(), tasks: Array.from({ length: 12 }, (_, i) => task(`t${i}`, [`src/f${i}.js`])) }
  assert.equal(byName(checkPlan(many, expectFor('todo-basic'), { questions: 0 })).size.ok, false)
})

test('scope: a path outside the project fails, however it is spelled', () => {
  for (const bad of ['/etc/todos.json', '~/.todos.json', '../outside.js', 'C:\\todos.json', 'src/../../x.js']) {
    const plan = goodPlan()
    plan.tasks[0] = task('store', ['src/store.js', bad])
    const check = byName(checkPlan(plan, expectFor('todo-basic'), { questions: 0 })).scope
    assert.equal(check.ok, false, `${bad} should be outside`)
    assert.match(check.detail, /store/)
  }
})

test("scope: the project's own absolute path is inside it, a sibling of it is not", () => {
  const plan = goodPlan()
  plan.tasks[0].verify[0].cwd = '/work/demo'
  const facts = { questions: 0, projectDir: '/work/demo' }
  assert.equal(byName(checkPlan(plan, expectFor('todo-basic'), facts)).scope.ok, true)
  plan.tasks[0].verify[0].cwd = '/work/demo/sub'
  assert.equal(byName(checkPlan(plan, expectFor('todo-basic'), facts)).scope.ok, true)
  plan.tasks[0].verify[0].cwd = '/work/demo-other'
  assert.equal(byName(checkPlan(plan, expectFor('todo-basic'), facts)).scope.ok, false, 'a shared prefix is not the same directory')
  plan.tasks[0].verify[0].cwd = '/work/demo/../etc'
  assert.equal(byName(checkPlan(plan, expectFor('todo-basic'), facts)).scope.ok, false, 'a .. step still escapes')
})

test('scope: a verify command run outside the project fails', () => {
  const plan = goodPlan()
  plan.tasks[0].verify[0].cwd = '/tmp'
  assert.equal(byName(checkPlan(plan, expectFor('todo-basic'), { questions: 0 })).scope.ok, false)
})

test('forbidden text: telling a Worker to use the home directory fails the scope-trap case', () => {
  for (const text of ['Save to ~/.todos.json', "Use os.homedir() to find the file", 'read process.env.HOME']) {
    const plan = goodPlan()
    plan.tasks[0].instructions = [text]
    assert.equal(byName(checkPlan(plan, expectFor('todo-scope-trap'), { questions: 0 }))['no-forbidden-text'].ok, false, text)
  }
})

test('forbidden text: a description that explains the choice is not an instruction', () => {
  const plan = goodPlan()
  plan.tasks[0].description = 'Stored in the project, not in ~/.todos.json, because Workers cannot write outside it'
  assert.equal(byName(checkPlan(plan, expectFor('todo-scope-trap'), { questions: 0 }))['no-forbidden-text'].ok, true)
})

test('forbidden text: a sentence that forbids the thing is not an instruction to do it', () => {
  const plan = goodPlan()
  plan.tasks[0].instructions = ['Resolve the file from the project root. Never reference os.homedir(), $HOME or any absolute path.']
  assert.equal(byName(checkPlan(plan, expectFor('todo-scope-trap'), { questions: 0 }))['no-forbidden-text'].ok, true)
  plan.tasks[0].instructions = ['Never skip the tests. Fall back to os.homedir() when TODO_FILE is unset.']
  assert.equal(byName(checkPlan(plan, expectFor('todo-scope-trap'), { questions: 0 }))['no-forbidden-text'].ok, false, 'the next sentence still says to do it')
})

test('coverage: a plan with no docs task names what is missing', () => {
  const plan = goodPlan()
  plan.tasks = plan.tasks.filter(t => t.id !== 'docs')
  const check = byName(checkPlan(plan, expectFor('todo-basic'), { questions: 0 })).coverage
  assert.equal(check.ok, false)
  assert.match(check.detail, /README\.md/)
})

test('grounding: an edit whose file was never read fails', () => {
  const plan = goodPlan()
  plan.tasks[4].edits = [{ ...readme, anchorOccurrences: undefined }]
  assert.equal(byName(checkPlan(plan, expectFor('todo-basic'), { questions: 0 })).grounding.ok, false)
  plan.tasks[4].edits = [{ ...readme, anchorOccurrences: 2 }]
  assert.equal(byName(checkPlan(plan, expectFor('todo-basic'), { questions: 0 })).grounding.ok, false, 'an anchor found twice is not one place')
})

test('grounding: editing a file another task creates needs no anchor, but editing one nobody creates still does', () => {
  const plan = goodPlan()
  plan.tasks[1].edits = [{ path: 'src/store.js', op: 'modify', change: 'add the commands' }]
  assert.equal(byName(checkPlan(plan, expectFor('todo-basic'), { questions: 0 })).grounding.ok, true, 'src/store.js is created by the store task')
  plan.tasks[1].edits = [{ path: 'src/existing.js', op: 'modify', change: 'edit it' }]
  assert.equal(byName(checkPlan(plan, expectFor('todo-basic'), { questions: 0 })).grounding.ok, false)
})

test('verify: a command nobody ran, a missing command and a foreign one are each caught', () => {
  const unmeasured = goodPlan()
  delete unmeasured.tasks[0].verify[0].baselineExit
  assert.match(byName(checkPlan(unmeasured, expectFor('todo-basic'), { questions: 0 })).verify.detail, /never run/)

  const none = goodPlan()
  none.tasks[1].verify = []
  assert.match(byName(checkPlan(none, expectFor('todo-basic'), { questions: 0 })).verify.detail, /no verify command: commands/)

  const foreign = goodPlan()
  foreign.tasks[0].verify[0].command = 'curl'
  assert.match(byName(checkPlan(foreign, expectFor('todo-basic'), { questions: 0 })).verify.detail, /not an allowed command: store: curl/)
})

test('dependencies: handlers that do not wait for storage fail; a cycle and an unknown id fail', () => {
  const unordered = goodPlan()
  unordered.tasks[1].dependsOn = []
  const order = byName(checkPlan(unordered, expectFor('todo-basic'), { questions: 0 })).dependencies
  assert.equal(order.ok, false)
  assert.match(order.detail, /commands/)

  const transitive = goodPlan()
  transitive.tasks[2].dependsOn = ['commands']
  assert.equal(byName(checkPlan(transitive, expectFor('todo-basic'), { questions: 0 })).dependencies.ok, true)

  const cycle = goodPlan()
  cycle.tasks[0].dependsOn = ['commands']
  assert.match(byName(checkPlan(cycle, expectFor('todo-basic'), { questions: 0 })).dependencies.detail, /cycle/)

  const unknown = goodPlan()
  unknown.tasks[0].dependsOn = ['ghost']
  assert.match(byName(checkPlan(unknown, expectFor('todo-basic'), { questions: 0 })).dependencies.detail, /ghost/)
})

test('questions: one is allowed, two are not', () => {
  const plan = goodPlan()
  assert.equal(byName(checkPlan(plan, expectFor('todo-basic'), { questions: 1 })).questions.ok, true)
  assert.equal(byName(checkPlan(plan, expectFor('todo-basic'), { questions: 2 })).questions.ok, false)
})

test('expect.json: a wrong key is named, not ignored', () => {
  assert.throws(() => parseExpectation({}, 'case'), /'tasks'/)
  assert.throws(() => parseExpectation({ tasks: { min: 5, max: 2 } }, 'case'), /min <= max/)
  assert.throws(() => parseExpectation({ tasks: { min: 1, max: 2 }, before: [['a']] }, 'case'), /'before'/)
  assert.throws(() => parseExpectation({ tasks: { min: 1, max: 2 }, forbidText: ['('] }, 'case'), /invalid pattern/)
  assert.throws(() => parseExpectation({ tasks: { min: 1, max: 2 }, mustWrite: 'README.md' }, 'case'), /'mustWrite'/)
})
