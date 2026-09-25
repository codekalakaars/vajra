import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const protocolUrl = pathToFileURL(join(import.meta.dirname, '..', '..', 'protocol', 'dist', 'index.js')).href
const { validatePlan, planParallel, validateContracts, writeSetOf } = await import(protocolUrl)

const evidence = (files = {}, baselines = {}) => ({
  filesRead: new Map(Object.entries(files)),
  baselines: new Map(Object.entries(baselines)),
})

const task = (over = {}) => ({
  id: 'a',
  title: 'Task',
  description: 'does a thing',
  ...over,
})

const provesChange = (over = {}) => ({
  command: 'pnpm',
  args: ['test'],
  expectExit: 0,
  timeoutSeconds: 60,
  kind: 'proves-change',
  ...over,
})

const regressionGuard = (over = {}) => ({
  command: 'pnpm',
  args: ['build'],
  expectExit: 0,
  timeoutSeconds: 60,
  kind: 'regression-guard',
  ...over,
})

const SRC = 'const run = () => {}\nexport { run }\n'

const errorsOf = (tasks, ev) => {
  const result = validatePlan(tasks, ev)
  assert.equal(result.ok, false, 'expected the plan to be rejected')
  return result.errors.join('\n')
}

// --- validatePlan: evidence rules -----------------------------------------

test('a fully evidenced structured plan is accepted', () => {
  const result = validatePlan(
    [
      task({
        context: [{ path: 'src/a.ts', reason: 'the edit site' }],
        edits: [{ path: 'src/a.ts', op: 'modify', anchor: 'const run = () => {}', change: 'Return a tuple.' }],
        verify: [provesChange()],
      }),
    ],
    evidence({ 'src/a.ts': SRC }, { 'a#0': 1 }),
  )
  assert.deepEqual(result, { ok: true })
})

test('rejects a dependency on an unknown task id', () => {
  const message = errorsOf(
    [task({ dependsOn: ['ghost'] })],
    evidence(),
  )
  assert.match(message, /unknown task id 'ghost'/)
})

test('rejects a task that depends on itself', () => {
  const message = errorsOf([task({ dependsOn: ['a'] })], evidence())
  assert.match(message, /depends on itself/)
})

test('read-gate: a context path that was never read is rejected', () => {
  const message = errorsOf(
    [task({ context: [{ path: 'src/unread.ts', reason: 'context' }] })],
    evidence(),
  )
  assert.match(message, /'src\/unread\.ts' as context, but you never read it/)
})

test('rejects a context entry with no reason', () => {
  const message = errorsOf(
    [task({ context: [{ path: 'src/a.ts', reason: '   ' }] })],
    evidence({ 'src/a.ts': SRC }),
  )
  assert.match(message, /gives no reason for reading 'src\/a\.ts'/)
})

test('rejects a task with no edits', () => {
  const message = errorsOf([task()], evidence())
  assert.match(message, /has no edits/)
})

test('rejects creating a file that already exists', () => {
  const message = errorsOf(
    [task({ edits: [{ path: 'src/a.ts', op: 'create', change: 'New file.' }] })],
    evidence({ 'src/a.ts': SRC }),
  )
  assert.match(message, /already exists/)
})

test('rejects creating a file a dependency already creates', () => {
  const message = errorsOf(
    [
      task({
        id: 'maker',
        edits: [{ path: 'src/new.ts', op: 'create', change: 'Make it.' }],
        verify: [provesChange()],
      }),
      task({
        id: 'copier',
        dependsOn: ['maker'],
        edits: [{ path: 'src/new.ts', op: 'create', change: 'Make it again.' }],
        verify: [provesChange()],
      }),
    ],
    evidence({}, { 'maker#0': 1, 'copier#0': 1 }),
  )
  assert.match(message, /'copier' creates 'src\/new\.ts'.*already creates it/)
})

test('rejects an edit to a file that was never read', () => {
  const message = errorsOf(
    [task({ edits: [{ path: 'src/unread.ts', op: 'modify', anchor: 'x', change: 'y' }] })],
    evidence(),
  )
  assert.match(message, /'src\/unread\.ts', but you never read it/)
})

test('allows editing a file only a dependency creates — it cannot be read yet', () => {
  const result = validatePlan(
    [
      task({
        id: 'maker',
        edits: [{ path: 'src/new.ts', op: 'create', change: 'Make it.' }],
        verify: [provesChange()],
      }),
      task({
        id: 'wirer',
        dependsOn: ['maker'],
        edits: [{ path: 'src/new.ts', op: 'modify', change: 'Wire it up.' }],
        verify: [provesChange()],
      }),
    ],
    evidence({}, { 'maker#0': 1, 'wirer#0': 1 }),
  )
  assert.deepEqual(result, { ok: true })
})

