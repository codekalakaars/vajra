// Machine-readable surface taxonomy.
//
// Kept as data rather than prose so the verifier can reason about what a task
// needs before it runs: a probe that needs a database should be refused at
// submission rather than failing mysteriously three minutes into a build.
//
// See docs/testing/surfaces.md for the reasoning. The short version: fourteen
// surfaces reduce to two mechanisms — spawn-and-assert, or generate-a-test-and-
// run-it — and both end at the same verdict pipeline.

export type Mechanism = 'spawn' | 'codegen'

export type Invocation =
  | 'subprocess'
  | 'http'
  | 'in-process'
  | 'message'
  | 'sql'
  | 'render'

export type Oracle =
  | 'output'
  | 'status'
  | 'body'
  | 'dom'
  | 'rows'
  | 'return'
  | 'diagnostics'
  | 'files'
  | 'score'

/** Infrastructure that must exist before any test on this surface can run. */
export type Prerequisite = 'none' | 'toolchain' | 'runtime' | 'database' | 'broker' | 'browser'

export interface SurfaceDefinition {
  name: string
  mechanism: Mechanism
  invocation: Invocation
  oracle: readonly Oracle[]
  requires: readonly Prerequisite[]
  /**
   * Whether this package can verify the surface today. `partial` means the
   * mechanism exists but the surface needs a generator or a real dependency
   * the project supplies.
   */
  status: 'built' | 'codegen' | 'partial' | 'unsupported'
  note?: string
}

export const SURFACES: readonly SurfaceDefinition[] = [
  {
    name: 'library',
    mechanism: 'codegen',
    invocation: 'in-process',
    oracle: ['return', 'diagnostics'],
    requires: ['toolchain'],
    status: 'codegen',
  },
  {
    name: 'cli',
    mechanism: 'spawn',
    invocation: 'subprocess',
    oracle: ['output', 'status', 'files'],
    requires: ['toolchain'],
    status: 'built',
  },
  {
    name: 'http-api',
    mechanism: 'spawn',
    invocation: 'http',
    oracle: ['status', 'body', 'diagnostics'],
    requires: ['toolchain', 'runtime'],
    status: 'built',
  },
  {
    name: 'component',
    mechanism: 'codegen',
    invocation: 'render',
    oracle: ['dom'],
    requires: ['toolchain', 'browser'],
    status: 'codegen',
    note: 'Generator emits tests in the framework idiom; rendering is the harness job.',
  },
  {
    name: 'page',
    mechanism: 'codegen',
    invocation: 'render',
    oracle: ['dom', 'body'],
    requires: ['toolchain', 'browser'],
    status: 'partial',
    note: 'Drive Playwright and parse its JUnit output rather than grow browser automation.',
  },
  {
    name: 'job',
    mechanism: 'spawn',
    invocation: 'subprocess',
    oracle: ['output', 'files', 'rows'],
    requires: ['toolchain', 'runtime'],
    status: 'built',
  },
  {
    name: 'queue',
    mechanism: 'codegen',
    invocation: 'message',
    oracle: ['rows', 'diagnostics'],
    requires: ['toolchain', 'broker'],
    status: 'unsupported',
    note: 'Needs a real broker; no abstraction removes that provisioning step.',
  },
  {
    name: 'grpc',
    mechanism: 'codegen',
    invocation: 'http',
    oracle: ['status', 'body'],
    requires: ['toolchain', 'runtime'],
    status: 'unsupported',
    note: 'gRPC is HTTP/2 with its own framing; not reachable by an HTTP probe.',
  },
  {
    name: 'data',
    mechanism: 'codegen',
    invocation: 'sql',
    oracle: ['rows'],
    requires: ['toolchain', 'database'],
    status: 'unsupported',
    note: 'Needs testcontainers or an in-process substitute such as SQLite.',
  },
  {
    name: 'migration',
    mechanism: 'spawn',
    invocation: 'subprocess',
    oracle: ['rows', 'diagnostics'],
    requires: ['toolchain', 'database'],
    status: 'partial',
  },
  {
    name: 'serverless',
    mechanism: 'spawn',
    invocation: 'subprocess',
    oracle: ['status', 'body'],
    requires: ['toolchain', 'runtime'],
    status: 'partial',
    note: 'Needs an emulator, which the project supplies.',
  },
  {
    name: 'static',
    mechanism: 'spawn',
    invocation: 'subprocess',
    oracle: ['diagnostics', 'status'],
    requires: ['toolchain'],
    status: 'partial',
    note: 'Reachable by wrapping a command; a first-class criterion type would be better.',
  },
  {
    name: 'infra',
    mechanism: 'spawn',
    invocation: 'subprocess',
    oracle: ['diagnostics', 'output'],
    requires: ['toolchain'],
    status: 'unsupported',
    note: 'Plan-diff assertions are project-specific.',
  },
  {
    name: 'ai-eval',
    mechanism: 'codegen',
    invocation: 'in-process',
    oracle: ['score'],
    requires: ['toolchain', 'runtime'],
    status: 'unsupported',
    note: 'A score against a threshold; needs an eval corpus the project owns.',
  },
]

export const SURFACES_BY_NAME: ReadonlyMap<string, SurfaceDefinition> = new Map(
  SURFACES.map((s) => [s.name, s]),
)

/**
 * Infrastructure a plan needs before it can be submitted. A task that declares
 * a probe against an unavailable prerequisite should be refused at submission
 * rather than failing after a build.
 */
export function prerequisitesFor(surfaceNames: readonly string[]): Prerequisite[] {
  const needed = new Set<Prerequisite>()
  for (const name of surfaceNames) {
    const surface = SURFACES_BY_NAME.get(name)
    if (!surface) continue
    for (const requirement of surface.requires) needed.add(requirement)
  }
  return [...needed]
}

export function unavailableSurfaces(
  surfaceNames: readonly string[],
  available: readonly Prerequisite[],
): string[] {
  const have = new Set(available)
  return surfaceNames.filter((name) => {
    const surface = SURFACES_BY_NAME.get(name)
    if (!surface) return true
    return surface.requires.some((r) => r !== 'none' && !have.has(r))
  })
}
