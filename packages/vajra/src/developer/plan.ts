import type {
  DeveloperPlan,
  EditSpec,
  PlanContract,
  
  PlannedTask,
  PlannedTaskInput
} from '@codekalakaars/vajra-protocol'
import {
  planParallel
} from '@codekalakaars/vajra-protocol'

export type ParsePlanResult =
  | { ok: true; plan: DeveloperPlan }
  | { ok: false; error: string }

function describeEdit(edit: EditSpec): string {
  if (edit.op === 'create') return `Create ${edit.path}: ${edit.change}`
  if (edit.op === 'delete') return `Delete ${edit.path}: ${edit.change}`
  return edit.anchor
    ? `In ${edit.path}, at the text \`${edit.anchor}\`: ${edit.change}`
    : `In ${edit.path}: ${edit.change}`
}

/**
 * Lower a task with structured `context`/`edits`/`verify` to the flat fields
 * the current executor consumes (§8). Structured fields, when present,
 * supersede the flat ones; a task that omits them passes through unchanged.
 */
function lower(task: PlannedTask): PlannedTask {
  const context = task.context ?? []
  const edits = task.edits ?? []

  return {
    ...task,
    readFile: context.length ? context.map((c) => c.path) : task.readFile,
    writeFile: edits.length
      ? edits.filter((e) => e.op !== 'delete').map((e) => e.path)
      : task.writeFile,
    deleteFile: edits.length
      ? edits.filter((e) => e.op === 'delete').map((e) => e.path)
      : task.deleteFile,
    instructions: edits.length ? edits.map(describeEdit) : task.instructions,
    validation: task.verify?.length
      ? task.verify.map((v) => [v.command, ...(v.args ?? [])].join(' '))
      : task.validation,
  }
}

/**
 * Parse and validate `propose_plan` arguments (E1).
 * - Requires model-supplied unique task `id`s (falls back to `task-N` only when absent).
 * - Unknown `dependsOn` ids are a tool error (not silently filtered).
 */
export function parseProposePlanArgs(raw: unknown, projectDir?: string): ParsePlanResult {
  const args = raw as {
    tasks?: Array<{
      id?: string
      title: string
      description: string
      context?: PlannedTaskInput['context']
      edits?: PlannedTaskInput['edits']
      verify?: PlannedTaskInput['verify']
      instructions?: string[]
      readFile?: string[]
      writeFile?: string[]
      deleteFile?: string[]
      createDir?: string[]
      validation?: string[] | string
      dependsOn?: string[]
      type?: string
      complexity?: string
      validationStrategy?: string
      alternativeApproaches?: string[]
      estimatedDuration?: string
      allowedTools?: string[]
      timeoutSeconds?: number
      retries?: number
      rollback?: string[]
      skipIf?: string[]
      successCriteria?: string[]
      notes?: string
    }>
    summary: string
    contracts?: PlanContract[]
  }

  if (!Array.isArray(args?.tasks) || args.tasks.length === 0) {
    return { ok: false, error: 'Plan has no tasks. Please propose a plan with at least one task.' }
  }

  const tasks: PlannedTask[] = args.tasks.map((t, i) => lower({
    id: t.id?.trim() || `task-${i + 1}`,
    title: t.title,
    description: t.description,
    context: t.context,
    edits: t.edits,
    verify: t.verify,
    instructions: t.instructions ?? [],
    readFile: t.readFile ?? [],
    writeFile: t.writeFile ?? [],
    deleteFile: t.deleteFile ?? [],
    createDir: t.createDir ?? [],
    validation: Array.isArray(t.validation) ? t.validation : t.validation ? [t.validation] : [],
    dependsOn: t.dependsOn ?? [],
    type: (['create', 'modify', 'delete', 'refactor'].includes(t.type ?? '') ? t.type : 'modify') as PlannedTask['type'],
    complexity: (['low', 'medium', 'high'].includes(t.complexity ?? '') ? t.complexity : 'medium') as PlannedTask['complexity'],
    validationStrategy: (['hierarchical', 'incremental', 'contextAware'].includes(t.validationStrategy ?? '')
      ? t.validationStrategy
      : 'hierarchical') as PlannedTask['validationStrategy'],
    alternativeApproaches: t.alternativeApproaches ?? [],
    estimatedDuration: t.estimatedDuration ? parseInt(t.estimatedDuration, 10) : undefined,
    allowedTools: t.allowedTools,
    timeoutSeconds: t.timeoutSeconds,
    retries: t.retries,
    rollback: t.rollback,
    skipIf: t.skipIf,
    ...(Array.isArray(t.successCriteria) ? { successCriteria: t.successCriteria.map(String) } : {}),
    ...(typeof t.notes === 'string' && t.notes.trim() ? { notes: t.notes.trim() } : {}),
  }))

  const seen = new Set<string>()
  for (const task of tasks) {
    if (seen.has(task.id)) {
      return { ok: false, error: `Duplicate task id '${task.id}'. Every task must have a unique id.` }
    }
    seen.add(task.id)
  }

  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!seen.has(dep)) {
        return {
          ok: false,
          error: `Task '${task.id}' depends on unknown task '${dep}'. Only reference ids defined in this plan.`,
        }
      }
    }
  }

  const parallel = planParallel(tasks, projectDir)
  if (parallel.errors.length > 0) {
    return {
      ok: false,
      error: `Plan rejected:\n- ${parallel.errors.join('\n- ')}`,
    }
  }

  return {
    ok: true,
    plan: {
      tasks,
      independentGroups: parallel.waves,
      estimatedWorkers: Math.max(1, ...parallel.waves.map(g => g.length)),
      // Carried, not just validated: a contract only helps if the tasks it
      // names see it.
      ...(Array.isArray(args.contracts) && args.contracts.length > 0 ? { contracts: args.contracts } : {}),
    },
  }
}