test('rejects a modify with no anchor', () => {
  const message = errorsOf(
    [task({ edits: [{ path: 'src/a.ts', op: 'modify', change: 'Do the thing.' }] })],
    evidence({ 'src/a.ts': SRC }),
  )
  assert.match(message, /modifies 'src\/a\.ts' with no anchor/)
})

test('rejects an anchor that does not appear in the file', () => {
  const message = errorsOf(
    [
      task({
        edits: [
          { path: 'src/a.ts', op: 'modify', anchor: 'const run = async () => {}', change: 'Do it.' },
        ],
      }),
    ],
    evidence({ 'src/a.ts': SRC }),
  )
  assert.match(message, /anchor for 'src\/a\.ts' does not appear/)
})

test('rejects an anchor that appears more than once', () => {
  const message = errorsOf(
    [
      task({
        edits: [{ path: 'src/a.ts', op: 'modify', anchor: 'const run', change: 'Do it.' }],
      }),
    ],
    evidence({ 'src/a.ts': 'const run = 1\nconst run = 2\n' }),
  )
  assert.match(message, /appears 2 times and must be unique/)
})

test('rejects a task with no verify commands', () => {
  const message = errorsOf(
    [
      task({
        edits: [{ path: 'src/a.ts', op: 'modify', anchor: 'const run = () => {}', change: 'x' }],
      }),
    ],
    evidence({ 'src/a.ts': SRC }),
  )
  assert.match(message, /has no verify commands/)
})

test('rejects a task whose only checks are regression-guards', () => {
  const message = errorsOf(
    [
      task({
        edits: [{ path: 'src/a.ts', op: 'modify', anchor: 'const run = () => {}', change: 'x' }],
        verify: [regressionGuard()],
      }),
    ],
    evidence({ 'src/a.ts': SRC }, { 'a#0': 0 }),
  )
  assert.match(message, /only regression-guard checks/)
})

test('rejects verify commands containing shell syntax', () => {
  const message = errorsOf(
    [
      task({
        edits: [{ path: 'src/a.ts', op: 'modify', anchor: 'const run = () => {}', change: 'x' }],
        verify: [provesChange({ command: 'pnpm', args: ['test', '&&', 'pnpm', 'build'] })],
      }),
    ],
    evidence({ 'src/a.ts': SRC }, { 'a#0': 1 }),
  )
  assert.match(message, /verify\[0\] contains shell syntax/)
})

test('rejects a verify command that was never baselined', () => {
  const message = errorsOf(
    [
      task({
        edits: [{ path: 'src/a.ts', op: 'modify', anchor: 'const run = () => {}', change: 'x' }],
        verify: [provesChange()],
      }),
    ],
    evidence({ 'src/a.ts': SRC }),
  )
  assert.match(message, /was never run.*run_baseline/)
})

test('rejects a proves-change check that already passes at baseline', () => {
  const message = errorsOf(
    [
      task({
        edits: [{ path: 'src/a.ts', op: 'modify', anchor: 'const run = () => {}', change: 'x' }],
        verify: [provesChange()],
      }),
    ],
    evidence({ 'src/a.ts': SRC }, { 'a#0': 0 }),
  )
  assert.match(message, /already passes before any change/)
})

test('rejects a regression-guard that already fails at baseline', () => {
  const message = errorsOf(
    [
      task({
        edits: [{ path: 'src/a.ts', op: 'modify', anchor: 'const run = () => {}', change: 'x' }],
        verify: [provesChange(), regressionGuard()],
      }),
    ],
    evidence({ 'src/a.ts': SRC }, { 'a#0': 1, 'a#1': 2 }),
  )
  assert.match(message, /regression-guard but already fails/)
})

test('accepts a regression-guard that passes at baseline alongside a proves-change', () => {
  const result = validatePlan(
    [
      task({
        edits: [{ path: 'src/a.ts', op: 'modify', anchor: 'const run = () => {}', change: 'x' }],
        verify: [provesChange(), regressionGuard()],
      }),
    ],
    evidence({ 'src/a.ts': SRC }, { 'a#0': 1, 'a#1': 0 }),
  )
  assert.deepEqual(result, { ok: true })
})

test('write-set conflicts are folded into validatePlan rejections', () => {
  const message = errorsOf(
    [
      task({ id: 'a', edits: [{ path: 'src/shared.ts', op: 'create', change: 'One.' }], verify: [provesChange()] }),
      task({ id: 'b', edits: [{ path: 'src/shared.ts', op: 'create', change: 'Two.' }], verify: [provesChange()] }),
    ],
    evidence({}, { 'a#0': 1, 'b#0': 1 }),
  )
  assert.match(message, /'a' and 'b' both edit 'src\/shared\.ts'/)
})

// --- §7 parallel safety -----------------------------------------------------

