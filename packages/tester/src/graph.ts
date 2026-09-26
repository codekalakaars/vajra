// Static module graph for test selection, across languages.
//
// A selection that returns nothing is indistinguishable from "nothing is
// affected", so an unresolvable import is the dangerous case: it looks exactly
// like a clean result. This module therefore tracks what it could not resolve
// and reports it, rather than quietly dropping the edge.
//
// That matters most for a language whose specifiers are package paths rather
// than relative paths — Go and JVM imports name a package, not a file, and
// resolving one to a specific source file needs layout knowledge. Where the
// layout is not known, the honest answer is "this ref invalidates everything",
// which is expensive but correct.

import {
  BUILTIN_LANGUAGES,
  indexLanguages,
  javascript,
  languageFor,
  type LanguageSpec,
} from './languages.js'

export const {
  extractImports,
  isTestFile,
  resolveSpecifier,
} = importShim()

function importShim() {
  return {
    extractImports: (source: string, spec: LanguageSpec = javascript): string[] =>
      spec.extract(source),
    isTestFile: (file: string, spec?: LanguageSpec): boolean =>
      (spec ?? javascript).testPattern.test(file),
    resolveSpecifier: (
      specifier: string,
      importer: string,
      known?: ReadonlySet<string>,
      spec: LanguageSpec = javascript,
    ): string | null => {
      for (const candidate of spec.candidates(specifier, importer)) {
        if (!known || known.has(candidate)) return candidate
      }
      return known ? null : spec.candidates(specifier, importer)[0] ?? null
    },
  }
}

export interface ModuleEntry {
  file: string
  /** Source text, or pre-extracted specifiers. */
  source?: string
  imports?: readonly string[]
}

export interface ModuleGraph {
  /** file → the files it transitively imports. */
  deps: Map<string, Set<string>>
  /** source file → every test file that transitively imports it. */
  testsFor: Map<string, Set<string>>
  /** source file → every file that transitively imports it. */
  importers: Map<string, Set<string>>
  /** Every test file in the graph, with the language that owns it. */
  testFiles: Set<string>
  testLanguages: Map<string, string>
  /**
   * Specifiers that looked internal but resolved to nothing. A change to any
   * file named here must be treated as affecting every test, because the
   * dependency it represents is invisible to selection.
   */
  unmodelled: Set<string>
}

export interface BuildGraphOptions {
  languages?: readonly LanguageSpec[]
  /** Files whose contents affect every test regardless of the import graph. */
  globalFiles?: readonly string[]
  /**
   * Import prefixes known to refer to code inside this repository — a Go module
   * path, a Maven groupId, a Python namespace package. Anything under one of
   * these that fails to resolve is a real, invisible dependency, so it widens
   * selection instead of being dropped.
   *
   * Without this, a Go import such as `example.com/internal/session` is
   * indistinguishable from a third-party module and is silently discarded.
   */
  internalPrefixes?: readonly string[]
}

