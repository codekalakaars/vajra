import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'

const root = join(import.meta.dirname, '..', 'dist')
const {
  validateApiTarget,
  renderPath,
  queryPath,
  checkExpectation,
  deriveProbesFromOpenApi,
  createApiTarget,
  ApiHarness,
  HarnessError,
  applyTemplates,
  renderCommand,
} = await import(pathToFileURL(join(root, 'index.js')).href)
const { classifyTest } = await import(pathToFileURL(join(root, 'classify.js')).href)
const { isSatisfied } = await import(pathToFileURL(join(root, 'verdict.js')).href)
const { TestRegistry } = await import(pathToFileURL(join(root, 'registry.js')).href)
const { verifyTask } = await import(pathToFileURL(join(root, 'verifier.js')).href)

// --- config validation ---

const validConfig = () => ({
  id: 'billing',
  language: 'python',
  build: [{ run: ['pip', 'install', '-r', 'requirements.txt'] }],
  serve: { run: ['python', '-m', 'uvicorn', 'app:app', '--port', '${PORT}'], port: 0 },
  probes: [
    { id: 'health', method: 'GET', path: '/health', expect: { status: 200 } },
  ],
})

test('a well-formed target config validates clean', () => {
  assert.deepEqual(validateApiTarget(validConfig()), [])
})

test('language is a label, not a branch — any string is accepted', () => {
  for (const language of ['typescript', 'python', 'java', 'rust', 'go']) {
    const issues = validateApiTarget({ ...validConfig(), language })
    assert.deepEqual(issues.filter((i) => i.path === 'language'), [])
  }
})

test('a config without a serve command is rejected', () => {
  const issues = validateApiTarget({ ...validConfig(), serve: { run: [] } })
  assert.equal(issues.some((i) => i.path === 'serve.run'), true)
})

test('a duplicate probe id is rejected', () => {
  // Duplicates silently overwrite a registry binding, which reads as a missing
  // test rather than a config error.
  const c = validConfig()
  c.probes.push({ ...c.probes[0] })
  assert.equal(validateApiTarget(c).some((i) => i.message.includes('duplicate')), true)
})

test('a probe with no expectation is rejected', () => {
  const c = validConfig()
  delete c.probes[0].expect
  assert.equal(validateApiTarget(c).some((i) => i.path === 'probes[0].expect'), true)
})

test('an unrecognised matcher is rejected', () => {
  const c = validConfig()
  c.probes[0].expect = { body: { '$.a': { bogusMatcher: 1 } } }
  assert.equal(validateApiTarget(c).some((i) => i.message.includes('bogusMatcher')), true)
})

test('path templates render from params and report what is missing', () => {
  assert.equal(renderPath('/users/{id}', { id: 7 }).path, '/users/7')
  assert.equal(renderPath('/users/{id}', { id: 'a b' }).path, '/users/a%20b')
  assert.deepEqual(renderPath('/users/{id}', {}).missing, ['id'])
})

// --- json path + matchers ---

const body = {
  status: 'active',
  data: { token: 'abc', count: 3, items: [{ name: 'x' }, { name: 'y' }] },
  empty: null,
}

test('json path walks objects, arrays and indices', () => {
  assert.equal(queryPath(body, '$.data.token')[0], 'abc')
  assert.equal(queryPath(body, 'data.count')[0], 3)
  assert.equal(queryPath(body, '$.data.items[1].name')[0], 'y')
  assert.equal(queryPath(body, '$.data.items[*].name').length, 2)
  assert.equal(queryPath(body, '$.missing').length, 0)
})

test('matchers cover the assertions a probe actually needs', () => {
  const check = (path, matcher) =>
    checkExpectation(
      { status: 200, headers: {}, body, raw: '', latencyMs: 1 },
      { body: { [path]: matcher } },
    ).length === 0

  assert.equal(check('$.status', { equals: 'active' }), true)
  assert.equal(check('$.data.token', { exists: true }), true)
  assert.equal(check('$.nope', { exists: false }), true)
  assert.equal(check('$.data.count', { gt: 2 }), true)
  assert.equal(check('$.data.count', { lt: 2 }), false)
  assert.equal(check('$.data.items', { length: 2 }), true)
  assert.equal(check('$.status', { matches: '^act' }), true)
  assert.equal(check('$.empty', { isNull: true }), true)
  assert.equal(check('$.data.items', { oneOf: [[{ name: 'x' }, { name: 'y' }]] }), true)
  assert.equal(check('$.data', { deepEquals: { token: 'abc' } }), true)
})

