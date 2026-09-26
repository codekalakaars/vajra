import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'

const root = join(import.meta.dirname, '..', 'dist')
const {
  BUILTIN_LANGUAGES,
  indexLanguages,
  languageFor,
  buildModuleGraph,
  selectTests,
  createGraphResolver,
  orderProbes,
  renderProbe,
  captureVariables,
  createApiTarget,
  validateProbeOrder,
} = await import(pathToFileURL(join(root, 'index.js')).href)

const e = (file, source) => ({ file, source })

// --- language coverage ---

test('the commonly used languages are all present', () => {
  const names = BUILTIN_LANGUAGES.map((l) => l.name)
  for (const expected of ['javascript', 'python', 'rust', 'go', 'java', 'ruby', 'csharp']) {
    assert.equal(names.includes(expected), true, `missing ${expected}`)
  }
})

test('files route to the right language by extension', () => {
  const index = indexLanguages()
  assert.equal(languageFor('src/a.py', index).name, 'python')
  assert.equal(languageFor('src/a.rs', index).name, 'rust')
  assert.equal(languageFor('src/A.java', index).name, 'java')
  assert.equal(languageFor('src/a.go', index).name, 'go')
  assert.equal(languageFor('src/a.rb', index).name, 'ruby')
  assert.equal(languageFor('src/A.cs', index).name, 'csharp')
  assert.equal(languageFor('src/a.ts', index).name, 'javascript')
  assert.equal(languageFor('a.unknownext', index), undefined)
})

test('each language recognises its own test files', () => {
  const index = indexLanguages()
  const isTest = (f) => languageFor(f, index)?.testPattern.test(f) ?? false
  assert.equal(isTest('tests/test_auth.py'), true)
  assert.equal(isTest('tests/auth_test.py'), true)
  assert.equal(isTest('src/auth_test.rs'), true)
  assert.equal(isTest('src/auth_test.go'), true)
  assert.equal(isTest('src/test/java/AuthTest.java'), true)
  assert.equal(isTest('spec/auth_spec.rb'), true)
  assert.equal(isTest('src/auth.test.ts'), true)
  assert.equal(isTest('src/auth.py'), false)
  assert.equal(isTest('src/helpers.py'), false)
})

// --- extraction ---

test('python imports are extracted, including relative ones', () => {
  const py = languageFor('a.py', indexLanguages())
  const found = py.extract('import os\nfrom mypkg.core import Thing\nfrom . import sibling\nfrom .util import helper\n')
  assert.equal(found.includes('mypkg.core'), true)
  assert.equal(found.includes('.util'), true)
  assert.equal(found.includes('os'), true)
})

test('rust modules and use paths are extracted', () => {
  const rs = languageFor('a.rs', indexLanguages())
  const found = rs.extract('mod util;\npub mod core;\nuse crate::auth::validate;\nuse super::helper;\n')
  assert.equal(found.includes('util'), true)
  assert.equal(found.includes('core'), true)
  assert.equal(found.includes('crate::auth::validate'), true)
})

test('go imports are extracted from single and block forms', () => {
  const go = languageFor('a.go', indexLanguages())
  const found = go.extract('import "fmt"\nimport (\n  "github.com/x/y/pkg"\n  alias "os"\n)\n')
  assert.equal(found.includes('fmt'), true)
  assert.equal(found.includes('github.com/x/y/pkg'), true)
})

test('java imports are extracted', () => {
  const java = languageFor('A.java', indexLanguages())
  const found = java.extract('package com.x;\nimport com.example.Auth;\nimport static org.junit.Assert.assertEquals;\n')
  assert.equal(found.includes('com.example.Auth'), true)
  assert.equal(found.includes('org.junit.Assert.assertEquals'), true)
})

test('ruby requires are extracted', () => {
  const rb = languageFor('a.rb', indexLanguages())
  const found = rb.extract("require 'json'\nrequire_relative 'helper'\n")
  assert.equal(found.includes('json'), true)
  assert.equal(found.includes('helper'), true)
})

test('csharp usings are extracted', () => {
  const cs = languageFor('A.cs', indexLanguages())
  assert.equal(cs.extract('using System.Text;\nusing static X.Y;\n').includes('System.Text'), true)
})

test('comments do not create phantom dependencies', () => {
  const py = languageFor('a.py', indexLanguages())
  assert.equal(py.extract('# import os\nx = 1\n').includes('os'), false)
  const ts = languageFor('a.ts', indexLanguages())
  assert.equal(ts.extract("// import x from './ghost'\n").length, 0)
})

// --- selection across languages ---

test('a python change selects the python tests that import it', () => {
  const graph = buildModuleGraph([
    e('mypkg/__init__.py', ''),
    e('mypkg/core.py', 'from mypkg.util import helper\n'),
    e('mypkg/util.py', 'def helper(): pass\n'),
    e('tests/test_core.py', 'from mypkg.core import Thing\n'),
    e('tests/test_util.py', 'from mypkg.util import helper\n'),
  ])
  assert.deepEqual(selectTests(graph, ['mypkg/util.py']), [
    'tests/test_core.py',
    'tests/test_util.py',
  ])
})

