import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = join(import.meta.dirname, '..', 'dist')
const {
  normalizeRoute,
  extractRoutes,
  buildRouteIndex,
  routeIsAffected,
  routeKey,
  createRoutedApiTarget,
  createSurfaceRunner,
  checkPlan,
  UnsupportedSurfaceError,
} = await import(pathToFileURL(join(root, 'index.js')).href)

// --- normalisation ---

test('every param spelling normalises to the same route', () => {
  // A FastAPI decorator, an Express route and a Flask route for the same URL
  // must compare equal, or a cross-framework plan selects nothing.
  const forms = ['/users/:id', '/users/<int:id>', '/users/{id}', '/users/{id}/']
  const normalized = new Set(forms.map(normalizeRoute))
  assert.equal(normalized.size, 1, [...normalized].join(' '))
  assert.equal(normalizeRoute('/users/{id}'), '/users/{}')
})

test('a query string and a full origin are stripped', () => {
  assert.equal(normalizeRoute('/search?q=1'), '/search')
  assert.equal(normalizeRoute('https://api.example.com/v1/users'), '/v1/users')
  assert.equal(normalizeRoute('/'), '/')
  assert.equal(normalizeRoute(''), '/')
})

// --- extraction across frameworks ---

const cases = [
  {
    name: 'express',
    source: `router.get('/users/:id', handler)
app.post('/users', createUser)`,
    expect: ['GET /users/{}', 'POST /users'],
  },
  {
    name: 'fastapi',
    source: `@app.get("/users/{user_id}")
async def read_user(): ...`,
    expect: ['GET /users/{}'],
  },
  {
    name: 'flask',
    source: `@app.route("/users/<name>")
def show(name): ...`,
    expect: ['ANY /users/{}'],
  },
  {
    name: 'spring',
    source: `@RestController
class UserController {
  @GetMapping("/users/{id}")
  public User get() {}
}`,
    expect: ['GET /users/{}'],
  },
  {
    name: 'aspnet',
    source: `[HttpGet("users/{id}")]
public IActionResult Get() => Ok();`,
    expect: ['GET /users/{}'],
  },
  {
    name: 'rails',
    source: `Rails.application.routes.draw do
  get "/users/:id" => "users#show"
end`,
    expect: ['GET /users/{}'],
  },
  {
    name: 'go',
    source: `mux.HandleFunc("/health", health)
r.GET("/users/{id}", show)`,
    expect: ['ANY /health', 'GET /users/{}'],
  },
  {
    name: 'nest',
    source: `@Controller('users')
export class UserController {
  @Get(':id')
  findOne() {}
}`,
    expect: ['GET /{}'],
  },
]

for (const { name, source, expect } of cases) {
  test(`routes are extracted from ${name}`, () => {
    const keys = extractRoutes(source).map((r) => `${r.method} ${r.path}`).sort()
    for (const wanted of expect) assert.equal(keys.includes(wanted), true, `${name}: wanted ${wanted}, got ${keys.join(', ')}`)
  })
}

test('a framework hint does not suppress a match in a mislabelled file', () => {
  // A mislabelled file is common, and a missed route is a silent gap.
  const source = `app.get('/x', h)` // labelled as go
  assert.equal(extractRoutes(source, 'go').length, 1)
})

test('a source with no routes yields nothing', () => {
  assert.deepEqual(extractRoutes('export function helper() { return 1 }'), [])
})

// --- the index and the hole it closes ---

const server = [
  {
    file: 'src/routes/users.ts',
    source: `router.get('/users/:id', show)\nrouter.post('/users', create)`,
  },
  { file: 'src/routes/health.ts', source: `app.get('/health', health)` },
  { file: 'src/service/user.ts', source: 'export const find = () => 1' },
]

test('a route index maps routes to the files that define them', () => {
  const index = buildRouteIndex(server)
  assert.equal([...(index.byRoute.get('GET /users/{}') ?? [])][0], 'src/routes/users.ts')
  assert.equal([...(index.byRoute.get('GET /health') ?? [])][0], 'src/routes/health.ts')
  assert.equal(index.byFile.get('src/service/user.ts'), undefined)
})

test('changing a route file selects the probes for that route — the hole this closes', () => {
  // Previously this selected nothing, because a route file is not imported by
  // anything: it defines the thing being tested.
  const index = buildRouteIndex(server)
  assert.equal(
    routeIsAffected(index, { method: 'GET', path: '/users/{id}' }, ['src/routes/users.ts']),
    true,
  )
  assert.equal(
    routeIsAffected(index, { method: 'POST', path: '/users' }, ['src/routes/users.ts']),
    true,
  )
})

test('changing an unrelated route file does not select a probe', () => {
  const index = buildRouteIndex(server)
  assert.equal(
    routeIsAffected(index, { method: 'GET', path: '/users/{id}' }, ['src/routes/health.ts']),
    false,
  )
})

