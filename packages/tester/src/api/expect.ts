// Response expectations — the oracle.
//
// A probe supplies stimulus; something must decide whether the response is
// correct. That decision is a pure function of the response, which makes it
// testable without a server and, more importantly, makes it identical across
// languages: an HTTP response does not know what language produced it.
//
// Matching is by JSON path so a probe asserts on a field rather than on a whole
// body, which keeps the oracle stable when an API adds an unrelated field.

export type Matcher =
  | { equals: unknown }
  | { notEquals: unknown }
  | { contains: string }
  | { oneOf: readonly unknown[] }
  | { matches: string }
  | { exists: boolean }
  | { isNull: boolean }
  | { type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null' }
  | { gt: number }
  | { gte: number }
  | { lt: number }
  | { lte: number }
  | { length: number }
  | { deepEquals: unknown }

export interface Expectation {
  /** Accepted status codes. Defaults to any 2xx. */
  status?: number | readonly number[]
  /** Path assertions, e.g. `{ '$.data.token': { exists: true } }`. */
  body?: Record<string, Matcher>
  /** Response header assertions, case-insensitive. */
  headers?: Record<string, string>
  /** Upper bound on response time. */
  latencyMs?: number
  /** The body must contain this text — useful for non-JSON endpoints. */
  bodyContains?: string
}

export interface ResponseSnapshot {
  status: number
  headers: Record<string, string>
  body: unknown
  raw: string
  latencyMs: number
}

export interface ExpectationFailure {
  path: string
  expected: string
  actual: string
}

/**
 * Evaluate a dotted/bracketed path against a value. Supports `$.a.b`,
 * `items[0].id`, and `[*]` wildcards. Recursive descent (`$..name`) is not
 * supported — it is rarely what a probe means and its absence is a compile-time
 * surprise rather than a silent one, because a path that matches nothing
 * reports zero matches.
 */
export function queryPath(value: unknown, path: string): unknown[] {
  const cleaned = path.replace(/^\$\.?/, '').replace(/^\./, '')
  if (cleaned === '') return [value]

  const segments: Array<string | number> = []
  const pattern = /[^.[\]]+|\[(\*|-?\d+)\]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(cleaned)) !== null) {
    segments.push(match[1] === undefined ? match[0] : match[1] === '*' ? '*' : Number(match[1]))
  }

  let current: unknown[] = [value]
  for (const segment of segments) {
    const next: unknown[] = []
    for (const item of current) {
      if (segment === '*') {
        if (Array.isArray(item)) next.push(...item)
        else if (isRecord(item)) next.push(...Object.values(item))
        continue
      }
      if (typeof segment === 'number') {
        if (Array.isArray(item) && segment >= 0 && segment < item.length) {
          next.push(item[segment])
        }
        continue
      }
      if (isRecord(item) && segment in item) next.push(item[segment])
    }
    current = next
    if (current.length === 0) break
  }
  return current
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function matches(value: unknown, matcher: Matcher): boolean {
  if ('equals' in matcher) return deepEquals(value, matcher.equals)
  if ('notEquals' in matcher) return !deepEquals(value, matcher.notEquals)
  if ('contains' in matcher) {
    if (typeof value === 'string') return value.includes(matcher.contains)
    if (Array.isArray(value)) return value.some((v) => deepEquals(v, matcher.contains))
    return false
  }
  if ('oneOf' in matcher) return matcher.oneOf.some((v) => deepEquals(value, v))
  if ('matches' in matcher) {
    if (typeof value !== 'string') return false
    try {
      return new RegExp(matcher.matches).test(value)
    } catch {
      return false
    }
  }
  if ('exists' in matcher) return (value !== undefined) === matcher.exists
  if ('isNull' in matcher) return (value === null) === matcher.isNull
  if ('type' in matcher) return typeOf(value) === matcher.type
  if ('gt' in matcher) return typeof value === 'number' && value > matcher.gt
  if ('gte' in matcher) return typeof value === 'number' && value >= matcher.gte
  if ('lt' in matcher) return typeof value === 'number' && value < matcher.lt
  if ('lte' in matcher) return typeof value === 'number' && value <= matcher.lte
  if ('length' in matcher) {
    if (typeof value === 'string' || Array.isArray(value)) return value.length === matcher.length
    if (isRecord(value)) return Object.keys(value).length === matcher.length
    return false
  }
  if ('deepEquals' in matcher) return deepEquals(value, matcher.deepEquals)
  return false
}

/** Recursive partial equality: every key present in `expected` must match. */
function deepEquals(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false
    return expected.every((item, i) => deepEquals(actual[i], item))
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false
    return Object.entries(expected).every(([key, value]) => deepEquals(actual[key], value))
  }
  return Object.is(actual, expected)
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === undefined) return 'absent'
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300
}

export function checkExpectation(
  response: ResponseSnapshot,
  expectation: Expectation,
): ExpectationFailure[] {
  const failures: ExpectationFailure[] = []

  if (expectation.status === undefined) {
    if (!isSuccess(response.status)) {
      failures.push({
        path: 'status',
        expected: '2xx',
        actual: String(response.status),
      })
    }
  } else {
    const allowed =
      typeof expectation.status === 'number' ? [expectation.status] : expectation.status
    if (!allowed.includes(response.status)) {
      failures.push({
        path: 'status',
        expected: allowed.join(' or '),
        actual: String(response.status),
      })
    }
  }

  if (expectation.latencyMs !== undefined && response.latencyMs > expectation.latencyMs) {
    failures.push({
      path: 'latency',
      expected: `<= ${expectation.latencyMs}ms`,
      actual: `${response.latencyMs}ms`,
    })
  }

  if (expectation.headers) {
    const lower = new Map(
      Object.entries(response.headers).map(([k, v]) => [k.toLowerCase(), v]),
    )
    for (const [name, wanted] of Object.entries(expectation.headers)) {
      const got = lower.get(name.toLowerCase())
      if (got !== wanted) {
        failures.push({ path: `headers.${name}`, expected: wanted, actual: got ?? 'absent' })
      }
    }
  }

  if (expectation.bodyContains !== undefined) {
    if (!response.raw.includes(expectation.bodyContains)) {
      failures.push({
        path: 'body',
        expected: `contains ${describe(expectation.bodyContains)}`,
        actual: `${describe(response.raw.slice(0, 120))}${response.raw.length > 120 ? '…' : ''}`,
      })
    }
  }

  for (const [path, matcher] of Object.entries(expectation.body ?? {})) {
    const found = queryPath(response.body, path)
    if (found.length === 0) {
      if ('exists' in matcher && matcher.exists === false) continue
      failures.push({ path, expected: describe(matcher), actual: 'no match' })
      continue
    }
    if (!found.some((value) => matches(value, matcher))) {
      failures.push({ path, expected: describe(matcher), actual: describe(found[0]) })
    }
  }

  return failures
}
