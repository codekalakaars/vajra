import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = join(import.meta.dirname, '..', 'dist')
const { detectFlake, FlakeHistory, DEFAULT_RERUNS } = await import(
  pathToFileURL(join(root, 'flake.js')).href
)

const request = { taskId: 't', testFiles: ['a.test.ts'], cwd: '.', timeoutMs: 1000 }

/** Returns a runner whose verdict changes on the nth call. */
function scriptedRunner(verdicts) {
  let n = 0
  return {
    name: 'scripted',
    version: 'v1',
    async run() {
      const v = verdicts[Math.min(n, verdicts.length - 1)]
      n += 1
      return {
        tests: [
          v === 'passed'
            ? { id: 'a', ref: 'a.test.ts', target: { kind: 'file', ref: 'a.test.ts' }, status: 'passed' }
            : {
                id: 'a',
                target: { kind: 'file', ref: 'a.test.ts' },
                status: v === 'timeout' ? 'not_run' : 'failed',
                ...(v === 'failed_assertion' ? { failureKind: 'assertion' } : {}),
                ...(v === 'failed_environment'
                  ? { status: 'errored', message: 'boom' }
                  : {}),
              },
        ],
        durationMs: 1,
        timedOut: v === 'timeout',
      }
    },
  }
}

const fixedRunner = (v) => {
  const inner = scriptedRunner([v])
  return inner
}

test('a consistent failure is not flaky', async () => {
  const result = await detectFlake(request, fixedRunner('failed_assertion'))
  assert.equal(result.verdict, 'failed_assertion')
  assert.equal(result.runs, DEFAULT_RERUNS + 1)
})

test('a consistent pass is not rerun at all', async () => {
  // No point spending reruns on a result that is not in doubt.
  const result = await detectFlake(request, fixedRunner('passed'))
  assert.equal(result.verdict, 'passed')
  assert.equal(result.runs, 1)
})

test('a verdict that changes is reported as flaky', async () => {
  const result = await detectFlake(request, scriptedRunner(['failed_assertion', 'passed']))
  assert.equal(result.verdict, 'flaky')
  assert.deepEqual(result.attempts, ['failed_assertion', 'passed'])
})

test('a timeout that then passes is flaky', async () => {
  const result = await detectFlake(request, scriptedRunner(['timeout', 'passed']))
  assert.equal(result.verdict, 'flaky')
})

test('reruns can be disabled', async () => {
  const result = await detectFlake(request, scriptedRunner(['failed_assertion']), 0)
  assert.equal(result.verdict, 'failed_assertion')
  assert.equal(result.runs, 1)
})

// --- history ---

test('history needs a full window before calling a test noisy', () => {
  const history = new FlakeHistory({ window: 4, threshold: 0.5 })
  history.record('a', true)
  assert.equal(history.isNoisy('a'), false, 'one observation is not a trend')
  assert.equal(history.rate('a'), 1)
})

test('a test over the threshold is reported as noisy', () => {
  const history = new FlakeHistory({ window: 4, threshold: 0.5 })
  for (let i = 0; i < 4; i += 1) history.record('a', i < 3)
  assert.equal(history.isNoisy('a'), true)
  assert.deepEqual(history.noisyTests(), ['a'])
})

test('a stable test is not noisy', () => {
  const history = new FlakeHistory({ window: 4, threshold: 0.5 })
  for (let i = 0; i < 10; i += 1) history.record('a', false)
  assert.equal(history.isNoisy('a'), false)
  assert.equal(history.rate('a'), 0)
  assert.deepEqual(history.noisyTests(), [])
})
