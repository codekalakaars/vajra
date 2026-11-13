import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { diagnose, guideFixes, describeCommand, bwrapProfile, PROFILE_PATH } = await import(pathToFileURL(join(import.meta.dirname, '..', 'dist', 'cli', 'doctor-fix.js')).href)

/** A machine that is ready; each test changes what it needs to. */
const machine = (changes = {}) => ({
  landlockEnforced: true, landlockDetail: 'Landlock ABI 8',
  bwrapPath: '/usr/bin/bwrap', bwrapWorks: true, bwrapDetail: 'works',
  apparmorRestrictsUserns: null, unprivilegedUsernsClone: null, maxUserNamespaces: '50000',
  hasApparmorParser: true, packageManager: 'apt',
  ...changes,
})

test('a machine that is ready has nothing to fix', () => {
  assert.deepEqual(diagnose(machine()), [])
})

test('AppArmor blocking user namespaces gets a profile for bwrap alone, not a global switch', () => {
  const [problem, ...rest] = diagnose(machine({ bwrapWorks: false, apparmorRestrictsUserns: '1' }))
  assert.equal(rest.length, 0)
  assert.equal(problem.id, 'bubblewrap-apparmor')
  const [write, load] = problem.fix.commands
  assert.deepEqual(write.argv, ['tee', PROFILE_PATH])
  assert.match(write.input, /^\/usr\/bin\/bwrap flags=\(unconfined\) \{\n {2}userns,\n\}/m)
  assert.deepEqual(load.argv, ['apparmor_parser', '-r', PROFILE_PATH])
  assert.ok([write, load].every(command => command.sudo))
  assert.ok(!JSON.stringify(problem.fix).includes('sysctl'), 'the broad switch is not what is offered')
})

test('the profile names the real path of bwrap, which is what AppArmor attaches to', () => {
  const [problem] = diagnose(machine({ bwrapPath: '/opt/tools/bin/bwrap', bwrapWorks: false, apparmorRestrictsUserns: '1' }))
  assert.match(problem.fix.commands[0].input, /^\/opt\/tools\/bin\/bwrap flags/m)
  assert.equal(bwrapProfile('/x/bwrap').split('\n')[0], 'abi <abi/4.0>,')
})

test('a missing bubblewrap is installed with whatever package manager the machine has', () => {
  for (const [manager, program] of [['apt', 'apt-get'], ['dnf', 'dnf'], ['pacman', 'pacman'], ['zypper', 'zypper']]) {
    const [problem] = diagnose(machine({ bwrapPath: null, bwrapWorks: false, packageManager: manager }))
    assert.equal(problem.id, 'bubblewrap-missing')
    assert.equal(problem.fix.commands[0].argv[0], program)
    assert.ok(problem.fix.commands[0].argv.includes('bubblewrap'))
  }
})

test('with no known package manager, the person is told to install it, and nothing is offered to run', () => {
  const [problem] = diagnose(machine({ bwrapPath: null, bwrapWorks: false, packageManager: null }))
  assert.equal(problem.fix, undefined)
  assert.match(problem.manual, /bubblewrap/)
})

test('the Debian and kernel settings each get their own sysctl fix', () => {
  const clone = diagnose(machine({ bwrapWorks: false, unprivilegedUsernsClone: '0' }))[0]
  assert.equal(clone.id, 'bubblewrap-userns-clone')
  assert.deepEqual(clone.fix.commands[1].argv, ['sysctl', '-w', 'kernel.unprivileged_userns_clone=1'])
  const max = diagnose(machine({ bwrapWorks: false, maxUserNamespaces: '0' }))[0]
  assert.equal(max.id, 'bubblewrap-max-userns')
  assert.deepEqual(max.fix.commands[1].argv, ['sysctl', '-w', 'user.max_user_namespaces=15000'])
})

test('a cause it does not recognise is shown as it is, with nothing run for the person', () => {
  const [problem] = diagnose(machine({ bwrapWorks: false, bwrapDetail: 'bwrap: something odd' }))
  assert.equal(problem.id, 'bubblewrap-unknown')
  assert.equal(problem.fix, undefined)
  assert.equal(problem.message, 'bwrap: something odd')
})

test('Landlock that cannot be enforced is explained and never "fixed"', () => {
  const [problem] = diagnose(machine({ landlockEnforced: false, landlockDetail: 'Landlock is not enabled' }))
  assert.equal(problem.id, 'landlock')
  assert.equal(problem.fix, undefined)
  assert.match(problem.manual, /5\.13/)
})

test('describeCommand shows a file written through tee as the heredoc a person would type', () => {
  assert.deepEqual(describeCommand({ argv: ['tee', '/x'], input: 'a\nb\n', sudo: true }), ["sudo tee /x <<'EOF'", 'a', 'b', 'EOF'])
  assert.deepEqual(describeCommand({ argv: ['ls'], sudo: false }), ['ls'])
})

function io({ answers, results = () => 0, after = [] }) {
  const log = { lines: [], ran: [], asked: 0 }
  return {
    log,
    io: {
      write: line => log.lines.push(line),
      confirm: async () => answers[log.asked++] ?? false,
      run: command => { log.ran.push(command); return results(command) },
      recheck: () => after,
    },
  }
}

test('nothing runs until the person says yes, and a no leaves the problem standing', async () => {
  const problems = diagnose(machine({ bwrapWorks: false, apparmorRestrictsUserns: '1' }))
  const declined = io({ answers: [false], after: problems })
  assert.equal(await guideFixes(problems, declined.io), false)
  assert.equal(declined.log.ran.length, 0, 'no command ran')
  assert.ok(declined.log.lines.some(line => line.includes('Still not ready')))
})

test('a yes runs each command in order and the check afterwards decides the outcome', async () => {
  const problems = diagnose(machine({ bwrapWorks: false, apparmorRestrictsUserns: '1' }))
  const accepted = io({ answers: [true], after: [] })
  assert.equal(await guideFixes(problems, accepted.io), true)
  assert.deepEqual(accepted.log.ran.map(command => command.argv[0]), ['tee', 'apparmor_parser'])
  assert.ok(accepted.log.lines.some(line => line.startsWith('ok:')))
})

test('a command that fails stops that fix, and the later commands do not run', async () => {
  const problems = diagnose(machine({ bwrapWorks: false, apparmorRestrictsUserns: '1' }))
  const failing = io({ answers: [true], results: command => (command.argv[0] === 'tee' ? 1 : 0), after: problems })
  assert.equal(await guideFixes(problems, failing.io), false)
  assert.deepEqual(failing.log.ran.map(command => command.argv[0]), ['tee'])
  assert.ok(failing.log.lines.some(line => line.includes('failed (exit 1)')))
})

test('a problem with no fix to run is explained, and no question is asked', async () => {
  const problems = diagnose(machine({ landlockEnforced: false, landlockDetail: 'off' }))
  const manual = io({ answers: [], after: problems })
  await guideFixes(problems, manual.io)
  assert.equal(manual.log.asked, 0)
  assert.ok(manual.log.lines.some(line => line.includes('to do yourself')))
})
