import type {
  DeveloperPlan,
  PlannedTaskInput,
  ToolName
} from '@codekalakaars/vajra-protocol'
import {
  planParallel,
  proposePlanTool,
  validateContracts,
  validatePlan
} from '@codekalakaars/vajra-protocol'
import { streamChatCompletion, type ChatMessage, type ReasoningEffort, type ToolCall } from '../model/chat.js'
import { getModelLimit } from '../model/context-window.js'
import { getDeveloperToolSpecs, parseToolCall } from '@codekalakaars/vajra-sandbox'
import {
  searchSummary,
  type LaunchHandle,
  type SummaryEntry
} from '@codekalakaars/vajra-sandbox'
import {
  startHeartbeat,
  summarizePlanTaskCount,
  summarizeToolCall,
  summarizeToolResult,
  type AgentEvent
} from '../manager/ui.js'
import { dispatchToolCall, loopHooks, READ_ONLY_TOOLS } from '../model/tool-dispatch.js'

import { compressMessages } from '../model/compress.js'
import { buildDeveloperConversationPrompt } from './prompt.js'
import { parseProposePlanArgs } from './plan.js'
import { MAX_PLAN_TASKS, baselineKey, buildEvidence, enrichHarnessEvidence, measuredBaselines, planShape, rejectPlan } from './review.js'
import { buildInitialPromptContext } from './context.js'
import { createEvidenceLedger, type PlanEvidenceLedger } from './evidence.js'

/**
 * A confined agent, as the Developer consumes it. Declared by `@codekalakaars/vajra-sandbox`, which owns what
 * a confined agent is and spawns them; re-exported so the Developer's consumers need not know which package forks.
 */
export type { LaunchHandle } from '@codekalakaars/vajra-sandbox'

// The Developer's public surface: the entry point is this file, whichever file defines a name.
export { parseProposePlanArgs, type ParsePlanResult } from './plan.js'
export { MAX_PLAN_TASKS, measuredBaselines, planShape } from './review.js'
export { buildInitialPromptContext, type InitialPromptContext } from './context.js'
export { createEvidenceLedger, resetEvidenceLedger, type PlanEvidenceLedger } from './evidence.js'

export interface DeveloperTurnInput {
  sessionId: string
  projectDir: string
  userMessage: string
  model: string
  apiKey: string
  /** Omitted from the wire when 'off'. */
  reasoningEffort?: ReasoningEffort
  handle: LaunchHandle
  messages: ChatMessage[]
  summaryIndex: SummaryEntry[]
  /**
   * Evidence carried between turns of one planning conversation. Omit it and
   * the turn keeps its own, which cannot survive a rejected plan.
   */
  evidence?: PlanEvidenceLedger
  onTextDelta?: (text: string) => void
  onThinkingDelta?: (text: string) => void
  isInterrupted?: () => boolean
  signal?: AbortSignal
  /** Sub-task progress for the UI port. Observability only. */
  onAgentEvent?: (event: AgentEvent) => void
}

export type DeveloperTurnResult =
  | { type: 'response'; response: string }
  | { type: 'plan'; plan: DeveloperPlan }