test('§7.2 disjoint write sets share one wave with no errors', () => {
  const parallel = planParallel([
    task({ id: 'a', edits: [{ path: 'src/a.ts', op: 'create', change: 'x' }] }),
    task({ id: 'b', edits: [{ path: 'src/b.ts', op: 'create', change: 'y' }] }),
  ])
  assert.deepEqual(parallel.waves, [['a', 'b']])
  assert.deepEqual(parallel.errors, [])
})

test('§7.2 write/write in one wave is a hard error', () => {
  const parallel = planParallel([
    task({ id: 'a', edits: [{ path: 'src/shared.ts', op: 'modify', anchor: 'x', change: 'y' }] }),
    task({ id: 'b', edits: [{ path: 'src/shared.ts', op: 'modify', anchor: 'x', change: 'z' }] }),
  ])
  assert.equal(parallel.errors.length, 1)
  assert.match(parallel.errors[0], /both edit 'src\/shared\.ts'/)
})

test('§7.2 a reader in the same wave as a writer is a hard error', () => {
  const parallel = planParallel([
    task({ id: 'a', edits: [{ path: 'src/shared.ts', op: 'create', change: 'x' }] }),
    task({ id: 'b', context: [{ path: 'src/shared.ts', reason: 'needs it' }] }),
  ])
  assert.equal(parallel.errors.length, 1)
  assert.match(parallel.errors[0], /'b' reads 'src\/shared\.ts' while 'a' edits it/)
})

test('§7.2 an explicit dependsOn makes sharing a file fine', () => {
  const parallel = planParallel([
    task({ id: 'a', edits: [{ path: 'src/shared.ts', op: 'create', change: 'x' }] }),
    task({
      id: 'b',
      dependsOn: ['a'],
      edits: [{ path: 'src/shared.ts', op: 'modify', anchor: 'x', change: 'y' }],
    }),
  ])
  assert.deepEqual(parallel.waves, [['a'], ['b']])
  assert.deepEqual(parallel.errors, [])
})

test('§7.4 three tasks editing one file raise a contention warning', () => {
  const parallel = planParallel([
    task({ id: 'a', dependsOn: [], edits: [{ path: 'src/hot.ts', op: 'create', change: 'x' }] }),
    task({ id: 'b', dependsOn: ['a'], edits: [{ path: 'src/hot.ts', op: 'modify', anchor: 'x', change: 'y' }] }),
    task({ id: 'c', dependsOn: ['b'], edits: [{ path: 'src/hot.ts', op: 'modify', anchor: 'x', change: 'z' }] }),
  ])
  assert.deepEqual(parallel.errors, [])
  assert.equal(parallel.warnings.length, 1)
  assert.match(parallel.warnings[0], /3 tasks edit 'src\/hot\.ts' \(a, b, c\)/)
})

test('writeSetOf counts deletes as writes', () => {
  const paths = [...writeSetOf(task({ edits: [{ path: 'src/gone.ts', op: 'delete', change: 'x' }] }))]
  assert.deepEqual(paths, ['src/gone.ts'])
})

test('writeSetOf includes every flat mutation field', () => {
  const paths = [...writeSetOf(task({
    writeFile: ['src/write.ts'],
    deleteFile: ['src/delete.ts'],
    createDir: ['src/dir'],
  }))].sort()
  assert.deepEqual(paths, ['src/delete.ts', 'src/dir', 'src/write.ts'])
})

test('flat write/write conflicts are hard errors', () => {
  const parallel = planParallel([
    task({ id: 'a', writeFile: ['src/shared.ts'] }),
    task({ id: 'b', writeFile: ['src/shared.ts'] }),
  ])
  assert.equal(parallel.errors.length, 1)
  assert.match(parallel.errors[0], /'a' and 'b' both edit 'src\/shared\.ts'/)
})

test('flat read/write conflicts are hard errors', () => {
  const parallel = planParallel([
    task({ id: 'a', writeFile: ['src/shared.ts'] }),
    task({ id: 'b', readFile: ['src/shared.ts'] }),
  ])
  assert.equal(parallel.errors.length, 1)
  assert.match(parallel.errors[0], /'b' reads 'src\/shared\.ts' while 'a' edits it/)
})

test('equivalent path spellings cannot bypass conflict detection', () => {
  const parallel = planParallel([
    task({ id: 'a', writeFile: ['src/shared.ts'] }),
    task({ id: 'b', writeFile: ['./src/../src/shared.ts'] }),
  ])
  assert.equal(parallel.errors.length, 1)
  assert.match(parallel.errors[0], /both edit 'src\/shared\.ts'/)
})

