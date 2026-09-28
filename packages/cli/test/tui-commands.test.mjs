import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const commandsUrl = pathToFileURL(
  join(import.meta.dirname, '..', 'dist', 'tui', 'session', 'commands.js'),
).href
const { parseSlashCommand, matchSlashCommands, findSlashCommand, SLASH_COMMANDS, HELP_LINES } =
  await import(commandsUrl)

/**
 * The menu is gone: its options are slash commands at the session prompt.
 * Only a single command-shaped token is a command — everything else must
 * reach the model as a normal message, or a path would turn into an error.
 */

const known = text => {
  const parsed = parseSlashCommand(text)
  assert.ok(parsed, `expected ${text} to parse`)
  assert.equal(parsed.known, true, `expected ${text} to be known`)
  return parsed.command
}

test('every menu option is reachable as a slash command', () => {
  assert.equal(known('/config'), 'config')
  // The names someone would reach for instead, since a settings screen has
  // three obvious names and picking one arbitrarily makes the other two fail.
  assert.equal(known('/settings'), 'config')
  assert.equal(known('/setup'), 'config')
  assert.equal(known('/model'), 'model')
  assert.equal(known('/sessions'), 'sessions')
  assert.equal(known('/help'), 'help')
  assert.equal(known('/quit'), 'quit')
  assert.equal(known('/exit'), 'quit')
})

test('commands are case-insensitive and tolerate surrounding space', () => {
  assert.equal(known('/Config'), 'config')
  assert.equal(known('/Model'), 'model')
  assert.equal(known('/SESSIONS'), 'sessions')
  assert.equal(known('  /quit  '), 'quit')
})

test('the commands /config replaced are gone, aliases and all', () => {
  // /dir and /defaults answered halves of the same question /config answers, and
  // a user who found one of them never learned the other three settings were on
  // a screen. They are unknown now, and said to be — quietly doing nothing would
  // be worse than either version.
  for (const gone of ['/dir', '/directory', '/defaults']) {
    const parsed = parseSlashCommand(gone)
    assert.ok(parsed, `${gone} should still parse as a command-shaped token`)
    assert.equal(parsed.known, false, `${gone} must no longer be a command`)
  }
})

test('only a lone command-shaped token is a command', () => {
  assert.equal(parseSlashCommand('hello'), null)
  assert.equal(parseSlashCommand(''), null)
  assert.equal(parseSlashCommand('/etc/hosts'), null)
  assert.equal(parseSlashCommand('/model now'), null)
  assert.equal(parseSlashCommand('/ do something'), null)
  assert.equal(parseSlashCommand('try /model'), null)
})

test('an unknown command token is reported, not sent', () => {
  const parsed = parseSlashCommand('/frobnicate')
  assert.ok(parsed)
  assert.equal(parsed.known, false)
  assert.equal(parsed.name, '/frobnicate')
})

test('help lists every command plus the way to start', () => {
  const text = HELP_LINES.join('\n')
  for (const cmd of ['/config', '/model', '/reasoning', '/sessions', '/help', '/quit']) {
    assert.ok(text.includes(cmd), `help should mention ${cmd}`)
  }
  assert.ok(text.includes('Type a task'))
})

test('the palette offers every command for an empty query, in order', () => {
  assert.deepEqual(
    matchSlashCommands('').map(c => c.name),
    SLASH_COMMANDS.map(c => c.name),
  )
})

test('the palette filters by prefix and by alias', () => {
  assert.deepEqual(matchSlashCommands('mod').map(c => c.name), ['model'])
  assert.deepEqual(matchSlashCommands('conf').map(c => c.name), ['config'])
  assert.deepEqual(matchSlashCommands('ses').map(c => c.name), ['sessions'])
  // Nothing is offered for the commands /config absorbed.
  assert.deepEqual(matchSlashCommands('dir'), [])
  assert.deepEqual(matchSlashCommands('def'), [])
  // An alias prefix finds the command it belongs to.
  assert.deepEqual(matchSlashCommands('session').map(c => c.name), ['sessions'])
  assert.deepEqual(matchSlashCommands('model').map(c => c.name), ['model'])
  // /models is not a command: the model's facts are in its picker row, and a
  // second command that dumps the same numbers is a second thing to forget.
  assert.deepEqual(matchSlashCommands('models'), [])
  assert.deepEqual(matchSlashCommands('zzz'), [])
})

test('aliases resolve to the canonical command', () => {
  assert.equal(findSlashCommand('exit')?.name, 'quit')
  assert.equal(findSlashCommand('q')?.name, 'quit')
  assert.equal(findSlashCommand('settings')?.name, 'config')
  assert.equal(findSlashCommand('directory'), undefined)
  assert.equal(findSlashCommand('Model')?.name, 'model', 'lookup is case-insensitive')
  assert.equal(findSlashCommand('nope'), undefined)
})

test('the palette and /help come from one table', () => {
  for (const command of SLASH_COMMANDS) {
    assert.ok(
      HELP_LINES.some(line => line.includes(`/${command.name}`)),
      `/help should document /${command.name}`,
    )
    assert.ok(command.summary.length > 0, `${command.name} needs a summary for the palette`)
  }
})