export function buildModuleGraph(
  entries: readonly ModuleEntry[],
  options: BuildGraphOptions = {},
): ModuleGraph {
  const specs = options.languages ?? BUILTIN_LANGUAGES
  const index = indexLanguages(specs)
  const known = new Set(entries.map((e) => e.file))
  const globals = new Set(options.globalFiles ?? [])
  const internalPrefixes = options.internalPrefixes ?? []

  const testFiles = new Set<string>()
  const testLanguages = new Map<string, string>()
  const direct = new Map<string, Set<string>>()
  const unmodelled = new Set<string>()

  for (const entry of entries) {
    const spec = languageFor(entry.file, index) ?? javascript
    if (spec.testPattern.test(entry.file)) {
      testFiles.add(entry.file)
      testLanguages.set(entry.file, spec.name)
    }

    const specifiers = entry.imports ?? (entry.source ? spec.extract(entry.source) : [])
    const resolved = new Set<string>()

    for (const specifier of specifiers) {
      const candidates = spec.candidates(specifier, entry.file)
      if (candidates.length === 0) {
        // A bare specifier: a third-party package by most languages' rules.
        // Not a gap — a package cannot be changed by editing a repo file.
        continue
      }
      const hit = candidates.find((c) => known.has(c))
      if (hit) {
        if (hit !== entry.file) resolved.add(hit)
        continue
      }

      // A package-style import names a directory, and depending on a package
      // means depending on everything in it. Go and JVM imports land here:
      // `internal/session` resolves to internal/session/session.go.
      const underPackage = candidates
        .flatMap((c) => [...known].filter((f) => f.startsWith(`${c}/`)))
        .filter((f) => f !== entry.file)
      if (underPackage.length > 0) {
        for (const file of underPackage) resolved.add(file)
        continue
      }

      if (isInternal(specifier, internalPrefixes, known)) {
        // It mapped to candidate paths but none exist. When the specifier is
        // known to be in-tree, that is a real dependency the graph cannot see,
        // so record it and let selection widen rather than miss it.
        unmodelled.add(entry.file)
      }
    }
    direct.set(entry.file, resolved)
  }

  const deps = new Map<string, Set<string>>()
  for (const entry of entries) deps.set(entry.file, closure(entry.file, direct))

  const importers = new Map<string, Set<string>>()
  const testsFor = new Map<string, Set<string>>()
  for (const [file, fileDeps] of deps) {
    for (const dep of fileDeps) {
      let bucket = importers.get(dep)
      if (!bucket) importers.set(dep, (bucket = new Set()))
      bucket.add(file)
    }
  }
  for (const testFile of testFiles) {
    for (const dep of deps.get(testFile) ?? []) {
      let bucket = testsFor.get(dep)
      if (!bucket) testsFor.set(dep, (bucket = new Set()))
      bucket.add(testFile)
    }
  }

  // A file with an unmodelled dependency invalidates everything: the edge it
  // hides could point at any test.
  if (unmodelled.size > 0) {
    for (const file of unmodelled) {
      testsFor.set(file, new Set(testFiles))
    }
  }

  for (const global of globals) {
    testsFor.set(global, new Set(testFiles))
  }

  return { deps, testsFor, importers, testFiles, testLanguages, unmodelled }
}

/**
 * Whether an unresolved specifier refers to code inside this repository.
 *
 * Three positive signals, and nothing inferred from a loose resemblance to a
 * candidate path — matching on a shared name segment wrongly flags ordinary
 * third-party imports, which would widen selection to the whole suite and
 * destroy the value of selecting at all.
 */
function isInternal(
  specifier: string,
  internalPrefixes: readonly string[],
  known: ReadonlySet<string>,
): boolean {
  // A relative path, or an explicit module path, is in-tree by construction.
  if (specifier.startsWith('.')) return true
  if (specifier.startsWith('crate::') || specifier.startsWith('self::') || specifier.startsWith('super::')) {
    return true
  }
  if (internalPrefixes.some((p) => p && specifier.startsWith(p))) return true
  // Otherwise: does the specifier's first segment name a real top-level
  // directory? A pip package called `mypkg` maps onto a repo directory called
  // `mypkg`; a package called `numpy` does not.
  const first = specifier.split(/[./:]/)[0]
  if (!first) return false
  for (const file of known) {
    if (file === first || file.startsWith(`${first}/`)) return true
  }
  return false
}

function closure(file: string, direct: Map<string, Set<string>>): Set<string> {
  const seen = new Set<string>()
  const stack = [...(direct.get(file) ?? [])]
  while (stack.length > 0) {
    const next = stack.pop() as string
    if (seen.has(next)) continue
    seen.add(next)
    for (const dep of direct.get(next) ?? []) {
      if (!seen.has(dep)) stack.push(dep)
    }
  }
  return seen
}

/** Every file whose behaviour could be affected by changing the given targets. */
export function affectedBy(
  graph: ModuleGraph,
  targets: readonly string[],
): Set<string> {
  const affected = new Set<string>()
  for (const target of targets) {
    affected.add(target)
    for (const importer of graph.importers.get(target) ?? []) affected.add(importer)
  }
  return affected
}

/**
 * The tests that could be affected by a change to the given targets. This is
 * what makes per-task verification affordable: at micro-task volume a
 * full-suite run per task does not scale, and the newest work is the least
 * covered by any heuristic.
 */
export function selectTests(
  graph: ModuleGraph,
  targets: readonly string[],
): string[] {
  const selected = new Set<string>()
  for (const target of targets) {
    for (const test of graph.testsFor.get(target) ?? []) selected.add(test)
  }
  return [...selected].sort()
}
