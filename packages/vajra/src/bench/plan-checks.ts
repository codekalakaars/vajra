import type { DeveloperPlan, PlannedTask } from '@codekalakaars/vajra-protocol'

/**
 * What a good plan for one request has to satisfy, as `expect.json` writes it.
 * Every key is optional except the size: a case checks only what it is about.
 */
export interface PlanExpectation {
  tasks: { min: number; max: number }
  /** Globs (`*` within a directory, `**` across them). Each must be written by some task. */
  mustWrite?: string[]
  /** `[first, second]`: the task writing `second` must come after the one writing `first`, directly or not. */
  before?: Array<[string, string]>
  /** Executables a verify command may use. */
  verifyCommands?: string[]
  /** Regular expressions that must not appear in what the plan tells a Worker to do or run. */
  forbidText?: string[]
  /** How many times the Developer may stop to ask. */
  maxQuestions?: number
}

export interface PlanCheck {
  name: string
  ok: boolean
  detail: string
}

/** What the run saw that the plan alone does not show. */
export interface PlanRunFacts {
  questions: number
  /** Where the Developer planned. An absolute path inside it is the project, not outside it. */
  projectDir?: string
}

const pass = (name: string, detail = ''): PlanCheck => ({ name, ok: true, detail })
const fail = (name: string, detail: string): PlanCheck => ({ name, ok: false, detail })

