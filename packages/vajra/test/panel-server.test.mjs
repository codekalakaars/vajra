import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { startPanel } = await import(pathToFileURL(join(import.meta.dirname, '..', 'dist', 'panel', 'server.js')).href)

async function panel(t, { policy, applied = '' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vajra-server-')))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'a.ts'), 'x')
  writeFileSync(join(root, 'secret.txt'), 'x')
  if (policy) writeFileSync(join(root, '.vajra.json'), JSON.stringify(policy))
  const calls = { applied: 0 }
  const server = await startPanel({ projectRoot: root, appliedPolicy: () => applied, agent: () => 'claude', onApply: () => { calls.applied++ } })
  t.after(async () => { await server.close(); rmSync(root, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${server.port}`
  const call = (path, { method = 'GET', body, headers = {}, token = server.token } = {}) => fetch(base + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { root, server, base, call, calls }
}

test('the page is served without a token, with a policy that allows only its own script', async (t) => {
  const { base } = await panel(t)
  const res = await fetch(base + '/')
  assert.equal(res.status, 200)
  const csp = res.headers.get('content-security-policy')
  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /script-src 'nonce-/)
  assert.doesNotMatch(csp, /unsafe-eval/)
  assert.equal(res.headers.get('x-frame-options'), 'DENY')
  assert.match(await res.text(), /<title>Vajra<\/title>/)
})

test('the browser address carries the token in the fragment, which is never sent to the server', async (t) => {
  const { server } = await panel(t)
  assert.match(server.browserUrl, new RegExp(`^http://127\\.0\\.0\\.1:${server.port}/#token=[A-Za-z0-9_-]{40,}$`))
})

test('every API call needs the token', async (t) => {
  const { call } = await panel(t)
  assert.equal((await call('/api/status', { token: null })).status, 401)
  assert.equal((await call('/api/status', { token: 'wrong' })).status, 401)
  assert.equal((await call('/api/list?path=', { token: null })).status, 401)
  assert.equal((await call('/api/rights', { method: 'POST', body: { path: 'a' }, token: null })).status, 401)
  assert.equal((await call('/api/apply', { method: 'POST', body: {}, token: null })).status, 401)
  assert.equal((await call('/api/status')).status, 200)
})

test('a request for another host or from another origin is refused, even with the token', async (t) => {
  const { server } = await panel(t)
  // fetch will not let a caller choose the Host header, so this uses a raw request, as a DNS-rebinding page would.
  const raw = (headers) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, path: '/api/status', headers: { Authorization: `Bearer ${server.token}`, ...headers } }, res => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject)
    req.end()
  })
  assert.equal(await raw({ Host: 'evil.example' }), 403)
  assert.equal(await raw({ Host: `127.0.0.1:${server.port}`, Origin: 'http://evil.example' }), 403)
  assert.equal(await raw({ Host: `localhost:${server.port}` }), 403, 'only the exact loopback address, so a hostname that resolves there later is refused too')
  assert.equal(await raw({ Host: `127.0.0.1:${server.port}`, Origin: `http://127.0.0.1:${server.port}` }), 200)
})

test('a listing shows the rights of each entry', async (t) => {
  const { call } = await panel(t, { policy: { version: 1, paths: { 'src/': { write: true } } } })
  const { entries } = await (await call('/api/list?path=')).json()
  assert.equal(entries.find(e => e.name === 'src').rights.write, true)
  assert.equal(entries.find(e => e.name === 'secret.txt').rights.write, false)
  const inside = (await (await call('/api/list?path=src')).json()).entries
  assert.equal(inside[0].source, 'inherited')
})

test('a path outside the project is refused', async (t) => {
  const { call } = await panel(t)
  for (const bad of ['..', '../..', '/etc', 'src/../..']) assert.equal((await call(`/api/list?path=${encodeURIComponent(bad)}`)).status, 400, bad)
  const res = await call('/api/rights', { method: 'POST', body: { path: '../x', isDir: false, read: true, write: true, delete: false } })
  assert.equal(res.status, 400)
})

test('changing a right writes the file, and it shows as waiting to be applied', async (t) => {
  const { call, root } = await panel(t, { applied: '' })
  assert.equal((await (await call('/api/status')).json()).pending, false, 'no file and nothing applied: nothing waiting')
  const res = await call('/api/rights', { method: 'POST', body: { path: 'secret.txt', isDir: false, read: false, write: false, delete: false } })
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.vajra.json'), 'utf-8')).paths, { 'secret.txt': { read: false } })
  const status = await (await call('/api/status')).json()
  assert.equal(status.pending, true)
  assert.equal(status.agent, 'claude')
  assert.equal(status.problem, null)
})

test('a change the shell could not start from is a 400 with the reason, and the file is unchanged', async (t) => {
  const policy = { version: 1, paths: { 'src/': { write: true } } }
  const { call, root } = await panel(t, { policy })
  const before = readFileSync(join(root, '.vajra.json'), 'utf-8')
  const res = await call('/api/rights', { method: 'POST', body: { path: 'src/a.ts', isDir: false, read: false, write: false, delete: false } })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /cannot lose write/)
  assert.equal(readFileSync(join(root, '.vajra.json'), 'utf-8'), before)
})

test('requests must be well-formed JSON of a sensible size', async (t) => {
  const { call, base, server } = await panel(t)
  const post = (body, type = 'application/json') => fetch(base + '/api/rights', { method: 'POST', headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': type }, body })
  assert.equal((await post('{not json')).status, 400)
  assert.equal((await post('[]')).status, 400)
  assert.equal((await post('{}', 'text/plain')).status, 400, 'a form post from another page cannot be JSON')
  assert.equal((await post(JSON.stringify({ path: 'a', isDir: 'yes', read: true, write: true, delete: false }))).status, 400)
  assert.equal((await post(JSON.stringify({ x: 'a'.repeat(20000) }))).status, 400)
  assert.equal((await call('/api/nope')).status, 404)
})

test('apply restarts the shell, but not into rules it could not start from', async (t) => {
  const { call, calls, root } = await panel(t)
  assert.equal((await call('/api/apply', { method: 'POST', body: {} })).status, 202)
  assert.equal(calls.applied, 1)
  writeFileSync(join(root, '.vajra.json'), '{ broken')
  const refused = await call('/api/apply', { method: 'POST', body: {} })
  assert.equal(refused.status, 409)
  assert.match((await refused.json()).error, /not restarted/)
  assert.equal(calls.applied, 1, 'the shell was left running')
})

test('closing the server frees the port', async (t) => {
  const { server, base } = await panel(t)
  await server.close()
  await assert.rejects(fetch(base + '/'))
})

const { renderPage } = await import(pathToFileURL(join(import.meta.dirname, '..', 'dist', 'panel', 'page.js')).href)
import { Script } from 'node:vm'

test('the page script is valid JavaScript', () => {
  const html = renderPage('abc')
  const script = html.match(/<script nonce="abc">([\s\S]*)<\/script>/)[1]
  assert.doesNotThrow(() => new Script(script))
})

test('the page never turns a file name into HTML', () => {
  const html = renderPage('abc')
  const script = html.match(/<script nonce="abc">([\s\S]*)<\/script>/)[1]
  for (const unsafe of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) assert.ok(!script.includes(unsafe), `uses ${unsafe}`)
  assert.match(script, /textContent/)
})
