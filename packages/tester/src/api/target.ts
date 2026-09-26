// An API target presented as a RunnerAdapter.
//
// This is the seam that makes the rest of the package language-neutral. Probes
// become RawTestOutcome[] exactly as parsed JUnit reports do, so expectation
// evaluation, Phase One inversion, cross-task attribution, caching and the
// at-rest invariant all apply unchanged to an HTTP API in any language.
//
// The one judgement this file makes is how a failed probe maps onto a verdict,
// and it turns on a single question: did the server answer at all?
//
//   No response — build failed, nothing listening, connection refused,
//   DNS, TLS, timeout.  The scaffolding is broken. → failed_environment
//
//   A response, but not the expected one — 404, 500, wrong body.
//   The API is running and did not do the right thing. → failed_assertion
//
// That line matters most in Phase One, where a probe is expected to fail. A
// stub endpoint that returns 404 is the gate succeeding; a server that never
// started is the gate being meaningless.

import { checkExpectation, type ResponseSnapshot } from './expect.js'
import { renderPath, type ApiProbe, type ApiTargetConfig } from './config.js'
import { captureVariables, orderProbes, renderProbe } from './order.js'
import { ApiHarness, HarnessError, type ExecDeps } from './lifecycle.js'
import { httpTarget, type TestTarget } from '../target.js'
import { buildRouteIndex, routeIsAffected, type RouteIndex } from '../route.js'
import type { RawRunResult, RawTestOutcome, RouteAwareRunner } from '../runner.js'