export async function developerConversationTurn(
  input: DeveloperTurnInput,
): Promise<DeveloperTurnResult> {
  const { sessionId, projectDir, userMessage, model, apiKey, reasoningEffort, handle, messages, summaryIndex, onTextDelta, onThinkingDelta, isInterrupted, signal, onAgentEvent } = input

  const agent = { role: 'developer' } as const
  const emit = (event: AgentEvent): void => onAgentEvent?.(event)
  const emitToolEnd = (
    callId: string,
    tool: string,
    ok: boolean,
    startedAt: number,
    detail?: string,
  ): void => {
    emit({
      type: 'tool-end',
      agent,
      callId,
      tool,
      ok,
      ms: Date.now() - startedAt,
      ...(detail === undefined ? {} : { detail }),
    })
  }

  type Precomputed = { content: string; raw: unknown; ms: number; ok: boolean; detail?: string }

  /**
   * Run this message's read-only tool calls concurrently, keyed by call id.
   * Returns empty when there is nothing to gain (zero or one call), so the
   * common path is unchanged.
   */
  const runReadOnlyCalls = async (
    toolCalls: ToolCall[],
  ): Promise<Map<string, Precomputed>> => {
    const out = new Map<string, Precomputed>()
    const readOnly = toolCalls.filter(tc => READ_ONLY_TOOLS.has(tc.function.name))
    if (readOnly.length < 2) return out

    for (const toolCall of readOnly) {
      const toolName = toolCall.function.name
      let callArgs: unknown
      try {
        callArgs = JSON.parse(toolCall.function.arguments)
      } catch {
        callArgs = undefined
      }
      emit({
        type: 'tool-start',
        agent,
        callId: toolCall.id,
        tool: toolName,
        summary: summarizeToolCall(toolName, callArgs, projectDir),
      })
    }

    const settled = await Promise.all(
      readOnly.map(async (toolCall): Promise<[string, Precomputed]> => {
        const started = Date.now()
        const toolName = toolCall.function.name
        const parsed = parseToolCall(toolCall)
        let content: string
        let raw: unknown
        if (!parsed.ok) {
          content = `Error: ${parsed.error}`
          raw = content
        } else if (parsed.call.tool === ('search_files' as ToolName)) {
          const args = parsed.call.args as { query: string }
          content = searchSummary(summaryIndex, args.query)
          raw = content
        } else {
          // A tool call can block for minutes; keep the row moving meanwhile.
          const stopHeartbeat = startHeartbeat(emit, agent)
          try {
            const result = await handle.callTool(parsed.call.tool, parsed.call.args)
            content = typeof result === 'string' ? result : JSON.stringify(result)
            raw = result
          } catch (e) {
            content = `Error: ${e instanceof Error ? e.message : String(e)}`
            raw = content
          } finally {
            stopHeartbeat()
          }
        }
        const ms = Date.now() - started
        const outcome = summarizeToolResult(
          parsed.ok ? parsed.call.tool : toolName,
          parsed.ok ? parsed.call.args : undefined,
          raw,
          ms,
        )
        return [toolCall.id, { content, raw, ms, ok: outcome.ok, detail: outcome.detail }]
      }),
    )
    for (const [id, value] of settled) out.set(id, value)
    return out
  }

  /**
   * One mutating (or single) tool call, end to end. Returns the content to
   * append as its result. Read-only calls arrive pre-computed from
   * `runReadOnlyCalls` and never reach here.
   */
  /**
   * What a tool call proves.
   *
   * The Developer's plan is only as good as what it actually looked at, so a
   * read and a baseline it measured both
   * update the ledger the plan validator checks against. This used to be inlined
   * in the tool executor; it lives here so the engine can own the dispatch
   * sequence without owning the role's evidence rules.
   */
  const recordEvidence = (tool: string, args: unknown, result: unknown): void => {
    if (tool === 'read_file' && typeof result === 'string') {
      const readArgs = args as { path?: unknown }
      if (typeof readArgs.path === 'string') filesRead.set(readArgs.path, result)
    } else if (tool === 'run_baseline' && typeof result === 'string') {
      recordBaseline(result, args)
    }
  }

  const runToolCall = async (toolCall: ToolCall, callStarted: number): Promise<string> => {
    const toolName = toolCall.function.name
    const parsed = parseToolCall(toolCall)
    if (!parsed.ok) {
      emitToolEnd(toolCall.id, toolName, false, callStarted, 'bad arguments')
      return `Error: ${parsed.error}`
    }

    if (parsed.call.tool === ('search_files' as ToolName)) {
      // Answered from the staged index rather than the handle: only the
      // Developer holds one, and re-reading files the summary already describes
      // would spend a tool call to learn the same thing.
      const args = parsed.call.args as { query: string }
      const content = searchSummary(summaryIndex, args.query)
      const outcome = summarizeToolResult('search_files', parsed.call.args, content, Date.now() - callStarted)
      emit({
        type: 'tool-end',
        agent,
        callId: toolCall.id,
        tool: 'search_files',
        ok: outcome.ok,
        ms: Date.now() - callStarted,
        detail: outcome.detail,
      })
      return content
    }

    // The engine owns the sequence from here: heartbeat, call, coerce, report.
    // `announceStart: false` because the caller announced this call already,
    // before the budget check — so a call the budget refuses is still reported.
    const dispatched = await dispatchToolCall({
      agent,
      call: toolCall,
      announceStart: false,
      // The evidence side effects ride on the executor rather than wrapping the
      // engine, so a call the engine reports is the same call the ledger saw.
      executor: {
        callTool: async (tool: string, args: unknown) => {
          const result = await handle.callTool(parsed.call.tool, parsed.call.args)
          recordEvidence(parsed.call.tool, args, result)
          return result
        },
      },
      ...loopHooks(projectDir, emit),
    })
    return dispatched.content
  }

  // Evidence ledger (§4): harness-collected observations for planning. The
  // model never supplies these values — it only triggers the calls that produce
  // them. The caller owns it so a plan rejected in one turn can be re-proposed
  // in the next without re-reading and re-baselining everything: without that,
  // the rejection feedback ("you never read it", "was never run") is
  // unsatisfiable, because the evidence it demands died with the turn.
  const evidence = input.evidence ?? createEvidenceLedger()
  const { filesRead, baselinesByCommand } = evidence
  /** Consecutive rejected plans, so the feedback can escalate. */
  let planRejections = 0
  /**
   * `rejectPlan`, and say so: the reasons go back to the model as a tool result,
   * which nothing outside the conversation sees, so a bench log or a screen
   * would otherwise show a plan vanishing and the Developer trying again.
   */
  const sendBack = (...args: Parameters<typeof rejectPlan>): void => {
    rejectPlan(...args)
    const [, , errors, attempt = 1] = args
    emit({ type: 'warning', agent, text: `plan rejected (attempt ${attempt}): ${errors.join(' | ')}` })
  }

  /** Record the observed exit code of a run_baseline call. Harness rejections
   *  (disallowed command, cwd escape, timeout) arrive as negative exits and are
   *  not observations of the command itself, so they are not recorded. */
  const recordBaseline = (result: string, rawArgs: unknown): void => {
    try {
      const payload = JSON.parse(result) as { exitCode?: number }
      if (typeof payload.exitCode !== 'number' || payload.exitCode < 0) return
      const b = rawArgs as { command?: unknown; args?: unknown; cwd?: unknown }
      if (typeof b.command !== 'string') return
      baselinesByCommand.set(
        baselineKey(
          b.command,
          Array.isArray(b.args) ? b.args.map(String) : [],
          typeof b.cwd === 'string' ? b.cwd : undefined,
          projectDir,
        ),
        payload.exitCode,
      )
    } catch {
      // Not a C1 payload — nothing to record.
    }
  }

  /**
   * Run the verify commands the model did not run itself, as the project stands.
   *
   * A baseline is only the exit code before any change, which nothing about the
   * model's judgement can improve: it used to be one model round per command (or
   * per pair), and a plan with ten verify commands spent most of its wall time on
   * rounds that did nothing but report an exit code. A command already measured is
   * not run again, so a model that measured on purpose, or a rejected plan being
   * re-proposed, costs nothing here.
   */
  /** Verify commands the harness refused to run, by baseline key, with why. */
  const refused = new Map<string, string>()

  const measureUnmeasured = async (tasks: readonly PlannedTaskInput[]): Promise<void> => {
    const pending = new Map<string, { command: string; args: string[]; cwd?: string; timeoutMs?: number }>()
    for (const task of tasks) {
      for (const v of task.verify ?? []) {
        const key = baselineKey(v.command, v.args ?? [], v.cwd, projectDir)
        if (baselinesByCommand.has(key) || pending.has(key)) continue
        pending.set(key, {
          command: v.command,
          args: v.args ?? [],
          ...(v.cwd ? { cwd: v.cwd } : {}),
          ...(v.timeoutSeconds ? { timeoutMs: v.timeoutSeconds * 1000 } : {}),
        })
      }
    }
    if (pending.size === 0) return
    const startedMeasuring = Date.now()
    await Promise.all(
      [...pending.entries()].map(async ([key, args]) => {
        try {
          const result = String(await handle.callTool('run_baseline', args))
          recordBaseline(result, args)
          // A negative exit is the harness declining, not the command failing: say why, because
          // "was never run" alone sends the model to run it itself and be refused again.
          const payload = JSON.parse(result) as { exitCode?: number; stderr?: string }
          if (typeof payload.exitCode === 'number' && payload.exitCode < 0) {
            refused.set(key, (payload.stderr ?? '').trim().slice(0, 160) || 'refused')
          }
        } catch {
          // Unmeasured stays unmeasured: the validator names it, as it always did.
        }
      }),
    )
    emit({
      type: 'warning',
      agent,
      text: `measured ${pending.size} verify command${pending.size === 1 ? '' : 's'} the plan used but had not run (${Date.now() - startedMeasuring}ms)`,
    })
  }

  /**
   * Give every measured verify command the kind its exit code decides.
   *
   * Whether a command is a `proves-change` (fails now) or a `regression-guard`
   * (passes now) is not a judgement: it is what the baseline says, and a model
   * that labels one the other way only earns a rejection round. A command with no
   * measurement keeps its label, and the validator still names it. Returns how
   * many labels were changed.
   */
  const settleKinds = (tasks: unknown): number => {
    let changed = 0
    if (!Array.isArray(tasks)) return changed
    for (const task of tasks as Array<{ verify?: unknown }>) {
      if (!Array.isArray(task?.verify)) continue
      for (const v of task.verify as Array<{ command?: unknown; args?: unknown; cwd?: unknown; expectExit?: unknown; kind?: unknown }>) {
        if (typeof v?.command !== 'string') continue
        const exit = baselinesByCommand.get(
          baselineKey(
            v.command,
            Array.isArray(v.args) ? v.args.map(String) : [],
            typeof v.cwd === 'string' ? v.cwd : undefined,
            projectDir,
          ),
        )
        if (exit === undefined) continue
        const kind = exit === (typeof v.expectExit === 'number' ? v.expectExit : 0) ? 'regression-guard' : 'proves-change'
        if (v.kind !== kind) {
          v.kind = kind
          changed++
        }
      }
    }
    return changed
  }

  // The context the profile's `buildContext` hands back. Built only for a first
  // turn: a continuing conversation already carries the system message and must
  // not re-scan the project.
  let builtContext: ReturnType<typeof buildInitialPromptContext> | undefined

  if (messages.length === 0) {
    emit({ type: 'phase', agent, phase: 'indexing' })
    builtContext = buildInitialPromptContext(projectDir, summaryIndex, model)
    messages.push({
      role: 'system',
      content: buildDeveloperConversationPrompt(projectDir, builtContext.tree, builtContext.summaryText),
    })
  }

  messages.push({ role: 'user', content: userMessage })

  const toolSpecs = getDeveloperToolSpecs()
  let toolCallCount = 0
  const MAX_TOOL_CALLS = 30
  // E4: wall-clock + total iteration bounds. Free tools count toward total
  // iterations (they can still run forever) but not toward the tool budget.
  const MAX_WALL_MS = 5 * 60 * 1000
  const MAX_TOTAL_ITERATIONS = 60
  const freeTools = new Set(['search_files'])
  const startedAt = Date.now()
  let totalIterations = 0
  emit({ type: 'phase', agent, phase: 'planning' })

  while (toolCallCount < MAX_TOOL_CALLS) {
    if (isInterrupted?.() || signal?.aborted) {
      break
    }
    totalIterations++
    if (totalIterations > MAX_TOTAL_ITERATIONS || Date.now() - startedAt > MAX_WALL_MS) {
      break
    }

    // Compress messages to fit within context window
    const compressedMessages = compressMessages(messages, model)
    if (compressedMessages.length < messages.length) {
      emit({
        type: 'warning',
        agent,
        text: `Context compacted: ${messages.length - compressedMessages.length} message(s) dropped to fit the ${getModelLimit(model).toLocaleString('en-US')}-token window`,
      })
    }

    const result = await streamChatCompletion(
      {
        apiKey,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        messages: compressedMessages,
        tools: toolSpecs,
        signal,
        round: totalIterations,
        roundBudget: MAX_TOTAL_ITERATIONS,
        onEvent: event => emit({ ...event, agent }),
      },
      text => onTextDelta?.(text),
      thinking => onThinkingDelta?.(thinking),
    )

    if (!result.message.tool_calls || result.message.tool_calls.length === 0) {
      const content = result.message.content ?? ''
      messages.push(result.message)
      return { type: 'response', response: content }
    }

    messages.push(result.message)

    /**
     * §2: read-only calls in one assistant message are independent — a model
     * routinely asks for 3-5 files at once. Run them together and hand the
     * results to the ordered loop below, so the tool-call chain is still
     * answered in the model's original order.
     */
    const precomputed = await runReadOnlyCalls(result.message.tool_calls)

    let planned: DeveloperTurnResult | null = null

    for (const toolCall of result.message.tool_calls) {
      if (planned) break
      const callStarted = Date.now()
      const toolName = toolCall.function.name
      let callArgs: unknown
      try {
        callArgs = JSON.parse(toolCall.function.arguments)
      } catch {
        callArgs = undefined
      }
      // A batched read-only call already announced itself before it ran.
      if (!precomputed.has(toolCall.id)) {
        const summary =
          toolName === 'propose_plan'
            ? summarizePlanTaskCount(callArgs)
            : summarizeToolCall(toolName, callArgs, projectDir)
        emit({
          type: 'tool-start',
          agent,
          callId: toolCall.id,
          tool: toolName,
          summary,
        })
      }

      if (toolCall.function.name === 'propose_plan') {
        let parsed: unknown
        try {
          parsed = JSON.parse(toolCall.function.arguments)
        } catch {
          messages.push({
            role: 'tool',
            content: 'Error: propose_plan arguments were not valid JSON. Please try again.',
            tool_call_id: toolCall.id,
          })
          emitToolEnd(toolCall.id, toolName, false, callStarted, 'invalid JSON')
          continue
        }

        const proposed = proposePlanTool.schema.safeParse(parsed)
        if (!proposed.success) {
          const detail = proposed.error.issues
            .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
            .join('; ')
          messages.push({
            role: 'tool',
            content: `Error: propose_plan arguments were rejected: ${detail}. Fix them and call propose_plan again.`,
            tool_call_id: toolCall.id,
          })
          emitToolEnd(toolCall.id, toolName, false, callStarted, 'rejected')
          continue
        }

        // One shape per plan. A plan that mixes them would have half its tasks
        // checked for real anchors and read files, and half skipped — worse
        // than either, because the unchecked half still runs.
        const shape = planShape(proposed.data.tasks)
        if (shape.kind === 'mixed') {
          planRejections += 1
          sendBack(messages, toolCall.id, [
            `Tasks use two different shapes (${shape.offenders}). Every task in a plan ` +
              'must use the same one. Convert the flat tasks to context/edits/verify.',
          ], planRejections)
          emitToolEnd(toolCall.id, toolName, false, callStarted, 'rejected')
          continue
        }
        if (proposed.data.tasks.length > MAX_PLAN_TASKS) {
          planRejections += 1
          sendBack(messages, toolCall.id, [
            `Plan has ${proposed.data.tasks.length} tasks; the limit is ${MAX_PLAN_TASKS}. ` +
              'Consolidate: one concern per task, and merge edits to the same file into ' +
              'a single task. If the work really is that large, plan the first slice and ' +
              'leave the rest for the user to schedule.',
          ], planRejections)
          emitToolEnd(toolCall.id, toolName, false, callStarted, 'rejected')
          continue
        }

        const rejection: string[] = []
        if (shape.kind !== 'structured') {
          // context/edits/verify are the only fields the harness can check: that
          // a cited file was really read, that an anchor really appears once,
          // that a baseline really failed. A flat or empty task declares no
          // target files and no success criteria, so there is nothing to check
          // its claims against — and nothing tells the Worker what it must
          // produce or how anyone will know it worked. Reject rather than accept
          // a plan that was never verified, however convenient its shape.
          rejection.push(
            'Every task must be built from context/edits/verify. A task made only ' +
              'of instructions/readFile/writeFile — or of none of those — declares no ' +
              'target files and no success criteria, so nothing about it can be ' +
              'verified and a Worker has nothing to execute against. Give each task: ' +
              'context (the files to read, each with a reason), edits (every change, ' +
              'with a verbatim anchor for each modify), and verify (a command that ' +
              'fails now and passes once the task is done).',
          )
        }

        await measureUnmeasured(proposed.data.tasks)
        // Both copies: the validator reads the parsed one, the plan is built from the raw one.
        const reclassified = settleKinds(proposed.data.tasks)
        settleKinds((parsed as { tasks?: unknown }).tasks)
        if (reclassified > 0) {
          emit({
            type: 'warning',
            agent,
            text: `set the kind of ${reclassified} verify command${reclassified === 1 ? '' : 's'} from its measured exit code`,
          })
        }
        const evidence = buildEvidence(filesRead, baselinesByCommand, proposed.data.tasks, projectDir)
        const validation = validatePlan(proposed.data.tasks, evidence, projectDir)
        if (!validation.ok) rejection.push(...validation.errors)
        const contractCheck = validateContracts(proposed.data.tasks, proposed.data.contracts)
        rejection.push(...contractCheck.errors)

        for (const task of proposed.data.tasks) {
          for (const v of task.verify ?? []) {
            const why = refused.get(baselineKey(v.command, v.args ?? [], v.cwd, projectDir))
            if (why === undefined) continue
            rejection.push(
              `Task '${task.title}': '${v.command} ${(v.args ?? []).join(' ')}' cannot be run here (${why}). ` +
                'Use a command that can, such as node with a script or --test, not a package manager.',
            )
          }
        }

        if (rejection.length > 0) {
          planRejections += 1
          sendBack(
            messages,
            toolCall.id,
            rejection,
            planRejections,
            measuredBaselines(proposed.data.tasks, baselinesByCommand, projectDir),
          )
          emitToolEnd(toolCall.id, toolName, false, callStarted, 'rejected')
          continue
        }

        const parsedPlan = parseProposePlanArgs(parsed, projectDir)
        if (!parsedPlan.ok) {
          planRejections += 1
          sendBack(messages, toolCall.id, [parsedPlan.error], planRejections)
          emitToolEnd(toolCall.id, toolName, false, callStarted, 'rejected')
          continue
        }
        const plan = parsedPlan.plan
        enrichHarnessEvidence(plan.tasks, filesRead, baselinesByCommand, projectDir)
        const parallel = planParallel(plan.tasks, projectDir)
        if (parallel.errors.length > 0) {
          planRejections += 1
          sendBack(messages, toolCall.id, parallel.errors, planRejections)
          emitToolEnd(toolCall.id, toolName, false, callStarted, 'rejected')
          continue
        }
        planRejections = 0
        const warnings = [...parallel.warnings, ...contractCheck.warnings]
        messages.push({
          role: 'tool',
          content:
            warnings.length > 0
              ? `Plan proposed. Awaiting user review.\nPlan warnings:\n- ${warnings.join('\n- ')}`
              : 'Plan proposed. Awaiting user review.',
          tool_call_id: toolCall.id,
        })
        emitToolEnd(
          toolCall.id,
          toolName,
          true,
          callStarted,
          `${plan.tasks.length} task${plan.tasks.length === 1 ? '' : 's'}`,
        )
        planned = { type: 'plan', plan }
        continue
      }

      const isFree = freeTools.has(toolCall.function.name)
      if (!isFree) {
        toolCallCount++
      }

      // Budget exhausted — still append a synthetic result so the tool-call
      // chain is never left dangling. The provider will reject a conversation
      // with an assistant tool_call that has no matching tool result.
      if (toolCallCount > MAX_TOOL_CALLS) {
        messages.push({
          role: 'tool',
          content: 'Error: Tool call budget exhausted. Please produce a plan based on what you have learned so far.',
          tool_call_id: toolCall.id,
        })
        emitToolEnd(toolCall.id, toolName, false, callStarted, 'budget exhausted')
        continue
      }

      const done = precomputed.get(toolCall.id)
      if (done) {
        // Already run in the read-only batch above; answer it in the model's
        // order without touching the handle a second time.
        if (toolName === 'read_file' && typeof done.raw === 'string') {
          let readArgs: unknown
          try {
            readArgs = JSON.parse(toolCall.function.arguments)
          } catch {
            readArgs = undefined
          }
          const path = (readArgs as { path?: unknown } | undefined)?.path
          if (typeof path === 'string') filesRead.set(path, done.raw)
        } else if (toolName === 'run_baseline') {
          let baseArgs: unknown
          try {
            baseArgs = JSON.parse(toolCall.function.arguments)
          } catch {
            baseArgs = undefined
          }
          recordBaseline(String(done.raw), baseArgs)
        }
        emit({
          type: 'tool-end',
          agent,
          callId: toolCall.id,
          tool: toolName,
          ok: done.ok,
          ms: done.ms,
          ...(done.detail === undefined ? {} : { detail: done.detail }),
        })
        messages.push({ role: 'tool', content: done.content, tool_call_id: toolCall.id })
        continue
      }

      const content = await runToolCall(toolCall, callStarted)
      messages.push({ role: 'tool', content, tool_call_id: toolCall.id })
    }

    if (planned) return planned
  }

  const fallbackContent = isInterrupted?.()
    ? 'Interrupted by user.'
    : 'I have enough context. Let me propose a plan.'
  messages.push({ role: 'assistant', content: fallbackContent })
  return { type: 'response', response: fallbackContent }
}