test('a wildcard passes if any element satisfies the matcher', () => {
  const failures = checkExpectation(
    { status: 200, headers: {}, body, raw: '', latencyMs: 1 },
    { body: { '$.data.items[*].name': { equals: 'y' } } },
  )
  assert.equal(failures.length, 0)
})

test('failures describe what was expected and what arrived', () => {
  const failures = checkExpectation(
    { status: 404, headers: {}, body: { error: 'not found' }, raw: '', latencyMs: 1 },
    { status: 200, body: { '$.data.token': { exists: true } } },
  )
  assert.equal(failures.length, 2)
  assert.match(failures[0].expected, /200/)
  assert.equal(failures[1].actual, 'no match')
})

test('status defaults to any 2xx', () => {
  const ok = (status) =>
    checkExpectation({ status, headers: {}, body: {}, raw: '', latencyMs: 1 }, {}).length === 0
  assert.equal(ok(200), true)
  assert.equal(ok(201), true)
  assert.equal(ok(500), false)
})

test('headers match case-insensitively', () => {
  const failures = checkExpectation(
    { status: 200, headers: { 'Content-Type': 'application/json' }, body: {}, raw: '', latencyMs: 1 },
    { headers: { 'content-type': 'application/json' } },
  )
  assert.equal(failures.length, 0)
})

// --- templates ---

test('port and base url are injectable into language config', () => {
  assert.deepEqual(
    renderCommand(['uvicorn', '--port', '${PORT}'], { PORT: '9001' }),
    ['uvicorn', '--port', '9001'],
  )
  assert.deepEqual(
    applyTemplates({ DB: 'sqlite:///${PORT}/db' }, { PORT: '9001' }),
    { DB: 'sqlite:///9001/db' },
  )
})

// --- a real server, end to end ---

async function startServer(handler) {
  const server = createServer(handler)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  return {
    port,
    stop: () => new Promise((r) => server.close(r)),
  }
}

/**
 * A fake managed process. kill() settles exited, the way a real one would —
 * a fake that never settles would hide a hang rather than exercise the path.
 */
function fakeServer() {
  let resolveExit
  const exited = new Promise((r) => {
    resolveExit = r
  })
  return {
    output: () => '',
    kill: () => resolveExit({ code: null, signal: 'SIGKILL' }),
    exited,
  }
}

const json = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

test('a passing probe yields a passed outcome', async () => {
  const server = await startServer((req, res) => json(res, 200, { status: 'ok', data: { token: 'abc' } }))
  try {
    const config = {
      id: 'live',
      language: 'typescript',
      serve: { run: ['node', 'server.js'], port: server.port },
      probes: [
        {
          id: 'login',
          method: 'POST',
          path: '/login',
          body: { user: 'ada' },
          expect: { status: 200, body: { '$.data.token': { exists: true } } },
        },
      ],
    }
    const harness = new ApiHarness({ config, build: false })
    // Point the harness at the already-running server rather than spawning one.
    const target = createApiTarget(
      config,
      { build: false, fetchImpl: (url, init) => fetch(url.toString(), init) },
      {
        spawnServer: () => fakeServer(),
        findPort: async () => server.port,
        sleep: async () => {},
        now: () => 0,
      },
    )
    const result = await target.run({ taskId: 't', testRefs: ['login'], cwd: '.', timeoutMs: 5000 })
    assert.equal(result.tests[0].status, 'passed')
  } finally {
    await server.stop()
  }
})

