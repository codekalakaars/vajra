// Pluggable dependency resolution.
//
// The first implementation resolved imports with a JavaScript-shaped regex and
// a `.ts`/`.js` resolver. That made test selection work for this repository and
// nothing else: a Rust `mod` tree, a Go package, a Python import, or a Java
// package were all invisible, so the tests covering them could never be
// selected and would silently never run.
//
// Selection is therefore expressed against an interface rather than an
// implementation. A language contributes a resolver; the core does not care
// which. A resolver that cannot see a dependency is not a resolver that
// reports nothing — it is one that silently drops coverage, so resolvers are
// expected to be conservative and to declare what they cannot resolve.

import type { ModuleGraph } from './graph.js'

export interface DependencyResolver {
  /** Human-readable language or ecosystem, for diagnostics. */
  readonly language: string
  /** Every known test identity. */
  tests(): string[]
  /**
   * Test identities that could be affected by a change to the given
   * references. Must over-report rather than under-report.
   */
  testsFor(refs: readonly string[]): string[]
  /**
   * References this resolver cannot model — dynamic imports, reflection,
   * generated code. A change to any of these invalidates every test.
   */
  unmodelled(): string[]
}

/** Wraps the JavaScript/TypeScript module graph as a resolver. */
export function createGraphResolver(
  graph: ModuleGraph,
  language = 'javascript',
): DependencyResolver {
  return {
    language,
    tests: () => [...graph.testFiles].sort(),
    testsFor: (refs) => {
      const selected = new Set<string>()
      for (const ref of refs) {
        for (const test of graph.testsFor.get(ref) ?? []) selected.add(test)
      }
      return [...selected].sort()
    },
    // Files whose imports could not be resolved. buildModuleGraph already
    // widens their testsFor entry to the whole suite, so this is reported for
    // diagnosis rather than to widen twice.
    unmodelled: () => [...graph.unmodelled].sort(),
  }
}

/**
 * Combines resolvers across languages. A change is resolved by every resolver
 * and the results unioned, so a task touching both a TypeScript file and a
 * Rust module selects tests from both ecosystems.
 */
export function createMultiResolver(resolvers: readonly DependencyResolver[]): DependencyResolver {
  return {
    language: resolvers.map((r) => r.language).join('+') || 'none',
    tests: () => [...new Set(resolvers.flatMap((r) => r.tests()))].sort(),
    testsFor: (refs) => [...new Set(resolvers.flatMap((r) => r.testsFor(refs)))].sort(),
    unmodelled: () => [...new Set(resolvers.flatMap((r) => r.unmodelled()))].sort(),
  }
}

/**
 * A resolver for ecosystems with no static model. It reports every test as
 * affected by every change, which is correct and useless — the point is that
 * it is honest, where an empty result would look like "no tests are affected"
 * and quietly skip them.
 */
export function createOpaqueResolver(
  language: string,
  tests: readonly string[],
  reason: string,
): DependencyResolver {
  return {
    language,
    tests: () => [...tests].sort(),
    testsFor: () => [...tests].sort(),
    unmodelled: () => [reason],
  }
}
