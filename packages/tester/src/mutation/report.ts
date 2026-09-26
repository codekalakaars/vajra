// Mutation report ingestion.
//
// A mutation tool is not reimplemented here. Stryker, mutmut, cargo-mut and
// others already insert seeded defects and report which survived; the useful
// work is interpreting the report, and interpreting it consistently is what
// decides whether the resulting number means anything.
//
// The one thing that must be right is the mapping from tool status to meaning.
// A mutant that no test executed is not the same as one a test ran and missed:
// the first means the code is untested, the second means the test is wrong.
// Collapsing them produces a score that looks reasonable and is not.

export type MutantStatus =
  | 'killed'
  | 'survived'
  | 'no_coverage'
  | 'timeout'
  | 'compile_error'
  | 'ignored'

export interface Mutant {
  id: string
  mutator: string
  file: string
  line?: number
  status: MutantStatus
  killedBy: string[]
}

export interface MutationReport {
  mutants: Mutant[]
  durationMs: number
  /** The tool that produced the report, for the audit log. */
  tool: string
}

const STRYKER_STATUS: Record<string, MutantStatus> = {
  Killed: 'killed',
  Survived: 'survived',
  NoCoverage: 'no_coverage',
  Timeout: 'timeout',
  CompileError: 'compile_error',
  Ignored: 'ignored',
  Pending: 'survived',
}

/**
 * Stryker's JSON report. The reference mutation tool for JavaScript and
 * TypeScript, and the shape most other tools are coerced into.
 */
export function parseStrykerReport(input: unknown): MutationReport | null {
  let json = input
  if (typeof input === 'string') {
    try {
      json = JSON.parse(input)
    } catch {
      return null
    }
  }
  if (typeof json !== 'object' || json === null) return null
  const raw = (json as { mutants?: unknown }).mutants
  if (!Array.isArray(raw)) return null

  const mutants: Mutant[] = raw.map((entry, index) => {
    const m = (entry ?? {}) as Record<string, any>
    const location = (m.location ?? {}) as Record<string, any>
    return {
      id: typeof m.id === 'string' ? m.id : `mutant-${index}`,
      mutator: String(m.mutatorName ?? m.mutator ?? 'unknown'),
      file: String(location.file ?? m.file ?? 'unknown'),
      ...(typeof location.start?.line === 'number' ? { line: location.start.line } : {}),
      status: STRYKER_STATUS[String(m.status)] ?? 'survived',
      killedBy: Array.isArray(m.killedBy) ? m.killedBy.map(String) : [],
    }
  })

  const duration = (json as { duration?: number }).duration
  return {
    mutants,
    durationMs: typeof duration === 'number' ? Math.round(duration) : 0,
    tool: 'stryker',
  }
}

/**
 * mutmut's JSON-lines output: one object per line, each carrying a path, a line
 * number and a status. Anything unrecognised is treated as survived, because
 * defaulting to killed would inflate the score.
 */
export function parseMutmutReport(input: string): MutationReport | null {
  const mutants: Mutant[] = []
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) continue
    let entry: any
    try {
      entry = JSON.parse(trimmed)
    } catch {
      continue
    }
    const path = entry.path ?? entry.file
    if (typeof path !== 'string') continue
    const status = String(entry.status ?? entry.status_code ?? 'survived')
    mutants.push({
      id: `${path}:${entry.line ?? mutants.length}`,
      mutator: String(entry.actual ?? entry.diff ?? 'substitution'),
      file: path,
      ...(typeof entry.line === 'number' ? { line: entry.line } : {}),
      status: /surviv/i.test(status) ? 'survived' : /killed/i.test(status) ? 'killed' : 'survived',
      killedBy: [],
    })
  }
  if (mutants.length === 0) return null
  return { mutants, durationMs: 0, tool: 'mutmut' }
}

/** A minimal shape for a project's own report: one line per mutant. */
export function parseSimpleReport(input: string): MutationReport | null {
  const mutants: Mutant[] = []
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 2) continue
    const [status, file, lineNo] = parts
    mutants.push({
      id: `${file}:${lineNo ?? mutants.length}`,
      mutator: 'unknown',
      file,
      ...(lineNo ? { line: Number(lineNo) } : {}),
      status: /kill/i.test(status) ? 'killed' : /nocov/i.test(status) ? 'no_coverage' : 'survived',
      killedBy: [],
    })
  }
  if (mutants.length === 0) return null
  return { mutants, durationMs: 0, tool: 'simple' }
}

export function parseMutationReport(
  input: string,
  format: 'stryker' | 'mutmut' | 'simple' | 'auto' = 'auto',
): MutationReport | null {
  if (format === 'stryker') return parseStrykerReport(input)
  if (format === 'mutmut') return parseMutmutReport(input)
  if (format === 'simple') return parseSimpleReport(input)

  const head = input.slice(0, 4096)
  if (head.trimStart().startsWith('{') || head.trimStart().startsWith('[')) {
    const stryker = parseStrykerReport(input)
    if (stryker) return stryker
    const mutmut = parseMutmutReport(input)
    if (mutmut) return mutmut
  }
  return parseSimpleReport(input)
}
