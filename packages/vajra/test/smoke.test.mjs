import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { useTempVajraHome } from './_isolate.mjs'

useTempVajraHome('vajra-smoke-')

const execFileAsync = promisify(execFile)
const cliEntry = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js')

test('CLI package builds an entrypoint', () => {
  assert.ok(existsSync(cliEntry), `missing ${cliEntry}`)
})

test('vajra --version reports 0.0.1', async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliEntry, '--version'], {
    timeout: 10000,
  })
  assert.match(stdout.trim(), /^0\.0\.1$/)
})

test('vajra --help lists the commands that exist', async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliEntry, '--help'], {
    timeout: 10000,
  })
  assert.match(stdout, /\brun\b/)
  assert.match(stdout, /bench/)
  assert.match(stdout, /auth/)
  assert.doesNotMatch(stdout, /sessions|resume|video/)
})
