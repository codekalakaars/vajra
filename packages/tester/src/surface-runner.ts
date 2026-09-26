// Surface dispatch.
//
// Four runner factories existed and the caller had to know which to reach for,
// and hand-wire the registry. That is a toolbox, not a system: a plan declaring
// "these are the surfaces under test" should be enough.
//
// This resolves a surface name to the right runner, and — more usefully —
// refuses a plan whose prerequisites are not available, at submission, rather
// than three minutes into a build.

import { createApiTarget } from './api/target.js'
import type { ApiTargetConfig } from './api/config.js'
import { createCliTarget } from './api/cli.js'
import type { CliTargetConfig } from './api/cli.js'
import { createCommandRunner, type CommandRunnerOptions } from './command.js'
import { createJestLikeRunner, type CommandReportTarget } from './command-target.js'
import type { RouteAwareRunner, RunnerAdapter } from './runner.js'
import { buildRouteIndex, type RouteIndex } from './route.js'
import {
  SURFACES_BY_NAME,
  unavailableSurfaces,
  type Prerequisite,
} from './surfaces.js'

export interface SurfaceRunnerRequest {
  /** Surface name, as classified in surfaces.ts. */
  surface: string
  id: string
  api?: ApiTargetConfig
  cli?: CliTargetConfig
  command?: CommandRunnerOptions
  /** Source files for route resolution, for an http-api surface. */
  routeFiles?: ReadonlyArray<{ file: string; source: string; framework?: string }>
}

export class UnsupportedSurfaceError extends Error {
  constructor(
    readonly surface: string,
    readonly reason: string,
  ) {
    super(`cannot build a runner for surface "${surface}": ${reason}`)
    this.name = 'UnsupportedSurfaceError'
  }
}

export function createSurfaceRunner(request: SurfaceRunnerRequest): RunnerAdapter {
  const definition = SURFACES_BY_NAME.get(request.surface)
  if (!definition) {
    throw new UnsupportedSurfaceError(request.surface, 'not a known surface')
  }

  switch (definition.mechanism) {
    case 'spawn': {
      if (request.surface === 'cli' || request.surface === 'job') {
        if (!request.cli) {
          throw new UnsupportedSurfaceError(request.surface, 'needs a `cli` config')
        }
        return createCliTarget({ ...request.cli, id: request.id })
      }
      if (request.surface === 'http-api') break
      if (!request.command) {
        throw new UnsupportedSurfaceError(request.surface, 'needs a `command` config')
      }
      return createCommandRunner(request.command)
    }

    case 'codegen': {
      if (request.surface === 'http-api') break
      if (!request.command) {
        throw new UnsupportedSurfaceError(
          request.surface,
          'needs a `command` config that runs the generated or existing tests',
        )
      }
      return createJestLikeRunner(request.command as CommandReportTarget)
    }
  }

  // http-api is either a real server under test or a report produced by one.
  if (!request.api && request.command) {
    return createCommandRunner(request.command)
  }
  if (!request.api) {
    throw new UnsupportedSurfaceError('http-api', 'needs an `api` or `command` config')
  }
  const runner = createApiTarget(request.api)
  if (request.routeFiles) {
    attachRoutes(runner, buildRouteIndex(request.routeFiles))
  }
  return runner
}

/** A route-aware target, with the index filled in, when route resolution is on. */
export function createRoutedApiTarget(
  config: ApiTargetConfig,
  routeFiles: ReadonlyArray<{ file: string; source: string; framework?: string }>,
): RouteAwareRunner {
  const runner = createApiTarget(config)
  attachRoutes(runner, buildRouteIndex(routeFiles))
  return runner
}

function attachRoutes(runner: RouteAwareRunner, index: RouteIndex): void {
  Object.defineProperty(runner, 'routes', { value: index, configurable: true })
}

/**
 * The infrastructure a plan needs before it can be submitted. A plan that needs
 * a database on a host without one is refused now, not after a build.
 */
export interface PlanCheck {
  ok: boolean
  required: Prerequisite[]
  missing: Prerequisite[]
  unavailableSurfaces: string[]
  unsupported: string[]
}

export function checkPlan(
  surfaces: ReadonlyArray<{ surface: string }>,
  available: readonly Prerequisite[] = ['toolchain', 'runtime'],
): PlanCheck {
  const names = surfaces.map((s) => s.surface)
  const unsupported = names.filter((name) => {
    const definition = SURFACES_BY_NAME.get(name)
    return !definition || definition.status === 'unsupported'
  })
  const buildable = names.filter((name) => !unsupported.includes(name))
  const missingSurfaces = unavailableSurfaces(buildable, available)
  const required = [
    ...new Set(
      buildable.flatMap((name) => SURFACES_BY_NAME.get(name)?.requires ?? ['none' as Prerequisite]),
    ),
  ].filter((r) => r !== 'none')
  const have = new Set(available)
  const missing = required.filter((r) => !have.has(r))

  return {
    ok: unsupported.length === 0 && missingSurfaces.length === 0,
    required,
    missing,
    unavailableSurfaces: missingSurfaces,
    unsupported,
  }
}