test('a wrong response is an assertion failure, not an environment one', async () => {
  // This is the line that makes the Phase One gate meaningful: the API answered,
  // it just did not do the right thing.
  const server = await startServer((req, res) => json(res, 200, { status: 'wrong' }))
  try {
    const config = {
      id: 'live',
      language: 'python',
      serve: { run: ['x'], port: server.port },
      probes: [
        {
          id: 'login',
          method: 'GET',
          path: '/login',
          expect: { status: 200, body: { '$.data.token': { exists: true } } },
        },
      ],
    }
    const target = createApiTarget(
      config,
      {
        build: false,
        fetchImpl: (url, init) => fetch(url.toString(), init),
      },
      {
        spawnServer: () => fakeServer(),
        findPort: async () => server.port,
        sleep: async () => {},
        now: () => 0,
      },
    )
    const result = await target.run({ taskId: 't', testRefs: ['login'], cwd: '.', timeoutMs: 5000 })
    const verdict = classifyTest(result.tests[0]).verdict
    assert.equal(result.tests[0].status, 'failed')
    assert.equal(verdict, 'failed_assertion')
    // And that satisfies a Phase One test task, which is the point.
    assert.equal(isSatisfied('fail_on_assertion', verdict), true)
  } finally {
    await server.stop()
  }
})

test('a 404 stub endpoint satisfies a Phase One probe', async () => {
  const server = await startServer((req, res) => json(res, 404, { error: 'not implemented' }))
  try {
    const config = {
      id: 'live',
      language: 'java',
      serve: { run: ['x'], port: server.port },
      probes: [{ id: 'p', method: 'GET', path: '/nope', expect: { status: 200 } }],
    }
    const target = createApiTarget(
      config,
      { build: false, fetchImpl: (url, init) => fetch(url.toString(), init) },
      {
        spawnServer: () => fakeServer(),
        findPort: async () => server.port,
        sleep: async () => {},
        now: () => 0,
      },
    )
    const result = await target.run({ taskId: 't', testRefs: ['p'], cwd: '.', timeoutMs: 5000 })
    assert.equal(classifyTest(result.tests[0]).verdict, 'failed_assertion')
  } finally {
    await server.stop()
  }
})

test('a server that never started is an environment failure on every probe', async () => {
  // The opposite case, and the one that must never be mistaken for a pass: a
  // Phase One gate must not be satisfiable by a broken harness.
  const config = {
    id: 'dead',
    language: 'java',
    serve: { run: ['x'], port: 1 },
    probes: [
      { id: 'a', method: 'GET', path: '/a', expect: { status: 200 } },
      { id: 'b', method: 'GET', path: '/b', expect: { status: 200 } },
    ],
  }
  const target = createApiTarget(
    config,
    { build: false, fetchImpl: (url) => fetch(url.toString(), { signal: AbortSignal.timeout(300) }) },
    {
      spawnServer: () => ({ output: () => '', kill: () => {}, exited: Promise.resolve({ code: 1, signal: null }) }),
      findPort: async () => 1,
      sleep: async () => {},
      now: () => Date.now(),
    },
  )
  const result = await target.run({ taskId: 't', testRefs: ['a', 'b'], cwd: '.', timeoutMs: 1000 })
  assert.equal(result.tests.length, 2)
  for (const test of result.tests) {
    assert.equal(classifyTest(test).verdict, 'failed_environment')
    assert.equal(isSatisfied('fail_on_assertion', classifyTest(test).verdict), false)
  }
})

test('a failed build step stops the target with the build output', async () => {
  const config = {
    id: 'b',
    language: 'java',
    build: [{ run: ['mvn', 'package'] }],
    serve: { run: ['java', '-jar', 'app.jar'], port: 8080 },
    probes: [{ id: 'a', method: 'GET', path: '/a', expect: { status: 200 } }],
  }
  const target = createApiTarget(config, {}, {
    runStep: async () => ({
      command: ['mvn', 'package'],
      code: 1,
      signal: null,
      stdout: '',
      stderr: 'COMPILATION ERROR',
      durationMs: 5,
    }),
    spawnServer: () => fakeServer(),
    sleep: async () => {},
    now: () => 0,
  })
  const result = await target.run({ taskId: 't', testRefs: ['a'], cwd: '.', timeoutMs: 1000 })
  assert.equal(result.tests[0].status, 'errored')
  assert.match(result.tests[0].message, /COMPILATION ERROR/)
})

