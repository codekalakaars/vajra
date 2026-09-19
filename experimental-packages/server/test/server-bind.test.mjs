// Tests for the listen guard in index.ts.
//
// Authentication is opt-in, so binding a public interface without a token
// would hand every RPC method — including the ones that write files and
// spawn processes — to anyone who can reach the port.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startServer } from '../dist/index.js'

function scratchDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'vajra-bind-test-'))
  return { path: join(dir, 'vajra.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('binds loopback by default', async () => {
  const db = scratchDbPath()
  const server = await startServer({ port: 0, dbPath: db.path })

  assert.ok(server.port > 0)

  await server.close()
  db.cleanup()
})

test('refuses a public interface with no auth token', async () => {
  const db = scratchDbPath()
  const previous = process.env.VAJRA_AUTH_TOKEN
  delete process.env.VAJRA_AUTH_TOKEN

  await assert.rejects(
    startServer({ port: 0, host: '0.0.0.0', dbPath: db.path }),
    /VAJRA_AUTH_TOKEN/,
  )

  if (previous !== undefined) process.env.VAJRA_AUTH_TOKEN = previous
  db.cleanup()
})

test('a public interface is allowed once a token is set', async () => {
  const db = scratchDbPath()
  const previous = process.env.VAJRA_AUTH_TOKEN
  process.env.VAJRA_AUTH_TOKEN = 'test-token'

  const server = await startServer({ port: 0, host: '127.0.0.1', dbPath: db.path })
  assert.ok(server.port > 0)
  await server.close()

  if (previous === undefined) delete process.env.VAJRA_AUTH_TOKEN
  else process.env.VAJRA_AUTH_TOKEN = previous
  db.cleanup()
})
