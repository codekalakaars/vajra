// Route → source resolution.
//
// The HTTP surface had a hole: a task that changes a route handler selected no
// probes at all. Probes are selected by import graph, and a route file is not
// imported by anything — it *defines* the thing being tested. So the natural
// change, "change what GET /users returns", verified nothing, and selecting
// nothing looks exactly like nothing being affected.
//
// This closes it by indexing the other direction: scan source for route
// definitions, and map the files that define a route to the probes that exercise
// it. The Developer's task names files; the resolver answers which probes those
// files determine.
//
// A route literal is recognised in every common spelling — `:id`, `<id>`,
// `{id}` — and normalised to one form, so a FastAPI decorator and a Flask route
// for the same URL compare equal.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

/** A route registered for every method, or one whose method was not detected. */
export const ANY_METHOD = 'ANY' as const
export type AnyMethod = typeof ANY_METHOD
export type RouteMethod = HttpMethod | AnyMethod

export interface RouteDefinition {
  method: RouteMethod
  /** The literal as written in the source. */
  raw: string
  /** Normalised so `:id`, `<id>` and `{id}` compare equal. */
  path: string
  file: string
}

// Optional converter prefix, as in Flask's `<int:id>` and `<string:name>`.
const PARAM = /[:<{](?:[A-Za-z_][A-Za-z0-9_]*:)?([A-Za-z_][A-Za-z0-9_]*)[}>]?/g

/**
 * `/users/:id`, `/users/<id>`, `/users/<int:id>` and `/users/{id}` all
 * normalise to `/users/{}`.
 *
 * A literal with no leading slash is treated as absolute rather than relative:
 * ASP.NET attributes and NestJS decorators carry only the segment
 * (`[HttpGet("users/{id}")]`, `@Get(':id')`), and the controller prefix is not
 * knowable from the literal alone. Guessing `/` matches the probe that was
 * written against the assembled URL, which is what selection is for.
 */
export function normalizeRoute(path: string): string {
  const trimmed = path.trim().replace(/^https?:\/\/[^/]+/, '').split('?')[0]
  const absolute = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return absolute.replace(PARAM, '{}').replace(/\/+$/, '') || '/'
}

interface RouteRule {
  framework: string
  patterns: readonly RegExp[]
}

const RULES: readonly RouteRule[] = [
  // Express, Koa, Fastify, Hapi: app.get('/x', …) / router.post("/x", …)
  {
    framework: 'node',
    patterns: [/\b(?:app|router|server|api)\s*\.\s*(get|post|put|patch|delete|head|options|all)\s*\(\s*['"`]([^'"`]+)['"`]/g],
  },
  // FastAPI / Flask decorators
  {
    framework: 'decorator',
    patterns: [
      /@\w+\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*['"]([^'"]+)['"]/g,
      /@(?:app|bp|blueprint)\s*\.\s*route\s*\(\s*['"]([^'"]+)['"]/g,
      /@\w+\s*\.\s*route\s*\(\s*['"]([^'"]+)['"]/g,
    ],
  },
  // Spring / Jakarta: @GetMapping("/users/{id}")
  {
    framework: 'jvm',
    patterns: [
      /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*)?['"]([^'"]+)['"]/g,
    ],
  },
  // ASP.NET: [HttpGet("users/{id}")]
  { framework: 'dotnet', patterns: [/\[Http(Get|Post|Put|Patch|Delete)\s*\(\s*['"]([^'"]+)['"]/g] },
  // Rails: get "/users/:id" => …
  { framework: 'rails', patterns: [/^\s*(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/gm] },
  // Go: mux.HandleFunc("/users/{id}", …) / r.GET("/x", …)
  {
    framework: 'go',
    patterns: [
      /\b(?:HandleFunc|Handle)\s*\(\s*"([^"]+)"/g,
      /\b\w+\.(GET|POST|PUT|PATCH|DELETE)\s*\(\s*"([^"]+)"/g,
    ],
  },
  // NestJS: @Get(':id') — only a segment, resolved against the controller prefix.
  { framework: 'nest', patterns: [/@(Get|Post|Put|Patch|Delete)\s*\(\s*['"]([^'"]*)['"]\s*\)/g] },
  // Mount points: app.use('/api', router) — a prefix, not an endpoint, and
  // every route mounted beneath it changes when it does.
  {
    framework: 'mount',
    patterns: [/\b(?:app|router|server|api|r|apiRouter)\s*\.\s*(?:use|mount|group)\s*\(\s*['"`]([^'"`]+)['"`]/g],
  },
]

const METHOD_MAP: Record<string, RouteMethod> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
  head: 'HEAD',
  options: 'OPTIONS',
  all: ANY_METHOD,
  request: ANY_METHOD,
}

/**
 * Every route literal in a source file, across all supported spellings.
 * A framework hint narrows the rules but never suppresses a match outright,
 * because a mislabelled file is common and a missed route is a silent gap.
 */
export function extractRoutes(source: string, framework?: string): RouteDefinition[] {
  const found = new Map<string, RouteDefinition>()
  // A hint reorders the rules so the named framework is tried first; it never
  // excludes any. A mislabelled file is common, and a route missed because the
  // hint disagreed is a silent verification gap.
  const rules = framework
    ? [...RULES].sort((a, b) => Number(b.framework === framework) - Number(a.framework === framework))
    : RULES

  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(source)) !== null) {
        // Two capture groups means (method, path); one means path only.
        const hasMethod = match.length > 2 && METHOD_MAP[match[1].toLowerCase()] !== undefined
        const method = hasMethod ? METHOD_MAP[match[1].toLowerCase()] : ANY_METHOD
        const raw = hasMethod ? match[2] : match[1]
        if (!raw) continue
        const path = normalizeRoute(raw)
        const key = `${method} ${path}`
        if (!found.has(key)) {
          found.set(key, { method, raw, path, file: '' })
        }
      }
    }
  }
  return [...found.values()]
}

