// Pure plan validation — no filesystem access, so this module stays loadable
// in browser bundles (see the constraint at the top of tools.ts). Everything
// the model asserts is checked against evidence the harness collected.

import type { PlanContract, PlannedTaskInput } from './tools.js'

export interface PlanEvidence {
  filesRead: ReadonlyMap<string, string>
  baselines: ReadonlyMap<string, number>
}

export type PlanValidation = { ok: true } | { ok: false; errors: string[] }

const SHELL_METACHARS = /[&|;<>`$(){}[\]!*?~\n]/

function canonicalPlanPath(path: string, baseDir?: string): string {
  const slashPath = path.replace(/\\/g, '/')
  const driveAbsolute = /^[A-Za-z]:\//.test(slashPath)
  const absolute = slashPath.startsWith('/') || driveAbsolute
  const rootParts = driveAbsolute ? 1 : 0
  const parts: string[] = []
  for (const part of slashPath.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length > rootParts && parts[parts.length - 1] !== '..') parts.pop()
      else if (!absolute) parts.push(part)
      continue
    }
    parts.push(part)
  }
  const result = driveAbsolute
    ? parts.join('/')
    : absolute
      ? `/${parts.join('/')}`
      : parts.join('/') || '.'
  if (!baseDir || !absolute) return result

  const base = canonicalPlanPath(baseDir)
  const comparableBase = /^[A-Za-z]:\//i.test(base) ? base.toLowerCase() : base
  const comparableResult = /^[A-Za-z]:\//i.test(result) ? result.toLowerCase() : result
  if (comparableResult === comparableBase) return '.'
  if (comparableResult.startsWith(`${comparableBase}/`)) {
    return result.slice(base.length + 1)
  }
  return result
}

/**
 * Paths a task may reference without having read them: files created by a task
 * it transitively depends on. Without this, a plan that creates a file in task A
 * and edits it in task B is rejected — B cannot have read a file that does not
 * exist yet.
 */
function createdByDependencies(
  task: PlannedTaskInput,
  byId: ReadonlyMap<string, PlannedTaskInput>,
  baseDir?: string,
): Set<string> {
  const paths = new Set<string>()
  const seen = new Set<string>()
  const queue = [...(task.dependsOn ?? [])]

  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)

    const dep = byId.get(id)
    if (!dep) continue

    for (const edit of dep.edits ?? []) {
      if (edit.op === 'create') paths.add(canonicalPlanPath(edit.path, baseDir))
    }
    queue.push(...(dep.dependsOn ?? []))
  }

  return paths
}

export function writeSetOf(task: PlannedTaskInput, baseDir?: string): Set<string> {
  return new Set([
    ...(task.edits ?? []).map((edit) => canonicalPlanPath(edit.path, baseDir)),
    ...(task.writeFile ?? []).map(path => canonicalPlanPath(path, baseDir)),
    ...(task.deleteFile ?? []).map(path => canonicalPlanPath(path, baseDir)),
    ...(task.createDir ?? []).map(path => canonicalPlanPath(path, baseDir)),
  ])
}

function readSetOf(task: PlannedTaskInput, baseDir?: string): Set<string> {
  return new Set([
    ...(task.context ?? []).map((ref) => canonicalPlanPath(ref.path, baseDir)),
    ...(task.readFile ?? []).map(path => canonicalPlanPath(path, baseDir)),
  ])
}

export interface ParallelPlan {
  /** Task ids by wave. Every task within a wave may run concurrently. */
  waves: string[][]
  /** Hard violations of §7.1. */
  errors: string[]
  /** Advisory — see §7.4. */
  warnings: string[]
}

/**
 * Group tasks into waves by dependency depth, then verify that everything
 * sharing a wave is genuinely independent.
 */
export function planParallel(
  tasks: readonly PlannedTaskInput[],
  baseDir?: string,
): ParallelPlan {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const placed = new Set<string>()
  const waves: string[][] = []
  const errors: string[] = []

  while (placed.size < tasks.length) {
    const wave = tasks
      .filter((t) => !placed.has(t.id) && (t.dependsOn ?? []).every((d) => placed.has(d)))
      .map((t) => t.id)

    if (wave.length === 0) {
      // A cycle, or a dependency on an id that does not exist. validatePlan
      // reports the cause; emit the remainder so the caller sees every task.
      waves.push(tasks.filter((t) => !placed.has(t.id)).map((t) => t.id))
      break
    }

    for (const id of wave) placed.add(id)
    waves.push(wave)
  }

  for (const wave of waves) {
    for (let i = 0; i < wave.length; i++) {
      for (let j = i + 1; j < wave.length; j++) {
        const a = byId.get(wave[i])!
        const b = byId.get(wave[j])!
        const aWrites = writeSetOf(a, baseDir)
        const bWrites = writeSetOf(b, baseDir)
        const aReads = readSetOf(a, baseDir)
        const bReads = readSetOf(b, baseDir)

        // write/write — they would clobber each other
        for (const path of aWrites) {
          if (bWrites.has(path)) {
            errors.push(
              `Tasks '${a.id}' and '${b.id}' both edit '${path}' and have no ordering ` +
                `between them. Add dependsOn to one, or merge them into a single task.`,
            )
          }
        }

        // read/write — the reader may observe a half-written file
        for (const path of bReads) {
          if (aWrites.has(path)) {
            errors.push(
              `Task '${b.id}' reads '${path}' while '${a.id}' edits it, with no ` +
                `ordering between them. Add '${a.id}' to '${b.id}'.dependsOn.`,
            )
          }
        }
        for (const path of aReads) {
          if (bWrites.has(path)) {
            errors.push(
              `Task '${a.id}' reads '${path}' while '${b.id}' edits it, with no ` +
                `ordering between them. Add '${b.id}' to '${a.id}'.dependsOn.`,
            )
          }
        }
      }
    }
  }

  return { waves, errors, warnings: contentionWarnings(tasks, baseDir) }
}

const CONTENTION_THRESHOLD = 3

function contentionWarnings(tasks: readonly PlannedTaskInput[], baseDir?: string): string[] {
  const perPath = new Map<string, string[]>()
  for (const task of tasks) {
    for (const path of writeSetOf(task, baseDir)) {
      perPath.set(path, [...(perPath.get(path) ?? []), task.id])
    }
  }

  const warnings: string[] = []
  for (const [path, ids] of perPath) {
    if (ids.length >= CONTENTION_THRESHOLD) {
      warnings.push(
        `${ids.length} tasks edit '${path}' (${ids.join(', ')}), so they must run ` +
          `in sequence. Consider a first task that splits the file along its ` +
          `existing boundaries — no behaviour change — so the rest can proceed ` +
          `in parallel.`,
      )
    }
  }
  return warnings
}

/**
 * Validate a proposed plan against evidence the harness collected.
 * Errors are phrased as instructions to the model — they are fed back as a
 * tool result so it can correct the plan and retry.
 */
export function validatePlan(
  tasks: readonly PlannedTaskInput[],
  evidence: PlanEvidence,
  baseDir?: string,
): PlanValidation {
  const errors: string[] = []
  const ids = new Set(tasks.map((t) => t.id))
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const filesRead = new Map(
    [...evidence.filesRead].map(([path, content]) => [canonicalPlanPath(path, baseDir), content]),
  )

  for (const task of tasks) {
    const where = `Task '${task.id}'`
    const willExist = createdByDependencies(task, byId, baseDir)
    /** A path is available if it was read, or a dependency creates it. */
    const available = (path: string) => filesRead.has(canonicalPlanPath(path, baseDir)) || willExist.has(canonicalPlanPath(path, baseDir))

    // --- dependencies -----------------------------------------------------
    for (const dep of task.dependsOn ?? []) {
      if (!ids.has(dep)) {
        errors.push(`${where} depends on unknown task id '${dep}'.`)
      }
      if (dep === task.id) {
        errors.push(`${where} depends on itself.`)
      }
    }

    // --- context ----------------------------------------------------------
    for (const ref of task.context ?? []) {
      if (!available(ref.path)) {
        errors.push(
          `${where} lists '${ref.path}' as context, but you never read it. ` +
            `Call read_file on it first, or remove it.`,
        )
      }
      if (!ref.reason?.trim()) {
        errors.push(`${where} gives no reason for reading '${ref.path}'.`)
      }
    }

    // --- edits ------------------------------------------------------------
    if (!task.edits || task.edits.length === 0) {
      errors.push(`${where} has no edits. Every task must change at least one file.`)
    }

    for (const edit of task.edits ?? []) {
      const content = filesRead.get(canonicalPlanPath(edit.path, baseDir))

      if (edit.op === 'create') {
        if (content !== undefined) {
          errors.push(
            `${where} wants to create '${edit.path}', but that file already exists. ` +
              `Use op: 'modify' with an anchor.`,
          )
        } else if (willExist.has(canonicalPlanPath(edit.path, baseDir))) {
          errors.push(
            `${where} creates '${edit.path}', but a task it depends on already creates it. ` +
              `Use op: 'modify' here.`,
          )
        }
        continue
      }

      if (content === undefined) {
        // A dependency creates it, so there is nothing to anchor against yet.
        if (willExist.has(canonicalPlanPath(edit.path, baseDir))) continue
        errors.push(
          `${where} edits '${edit.path}', but you never read it. ` +
            `Call read_file on it before proposing an edit.`,
        )
        continue
      }

      if (edit.op === 'modify') {
        if (!edit.anchor?.trim()) {
          errors.push(
            `${where} modifies '${edit.path}' with no anchor. ` +
              `Supply the exact text, copied verbatim from the file, where the change goes.`,
          )
          continue
        }
        const occurrences = content.split(edit.anchor).length - 1
        if (occurrences === 0) {
          errors.push(
            `${where}: anchor for '${edit.path}' does not appear in the file. ` +
              `Copy it verbatim — whitespace and indentation must match.`,
          )
        } else if (occurrences > 1) {
          errors.push(
            `${where}: anchor for '${edit.path}' appears ${occurrences} times and must be unique. ` +
              `Extend it with surrounding lines until it identifies one site.`,
          )
        }
      }
    }

    // --- verify -----------------------------------------------------------
    const verify = task.verify ?? []
    if (verify.length === 0) {
      errors.push(
        `${where} has no verify commands. Give at least one kind=proves-change ` +
          `command that fails now and passes once the task is done.`,
      )
    }
    if (verify.length > 0 && !verify.some((v) => v.kind === 'proves-change')) {
      errors.push(
        `${where} has only regression-guard checks. Add one kind=proves-change ` +
          `command that demonstrates this specific task worked.`,
      )
    }

    verify.forEach((v, i) => {
      if (SHELL_METACHARS.test(v.command) || v.args.some((a) => SHELL_METACHARS.test(a))) {
        errors.push(
          `${where}: verify[${i}] contains shell syntax. Commands run without a shell — ` +
            `split it into separate verify entries.`,
        )
      }

      const baseline = evidence.baselines.get(`${task.id}#${i}`)
      if (baseline === undefined) {
        errors.push(
          `${where}: verify[${i}] ('${v.command} ${v.args.join(' ')}') was never run. ` +
            `Call run_baseline on it before proposing it.`,
        )
        return
      }

      const expected = v.expectExit ?? 0
      if (v.kind === 'proves-change' && baseline === expected) {
        errors.push(
          `${where}: verify[${i}] already passes before any change, so it cannot ` +
            `prove this task worked. Use a command that fails now, or mark it ` +
            `kind=regression-guard.`,
        )
      }
      if (v.kind === 'regression-guard' && baseline !== expected) {
        errors.push(
          `${where}: verify[${i}] is a regression-guard but already fails ` +
            `(exit ${baseline}). Fix it in an earlier task or drop it.`,
        )
      }
    })
  }

  errors.push(...planParallel(tasks, baseDir).errors)

  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

