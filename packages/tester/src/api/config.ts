// Declarative configuration for building, serving and probing an API.
//
// The point of this file is that language appears exactly once, in the build
// and serve commands. Everything downstream — probe construction, expectation
// evaluation, verdict classification — is identical whether the API is
// TypeScript, Python or Java, because an HTTP response does not carry its
// origin language.
//
// A target is therefore described declaratively rather than implemented per
// language. Adding a fourth language means writing a build command, not a
// runner.

import type { Expectation, Matcher } from './expect.js'

export type ProbeMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

export type TemplateValue = string | number | boolean | readonly string[]

export interface BuildStep {
  /** Executable and arguments. */
  run: readonly string[]
  cwd?: string
  env?: Record<string, string | TemplateValue>
  timeoutMs?: number
  /** Fail the target if this step exits non-zero. Defaults to true. */
  optional?: boolean
}

export type ReadyCheck =
  /** Poll an HTTP endpoint until it answers acceptably. */
  | { kind: 'http'; path: string; status?: number | readonly number[]; timeoutMs?: number }
  /** Poll a TCP port until it accepts a connection. */
  | { kind: 'tcp'; timeoutMs?: number }
  /** Wait for a pattern in the server's combined output. */
  | { kind: 'log'; pattern: string; timeoutMs?: number }
  /** Unconditional wait. A last resort, not a readiness signal. */
  | { kind: 'delay'; ms: number }

export interface ServeStep {
  run: readonly string[]
  cwd?: string
  env?: Record<string, string | TemplateValue>
  /**
   * Preferred port. `0` means the OS assigns one, which is the default
   * because two targets running at once would otherwise collide.
   */
  port?: number
  /** How to know the server is up. Polled, not slept on, when possible. */
  ready?: ReadyCheck
  timeoutMs?: number
  /** Grace period on shutdown. */
  shutdownMs?: number
}

export interface ApiProbe {
  id: string
  method: ProbeMethod
  /** Path template; `{name}` segments are filled from `params`. */
  path: string
  /** Query parameters. */
  params?: Record<string, string | number | boolean>
  headers?: Record<string, string>
  /** JSON request body. */
  body?: unknown
  expect: Expectation
  /** Overrides the target's base URL — for probing a different environment. */
  baseUrl?: string
  timeoutMs?: number
  /**
   * Probes that must run first, in the order given. Their captured variables
   * become available to this probe.
   *
   * Almost every real API needs this: authenticating once and reusing the
   * token is the normal shape of a test suite, and without it an authenticated
   * endpoint can only be probed by hard-coding a credential that expires.
   */
  dependsOn?: readonly string[]
  /**
   * Capture values from this probe's response so later probes can use them.
   * `{ '$.data.token': 'token' }` stores the field at that path as `token`,
   * usable as `{{token}}` in a later path, header, or body.
   */
  capture?: Record<string, string>
}

export interface ApiTargetConfig {
  id: string
  /** Free-form label: typescript, python, java. Used only for diagnostics. */
  language: string
  /** Compile and install steps, run in order before serving. */
  build?: readonly BuildStep[]
  serve: ServeStep
  /** Probes the Developer specified, or that were derived from a contract. */
  probes: readonly ApiProbe[]
  /** Env applied to every step. */
  env?: Record<string, string | TemplateValue>
  /** Files whose contents invalidate cached probe results. */
  configFiles?: readonly string[]
}

export interface ConfigIssue {
  path: string
  message: string
}

const METHODS: readonly ProbeMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

const MATCHERS = [
  'equals',
  'notEquals',
  'contains',
  'oneOf',
  'matches',
  'exists',
  'isNull',
  'type',
  'gt',
  'gte',
  'lt',
  'lte',
  'length',
  'deepEquals',
] as const

export function validateApiTarget(config: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  const add = (path: string, message: string): void => {
    issues.push({ path, message })
  }

  if (typeof config !== 'object' || config === null) {
    add('$', 'target config must be an object')
    return issues
  }
  const c = config as Partial<ApiTargetConfig>

  if (!c.id || typeof c.id !== 'string') add('id', 'required, must be a non-empty string')
  if (!c.language || typeof c.language !== 'string') add('language', 'required')
  if (!c.serve || typeof c.serve !== 'object') {
    add('serve', 'required, with a run command')
  } else {
    if (!Array.isArray(c.serve.run) || c.serve.run.length === 0) {
      add('serve.run', 'required, a non-empty command')
    }
    if (c.serve.port !== undefined && !isPort(c.serve.port)) {
      add('serve.port', 'must be 0 (OS-assigned) or an integer from 1 to 65535')
    }
  }

  for (const [i, step] of (c.build ?? []).entries()) {
    if (!Array.isArray(step?.run) || step.run.length === 0) {
      add(`build[${i}].run`, 'required, a non-empty command')
    }
  }

  if (!Array.isArray(c.probes) || c.probes.length === 0) {
    add('probes', 'required, at least one probe')
  } else {
    const seen = new Set<string>()
    for (const [i, probe] of c.probes.entries()) {
      const at = `probes[${i}]`
      if (!probe?.id || typeof probe.id !== 'string') {
        add(`${at}.id`, 'required')
      } else if (seen.has(probe.id)) {
        // Duplicate ids collide in the registry and silently overwrite a
        // binding, which reads as a missing test rather than a config error.
        add(`${at}.id`, `duplicate probe id "${probe.id}"`)
      } else {
        seen.add(probe.id)
      }
      if (!probe?.method || !METHODS.includes(probe.method)) {
        add(`${at}.method`, `required, one of ${METHODS.join(', ')}`)
      }
      if (typeof probe?.path !== 'string' || !probe.path.startsWith('/')) {
        add(`${at}.path`, 'required, must start with /')
      }
      if (probe?.expect === undefined) {
        add(`${at}.expect`, 'required')
      }
      for (const [path, matcher] of Object.entries(probe?.expect?.body ?? {})) {
        if (!isMatcher(matcher)) {
          const given = Object.keys(matcher as object).join(', ') || 'nothing'
          add(
            `${at}.expect.body.${path}`,
            `not a recognised matcher (got: ${given}); expected one of ${MATCHERS.join(', ')}`,
          )
        }
      }
    }
  }

  return issues
}

function isPort(value: unknown): boolean {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535
  )
}

function isMatcher(value: unknown): value is Matcher {
  if (typeof value !== 'object' || value === null) return false
  const keys = Object.keys(value as object)
  if (keys.length !== 1) return false
  return (MATCHERS as readonly string[]).includes(keys[0])
}

/** Fill `{name}` segments from the probe's params. */
export function renderPath(
  template: string,
  params: Record<string, string | number | boolean> = {},
): { path: string; missing: string[] } {
  const missing: string[] = []
  const path = template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = params[name]
    if (value === undefined) {
      missing.push(name)
      return ''
    }
    return encodeURIComponent(String(value))
  })
  return { path, missing }
}