export interface ApiTargetOptions {
  /** Reuse a running harness instead of building and serving. */
  harness?: ApiHarness
  build?: boolean
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export interface ApiTargetDeps extends ExecDeps {
  createHarness?: (config: ApiTargetConfig, build: boolean) => ApiHarness
}

export interface ApiTargetSelectors {
  /**
   * Source files that define each probe's route. Without this a task that
   * changes a route handler selects no probes, because a route file is not
   * imported by anything — it defines the thing being tested.
   */
  routes?: RouteIndex
}

export function createApiTarget(
  config: ApiTargetConfig,
  options: ApiTargetOptions = {},
  deps: ApiTargetDeps = {},
): RouteAwareRunner {
  return {
    name: `api:${config.id}`,
    version: '1',
    /** Probes a set of changed source files determines, for the resolver. */
    probesForRoutes(routes: RouteIndex, changedFiles: readonly string[]): string[] {
      return config.probes
        .filter((probe) => routeIsAffected(routes, probe, changedFiles))
        .map((probe) => probe.id)
    },
    routes: buildRouteIndex([]),

    async run(request): Promise<RawRunResult> {
      const started = Date.now()
      const fetchImpl = options.fetchImpl ?? deps.fetchImpl ?? globalThis.fetch
      const ownHarness = options.harness
        ? undefined
        : (deps.createHarness ?? ((c, build) => new ApiHarness({ config: c, build }, deps)))(config, options.build ?? true)

      try {
        if (ownHarness) await ownHarness.start()
      } catch (error) {
        await ownHarness?.stop()
        return harnessFailure(config, error, Date.now() - started)
      }

      const base = ownHarness ? ownHarness.baseUrl : (options.harness?.baseUrl ?? '')
      const wanted = new Set(
        request.testRefs.length > 0 ? request.testRefs : config.probes.map((p) => p.id),
      )

      // Probes run in dependency order and share a variable bag, so a token
      // captured by one probe is available to the probes that depend on it.
      // Selecting a subset does not skip a prerequisite — a probe that needs a
      // capture it cannot have is an error, not a request with holes in it.
      const { ordered, problems } = orderProbes(config.probes)
      const variables: Record<string, string> = {}
      const tests: RawTestOutcome[] = []

      for (const problem of problems) {
        tests.push({
          id: `http:config`,
          ref: 'config',
          target: httpTarget(`config ${config.id}`),
          status: 'errored',
          message: problem,
        })
      }

      const runnable = ordered.filter((p) => wanted.has(p.id))
      const required = new Set<string>()
      for (const probe of runnable) {
        for (const dep of probe.dependsOn ?? []) required.add(dep)
      }
      // Pull in prerequisites even when they were not explicitly selected.
      const withPrereqs = ordered.filter((p) => wanted.has(p.id) || required.has(p.id))

      for (const probe of withPrereqs) {
        tests.push(
          await runProbe(probe, base, fetchImpl, options.timeoutMs ?? request.timeoutMs, variables),
        )
      }

      try {
        await ownHarness?.stop()
      } catch {
        /* teardown is best-effort; it must not mask a probe result */
      }

      return { tests, durationMs: Date.now() - started }
    },
  }
}

async function runProbe(
  probe: ApiProbe,
  baseUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  variables: Record<string, string>,
): Promise<RawTestOutcome> {
  const target = httpTarget(`${probe.method} ${probe.path}`)
  const id = `http:${probe.id}`
  const ref = probe.id
  const rendered = renderProbe(probe, variables)
  const { path, missing } = renderPath(rendered.path, rendered.params)

  if (rendered.unresolved.length > 0) {
    // A `{{token}}` with no capture behind it. Running it anyway would send a
    // literal `{{token}}` and produce a baffling 404.
    return {
      id,
      ref,
      target,
      status: 'errored',
      message: `probe references uncaptured variables: ${rendered.unresolved.join(', ')}`,
    }
  }

  if (missing.length > 0) {
    // A probe whose params the Developer did not supply is a configuration
    // error, not a failing API.
    return {
      id,
      ref,
      target,
      status: 'errored',
      message: `probe is missing params: ${missing.join(', ')}`,
    }
  }

  const url = new URL(path, probe.baseUrl ?? baseUrl)
  for (const [key, value] of Object.entries(probe.params ?? {})) {
    if (path.includes(`{${key}}`)) continue
    url.searchParams.set(key, String(value))
  }

  const hasBody = probe.body !== undefined && probe.method !== 'GET' && probe.method !== 'HEAD'
  const started = Date.now()
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: probe.method,
      headers: {
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        ...rendered.headers,
      },
      ...(hasBody ? { body: JSON.stringify(rendered.body) } : {}),
      signal: AbortSignal.timeout(probe.timeoutMs ?? timeoutMs),
    })
  } catch (error) {
    return {
      id,
      ref,
      target,
      status: 'errored',
      message: `${probe.id}: no response from ${probe.method} ${url.pathname}: ${describe(error)}`,
    }
  }

  const raw = await response.text()
  const snapshot: ResponseSnapshot = {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: parseBody(raw, response.headers.get('content-type')),
    raw,
    latencyMs: Date.now() - started,
  }

  captureVariables(probe, snapshot, variables)

  const failures = checkExpectation(snapshot, probe.expect)
  if (failures.length === 0) {
    return { id, ref, target, status: 'passed' }
  }
  return {
    id,
    ref,
    target,
    status: 'failed',
    failureKind: 'assertion',
    message: failures
      .map((f) => `${f.path}: expected ${f.expected}, got ${f.actual}`)
      .join('; '),
  }
}

function parseBody(raw: string, contentType: string | null): unknown {
  if (!contentType?.includes('json')) return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError' || error.name === 'AbortError'
      ? `timed out (${error.message})`
      : error.message
  }
  return String(error)
}

/**
 * A build or startup failure is an environment failure on every probe the
 * target declares, so the task cannot verify — and, critically, a Phase One
 * test task cannot pass its gate on a server that never ran.
 */
function harnessFailure(
  config: ApiTargetConfig,
  error: unknown,
  durationMs: number,
): RawRunResult {
  const stage = error instanceof HarnessError ? error.stage : 'serve'
  const detail = error instanceof HarnessError ? error.detail : undefined
  const message =
    error instanceof Error
      ? `${stage}: ${error.message}${detail?.stderr ? ` — ${detail.stderr.trim().slice(0, 300)}` : ''}`
      : String(error)

  return {
    tests: config.probes.map((probe) => ({
      id: `http:${probe.id}`,
      ref: probe.id,
      target: httpTarget(`${probe.method} ${probe.path}`),
      status: 'errored' as const,
      message,
    })),
    durationMs,
  }
}