export interface ContractCheck {
  errors: string[]
  warnings: string[]
}

const BANNED_PHRASES = /as discussed|the above|as described/i
const MIN_STATEMENT_LENGTH = 40
const IDENTIFIER_RE = /\b[A-Za-z_][A-Za-z0-9_]*\b/g

function isIdentifier(token: string): boolean {
  if (token.length < 4) return false
  if (token.includes('_')) return true
  if (/[A-Z]/.test(token.slice(1))) return true
  if (/^[A-Z][A-Z0-9]+$/.test(token)) return true
  return false
}

function identifiersOf(task: PlannedTaskInput): Set<string> {
  const found = new Set<string>()
  for (const edit of task.edits ?? []) {
    for (const match of edit.change.matchAll(IDENTIFIER_RE)) {
      if (isIdentifier(match[0])) found.add(match[0])
    }
  }
  return found
}

/**
 * Check contract coherence — ids exist, consumers run after the producer, and
 * each statement can be read cold. Whether a contract is *needed* is a
 * semantic judgement no static check can make, so candidates are surfaced as
 * warnings instead (§7.3).
 */
export function validateContracts(
  tasks: readonly PlannedTaskInput[],
  contracts: readonly PlanContract[] | undefined,
): ContractCheck {
  const errors: string[] = []
  const warnings: string[] = []
  const byId = new Map(tasks.map((t) => [t.id, t]))

  const dependsOnTransitively = (from: string, target: string): boolean => {
    const seen = new Set<string>()
    const queue = [...(byId.get(from)?.dependsOn ?? [])]
    while (queue.length > 0) {
      const id = queue.shift()!
      if (id === target) return true
      if (seen.has(id)) continue
      seen.add(id)
      queue.push(...(byId.get(id)?.dependsOn ?? []))
    }
    return false
  }

  for (const contract of contracts ?? []) {
    const where = `Contract '${contract.id}'`
    const exists = (id: string) => byId.has(id)

    if (!exists(contract.producedBy)) {
      errors.push(`${where} is produced by unknown task '${contract.producedBy}'.`)
    }
    for (const consumer of contract.consumedBy) {
      if (!exists(consumer)) {
        errors.push(`${where} is consumed by unknown task '${consumer}'.`)
      }
      if (consumer === contract.producedBy) {
        errors.push(
          `${where} is produced by '${contract.producedBy}', which also appears in ` +
            `its own consumedBy. A producer cannot consume its own contract.`,
        )
        continue
      }
      if (exists(consumer) && exists(contract.producedBy) && !dependsOnTransitively(consumer, contract.producedBy)) {
        errors.push(
          `${where}: consumer '${consumer}' does not depend on producer ` +
            `'${contract.producedBy}' (directly or transitively). A task that runs ` +
            `first cannot honour the contract — add it to '${consumer}'.dependsOn.`,
        )
      }
    }

    if (contract.statement.trim().length < MIN_STATEMENT_LENGTH) {
      errors.push(
        `${where} statement is only ${contract.statement.trim().length} characters. ` +
          `Write the decision out in full so an implementer can follow it with no ` +
          `other context.`,
      )
    }
    if (BANNED_PHRASES.test(contract.statement)) {
      errors.push(
        `${where} statement contains a back-reference ("as discussed", "the above", ` +
          `"as described"). Assume the reader has seen nothing else — restate it.`,
      )
    }
  }

  const contractMembers = (contracts ?? []).map((c) => new Set([c.producedBy, ...c.consumedBy]))
  const shareContract = (a: string, b: string) =>
    contractMembers.some((members) => members.has(a) && members.has(b))

  const waves = planParallel(tasks).waves
  for (const wave of waves) {
    for (let i = 0; i < wave.length; i++) {
      for (let j = i + 1; j < wave.length; j++) {
        const a = byId.get(wave[i])!
        const b = byId.get(wave[j])!
        if (shareContract(a.id, b.id)) continue
        const shared = [...identifiersOf(a)].filter((name) => identifiersOf(b).has(name))
        for (const name of shared) {
          warnings.push(
            `Tasks '${a.id}' and '${b.id}' both mention '${name}' but share no ` +
              `contract — is there an interface decision to pin down?`,
          )
        }
      }
    }
  }

  return { errors, warnings }
}
