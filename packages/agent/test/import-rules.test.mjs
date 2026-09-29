import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname, sep } from 'node:path'

/**
 * The package's import rules, as a test.
 *
 * The architecture plan requires that runtime modules never import the CLI or
 * the TUI, that `contracts` depends on nothing else in the package, and that
 * `agent` depends on `sandbox` and never the reverse. Those are boundaries 9
 * and 10, and until this file existed they were prose: the repository has no
 * eslint, biome, oxlint, prettier or dependency-cruiser, so nothing enforced
 * them. A boundary nothing checks is a boundary that erodes one convenient
 * import at a time.
 *
 * This is deliberately a plain `node:test` file with no new dependencies. It
 * runs under the `test` script the package already has, and under
 * `turbo run test`, so it cannot be skipped by not being wired into a linter
 * nobody runs.
 *
 * If this ever needs to become a real linter, the rules below are the same
 * rules; only the mechanism changes.
 */

const PACKAGE_ROOT = resolve(import.meta.dirname, '..')
const SRC = join(PACKAGE_ROOT, 'src')

/** Packages this one may import, by specifier prefix. */
const ALLOWED_PACKAGES = ['@codekalakaars/vajra-protocol', '@codekalakaars/vajra-sandbox']

/**
 * Packages this one must never import.
 *
 * `cli` is the host: a runtime that reaches back into it cannot be reused by
 * another host, and it is how a "runtime" module ends up owning a terminal.
 * `tui` is presentation (plan boundary 9). The two packages being dissolved by
 * this migration are named too, so that a lane cannot quietly depend on the
 * thing it is about to delete.
 */
const FORBIDDEN_PACKAGES = [
  '@codekalakaars/vajra-cli',
  '@codekalakaars/vajra-tui',
  '@codekalakaars/vajra-agent-core',
  '@codekalakaars/vajra-agent-process',
]

/** Subpackages that may not import their siblings. `contracts` is foundational. */
const FOUNDATIONAL = ['contracts']

function sourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

/** Subpackage a source file belongs to, relative to src/. */
function subpackageOf(file) {
  const rel = relative(SRC, file)
  const [head] = rel.split(sep)
  return head
}

/**
 * Every module specifier a file imports, from `import`, `export … from` and
 * `import type`. Dynamic `import()` and `require` are included because a
 * runtime that cannot import the CLI statically can still do it lazily.
 */
function specifiersIn(source) {
  const specifiers = new Set()
  const patterns = [
    /(?:^|\n)\s*import\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1])
  }
  return [...specifiers]
}

const files = sourceFiles(SRC)

test('the package has source to check', () => {
  assert.ok(files.length > 0, 'no TypeScript found under src/')
})

test('no runtime module imports the CLI, the TUI, or a package being dissolved', () => {
  const offences = []
  for (const file of files) {
    for (const specifier of specifiersIn(readFileSync(file, 'utf-8'))) {
      for (const forbidden of FORBIDDEN_PACKAGES) {
        if (specifier === forbidden || specifier.startsWith(`${forbidden}/`)) {
          offences.push(`${relative(PACKAGE_ROOT, file)} imports ${specifier}`)
        }
      }
    }
  }
  assert.deepEqual(offences, [], `import rule violated:\n  ${offences.join('\n  ')}`)
})

test('every workspace import is on the allowlist', () => {
  const offences = []
  for (const file of files) {
    for (const specifier of specifiersIn(readFileSync(file, 'utf-8'))) {
      if (!specifier.startsWith('@')) continue
      if (ALLOWED_PACKAGES.some(allowed => specifier === allowed || specifier.startsWith(`${allowed}/`))) {
        continue
      }
      offences.push(`${relative(PACKAGE_ROOT, file)} imports ${specifier}`)
    }
  }
  assert.deepEqual(offences, [], `undeclared dependency:\n  ${offences.join('\n  ')}`)
})

test('contracts depends on nothing outside contracts', () => {
  // `contracts` files importing each other is the design — that is what makes
  // the subpackage a unit. What is forbidden is reaching *out* of it, because
  // every other subpackage would then transitively depend on the layer that is
  // supposed to be underneath all of them.
  const CONTRACTS = join(SRC, 'contracts')
  const offences = []
  for (const file of files) {
    if (subpackageOf(file) !== 'contracts') continue
    for (const specifier of specifiersIn(readFileSync(file, 'utf-8'))) {
      if (!specifier.startsWith('.')) continue
      const target = resolve(dirname(file), specifier)
      if (target.startsWith(SRC) && !target.startsWith(CONTRACTS)) {
        offences.push(`${relative(PACKAGE_ROOT, file)} imports ${specifier}`)
      }
    }
  }
  assert.deepEqual(offences, [], `contracts must stay foundational:\n  ${offences.join('\n  ')}`)
})

test('no module reaches outside the package by relative path', () => {
  // `rootDir: src` means a deep relative escape compiles, and a file that
  // escapes into a sibling package's dist is a dependency the package.json
  // does not declare — so `pnpm install --frozen-lockfile` and the import map
  // both stop describing reality.
  const offences = []
  for (const file of files) {
    for (const specifier of specifiersIn(readFileSync(file, 'utf-8'))) {
      if (!specifier.startsWith('..')) continue
      const target = resolve(dirname(file), specifier)
      if (!target.startsWith(SRC)) offences.push(`${relative(PACKAGE_ROOT, file)} imports ${specifier}`)
    }
  }
  assert.deepEqual(offences, [], `escaped the package:\n  ${offences.join('\n  ')}`)
})

test('every declared subpath export resolves to a real module', () => {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8'))
  const missing = []
  for (const [subpath, entry] of Object.entries(pkg.exports)) {
    const target = resolve(PACKAGE_ROOT, entry.types ?? entry.default)
    if (!statSync(target, { throwIfNoEntry: false })) missing.push(`${subpath} -> ${entry.types}`)
  }
  assert.deepEqual(missing, [], `declared export with no file:\n  ${missing.join('\n  ')}`)
})

test('the foundational list is not empty, or the rule above is vacuous', () => {
  // A test that cannot fail is worse than no test: it reads as coverage.
  assert.ok(FOUNDATIONAL.includes('contracts'))
  assert.ok(
    files.some(file => subpackageOf(file) === 'contracts'),
    'no contracts sources found — the foundational rule would pass vacuously',
  )
})
