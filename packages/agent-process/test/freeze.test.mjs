import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { descendants, freezeTree, thawTree, spawnAgentPool } from '../dist/index.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** The one-letter state in /proc/<pid>/stat: 'T' is stopped. */
function state(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
}

async function until(check, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await sleep(20)
  }
  return check()
}

test('freezing a worker stops a grandchild in its own process group, and thawing continues it', async () => {
  // A parent that starts a child in a new process group, as core does for every
  // command: a signal to the parent's group would never reach it.
  const parent = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process')
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
    console.log(child.pid)
    setInterval(() => {}, 1000)
  `], { stdio: ['ignore', 'pipe', 'ignore'] })
  const childPid = await new Promise(resolve => parent.stdout.once('data', data => resolve(Number(String(data).trim()))))
  try {
    assert.ok(descendants(parent.pid).includes(childPid))

    freezeTree(parent.pid)
    assert.ok(await until(() => state(parent.pid) === 'T'), 'the worker is stopped')
    assert.ok(await until(() => state(childPid) === 'T'), 'the command it started is stopped too')

    thawTree(parent.pid)
    assert.ok(await until(() => state(parent.pid) !== 'T'))
    assert.ok(await until(() => state(childPid) !== 'T'))
  } finally {
    try { process.kill(childPid, 'SIGKILL') } catch {}
    parent.kill('SIGKILL')
  }
})

test("a paused task's calls wait for resume instead of failing", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-pause-'))
  writeFileSync(join(dir, 'a.txt'), 'alpha\n')
  const pool = await spawnAgentPool(dir, 'pause-session', { allowUnenforced: true })
  const ALLOW = { read: true, write: true, edit: true, delete: false }
  try {
    const handle = pool.handleForTask('t1', () => ALLOW, () => {})
    await handle.callTool('read_file', { path: join(dir, 'a.txt') })

    assert.equal(pool.pauseTask('t1'), true)
    await sleep(50)
    let answered = false
    const pending = handle.callTool('read_file', { path: join(dir, 'a.txt') }).then(result => {
      answered = true
      return result
    })
    await sleep(300)
    assert.equal(answered, false, 'a frozen worker answers nothing')

    pool.resumeTask('t1')
    assert.match(String(await pending), /alpha/)
  } finally {
    pool.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pausing a task with no worker is refused, and resuming it is harmless', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-pause-none-'))
  const pool = await spawnAgentPool(dir, 'pause-none', { allowUnenforced: true })
  try {
    assert.equal(pool.pauseTask('nobody'), false)
    pool.resumeTask('nobody')
  } finally {
    pool.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