test('a rust change selects the rust tests that use it', () => {
  const graph = buildModuleGraph([
    e('src/auth.rs', 'mod util;\nuse crate::session::Token;\n'),
    e('src/util.rs', 'pub fn h() {}\n'),
    e('src/session.rs', 'pub struct Token;\n'),
    e('tests/auth_test.rs', 'use crate::auth::check;\n'),
  ])
  assert.deepEqual(selectTests(graph, ['src/util.rs']), ['tests/auth_test.rs'])
  assert.deepEqual(selectTests(graph, ['src/session.rs']), ['tests/auth_test.rs'])
})

test('a go change selects the tests that import its package', () => {
  const graph = buildModuleGraph([
    e('internal/auth/auth.go', 'package auth\n'),
    e('internal/session/session.go', 'package session\n'),
    e('internal/auth/auth_test.go', 'package auth\nimport "example.com/internal/session"\n'),
  ])
  // A Go import names a package, so resolution is coarse by necessity — but
  // the test must still be selected rather than silently dropped.
  const selected = selectTests(graph, ['internal/session/session.go'])
  assert.equal(selected.length + (graph.unmodelled.size > 0 ? 0 : 0) >= 0, true)
  assert.equal(selected.includes('internal/auth/auth_test.go'), true)
})

test('languages in one repository select independently', () => {
  const graph = buildModuleGraph([
    e('src/auth.ts', "import './util'"),
    e('src/util.ts', ''),
    e('src/auth.test.ts', "import './auth'"),
    e('mypkg/core.py', 'from mypkg.util import h'),
    e('mypkg/util.py', ''),
    e('tests/test_core.py', 'from mypkg.core import Thing'),
  ])
  assert.deepEqual(selectTests(graph, ['src/util.ts']), ['src/auth.test.ts'])
  assert.deepEqual(selectTests(graph, ['mypkg/util.py']), ['tests/test_core.py'])
  // A TypeScript change must not drag in Python tests, or vice versa.
  assert.equal(selectTests(graph, ['src/auth.ts']).includes('tests/test_core.py'), false)
})

test('third-party packages are not treated as unmodelled', () => {
  // A pip or npm dependency cannot be changed by editing a repo file, so it
  // must not invalidate the whole suite.
  const graph = buildModuleGraph([
    e('mypkg/core.py', 'import numpy\nfrom mypkg.util import h\n'),
    e('mypkg/util.py', ''),
    e('tests/test_core.py', 'from mypkg.core import Thing'),
  ])
  assert.equal(graph.unmodelled.size, 0)
})

test('an unresolvable internal import is recorded, not dropped', () => {
  // This is the defect that motivated tracking: a missing edge looks exactly
  // like a clean result, so it has to widen selection rather than shrink it.
  const graph = buildModuleGraph([
    e('mypkg/core.py', 'from mypkg.ghost import h\n'),
    e('tests/test_core.py', 'from mypkg.core import Thing'),
  ])
  assert.equal(graph.unmodelled.has('mypkg/core.py'), true)
  // A change to that file now selects every test, because the hidden edge
  // could point anywhere.
  assert.deepEqual(selectTests(graph, ['mypkg/core.py']), ['tests/test_core.py'])
})

test('a resolver reports what it could not model', () => {
  const graph = buildModuleGraph([
    e('mypkg/core.py', 'from mypkg.ghost import h\n'),
    e('tests/test_core.py', 'from mypkg.core import Thing'),
  ])
  const resolver = createGraphResolver(graph, 'python')
  assert.deepEqual(resolver.unmodelled(), ['mypkg/core.py'])
  assert.equal(resolver.language, 'python')
})

// --- probe ordering and capture ---

const loginFirst = () => ({
  id: 'auth',
  language: 'typescript',
  serve: { run: ['x'], port: 0 },
  probes: [
    {
      id: 'login',
      method: 'POST',
      path: '/login',
      body: { user: 'ada', password: 'pw' },
      capture: { '$.data.token': 'token' },
      expect: { status: 200 },
    },
    {
      id: 'me',
      method: 'GET',
      path: '/me',
      dependsOn: ['login'],
      headers: { authorization: 'Bearer {{token}}' },
      expect: { status: 200, body: { '$.data.user': { equals: 'ada' } } },
    },
  ],
})

test('probes order so a dependency runs before its dependent', () => {
  const { ordered, problems } = orderProbes(loginFirst().probes)
  assert.deepEqual(problems, [])
  assert.deepEqual(ordered.map((p) => p.id), ['login', 'me'])
})

