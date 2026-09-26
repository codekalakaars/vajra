// A worked example of the whole path, for a REST API in any language.
//
// The three targets below differ only in their build and serve commands. The
// probes, the expectations, the verdicts and the Phase One gate are identical —
// which is the whole claim: language is a build concern, not a testing concern.
//
// Run: node examples/rest-api.mjs
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'

const dist = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist')
const {
  createApiTarget,
  validateApiTarget,
  deriveProbesFromOpenApi,
  TestRegistry,
  verifyTask,
} = await import(join(dist, 'index.js'))

// One API, three toolchains. Only these blocks change.
const TOOLCHAINS = {
  typescript: {
    build: [{ run: ['npm', 'ci'] }],
    serve: { run: ['npx', 'tsx', 'src/server.ts', '--port', '${PORT}'] },
  },
  python: {
    build: [{ run: ['pip', 'install', '-r', 'requirements.txt'] }],
    serve: { run: ['uvicorn', 'app:app', '--port', '${PORT}'] },
  },
  java: {
    build: [{ run: ['./mvnw', '-q', 'package', '-DskipTests'] }],
    serve: { run: ['java', '-jar', 'target/app.jar', '--server.port=${PORT}'] },
  },
}

const PROBES = [
  {
    id: 'health',
    method: 'GET',
    path: '/health',
    expect: { status: 200, body: { '$.status': { equals: 'ok' } } },
  },
  {
    id: 'getUser',
    method: 'GET',
    path: '/users/{id}',
    params: { id: 'u1' },
    expect: { status: 200, body: { '$.data.id': { equals: 'u1' } } },
  },
  {
    id: 'login',
    method: 'POST',
    path: '/login',
    body: { user: 'ada', password: 'correct horse' },
    expect: { status: 200, body: { '$.data.token': { exists: true } } },
  },
]

// A stand-in for the real service, so the example runs anywhere.
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const send = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }
  if (url.pathname === '/health') return send(200, { status: 'ok' })
  if (url.pathname === '/users/u1') return send(200, { data: { id: 'u1', name: 'Ada' } })
  if (url.pathname === '/login' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => (body += c))
    return req.on('end', () => {
      const { password } = JSON.parse(body || '{}')
      send(200, { data: { token: password === 'correct horse' ? 'tok_abc' : null } })
    })
  }
  send(404, { error: 'not found' })
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const { port } = server.address()

const report = (label, result) => {
  console.log(`\n${label}`)
  console.log(`  expected   ${result.expected}`)
  console.log(`  observed   ${result.observed}`)
  console.log(`  satisfied  ${result.satisfied}`)
  for (const test of result.tests) {
    const mark = { passed: '✓', failed_assertion: '✗', failed_environment: '!', not_collected: '?' }[test.verdict] ?? '·'
    console.log(`  ${mark} ${test.id}${test.message ? ` — ${test.message.slice(0, 70)}` : ''}`)
  }
}

try {
  for (const [language, toolchain] of Object.entries(TOOLCHAINS)) {
    const config = { id: 'accounts', language, ...toolchain, probes: PROBES }

    const issues = validateApiTarget(config)
    if (issues.length > 0) {
      console.log(`${language}: invalid config`, issues)
      continue
    }

    const registry = new TestRegistry()
    for (const probe of PROBES) {
      registry.register({ ref: probe.id, taskId: 'impl_login', phase: 2 })
    }

    // The harness is pointed at the already-running stand-in rather than
    // spawning a real toolchain, but nothing else differs.
    const runner = createApiTarget(
      config,
      { build: false, fetchImpl: (url, init) => fetch(url.toString(), init) },
      {
        spawnServer: () => ({ output: () => '', kill: () => {}, exited: Promise.resolve({ code: 0, signal: null }) }),
        findPort: async () => port,
        sleep: async () => {},
        now: () => 0,
      },
    )

    const result = await verifyTask(
      { id: 'impl_login', phase: 2, targetFiles: [], successCriteria: [{ id: 'c', type: 'test' }] },
      { registry, runner },
    )
    report(`${language} — phase 2, all probes implemented`, result)
  }

  // The Phase One case: a stub service where nothing is implemented yet.
  const stubs = createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not implemented' }))
  })
  await new Promise((r) => stubs.listen(0, '127.0.0.1', r))
  const stubPort = stubs.address().port

  const phaseOneConfig = { id: 'accounts', language: 'python', ...TOOLCHAINS.python, probes: PROBES }
  const phaseOneRegistry = new TestRegistry()
  for (const probe of PROBES) {
    phaseOneRegistry.register({ ref: probe.id, taskId: 'test_login', phase: 1, kind: 'test' })
  }
  const phaseOne = await verifyTask(
    {
      id: 'test_login',
      phase: 1,
      kind: 'test',
      targetFiles: [],
      successCriteria: [{ id: 'c', type: 'test' }],
    },
    {
      registry: phaseOneRegistry,
      runner: createApiTarget(
        phaseOneConfig,
        { build: false, fetchImpl: (url, init) => fetch(url.toString(), init) },
        {
          spawnServer: () => ({ output: () => '', kill: () => {}, exited: Promise.resolve({ code: 0, signal: null }) }),
          findPort: async () => stubPort,
          sleep: async () => {},
          now: () => 0,
        },
      ),
    },
  )
  report('python — phase 1, stub service (a 404 is the gate succeeding)', phaseOne)
  await new Promise((r) => stubs.close(r))

  // And the case that must never pass: a server that is not running at all.
  const deadConfig = { id: 'accounts', language: 'java', ...TOOLCHAINS.java, probes: PROBES }
  const dead = await createApiTarget(
    deadConfig,
    { build: false, fetchImpl: (url) => fetch(url.toString(), { signal: AbortSignal.timeout(250) }) },
    {
      spawnServer: () => ({ output: () => '', kill: () => {}, exited: Promise.resolve({ code: 1, signal: null }) }),
      findPort: async () => 1,
      sleep: async () => {},
      now: () => Date.now(),
    },
  ).run({ taskId: 't', testRefs: PROBES.map((p) => p.id), cwd: '.', timeoutMs: 500 })
  console.log('\njava — server never started (must be an environment failure, never a pass)')
  for (const test of dead.tests) {
    console.log(`  ! ${test.id} — ${test.message.slice(0, 80)}`)
  }

  // Deriving probes from a contract instead of writing them by hand.
  const derived = deriveProbesFromOpenApi({
    openapi: '3.0.0',
    paths: {
      '/users/{id}': {
        get: {
          operationId: 'getUser',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        },
      },
    },
  })
  console.log('\nprobes derived from an OpenAPI document')
  for (const probe of derived.probes) {
    console.log(`  ${probe.method} ${probe.path} (id=${probe.id}, params=${JSON.stringify(probe.params)})`)
  }
} finally {
  await new Promise((r) => server.close(r))
}
