import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = join(import.meta.dirname, '..', 'dist')
const {
  buildModuleGraph,
  selectTests,
  affectedBy,
  extractImports,
  resolveSpecifier,
  isTestFile,
} = await import(pathToFileURL(join(root, 'graph.js')).href)

const e = (file, ...imports) => ({ file, imports })

const project = [
  e('src/auth.ts', './errors', './util'),
  e('src/util.ts'),
  e('src/errors.ts'),
  e('src/session.ts'),
  e('src/auth.test.ts', './auth', './util'),
  e('src/util.test.ts', './util'),
  e('src/session.test.ts', './session'),
]

test('extracts every static import form', () => {
  const source = `
    import a from './a.js'
    import type { B } from './b.js'
    export { c } from './c.js'
    import './side-effect.js'
    const d = require('./d.js')
    const e = await import('./e.js')
    // import commented from './nope.js'
    /* import alsoCommented from './nope.js' */
  `
  const found = extractImports(source).sort()
  assert.deepEqual(found, [
    './a.js',
    './b.js',
    './c.js',
    './d.js',
    './e.js',
    './side-effect.js',
  ])
})

test('identifies test files', () => {
  assert.equal(isTestFile('src/auth.test.ts'), true)
  assert.equal(isTestFile('src/auth.spec.tsx'), true)
  assert.equal(isTestFile('src/auth.ts'), false)
})

test('resolves relative specifiers to repo paths', () => {
  const known = new Set(['src/util.ts', 'src/deep/index.ts', 'src/a.tsx'])
  assert.equal(resolveSpecifier('./util.js', 'src/auth.ts', known), 'src/util.ts')
  assert.equal(resolveSpecifier('./util', 'src/auth.ts', known), 'src/util.ts')
  assert.equal(resolveSpecifier('./deep', 'src/auth.ts', known), 'src/deep/index.ts')
  assert.equal(resolveSpecifier('./a', 'src/auth.ts', known), 'src/a.tsx')
})

test('bare specifiers are out of scope', () => {
  // A node_modules dependency cannot be changed by a task, so it must not
  // invalidate anything.
  assert.equal(resolveSpecifier('zod', 'src/auth.ts'), null)
  assert.equal(resolveSpecifier('node:fs', 'src/auth.ts'), null)
})

test('selects tests affected by a change, including transitively', () => {
  const graph = buildModuleGraph(project)
  // auth.test.ts imports util, so changing util must select it too.
  assert.deepEqual(selectTests(graph, ['src/util.ts']), [
    'src/auth.test.ts',
    'src/util.test.ts',
  ])
  assert.deepEqual(selectTests(graph, ['src/errors.ts']), ['src/auth.test.ts'])
  assert.deepEqual(selectTests(graph, ['src/session.ts']), ['src/session.test.ts'])
})

test('selects nothing for a file no test depends on', () => {
  const graph = buildModuleGraph(project)
  assert.deepEqual(selectTests(graph, ['src/orphan.ts']), [])
})

test('affectedBy walks importers, not dependencies', () => {
  // Changing util affects its importers, not the things util imports.
  const graph = buildModuleGraph(project)
  const affected = affectedBy(graph, ['src/util.ts'])
  assert.equal(affected.has('src/util.ts'), true)
  assert.equal(affected.has('src/auth.ts'), true)
  assert.equal(affected.has('src/auth.test.ts'), true)
  assert.equal(affected.has('src/session.ts'), false)
})

test('a cycle does not hang the closure', () => {
  const graph = buildModuleGraph([
    e('src/a.ts', './b'),
    e('src/b.ts', './a'),
    e('src/a.test.ts', './a'),
  ])
  assert.deepEqual(selectTests(graph, ['src/a.ts']), ['src/a.test.ts'])
  assert.deepEqual(selectTests(graph, ['src/b.ts']), ['src/a.test.ts'])
})

test('a global file invalidates every test', () => {
  // Runner config, setup files and shared fixtures are invisible to the import
  // graph, so they are declared explicitly.
  const graph = buildModuleGraph(project, { globalFiles: ['vitest.config.ts'] })
  assert.deepEqual(selectTests(graph, ['vitest.config.ts']), [
    'src/auth.test.ts',
    'src/session.test.ts',
    'src/util.test.ts',
  ])
})

test('graph exposes its test inventory', () => {
  const graph = buildModuleGraph(project)
  assert.equal(graph.testFiles.size, 3)
})