function globToRegExp(glob: string): RegExp {
  const source = glob
    .split('**')
    .map(part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*')
  return new RegExp(`^${source}$`)
}

/** Every path a task changes: written, edited, deleted, or a directory it creates. */
function pathsChanged(task: PlannedTask): string[] {
  return [
    ...task.writeFile,
    ...task.deleteFile,
    ...task.createDir,
    ...(task.edits ?? []).map(edit => edit.path),
  ]
}

/**
 * Not inside the project: absolute, a home path, a drive letter, or a `..` step.
 * A Developer may spell a verify command's working directory as the project's own
 * absolute path, and that is inside it.
 */
function leavesProject(path: string, projectDir?: string): boolean {
  if (path.split(/[\\/]/).includes('..')) return true
  if (projectDir && (path === projectDir || path.startsWith(`${projectDir}/`))) return false
  return /^([/~\\]|[A-Za-z]:)/.test(path)
}

/** Every task that must finish before `id` starts, however indirectly. */
function ancestors(tasks: readonly PlannedTask[], id: string): Set<string> {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const found = new Set<string>()
  const stack = [...(byId.get(id)?.dependsOn ?? [])]
  while (stack.length > 0) {
    const next = stack.pop() as string
    if (found.has(next)) continue
    found.add(next)
    stack.push(...(byId.get(next)?.dependsOn ?? []))
  }
  return found
}

/**
 * Sentences that forbid something are not instructions to do it: "never call
 * os.homedir()" is a plan obeying the rule a pattern is there to enforce.
 */
function withoutProhibitions(text: string): string {
  return text
    .split(/(?<=[.;!?])\s+|\n+/)
    .filter(sentence => !/\b(never|not|don't|no)\b/i.test(sentence))
    .join('\n')
}

/**
 * What the plan tells a Worker to do or run, as one string a pattern can be tried on.
 * The description is left out: it is where a plan explains why it did not do what
 * was asked, and that explanation would trip the very pattern it is about.
 */
function whatWorkersAreTold(task: PlannedTask): string {
  const prose = [...task.instructions, ...(task.edits ?? []).map(edit => edit.change)].map(withoutProhibitions)
  return [
    ...prose,
    ...(task.verify ?? []).flatMap(v => [v.command, ...v.args, v.cwd ?? '']),
    ...task.validation,
  ].join('\n')
}

/**
 * Judge an accepted plan against what its case expects. Pure: the plan and the
 * facts are all it looks at, so a plan can be checked without a model.
 *
 * "Grounded" and "measured" are read from what the harness stamped on the plan,
 * not from what the model claims: an edit's `anchorOccurrences` exists only when
 * the file was really read, and a verify's `baselineExit` only when the command
 * was really run.
 */
export function checkPlan(plan: DeveloperPlan, expect: PlanExpectation, facts: PlanRunFacts): PlanCheck[] {
  const tasks = plan.tasks
  const checks: PlanCheck[] = []

  checks.push(
    tasks.length >= expect.tasks.min && tasks.length <= expect.tasks.max
      ? pass('size', `${tasks.length} tasks`)
      : fail('size', `${tasks.length} tasks, expected ${expect.tasks.min}-${expect.tasks.max}`),
  )

  const outside = tasks.flatMap(task =>
    [...pathsChanged(task), ...task.readFile, ...(task.verify ?? []).flatMap(v => (v.cwd ? [v.cwd] : []))]
      .filter(path => leavesProject(path, facts.projectDir))
      .map(path => `${task.id}: ${path}`),
  )
  checks.push(
    outside.length === 0
      ? pass('scope', 'every path is inside the project')
      : fail('scope', `outside the project: ${outside.join(', ')}`),
  )

  if (expect.forbidText && expect.forbidText.length > 0) {
    const hits = tasks.flatMap(task =>
      expect.forbidText!.filter(pattern => new RegExp(pattern).test(whatWorkersAreTold(task))).map(pattern => `${task.id}: /${pattern}/`),
    )
    checks.push(
      hits.length === 0
        ? pass('no-forbidden-text')
        : fail('no-forbidden-text', `a Worker is told something out of scope: ${hits.join(', ')}`),
    )
  }

  const written = tasks.flatMap(task => pathsChanged(task))
  const missing = (expect.mustWrite ?? []).filter(glob => !written.some(path => globToRegExp(glob).test(path)))
  if (expect.mustWrite) {
    checks.push(
      missing.length === 0 ? pass('coverage') : fail('coverage', `nothing writes: ${missing.join(', ')}`),
    )
  }

  // A file another task creates has no text to anchor to when the plan is made: the
  // edit that changes it afterwards takes no anchor, and the Developer has nothing to read.
  const createdByPlan = new Set(tasks.flatMap(task => (task.edits ?? []).filter(edit => edit.op === 'create').map(edit => edit.path)))
  const ungrounded = tasks.flatMap(task =>
    (task.edits ?? [])
      .filter(edit => edit.op === 'modify' && !createdByPlan.has(edit.path) && edit.anchorOccurrences !== 1)
      .map(edit => `${task.id}: ${edit.path}`),
  )
  checks.push(
    ungrounded.length === 0
      ? pass('grounding', 'every edited file was read and its anchor found once')
      : fail('grounding', `edits not tied to a file the Developer read: ${ungrounded.join(', ')}`),
  )

  const allowed = expect.verifyCommands
  const verifies = tasks.flatMap(task => (task.verify ?? []).map(v => ({ task: task.id, v })))
  const unmeasured = verifies.filter(({ v }) => v.baselineExit === undefined).map(({ task, v }) => `${task}: ${v.command} ${v.args.join(' ')}`)
  const unchecked = tasks.filter(task => (task.verify ?? []).length === 0).map(task => task.id)
  const disallowed = allowed ? verifies.filter(({ v }) => !allowed.includes(v.command)).map(({ task, v }) => `${task}: ${v.command}`) : []
  const problems = [
    ...(unchecked.length > 0 ? [`no verify command: ${unchecked.join(', ')}`] : []),
    ...(unmeasured.length > 0 ? [`never run: ${unmeasured.join('; ')}`] : []),
    ...(disallowed.length > 0 ? [`not an allowed command: ${disallowed.join(', ')}`] : []),
  ]
  checks.push(problems.length === 0 ? pass('verify', `${verifies.length} commands, all measured`) : fail('verify', problems.join(' | ')))

  const ids = new Set(tasks.map(task => task.id))
  const unknown = tasks.flatMap(task => task.dependsOn.filter(dep => !ids.has(dep)).map(dep => `${task.id} -> ${dep}`))
  const cyclic = tasks.filter(task => ancestors(tasks, task.id).has(task.id)).map(task => task.id)
  const order = (expect.before ?? []).flatMap(([first, second]) => {
    const firsts = tasks.filter(task => pathsChanged(task).some(path => globToRegExp(first).test(path)))
    const seconds = tasks.filter(task => pathsChanged(task).some(path => globToRegExp(second).test(path)))
    // A pair is only checked when both sides exist; a missing side is `coverage`'s to report.
    if (firsts.length === 0 || seconds.length === 0) return []
    const wrong = seconds.filter(s => !firsts.some(f => f.id === s.id || ancestors(tasks, s.id).has(f.id)))
    return wrong.map(s => `${s.id} (${second}) does not wait for ${first}`)
  })
  const graph = [
    ...(unknown.length > 0 ? [`unknown dependency: ${unknown.join(', ')}`] : []),
    ...(cyclic.length > 0 ? [`cycle through: ${cyclic.join(', ')}`] : []),
    ...order,
  ]
  checks.push(graph.length === 0 ? pass('dependencies') : fail('dependencies', graph.join(' | ')))

  if (expect.maxQuestions !== undefined) {
    checks.push(
      facts.questions <= expect.maxQuestions
        ? pass('questions', `${facts.questions} asked`)
        : fail('questions', `${facts.questions} asked, at most ${expect.maxQuestions}`),
    )
  }

  return checks
}

/** Reading `expect.json`: by hand, with the key named when it is wrong. */
export function parseExpectation(raw: unknown, where: string): PlanExpectation {
  const bad = (what: string): never => {
    throw new Error(`${where}: ${what}`)
  }
  if (typeof raw !== 'object' || raw === null) return bad('expected an object')
  const o = raw as Record<string, unknown>
  const strings = (key: string): string[] | undefined => {
    if (o[key] === undefined) return undefined
    const v = o[key]
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) return bad(`'${key}' must be an array of strings`)
    return v as string[]
  }
  const size = o.tasks as { min?: unknown; max?: unknown } | undefined
  if (!size || typeof size.min !== 'number' || typeof size.max !== 'number' || size.min > size.max) {
    return bad("'tasks' must be { min, max } with min <= max")
  }
  const before = o.before
  if (before !== undefined) {
    const ok = Array.isArray(before) && before.every(p => Array.isArray(p) && p.length === 2 && p.every(x => typeof x === 'string'))
    if (!ok) return bad("'before' must be an array of [first, second] glob pairs")
  }
  if (o.maxQuestions !== undefined && typeof o.maxQuestions !== 'number') return bad("'maxQuestions' must be a number")
  for (const pattern of strings('forbidText') ?? []) {
    try {
      new RegExp(pattern)
    } catch {
      return bad(`'forbidText' has an invalid pattern: ${pattern}`)
    }
  }
  const mustWrite = strings('mustWrite')
  const verifyCommands = strings('verifyCommands')
  const forbidText = strings('forbidText')
  return {
    tasks: { min: size.min, max: size.max },
    ...(mustWrite ? { mustWrite } : {}),
    ...(before ? { before: before as Array<[string, string]> } : {}),
    ...(verifyCommands ? { verifyCommands } : {}),
    ...(forbidText ? { forbidText } : {}),
    ...(o.maxQuestions !== undefined ? { maxQuestions: o.maxQuestions as number } : {}),
  }
}
