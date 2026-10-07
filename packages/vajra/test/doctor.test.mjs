import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dist = join(import.meta.dirname, '..', 'dist')
const cli = join(dist, 'cli', 'index.js')
const { describeCapabilities } = await import(pathToFileURL(join(dist, 'cli', 'doctor.js')).href)

const caps = (over = {}) => ({
  platform: 'linux',
  filesystem: 'enforced',
  mechanism: 'landlock',
  details: 'Landlock ABI 5',
  abi: 5,
  ...over,
})

test('a kernel that can confine files is reported as ok', () => {
  const report = describeCapabilities(caps(), '6.8.0')
  assert.equal(report.enforced, true)
  assert.match(report.lines.join('\n'), /mechanism\s+landlock \(ABI 5\)/)
  assert.match(report.lines.at(-1), /^ok:/)
})

test('a kernel that cannot is reported as not ok, and says why a guarded shell would not be guarded', () => {
  const report = describeCapabilities(caps({ filesystem: 'unavailable', abi: undefined, details: 'Landlock is not enabled' }), '4.19.0')
  assert.equal(report.enforced, false)
  assert.doesNotMatch(report.lines.join('\n'), /ABI/, 'no ABI is claimed when there is none')
  assert.match(report.lines.at(-1), /^not ok:.*would not be guarded/)
})

test('`vajra --help` lists doctor, and nothing from the old harness', () => {
  const out = spawnSync('node', [cli, '--help'], { encoding: 'utf-8' }).stdout
  assert.match(out, /doctor/)
  for (const gone of ['run', 'bench', 'auth']) assert.doesNotMatch(out, new RegExp(`^\\s+${gone}\\b`, 'm'), `${gone} is gone`)
})

test('`vajra doctor` exits 0 exactly when it says ok', () => {
  const result = spawnSync('node', [cli, 'doctor'], { encoding: 'utf-8' })
  const ok = /^ok:/m.test(result.stdout)
  assert.equal(result.status, ok ? 0 : 1)
})
