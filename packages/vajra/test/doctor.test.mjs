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

const { renderChecklist } = await import(pathToFileURL(join(dist, 'cli', 'doctor.js')).href)
const working = { path: '/usr/bin/bwrap', works: true, detail: 'ok', reason: null }
const broken = { path: '/usr/bin/bwrap', works: false, detail: 'x', reason: 'bwrap: setting up uid map: Permission denied' }
const apparmor = { id: 'bubblewrap-apparmor', message: 'AppArmor stops user namespaces', fix: { title: 'Install a profile for bwrap', commands: [] } }

test('checklist: when everything is there it says ok, with a tick for each item and nothing to fix', () => {
  const out = renderChecklist(caps(), '6.8.0', working, [])
  assert.equal(out.ready, true)
  const text = out.lines.join('\n')
  assert.equal([...text.matchAll(/✔/g)].length, 3)
  assert.doesNotMatch(text, /✘/)
  assert.match(out.lines.at(-1), /^ok: /)
})

test('checklist: a failing item is crossed, shows what bwrap said, and the cause and fix are named', () => {
  const out = renderChecklist(caps(), '6.8.0', broken, [apparmor])
  assert.equal(out.ready, false)
  const text = out.lines.join('\n')
  assert.match(text, /✘ +Bubblewrap +installed at \/usr\/bin\/bwrap, but it cannot build the view/)
  assert.match(text, /uid map: Permission denied/)
  assert.match(text, /^ {2}Cause {3}AppArmor stops user namespaces$/m)
  assert.match(text, /^ {2}Fix {5}Install a profile for bwrap$/m)
  assert.match(text, /vajra doctor --fix/)
  assert.match(out.lines.find(line => line.startsWith('not ok')), /cannot open a shell/)
})

test('checklist: a problem with nothing to run is told as "To do", and --fix is not suggested for it', () => {
  const manual = { id: 'landlock', message: 'cannot confine', manual: 'Add landlock to the kernel command line' }
  const out = renderChecklist(caps({ filesystem: 'unavailable', details: 'Landlock is off' }), '4.19', working, [manual])
  const text = out.lines.join('\n')
  assert.match(text, /✘ +Landlock +not enforced/)
  assert.match(text, /^ {2}To do {3}Add landlock/m)
  assert.doesNotMatch(text, /doctor --fix/)
})

test('checklist: a missing bubblewrap is shown as not installed', () => {
  const out = renderChecklist(caps(), '6.8.0', { path: null, works: false, detail: 'not installed', reason: null }, [])
  assert.match(out.lines.join('\n'), /✘ +Bubblewrap +not installed/)
})

test('checklist: color is added only when asked for', () => {
  assert.doesNotMatch(renderChecklist(caps(), '6.8.0', working, []).lines.join('\n'), /\x1b\[/)
  assert.match(renderChecklist(caps(), '6.8.0', working, [], true).lines.join('\n'), /\x1b\[32m✔/)
})
