import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const cliEntry = join(import.meta.dirname, '..', 'dist', 'index.js')

test('CLI package builds an entrypoint', () => {
  assert.ok(existsSync(cliEntry), `missing ${cliEntry}`)
})

test('vajra --version reports 0.0.1', async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliEntry, '--version'], {
    timeout: 10000,
  })
  assert.match(stdout.trim(), /^0\.0\.1$/)
})

test('vajra --help lists core commands', async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliEntry, '--help'], {
    timeout: 10000,
  })
  assert.match(stdout, /run/)
  assert.match(stdout, /config/)
})

test('parseProposePlanArgs-style plan shape is reachable via protocol schemas', async () => {
  const protocolUrl = pathToFileURL(
    join(import.meta.dirname, '..', '..', 'protocol', 'dist', 'index.js'),
  ).href
  const { toolDefinitions } = await import(protocolUrl)

  const parsed = toolDefinitions.propose_plan.schema.parse({
    tasks: [{ id: 't1', title: 't', description: 'd' }],
    summary: 's',
  })
  assert.equal(parsed.tasks[0].id, 't1')
  assert.equal(parsed.tasks[0].type, 'modify')
  assert.deepEqual(parsed.tasks[0].instructions, [])
})