test('declaration order does not override dependency order', () => {
  const { ordered } = orderProbes([
    { id: 'me', method: 'GET', path: '/me', dependsOn: ['login'], expect: {} },
    { id: 'login', method: 'POST', path: '/login', expect: {} },
  ])
  assert.deepEqual(ordered.map((p) => p.id), ['login', 'me'])
})

test('a dependency cycle is reported instead of deadlocking', () => {
  const { problems } = orderProbes([
    { id: 'a', method: 'GET', path: '/a', dependsOn: ['b'], expect: {} },
    { id: 'b', method: 'GET', path: '/b', dependsOn: ['a'], expect: {} },
  ])
  assert.equal(problems.length, 2)
  assert.equal(problems.every((p) => p.includes('can never run')), true)
})

test('a dependency on an unknown probe is reported', () => {
  const { problems } = orderProbes([
    { id: 'a', method: 'GET', path: '/a', dependsOn: ['ghost'], expect: {} },
  ])
  assert.equal(problems[0].includes('unknown probe'), true)
})

test('order problems surface through config validation', () => {
  assert.equal(
    validateProbeOrder({
      ...loginFirst(),
      probes: [
        { id: 'a', method: 'GET', path: '/a', dependsOn: ['b'], expect: {} },
        { id: 'b', method: 'GET', path: '/b', dependsOn: ['a'], expect: {} },
      ],
    }).length > 0,
    true,
  )
})

test('substitution fills captured variables and reports the missing', () => {
  const rendered = renderProbe(
    {
      id: 'me',
      method: 'GET',
      path: '/me',
      headers: { authorization: 'Bearer {{token}}' },
      body: { who: '{{token}}' },
      expect: {},
    },
    { token: 'tok_abc' },
  )
  assert.equal(rendered.headers.authorization, 'Bearer tok_abc')
  assert.deepEqual(rendered.body, { who: 'tok_abc' })
  assert.deepEqual(rendered.unresolved, [])
})

test('an uncaptured variable is reported rather than sent literally', () => {
  const rendered = renderProbe(
    { id: 'me', method: 'GET', path: '/me', headers: { a: '{{nope}}' }, expect: {} },
    {},
  )
  assert.deepEqual(rendered.unresolved, ['nope'])
})

test('capture reads a path out of the response body', () => {
  const vars = {}
  captureVariables(
    { id: 'l', method: 'POST', path: '/login', capture: { '$.data.token': 'token' }, expect: {} },
    { status: 200, headers: {}, body: { data: { token: 'tok_1' } }, raw: '', latencyMs: 1 },
    vars,
  )
  assert.equal(vars.token, 'tok_1')
})

// --- capture, end to end against a real server ---

test('an authenticated flow verifies: a token captured by one probe reaches the next', async () => {
  // The capability that made every authenticated API untestable before.
  const server = createServer((req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (req.url === '/login') return send(200, { data: { token: 'tok_live' } })
    if (req.url === '/me') {
      if (req.headers.authorization !== 'Bearer tok_live') {
        return send(401, { error: 'unauthorized' })
      }
      return send(200, { data: { user: 'ada' } })
    }
    send(404, { error: 'not found' })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()

  try {
    const config = loginFirst()
    const target = createApiTarget(
      config,
      { build: false, fetchImpl: (url, init) => fetch(url.toString(), init) },
      {
        spawnServer: () => ({ output: () => '', kill: () => {}, exited: Promise.resolve({ code: 0, signal: null }) }),
        findPort: async () => port,
        sleep: async () => {},
        now: () => 0,
      },
    )
    const result = await target.run({ taskId: 't', testRefs: ['login', 'me'], cwd: '.', timeoutMs: 5000 })
    assert.equal(result.tests.length, 2)
    for (const test of result.tests) {
      assert.equal(test.status, 'passed', `${test.id}: ${test.message}`)
    }
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('selecting only the dependent probe still runs its prerequisite', async () => {
  // Otherwise an authenticated endpoint is unreachable by selecting it alone.
  const server = createServer((req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (req.url === '/login') return send(200, { data: { token: 'tok_live' } })
    if (req.url === '/me') {
      return req.headers.authorization === 'Bearer tok_live'
        ? send(200, { data: { user: 'ada' } })
        : send(401, { error: 'unauthorized' })
    }
    send(404, {})
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  try {
    const target = createApiTarget(
      loginFirst(),
      { build: false, fetchImpl: (url, init) => fetch(url.toString(), init) },
      {
        spawnServer: () => ({ output: () => '', kill: () => {}, exited: Promise.resolve({ code: 0, signal: null }) }),
        findPort: async () => port,
        sleep: async () => {},
        now: () => 0,
      },
    )
    const result = await target.run({ taskId: 't', testRefs: ['me'], cwd: '.', timeoutMs: 5000 })
    const ids = result.tests.map((t) => t.id).sort()
    assert.deepEqual(ids, ['http:login', 'http:me'])
    assert.equal(result.tests.find((t) => t.ref === 'me').status, 'passed')
  } finally {
    await new Promise((r) => server.close(r))
  }
})
