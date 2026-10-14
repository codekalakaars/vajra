import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const { agentOf, findAgent, quote, resumeCommand, startWith } = await import(pathToFileURL(join(import.meta.dirname, '..', 'dist', 'session', 'resume.js')).href)

test('each agent resumes with its own option', () => {
  assert.deepEqual(resumeCommand('claude'), ['claude', '--continue'])
  assert.deepEqual(resumeCommand('opencode'), ['opencode', '--continue'])
  assert.deepEqual(resumeCommand('codex'), ['codex', 'resume', '--last'])
})

test('an agent is recognised by its program name, or by the script a runtime was given', () => {
  assert.equal(agentOf(['/home/a/.local/bin/claude', '--model', 'x']), 'claude')
  assert.equal(agentOf(['opencode']), 'opencode')
  assert.equal(agentOf(['node', '/usr/lib/node_modules/@openai/codex/bin/codex.js', 'x']), 'codex')
  assert.equal(agentOf(['bun', '/x/opencode.mjs']), 'opencode')
  assert.equal(agentOf(['bash']), null)
  assert.equal(agentOf(['node', 'build.js']), null)
  assert.equal(agentOf([]), null)
})

test('words are quoted so a resume command cannot be changed by what is in them', () => {
  assert.equal(quote('plain'), "'plain'")
  assert.equal(quote("it's"), `'it'\\''s'`)
  assert.equal(quote('$(rm -rf ~)'), "'$(rm -rf ~)'")
})

test('a shell is told to run the agent and then stay, and an unknown shell is not told anything', () => {
  const args = startWith('/bin/bash', ['--noprofile', '--norc'], ['claude', '--continue'])
  assert.deepEqual(args.slice(0, 4), ['--noprofile', '--norc', '-i', '-c'])
  assert.equal(args[4], "'claude' '--continue'; exec '/bin/bash' '--noprofile' '--norc' '-i'")
  assert.equal(startWith('/usr/bin/fish', [], ['claude']), null)
})

test('the agent running under a process is found in the real process tree, and nothing else', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-resume-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // A program whose name is "claude": a copy of sleep, so the process list shows it as an agent would.
  const fake = join(dir, 'claude')
  copyFileSync('/usr/bin/sleep', fake)
  chmodSync(fake, 0o755)
  const parent = spawn('sh', ['-c', `${fake} 30 & wait`], { stdio: 'ignore' })
  t.after(() => parent.kill('SIGKILL'))
  await delay(400)
  const found = findAgent(parent.pid)
  assert.equal(found?.name, 'claude')
  assert.notEqual(found.pid, parent.pid)
  process.kill(found.pid, 'SIGKILL')
  const idle = spawn('sh', ['-c', 'sleep 30'], { stdio: 'ignore' })
  t.after(() => idle.kill('SIGKILL'))
  await delay(300)
  assert.equal(findAgent(idle.pid), null, 'a shell with no agent below it has none to resume')
})

test('with two agents below, the newest is chosen when none is in the terminal foreground', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-resume-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const name of ['claude', 'opencode']) {
    copyFileSync('/usr/bin/sleep', join(dir, name))
    chmodSync(join(dir, name), 0o755)
  }
  const parent = spawn('sh', ['-c', `${join(dir, 'claude')} 30 & sleep 0.3; ${join(dir, 'opencode')} 30 & wait`], { stdio: 'ignore' })
  t.after(() => parent.kill('SIGKILL'))
  await delay(900)
  const found = findAgent(parent.pid)
  assert.equal(found?.name, 'opencode')
  spawn('pkill', ['-KILL', '-P', String(parent.pid)])
})