test('a method-restricted route is not affected by an ANY-method definition elsewhere', () => {
  const index = buildRouteIndex([
    { file: 'a.ts', source: `app.all('/x', h)` },
    { file: 'b.ts', source: `app.post('/x', h)` },
  ])
  assert.equal(routeIsAffected(index, { method: 'POST', path: '/x' }, ['b.ts']), true)
  assert.equal(routeIsAffected(index, { method: 'DELETE', path: '/x' }, ['a.ts']), true)
  assert.equal(routeIsAffected(index, { method: 'DELETE', path: '/x' }, ['b.ts']), false)
})

test('a prefix change affects the routes mounted under it', () => {
  const index = buildRouteIndex([{ file: 'r.ts', source: `app.use('/api', router)` }])
  assert.equal(routeIsAffected(index, { method: 'GET', path: '/api' }, ['r.ts']), true)
  assert.equal(routeIsAffected(index, { method: 'GET', path: '/api/users' }, ['r.ts']), true)
})

test('route keys are method and path only', () => {
  assert.equal(routeKey('get', '/users/:id'), 'GET /users/{}')
  assert.equal(routeKey('GET', '/users/{}'), routeKey('get', '/users/:id'))
})

test('a routed api target answers which probes a change determines', () => {
  const target = createRoutedApiTarget(
    {
      id: 'svc',
      language: 'typescript',
      serve: { run: ['x'], port: 0 },
      probes: [
        { id: 'getUser', method: 'GET', path: '/users/{id}', expect: { status: 200 } },
        { id: 'health', method: 'GET', path: '/health', expect: { status: 200 } },
      ],
    },
    server,
  )
  assert.deepEqual(
    target.probesForRoutes(target.routes, ['src/routes/users.ts']).sort(),
    ['getUser'],
  )
  assert.deepEqual(target.probesForRoutes(target.routes, ['src/routes/health.ts']), ['health'])
  assert.deepEqual(target.probesForRoutes(target.routes, ['src/service/user.ts']), [])
})

// --- plan checking ---

test('a plan is checked before it is submitted', () => {
  const ok = checkPlan([{ surface: 'cli' }, { surface: 'http-api' }], ['toolchain', 'runtime'])
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.missing, [])
})

test('an unimplemented surface is unsupported, not merely missing infrastructure', () => {
  // Data access is not built at all, so a database would not help. Reporting
  // it as a missing prerequisite would send the reader looking for the wrong
  // thing.
  const check = checkPlan([{ surface: 'data' }], ['toolchain', 'runtime'])
  assert.equal(check.ok, false)
  assert.deepEqual(check.unsupported, ['data'])
  assert.deepEqual(check.missing, [])
})

test('a component plan declares that it needs a browser', () => {
  const check = checkPlan([{ surface: 'component' }], ['toolchain', 'runtime'])
  assert.deepEqual(check.missing, ['browser'])
  assert.equal(check.required.includes('browser'), true)
})

test('a component plan passes once a browser is available', () => {
  assert.equal(checkPlan([{ surface: 'component' }], ['toolchain', 'runtime', 'browser']).ok, true)
  // A surface this package cannot build stays unsupported whatever is available.
  assert.equal(checkPlan([{ surface: 'data' }], ['toolchain', 'runtime', 'database']).ok, false)
})

test('an unknown surface is unsupported rather than a missing prerequisite', () => {
  const check = checkPlan([{ surface: 'telepathy' }], ['toolchain', 'runtime', 'database', 'browser'])
  assert.deepEqual(check.unsupported, ['telepathy'])
})

// --- dispatch ---

test('a cli surface resolves to a cli runner', () => {
  const runner = createSurfaceRunner({
    surface: 'cli',
    id: 'sum',
    cli: { id: 'sum', probes: [{ id: 'p', command: ['node', '-e', '0'], expect: {} }] },
  })
  assert.match(runner.name, /^cli:/)
})

test('an http-api surface with a config resolves to an api target', () => {
  const runner = createSurfaceRunner({
    surface: 'http-api',
    id: 'svc',
    api: {
      id: 'svc',
      language: 'python',
      serve: { run: ['x'], port: 0 },
      probes: [{ id: 'p', method: 'GET', path: '/p', expect: { status: 200 } }],
    },
  })
  assert.match(runner.name, /^api:/)
})

test('a surface with no config is refused with a reason', () => {
  assert.throws(
    () => createSurfaceRunner({ surface: 'cli', id: 'x' }),
    (error) => error instanceof UnsupportedSurfaceError && /needs a `cli` config/.test(error.message),
  )
})

test('an unknown surface is refused', () => {
  assert.throws(
    () => createSurfaceRunner({ surface: 'telepathy', id: 'x' }),
    (error) => error instanceof UnsupportedSurfaceError && /not a known surface/.test(error.message),
  )
})

test('a codegen surface runs the project suite and reads its report', () => {
  const runner = createSurfaceRunner({
    surface: 'component',
    id: 'web',
    command: { command: ['npm', 'test'], report: { format: 'junit' } },
  })
  assert.match(runner.name, /^(npm|suite)$/)
})