test('absolute paths under the project use the same identity as relative paths', () => {
  const parallel = planParallel(
    [
      task({ id: 'a', writeFile: ['/project/src/shared.ts'] }),
      task({ id: 'b', writeFile: ['src/shared.ts'] }),
    ],
    '/project',
  )
  assert.equal(parallel.errors.length, 1)
  assert.match(parallel.errors[0], /both edit 'src\/shared\.ts'/)
})

test('drive-letter paths normalize without dropping their root', () => {
  const parallel = planParallel(
    [
      task({ id: 'a', writeFile: ['C:/project/src/shared.ts'] }),
      task({ id: 'b', writeFile: ['src/shared.ts'] }),
    ],
    'C:/project',
  )
  assert.equal(parallel.errors.length, 1)
  assert.match(parallel.errors[0], /both edit 'src\/shared\.ts'/)
})

// --- §7.3 contracts ---------------------------------------------------------

const contract = (over = {}) => ({
  id: 'run-shape',
  statement: 'run_command always returns {exitCode, signal, stdout, stderr} as JSON.',
  producedBy: 'a',
  consumedBy: ['b'],
  ...over,
})

const producerConsumerPlan = () => [
  task({
    id: 'a',
    edits: [{ path: 'src/a.ts', op: 'create', change: 'Define the runCommandResult shape.' }],
  }),
  task({
    id: 'b',
    dependsOn: ['a'],
    edits: [{ path: 'src/b.ts', op: 'create', change: 'Consume runCommandResult.' }],
  }),
]

test('a coherent contract passes', () => {
  const check = validateContracts(producerConsumerPlan(), [contract()])
  assert.deepEqual(check.errors, [])
})

test('rejects a contract naming unknown tasks', () => {
  const producer = validateContracts(producerConsumerPlan(), [contract({ producedBy: 'ghost' })])
  assert.match(producer.errors.join('\n'), /produced by unknown task 'ghost'/)
  const consumer = validateContracts(producerConsumerPlan(), [contract({ consumedBy: ['phantom'] })])
  assert.match(consumer.errors.join('\n'), /consumed by unknown task 'phantom'/)
})

test('rejects a producer listed as its own consumer', () => {
  const check = validateContracts(producerConsumerPlan(), [contract({ consumedBy: ['a'] })])
  assert.match(check.errors.join('\n'), /appears in\s+its own consumedBy/)
})

test('rejects a consumer that does not depend on the producer', () => {
  const plan = [task({ id: 'a' }), task({ id: 'b' })]
  const check = validateContracts(plan, [contract()])
  assert.match(check.errors.join('\n'), /'b' does not depend on producer 'a'/)
})

test('accepts a consumer that depends on the producer transitively', () => {
  const plan = [
    task({ id: 'a' }),
    task({ id: 'mid', dependsOn: ['a'] }),
    task({ id: 'b', dependsOn: ['mid'] }),
  ]
  const check = validateContracts(plan, [contract({ consumedBy: ['b'] })])
  assert.deepEqual(check.errors, [])
})

test('rejects a statement too short to stand alone', () => {
  const check = validateContracts(producerConsumerPlan(), [contract({ statement: 'Use the tuple.' })])
  assert.match(check.errors.join('\n'), /statement is only 14 characters/)
})

test('rejects a statement that back-references prior context', () => {
  const check = validateContracts(
    producerConsumerPlan(),
    [contract({ statement: 'The return shape from the discussion earlier, as discussed.' })],
  )
  assert.match(check.errors.join('\n'), /back-reference/)
})

test('warns when two tasks in one wave mention the same identifier but share no contract', () => {
  const plan = [
    task({ id: 'a', edits: [{ path: 'src/a.ts', op: 'create', change: 'Return runCommandResult.' }] }),
    task({ id: 'b', edits: [{ path: 'src/b.ts', op: 'create', change: 'Parse runCommandResult.' }] }),
  ]
  const check = validateContracts(plan, [])
  assert.deepEqual(check.errors, [])
  assert.equal(check.warnings.length, 1)
  assert.match(check.warnings[0], /'a' and 'b' both mention 'runCommandResult' but share no\s+contract/)
})

test('no candidate warning when both tasks consume the same contract', () => {
  const plan = [
    task({ id: 'c', edits: [{ path: 'src/c.ts', op: 'create', change: 'Define runCommandResult.' }] }),
    task({
      id: 'a',
      dependsOn: ['c'],
      edits: [{ path: 'src/a.ts', op: 'create', change: 'Return runCommandResult.' }],
    }),
    task({
      id: 'b',
      dependsOn: ['c'],
      edits: [{ path: 'src/b.ts', op: 'create', change: 'Parse runCommandResult.' }],
    }),
  ]
  const check = validateContracts(plan, [contract({ producedBy: 'c', consumedBy: ['a', 'b'] })])
  assert.deepEqual(check.errors, [])
  assert.deepEqual(check.warnings, [])
})
