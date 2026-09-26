// Probe ordering and variable capture.
//
// An API suite is rarely a set of independent calls. Almost all of them need a
// token from an earlier call, and a test runner that cannot express that can
// only test an API with the authentication removed — which is not the API.
//
// So probes form an order: `dependsOn` names predecessors, captured values flow
// forward, and the topological sort is what makes a run reproducible. A cycle is
// rejected at validation rather than deadlocking a run, and an unsatisfiable
// dependency marks the dependent probe as an error instead of running it with
// holes in its inputs.

import type { ApiProbe, ApiTargetConfig } from './config.js'
import { queryPath } from './expect.js'
import type { ResponseSnapshot } from './expect.js'

/** Replace `{{name}}` with a captured value. */
export function substitute(
  text: string,
  variables: Readonly<Record<string, string>>,
): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, name: string) => variables[name] ?? match)
}

function substituteDeep<T>(value: T, variables: Readonly<Record<string, string>>): T {
  if (typeof value === 'string') return substitute(value, variables) as unknown as T
  if (Array.isArray(value)) {
    return value.map((v) => substituteDeep(v, variables)) as unknown as T
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteDeep(v, variables)
    }
    return out as unknown as T
  }
  return value
}

export function renderProbe(
  probe: ApiProbe,
  variables: Readonly<Record<string, string>>,
): {
  method: string
  path: string
  params: Record<string, string>
  headers: Record<string, string>
  body: unknown
  unresolved: string[]
} {
  const unresolved: string[] = []

  const render = (text: string): string =>
    substitute(text, variables).replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
      unresolved.push(name)
      return match
    })

  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(probe.params ?? {})) {
    params[key] = render(String(value))
  }

  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(probe.headers ?? {})) {
    headers[key] = render(value)
  }

  return {
    method: probe.method,
    path: render(probe.path),
    params,
    headers,
    body: substituteDeep(probe.body, variables),
    unresolved: [...new Set(unresolved)],
  }
}

/** Store `capture` paths from a response into the variable bag. */
export function captureVariables(
  probe: ApiProbe,
  response: ResponseSnapshot,
  into: Record<string, string>,
): void {
  for (const [path, name] of Object.entries(probe.capture ?? {})) {
    const found = queryPath(response.body, path)
    if (found.length > 0 && found[0] !== undefined && found[0] !== null) {
      into[name] = typeof found[0] === 'string' ? found[0] : JSON.stringify(found[0])
    }
  }
}

export interface OrderedProbe {
  probe: ApiProbe
  /** Probes that must have produced their captures first. */
  requires: string[]
  /** Probes whose captures this one needs. */
  provides: string[]
}

export function orderProbes(probes: readonly ApiProbe[]): {
  ordered: ApiProbe[]
  problems: string[]
} {
  const byId = new Map(probes.map((p) => [p.id, p]))
  const problems: string[] = []

  for (const probe of probes) {
    for (const dep of probe.dependsOn ?? []) {
      if (!byId.has(dep)) {
        problems.push(`${probe.id} depends on unknown probe "${dep}"`)
      }
      if (dep === probe.id) problems.push(`${probe.id} depends on itself`)
    }
  }

  const ordered: ApiProbe[] = []
  const placed = new Set<string>()
  const remaining = [...probes]

  // Repeatedly place probes whose dependencies are satisfied. A probe whose
  // dependencies can never be satisfied is reported rather than looped on.
  while (remaining.length > 0) {
    const ready = remaining.filter((p) =>
      (p.dependsOn ?? []).every((d) => placed.has(d) || !byId.has(d)),
    )
    if (ready.length === 0) {
      for (const stuck of remaining) {
        problems.push(
          `${stuck.id} can never run: depends on ${(stuck.dependsOn ?? [])
            .filter((d) => !placed.has(d))
            .join(', ')}`,
        )
      }
      break
    }
    for (const probe of ready) {
      ordered.push(probe)
      placed.add(probe.id)
      remaining.splice(remaining.indexOf(probe), 1)
    }
  }

  return { ordered, problems }
}

/** Config-level validation of the ordering, so a cycle is caught at submit. */
export function validateProbeOrder(config: ApiTargetConfig): string[] {
  return orderProbes(config.probes).problems
}
