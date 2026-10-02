import {
  readFileSync,
  readdirSync
} from 'node:fs'
import { join, sep } from 'node:path'
import { type PlannedTaskInput } from '@codekalakaars/vajra-protocol'

/** How a suite's acceptance tests are run, after the run has finished. */
export interface BenchAcceptance {
  /** Executable, resolved against PATH. No shell: argv only. */
  command: string
  args?: string[]
  timeoutMs?: number
}

/** `plan.json`: the plan, plus how to check the run's result. */
export interface BenchSuitePlan {
  summary?: string
  acceptance: BenchAcceptance
  tasks: PlannedTaskInput[]
}

/** A setup error: the run never started, so it is exit 2 and not a failed run. */
export class BenchSetupError extends Error {}

export function setup(message: string): never {
  throw new BenchSetupError(message)
}

// --- the suite on disk -----------------------------------------------------

function readJson(file: string, what: string): unknown {
  let text: string
  try {
    text = readFileSync(file, 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return setup(
      code === 'ENOENT'
        ? `${what} is missing: ${file}`
        : `${what} cannot be read: ${file} (${code ?? 'unknown error'})`,
    )
  }
  try {
    return JSON.parse(text)
  } catch (err) {
    return setup(`${what} is not valid JSON: ${file} (${err instanceof Error ? err.message : String(err)})`)
  }
}

function parseAcceptance(raw: unknown, file: string): BenchAcceptance {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return setup(`${file}: 'acceptance' is required, as { "command": "node", "args": ["--test"] }`)
  }
  const value = raw as Record<string, unknown>
  const command = value.command
  if (typeof command !== 'string' || !command.trim()) {
    return setup(`${file}: 'acceptance.command' is required and must be a non-empty string`)
  }
  const args = value.args ?? []
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
    return setup(`${file}: 'acceptance.args' must be an array of strings`)
  }
  const timeoutMs = value.timeoutMs
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    return setup(`${file}: 'acceptance.timeoutMs' must be a positive number of milliseconds`)
  }
  return {
    command: command.trim(),
    args: args as string[],
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
  }
}

export function parseSuitePlan(file: string): BenchSuitePlan {
  const raw = readJson(file, 'plan.json') as Record<string, unknown>
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    return setup(`${file}: 'tasks' is required and must be a non-empty array`)
  }
  return {
    ...(typeof raw.summary === 'string' ? { summary: raw.summary } : {}),
    acceptance: parseAcceptance(raw.acceptance, file),
    tasks: raw.tasks as PlannedTaskInput[],
  }
}

// --- evidence --------------------------------------------------------------

/** Never worth walking, and never worth validating an edit against. */
const SKIP_DIRS = new Set(['node_modules', '.git'])

function projectRelative(projectDir: string, path: string): string {
  return path.slice(projectDir.length + 1).split(sep).join('/')
}

/**
 * What the plan may claim to know: every file in the working copy, with its
 * content.
 *
 * A suite's plan is written by hand, so nothing has been read by a Developer
 * turn. Reading the fixture here is what makes `validatePlan` mean something —
 * an edit with an anchor that does not appear in the file is still an error.
 */
export function readFixture(projectDir: string): Map<string, string> {
  const files = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const full = join(dir, entry.name)
      try {
        files.set(projectRelative(projectDir, full), readFileSync(full, 'utf-8'))
      } catch {
        // Not text, or unreadable: the plan cannot anchor against it either.
      }
    }
  }
  walk(projectDir)
  return files
}
