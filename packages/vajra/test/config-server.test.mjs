import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dist = join(import.meta.dirname, '..', 'dist')
const { startConfigServer } = await import(pathToFileURL(join(dist, 'cli', 'config-server.js')).href)

test('the settings token is only in the browser fragment and gates the API', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'vajra-config-test-'))
  const server = await startConfigServer(projectRoot)
  try {
    const browserUrl = new URL(server.browserUrl)
    const token = browserUrl.hash.slice(1)
    assert.ok(token)
    assert.equal(server.url, `${browserUrl.origin}`)

    const page = await fetch(server.url)
    const html = await page.text()
    assert.equal(page.status, 200)
    assert.doesNotMatch(html, new RegExp(token))

    const denied = await fetch(`${server.url}/api/files`)
    assert.equal(denied.status, 403)

    const allowed = await fetch(`${server.url}/api/files`, {
      headers: { 'x-vajra-token': token },
    })
    assert.equal(allowed.status, 200)
    assert.deepEqual(await allowed.json(), [
      { path: '', directory: true, permissions: { read: false, write: false, edit: false, delete: false } },
    ])
  } finally {
    await server.close()
    await rm(projectRoot, { recursive: true, force: true })
  }
})