test('a probe missing its params is a config error, not a failing API', async () => {
  const config = {
    id: 'm',
    language: 'typescript',
    serve: { run: ['x'], port: 8080 },
    probes: [{ id: 'a', method: 'GET', path: '/users/{id}', expect: { status: 200 } }],
  }
  const target = createApiTarget(
    config,
    { build: false, fetchImpl: async () => new Response('{}', { status: 200 }) },
    {
      spawnServer: () => fakeServer(),
      findPort: async () => 8080,
      sleep: async () => {},
      now: () => 0,
    },
  )
  const result = await target.run({ taskId: 't', testRefs: ['a'], cwd: '.', timeoutMs: 1000 })
  assert.equal(result.tests[0].status, 'errored')
  assert.match(result.tests[0].message, /missing params: id/)
})

// --- the whole pipeline, with an API behind it ---

test('a Phase One probe task verifies through the real verifier', async () => {
  // The integration that matters: a language-specific build and serve, a
  // language-neutral probe, and the existing verdict pipeline with expectation
  // inversion — unchanged.
  const server = await startServer((req, res) => {
    if (req.url === '/health') return json(res, 200, { status: 'ok' })
    json(res, 404, { error: 'not implemented' })
  })
  try {
    const config = {
      id: 'svc',
      language: 'go',
      serve: { run: ['go', 'run', '.'], port: server.port },
      probes: [
        { id: 'health', method: 'GET', path: '/health', expect: { status: 200, body: { '$.status': { equals: 'ok' } } } },
        { id: 'users', method: 'GET', path: '/users', expect: { status: 200, body: { '$.data': { exists: true } } } },
      ],
    }
    const registry = new TestRegistry()
    for (const p of config.probes) {
      registry.register({ ref: p.id, taskId: 'impl', phase: 2 })
    }
    const deps = {
      registry,
      runner: createApiTarget(
        config,
        { build: false, fetchImpl: (url, init) => fetch(url.toString(), init) },
        {
          spawnServer: () => fakeServer(),
          findPort: async () => server.port,
          sleep: async () => {},
          now: () => 0,
        },
      ),
    }

    const phaseTwo = await verifyTask(
      { id: 'impl', phase: 2, targetFiles: [], successCriteria: [{ id: 'c', type: 'test' }] },
      deps,
    )
    // /users 404s, so the phase-two task correctly fails.
    assert.equal(phaseTwo.satisfied, false)
    assert.equal(phaseTwo.observed, 'failed_assertion')
  } finally {
    await server.stop()
  }
})

// --- OpenAPI derivation ---

test('probes are derived from an OpenAPI document', () => {
  const doc = {
    openapi: '3.0.0',
    paths: {
      '/users/{id}': {
        get: {
          operationId: 'getUser',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        },
      },
      '/login': { post: { operationId: 'login' } },
    },
  }
  const { probes } = deriveProbesFromOpenApi(doc)
  assert.equal(probes.length, 2)
  const getUser = probes.find((p) => p.id === 'getUser')
  assert.equal(getUser.method, 'GET')
  assert.equal(getUser.path, '/users/{id}')
  assert.equal(getUser.params.id, 'test')
})

test('a required parameter with no derivable value is skipped, not guessed', () => {
  const doc = {
    paths: {
      '/x': {
        get: {
          operationId: 'x',
          parameters: [
            { name: 'blob', in: 'query', required: true, schema: { type: 'object' } },
          ],
        },
      },
    },
  }
  const { probes, skipped } = deriveProbesFromOpenApi(doc)
  assert.equal(probes.length, 0)
  assert.equal(skipped[0].reason.includes('no derivable sample'), true)
})

test('optional parameters are not invented', () => {
  const doc = {
    paths: {
      '/y': {
        get: {
          operationId: 'y',
          parameters: [{ name: 'q', in: 'query', required: false, schema: { type: 'string' } }],
        },
      },
    },
  }
  assert.deepEqual(deriveProbesFromOpenApi(doc).probes[0].params, {})
})

test('junk input yields nothing rather than throwing', () => {
  assert.deepEqual(deriveProbesFromOpenApi(null), { probes: [], skipped: [] })
  assert.deepEqual(deriveProbesFromOpenApi('nonsense'), { probes: [], skipped: [] })
  assert.deepEqual(deriveProbesFromOpenApi({}), { probes: [], skipped: [] })
})