export interface RouteIndex {
  /** `${METHOD} ${path}` → the files that define it. */
  byRoute: Map<string, Set<string>>
  /** file → the routes it defines. */
  byFile: Map<string, Set<string>>
  /** Every route key known. */
  routes: Set<string>
}

export function buildRouteIndex(
  files: ReadonlyArray<{ file: string; source: string; framework?: string }>,
): RouteIndex {
  const byRoute = new Map<string, Set<string>>()
  const byFile = new Map<string, Set<string>>()

  for (const { file, source, framework } of files) {
    for (const route of extractRoutes(source, framework)) {
      const key = `${route.method} ${route.path}`
      let files0 = byRoute.get(key)
      if (!files0) byRoute.set(key, (files0 = new Set()))
      files0.add(file)

      let owned = byFile.get(file)
      if (!owned) byFile.set(file, (owned = new Set()))
      owned.add(key)
    }
  }

  return { byRoute, byFile, routes: new Set(byRoute.keys()) }
}

function normalizeMethod(method: string): RouteMethod {
  const upper = method.toUpperCase()
  return upper === ANY_METHOD ? ANY_METHOD : (upper as HttpMethod)
}

export function routeKey(method: string, path: string): string {
  return `${normalizeMethod(method)} ${normalizeRoute(path)}`
}

/**
 * Does a changed file determine this probe?
 *
 * A file that defines the route decides it. A file that does not might still
 * be involved, so a wildcard route — one whose path is fully parameterised, or
 * an ANY-method route — matches every file that defines any route. Over-reporting
 * here is cheap; missing a route is a silent verification gap.
 */
export function routeIsAffected(
  index: RouteIndex,
  probe: { method: string; path: string },
  changedFiles: readonly string[],
): boolean {
  const key = routeKey(probe.method, probe.path)
  const defining = index.byRoute.get(key)
  if (defining && [...defining].some((f) => changedFiles.includes(f))) return true

  // A wildcard route constrains nothing, so any route file could affect it.
  const wildcard = `${ANY_METHOD} ${normalizeRoute(probe.path)}`
  const wild = index.byRoute.get(wildcard)
  if (wild && [...wild].some((f) => changedFiles.includes(f))) return true

  for (const file of changedFiles) {
    for (const defined of index.byFile.get(file) ?? []) {
      if (routesOverlap(defined, key)) return true
    }
  }
  return false
}

/**
 * Do two route keys constrain each other?
 *
 * The method matters: a file defining `POST /x` does not determine what
 * `DELETE /x` returns, and treating it as though it did would verify the wrong
 * endpoint. `ANY` matches anything, since a handler registered for every method
 * does determine all of them.
 *
 * A prefix relation counts, because mounting a router at a new base path
 * changes every route beneath it.
 */
function routesOverlap(a: string, b: string): boolean {
  const [methodA, pathA] = splitKey(a)
  const [methodB, pathB] = splitKey(b)
  const methodsCompatible = methodA === ANY_METHOD || methodB === ANY_METHOD || methodA === methodB
  if (!methodsCompatible) return false
  if (pathA === pathB) return true
  return pathB.startsWith(`${pathA}/`) || pathA.startsWith(`${pathB}/`)
}

function splitKey(key: string): [string, string] {
  const at = key.indexOf(' ')
  return [key.slice(0, at), key.slice(at + 1)]
}
