// Deriving probes from an API contract.
//
// A contract already states the methods, paths, required parameters and
// response schemas — which is exactly the four things a hand-written probe has
// to supply. Deriving probes from it means a REST API with no tests at all
// still has a Phase One to run against, which is the case "any API in a
// standard format" is really about.
//
// The generated probe asserts the *shape* of a successful response, not its
// semantics. Nobody can derive "a valid password is 8+ characters" from a
// schema, and pretending otherwise would produce a gate that passes
// unconditionally.

export interface OpenApiDocument {
  openapi?: string
  swagger?: string
  info?: { title?: string; version?: string }
  servers?: Array<{ url: string }>
  paths?: Record<string, Record<string, unknown>>
}

export interface DerivedProbe {
  id: string
  method: string
  path: string
  params: Record<string, string | number | boolean>
  expect: { status: number; body: Record<string, unknown> }
}

export interface DeriveResult {
  probes: DerivedProbe[]
  /** Paths present in the document that could not be turned into a probe. */
  skipped: Array<{ path: string; method: string; reason: string }>
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

/**
 * Build one probe per operation. Required parameters are filled with a
 * synthetic value of the right type, because a probe that omits a required
 * parameter tests the 400 path rather than the operation.
 */
export function deriveProbesFromOpenApi(doc: unknown): DeriveResult {
  if (typeof doc !== 'object' || doc === null) {
    return { probes: [], skipped: [] }
  }
  const document = doc as OpenApiDocument
  const probes: DerivedProbe[] = []
  const skipped: DeriveResult['skipped'] = []

  for (const [path, operations] of Object.entries(document.paths ?? {})) {
    if (typeof operations !== 'object' || operations === null) continue

    // Path-level parameters apply to every operation under it.
    const shared = Array.isArray((operations as { parameters?: unknown }).parameters)
      ? ((operations as { parameters: unknown[] }).parameters as Parameter[])
      : []

    for (const method of METHODS) {
      const operation = (operations as Record<string, unknown>)[method]
      if (typeof operation !== 'object' || operation === null) continue

      const op = operation as {
        operationId?: string
        parameters?: unknown[]
      }
      const params: Record<string, string | number | boolean> = {}
      let usable = true

      for (const raw of [...shared, ...(op.parameters ?? [])]) {
        const param = raw as Parameter
        if (param?.in !== 'path' && param?.in !== 'query') continue
        if (param.required !== true) continue
        if (typeof param.name !== 'string') continue
        const value = sampleFor(param.schema)
        if (value === undefined) {
          usable = false
          skipped.push({
            path,
            method,
            reason: `required ${param.in} parameter "${param.name}" has no derivable sample value`,
          })
          break
        }
        params[param.name] = value
      }

      if (!usable) continue

      const id = op.operationId ?? `${method}_${path.replace(/[^a-z0-9]+/gi, '_')}`
      probes.push({
        id,
        method: method.toUpperCase(),
        path,
        params,
        expect: {
          status: 200,
          body: { '$.status': { exists: true } },
        },
      })
    }
  }

  return { probes, skipped }
}

interface Parameter {
  name?: string
  in?: string
  required?: boolean
  schema?: { type?: string; format?: string; default?: unknown }
}

function sampleFor(schema: Parameter['schema']): string | number | boolean | undefined {
  if (!schema) return undefined
  if (schema.default !== undefined) return schema.default as string
  switch (schema.type) {
    case 'integer':
    case 'number':
      return 1
    case 'boolean':
      return true
    case 'string':
      // An id-shaped parameter gets an id-shaped value; a path template is
      // usually an identifier and a generic string may 404.
      return schema.format === 'uuid' ? '00000000-0000-4000-8000-000000000000' : 'test'
    default:
      return undefined
  }
}
