import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { compressMessages } from '../model/compress.js'
import type { LaunchHandle } from '@codekalakaars/vajra-sandbox'
import { getModelLimit } from '../model/context-window.js'
import { ContextBudget, promptChars } from '../model/budget.js'
import { buildContextPack } from './pack.js'
import type { AgentRegistry } from '../manager/registry.js'
import type { TaskQueue } from '../manager/taskqueue.js'
import { streamChatCompletion, type ChatMessage, type ReasoningEffort, type ToolCall } from '../model/chat.js'
import { reasoningLevelsFor } from '../model/catalog.js'
import { getWorkerToolSpecs } from '@codekalakaars/vajra-sandbox'
import type { ChangeHistory, FileLockManager } from '@codekalakaars/vajra-sandbox'
import type { AgentEvent, AgentLabel, SessionStreamer } from '../manager/ui.js'
import { dispatchToolCall, loopHooks, READ_ONLY_TOOLS } from '../model/tool-dispatch.js'
import { startHeartbeat, summarizeToolCall, summarizeToolResult } from '../manager/ui.js'
import type { WorkerParams } from '../bench/params.js'
import type { ContextRef, EditSpec, VerifySpec } from '@codekalakaars/vajra-protocol'
import type { PauseGate } from '../manager/pause.js'
import { capToolOutput } from './output-cap.js'
import { elideMessages } from './elide.js'
import type { DiffFile } from './diff.js'
import { WorkLedger } from './ledger.js'
import {
  CHECKPOINT_TOOL,
  CHECKPOINT_TOOL_SPEC,
  compactedMessages,
  completeCheckpoint,
  madeProgress,
  markAt,
  parseCheckpoint,
  type ProgressMark,
} from './checkpoint.js'
import { renderPreviousAttempts } from '../manager/handoff.js'
import { legacySystemPrompt, packSystemPrompt, START_MESSAGE } from './prompt.js'
import type { AttemptOutcome, Checkpoint, WorkerContext } from './context-types.js'
import { allocateServerPort, findServerEntry, needsServer, probeServerPort, substituteServerPort } from './server.js'

export interface ExecuteTaskInput {  agentId: string
  task: {
    id: string
    title: string
    description: string | null
    instructions: string[]
    readFile: string[]
    writeFile: string[]
    deleteFile: string[]
    createDir: string[]
    validation: string[]
    timeoutSeconds: number
    /** C4: internal retry limit (from wire field `retries`). */
    maxRetries: number
    rollback: string[]
    skipIf: string[]
    /** The plan's structured fields, when it had them. Read by the context pack. */
    context?: ContextRef[]
    edits?: EditSpec[]
    verify?: VerifySpec[]
    successCriteria?: string[]
    notes?: string
    dependsOn?: string[]
    type?: string
  }
  handle: LaunchHandle
  apiKey: string
  model: string
  streamer: SessionStreamer
  changeHistory: ChangeHistory
  queue: TaskQueue
  registry: AgentRegistry
  sessionId: string
  fileLocks: FileLockManager
  projectDir: string
  signal?: AbortSignal
  /** Identifies this worker's row; falls back to the title alone. */
  onAgentEvent?: (event: AgentEvent) => void
}

/**
 * Parse a C1 run_command result. Non-JSON or missing exitCode is failure —
 * never the old `exitCode = 0` fallback (C2t).
 */
export function parseCommandResult(output: string): {
  ok: boolean
  exitCode: number
  signal: string | null
  stdout: string
  stderr: string
} {
  try {
    const parsed = JSON.parse(output) as {
      exitCode?: number
      signal?: string | null
      stdout?: string
      stderr?: string
    }
    if (typeof parsed.exitCode !== 'number') {
      return { ok: false, exitCode: -1, signal: null, stdout: output, stderr: 'Malformed run_command result' }
    }
    const signal = parsed.signal ?? null
    const ok = parsed.exitCode === 0 && signal === null
    return {
      ok,
      exitCode: parsed.exitCode,
      signal,
      stdout: parsed.stdout ?? '',
      stderr: parsed.stderr ?? '',
    }
  } catch {
    // Bare string success from an older handle is still not trusted (C1).
    return {
      ok: false,
      exitCode: -1,
      signal: null,
      stdout: output,
      stderr: 'run_command did not return JSON {exitCode, signal, stdout, stderr}',
    }
  }
}

async function killProcessGroup(
  serverProcess: ReturnType<typeof import('node:child_process').spawn>,
): Promise<void> {
  // Consume piped stdout/stderr so the buffer cannot fill and stall the server.
  serverProcess.stdout?.resume()
  serverProcess.stderr?.resume()
  if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) return
  try {
    if (serverProcess.pid) {
      // Negative pid signals the process group (spawn used detached: true).
      process.kill(-serverProcess.pid, 'SIGTERM')
    }
  } catch {
    try {
      serverProcess.kill('SIGTERM')
    } catch {
      // already dead
    }
  }
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try {
        if (serverProcess.pid) process.kill(-serverProcess.pid, 'SIGKILL')
      } catch { /* ignore */ }
      resolve()
    }, 3000)
    serverProcess.once('close', () => {
      clearTimeout(t)
      resolve()
    })
  })
}

function waitForServerStartup(
  serverProcess: ReturnType<typeof import('node:child_process').spawn>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const finish = (started: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      serverProcess.off('error', onError)
      serverProcess.off('exit', onExit)
      resolve(started)
    }
    const onError = () => finish(false)
    const onExit = () => finish(false)
    const timer = setTimeout(() => finish(true), timeoutMs)
    serverProcess.once('error', onError)
    serverProcess.once('exit', onExit)
  })
}

/**
 * The reasoning level this Worker may ask for.
 *
 * The run's config states a level; only the model's own catalog entry knows
 * whether it accepts one. A level outside that list becomes `off`, which sends no
 * field at all — silence is the one spelling every provider agrees on. Without
 * the filter a config naming `high` for a model with no dial is a 400 on the
 * first round, which is the worst possible moment to learn it.
 */
function reasoningFor(model: string, level: ReasoningEffort): ReasoningEffort {
  return reasoningLevelsFor(model).includes(level) ? level : 'off'
}

/** One file's preload: its contents, or why it has none. */
interface PreloadedRead {
  path: string
  content?: string
  error?: string
}

/**
 * The task's read files, loaded before the first round and handed over in the
 * first user message.
 *
 * Read through the same handle the Worker's own reads go through, so what the
 * Worker is given is what `read_file` would have answered — the permission gate
 * and the masked-file stub included — and they run together because they are
 * independent. A file that cannot be read is named as unread rather than left
 * out: silence would leave the Worker planning against contents it never saw.
 *
 * These are the arrangement's reads, not the Worker's: they are not tool calls,
 * so they are not announced as ones and they do not spend the call budget.
 */
async function preloadReadFiles(
  paths: string[],
  handle: LaunchHandle,
  maxChars: number,
  onUnreadable: (path: string, why: string) => void,
): Promise<string | null> {
  if (paths.length === 0) return null
  const settled: PreloadedRead[] = await Promise.all(
    paths.map(async path => {
      try {
        const result = await handle.callTool('read_file', { path })
        const text = typeof result === 'string' ? result : JSON.stringify(result ?? '')
        // Capped like any read the Worker makes itself, so preloading cannot be
        // the thing that fills the window.
        return { path, content: capToolOutput('read_file', text, maxChars) }
      } catch (e) {
        return { path, error: e instanceof Error ? e.message : String(e) }
      }
    }),
  )
  const blocks: string[] = []
  for (const { path, content, error } of settled) {
    if (error !== undefined) {
      onUnreadable(path, error)
      blocks.push([
        `--- NOT READ: ${path} ---`,
        `It could not be read before you started: ${error}`,
        'Read it yourself with read_file if the task needs it.',
      ].join('\n'))
      continue
    }
    blocks.push([
      `--- BEGIN FILE: ${path} ---`,
      content ?? '',
      `--- END FILE: ${path} ---`,
    ].join('\n'))
  }
  return [
    'These files were read for you. Their contents are as of this message, so do not',
    'call read_file on them again unless you need a window this text does not show.',
    '',
    ...blocks,
  ].join('\n')
}

/**
 * Tokens left free for the Worker's reply when its history is trimmed. A
 * reply that writes a whole file needs more room than a question does.
 */
const WORKER_REPLY_RESERVE = 8000

/** A tool handle answers with a string or a structured value; a pack reads text. */
function asText(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result ?? '')
}

export async function executeTask(
  agentId: string,
  task: ExecuteTaskInput['task'],
  handle: LaunchHandle,
  apiKey: string,
  model: string,
  streamer: SessionStreamer,
  changeHistory: ChangeHistory,
  queue: TaskQueue,
  registry: AgentRegistry,
  sessionId: string,
  fileLocks: FileLockManager,
  projectDir: string,
  signal: AbortSignal | undefined,
  onAgentEvent: ((event: AgentEvent) => void) | undefined,
  params: WorkerParams,
  /** Shut by the scheduler while the CPU is saturated. Absent: never paused. */
  gate?: PauseGate,
  /** The plan's contracts, the project card, upstream handoffs and earlier attempts. */
  context?: WorkerContext,
): Promise<boolean> {
  let toolCallCount = 0

  const agent: AgentLabel = { role: 'worker', taskId: task.id, title: task.title }
  const emit = (event: AgentEvent): void => onAgentEvent?.(event)

  /**
   * One signal for the whole attempt: the session's, and the run's deadline.
   *
   * Everything the attempt waits on is handed the combined signal, so whichever
   * of the two ends it — a person pressing Ctrl-C, or the clock — the attempt is
   * judged the same way.
   *
   * The deadline is enforced wherever the attempt can still be interrupted:
   * before each round, before each group of tool calls, and as the ceiling on a
   * validation command. A provider request already in flight is not cut short,
   * because `streamChatCompletion` puts the signal in the request body and the
   * SDK only reads a signal passed as request options; a round that never comes
   * back still ends when it does. That gap is in chat.ts, not here.
   */
  const deadlineMs = params.taskTimeoutSec * 1000
  const attemptStartedAt = Date.now()
  // Time the attempt has been allowed to run. A pause is the scheduler's
  // decision, not the task's slowness, so the clock stops while the gate is shut.
  const activeMs = (): number => Date.now() - attemptStartedAt - (gate?.pausedMs() ?? 0)
  const deadlineController = new AbortController()
  const deadline = deadlineController.signal
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null
  const armDeadline = (): void => {
    if (deadlineTimer) clearTimeout(deadlineTimer)
    deadlineTimer = null
    if (deadline.aborted || gate?.paused) return
    deadlineTimer = setTimeout(
      () => deadlineController.abort(new DOMException('Attempt timed out', 'TimeoutError')),
      Math.max(0, deadlineMs - activeMs()),
    )
    deadlineTimer.unref?.()
  }
  armDeadline()
  gate?.onChange(armDeadline)
  const attemptSignal = signal ? AbortSignal.any([signal, deadline]) : deadline

  /**
   * Hold here while the scheduler has this Worker paused. The session ending
   * opens it too: a paused Worker must still be able to notice an interrupt.
   */
  const waitWhilePaused = async (): Promise<void> => {
    if (!gate?.paused || signal?.aborted) return
    await new Promise<void>(resolve => {
      const done = (): void => {
        signal?.removeEventListener('abort', done)
        resolve()
      }
      signal?.addEventListener('abort', done, { once: true })
      void gate.wait().then(done)
    })
  }

  /**
   * Whether the attempt ran out of time, as opposed to the session ending.
   *
   * A timeout is a failed attempt rather than a silent success: leaving the loop
   * on the abort and carrying on to validation would report a task done having
   * done nothing, and would hand the run back a result nothing stands behind.
   */
  const outOfTime = (): boolean => deadline.aborted
  const timedOutMessage = (): string => `Attempt timed out after ${params.taskTimeoutSec}s.`

  const preloaded = params.preloadReads
    ? await preloadReadFiles(task.readFile, handle, params.toolOutputMaxChars, (path, why) =>
        streamer.warning(`Could not preload ${path}: ${why}`))
    : null

  /**
   * How full this model's window is, and what one character costs in tokens.
   *
   * Calibrated from what the provider reported for each round, so a model whose
   * tokenizer packs code densely stops being under-counted after a few rounds.
   * Every Worker on this model in the process shares the calibration, which is
   * why it lives in `budget.ts` rather than here.
   */
  const budget = new ContextBudget(model)

  /** What the harness saw this attempt do. The half no model can misreport. */
  const ledger = new WorkLedger()

  /**
   * The retry's account of what it is replacing, rendered here rather than by
   * the pack so it is byte-for-byte the same block whether the pack is on (where
   * it is section 3) or off (where it is appended to the first user message).
   */
  const previousAttempt =
    params.respawnContext && context?.previousAttempts && context.previousAttempts.length > 0
      ? renderPreviousAttempts(context.previousAttempts, params.respawnDiffChars)
      : undefined

  /**
   * The compiled context, or `null` when the run has `contextPack` off.
   *
   * Built here, at dispatch, through the task's own handle — the same call path,
   * permission gate and masked-file stub a Worker's own `read_file` goes through,
   * so the pack can never show more than the Worker would have been allowed to
   * read. A pack that cannot be built falls back to the legacy prompt with a
   * warning rather than failing the attempt: an unreadable file is not a reason
   * to refuse to do the work.
   */
  let pack: Awaited<ReturnType<typeof buildContextPack>> | null = null
  if (params.contextPack) {
    try {
      pack = await buildContextPack({
        task,
        params,
        model,
        read: async (path, symbols) =>
          asText(
            await handle.callTool(
              'read_file',
              symbols && symbols.length > 0 ? { path, symbols } : { path },
            ),
          ),
        list: async path => asText(await handle.callTool('list_files', { path })),
        ...(context?.contracts ? { contracts: context.contracts } : {}),
        ...(context?.projectCard !== undefined ? { projectCard: context.projectCard } : {}),
        ...(context?.upstream ? { upstream: context.upstream } : {}),
        ...(previousAttempt !== undefined ? { previousAttempt } : {}),
      })
      emit({
        type: 'context',
        agent,
        kind: 'pack',
        pack: {
          tokens: pack.tokens,
          hash: pack.hash,
          paths: pack.paths,
          omitted: pack.omitted.length,
          stale: pack.staleAnchors.length,
          relocated: pack.relocatedAnchors.length,
        },
      })
    } catch (e) {
      streamer.warning(
        `Could not build the context pack (${e instanceof Error ? e.message : String(e)}); starting from the task prompt instead.`,
      )
      pack = null
    }
  }

  const systemPrompt = pack ? packSystemPrompt(pack.text) : legacySystemPrompt(task, preloaded !== null)

  /**
   * The first user message.
   *
   * With a pack it says only "start": the pack is the whole brief, and a second
   * paragraph in front of it is a paragraph the model reads before it knows what
   * it is starting. Without a pack it carries the preloaded reads, and either way
   * the retry's account of what it is replacing goes last, where it is read as
   * context for the task rather than as the task.
   */
  let messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: pack
        ? [START_MESSAGE, ...(previousAttempt === undefined ? [] : ['', previousAttempt])].join('\n')
        : [
            preloaded ? `${START_MESSAGE}\n\n${preloaded}` : START_MESSAGE,
            ...(previousAttempt === undefined ? [] : ['', previousAttempt]),
          ].join('\n'),
    },
  ]

  const toolSpecs = getWorkerToolSpecs()

  /**
   * How this attempt ended, and what it left behind.
   *
   * Reported through `context.onAttemptEnd` on every exit path, because a retry is
   * only as good as the record of what it is replacing. The precedence below is
   * the order in which the causes are checked, and it is deliberate that
   * `failed_verification` is named in preference to `budget`: a check that failed
   * is what the next attempt has to fix, whatever else also happened.
   */
  let lastCheckpoint: Checkpoint | undefined
  let closingText: string | undefined
  let failure: { command: string; exitCode: number; outputTail: string } | undefined
  let errorMessage: string | undefined
  let stuckReason: string | undefined
  let budgetSpent = false
  let providerRounds = 0

  const finishAttempt = (ok: boolean): boolean => {
    const outcome: AttemptOutcome = outOfTime()
      ? 'timeout'
      : stuckReason !== undefined
        ? 'stuck'
        : signal?.aborted
          ? 'interrupted'
          : failure !== undefined
            ? 'failed_verification'
            : errorMessage !== undefined
              ? 'error'
              : budgetSpent
                ? 'budget'
                : 'done'
    if (stuckReason !== undefined) errorMessage = stuckReason
    try {
      // The outcome is what an attempt *is*, so it is reported as itself. What
      // the attempt is worth is the boolean, and the two are not the same
      // question: a Worker that ran out of tool calls can still have left correct
      // work behind, and calling that attempt `budget` in the record would tell
      // the next one it had nothing to show.
      context?.onAttemptEnd?.({
        outcome,
        ...(failure !== undefined ? { failure } : {}),
        ...(errorMessage !== undefined ? { error: errorMessage } : {}),
        ...(lastCheckpoint !== undefined ? { checkpoint: lastCheckpoint } : {}),
        filesWritten: ledger.filesWritten(),
        ...(closingText !== undefined && closingText.trim() !== '' ? { summary: closingText.trim() } : {}),
      })
    } catch {
      // A recorder that throws must not cost the run the outcome of its work.
    }
    return ok
  }

  /**
   * The "before" of a tracked file, or `undefined` when the harness never
   * recorded one. Distinguishing the two matters: `null` is a file that did not
   * exist, which is exactly what a created file's diff needs to say.
   */
  const originalOf = (path: string): string | null | undefined =>
    changeHistory ? changeHistory.getOriginalContent(task.id, path) : undefined

  /** The file as it is now, or `null` when the attempt deleted it. */
  const currentOf = (path: string): string | null => {
    try {
      return readFileSync(isAbsolute(path) ? path : join(projectDir, path), 'utf-8')
    } catch {
      return null
    }
  }

  /** Diffs of everything this attempt may have touched, most important first. */
  const trackedDiffs = (): DiffFile[] => {
    const written = ledger.filesWritten()
    const files = written.length > 0
      ? written
      : [...new Set([...task.writeFile, ...task.deleteFile])]
    const diffs: DiffFile[] = []
    for (const path of files) {
      const before = originalOf(path)
      if (before === undefined) continue
      diffs.push({ path, before, after: currentOf(path) })
    }
    return diffs
  }

  /** One round in which the only thing on offer is the checkpoint. */
  const requestCheckpoint = async (sequence: number): Promise<Checkpoint | null> => {
    const asked = await streamChatCompletion(
      {
        apiKey,
        model,
        // The whole conversation, because the point is that the model summarises
        // what it is about to lose.
        messages,
        tools: [CHECKPOINT_TOOL_SPEC],
        toolChoice: 'required',
        reasoningEffort: reasoningFor(model, params.workerReasoning),
        signal: attemptSignal,
        round: providerRounds,
        onEvent: event => emit({ ...event, agent }),
      },
      text => streamer.onTextDelta(text),
    )
    streamer.finishLine()
    const call = (asked.message.tool_calls ?? []).find(c => c.function.name === CHECKPOINT_TOOL)
    if (!call) return null
    let args: unknown = {}
    try {
      args = JSON.parse(call.function.arguments)
    } catch {
      // A malformed checkpoint still compacts: the ledger and the diff are ours,
      // and losing the model's half is better than losing the round.
      args = {}
    }
    return completeCheckpoint(parseCheckpoint(args), sequence, ledger)
  }

  try {
    emit({ type: 'phase', agent, phase: 'executing' })
    let lastFittedLength = -1
    let compactions = 0
    let compactionsWithoutProgress = 0
    let mark: ProgressMark = markAt(ledger)
    const elidedCalls = new Set<string>()

    while (toolCallCount < params.workerMaxToolCalls) {
      await waitWhilePaused()
      if (attemptSignal.aborted) break

      providerRounds++
      // The window is the model's, and a Worker that overflows it fails its
      // attempt and starts again from nothing. So the oldest exchanges are
      // dropped first — the system prompt and the task message never are — and
      // the full history stays here for nothing but this trim to read.
      const fitted = compressMessages(messages, model, WORKER_REPLY_RESERVE, 2)
      if (fitted.length < messages.length && fitted.length !== lastFittedLength) {
        lastFittedLength = fitted.length
        emit({
          type: 'warning',
          agent,
          text: `Context trimmed: ${messages.length - fitted.length} older message(s) dropped to fit the ${getModelLimit(model).toLocaleString('en-US')}-token window`,
        })
      }
      const sentChars = promptChars(fitted)
      const result = await streamChatCompletion(
        {
          apiKey,
          model,
          messages: fitted,
          tools: toolSpecs,
          reasoningEffort: reasoningFor(model, params.workerReasoning),
          signal: attemptSignal,
          round: providerRounds,
          onEvent: event => emit({ ...event, agent }),
        },
        text => streamer.onTextDelta(text),
      )
      // What was actually on the wire, against what the provider counted: the
      // only honest way to learn this model's characters per token.
      if (result.usage) budget.observe(sentChars, result.usage.promptTokens)

      if (!result.message.tool_calls || result.message.tool_calls.length === 0) {
        const text = typeof result.message.content === 'string' ? result.message.content : ''
        if (text.trim() !== '') closingText = text
        streamer.finishLine()
        break
      }

      messages.push(result.message)

      /**
       * Run one tool call end to end: announce, execute, announce the result.
       * The caller decides whether calls like this one may overlap.
       *
       * The sequence is the engine's, because the Developer's was the same
       * code with the same comment; what stays here is the part that is the
       * Worker's alone — which calls may overlap, and the budget charged
       * before one is announced.
       */
      const runToolCall = async (toolCall: ToolCall): Promise<string> => {
        const dispatched = await dispatchToolCall({
          agent,
          call: toolCall,
          executor: { callTool: (tool: string, args: unknown) => handle.callTool(tool, args) },
          ...loopHooks(projectDir, emit),
        })
        // Recorded before the cap, because what the harness ran is what happened
        // whether or not the conversation will still hold its output.
        ledger.record({
          round: providerRounds,
          callId: toolCall.id,
          tool: toolCall.function.name,
          args: dispatched.args,
          content: dispatched.content,
          ok: dispatched.ok,
        })
        return capToolOutput(toolCall.function.name, dispatched.content, params.toolOutputMaxChars)
      }

      const toolCalls = result.message.tool_calls
      let index = 0
      while (index < toolCalls.length) {
        await waitWhilePaused()
        if (attemptSignal.aborted) break

        // Models routinely return 3-5 independent reads in one message.
        // Overlapping them is the cheapest parallelism in the whole loop; only
        // read-only tools may overlap, because ordering matters for mutations.
        let end = index
        if (READ_ONLY_TOOLS.has(toolCalls[index].function.name)) {
          while (end < toolCalls.length && READ_ONLY_TOOLS.has(toolCalls[end].function.name)) {
            end++
          }
        } else {
          end = index + 1
        }

        const group = toolCalls.slice(index, end)
        // The budget is charged before running, so an exhausted loop still
        // answers every tool call rather than leaving the chain dangling.
        toolCallCount += group.length
        if (toolCallCount > params.workerMaxToolCalls) {
          for (const toolCall of group) {
            messages.push({
              role: 'tool',
              content: 'Error: Tool call budget exhausted.',
              tool_call_id: toolCall.id,
            })
          }
          break
        }

        if (group.length > 1) {
          // Results are appended in the model's original call order, whatever
          // order they finished in — the provider rejects a mismatch.
          const settled = await Promise.all(group.map(runToolCall))
          for (let k = 0; k < group.length; k++) {
            messages.push({ role: 'tool', content: settled[k], tool_call_id: group[k].id })
          }
        } else {
          const content = await runToolCall(group[0])
          messages.push({ role: 'tool', content, tool_call_id: group[0].id })
        }
        index = end
      }

      // --- rung 1: elide what is stale -----------------------------------
      // Cheapest first, and only once there is something to gain: a rewrite
      // costs nothing but a pass, and the share only grows, so this runs every
      // round past the threshold and is a no-op until a result actually goes stale.
      if (params.elision && budget.share(budget.estimate(messages)) >= params.elideAt) {
        const before = budget.share(budget.estimate(messages))
        const elided = elideMessages(messages, ledger, {
          keepRecentRounds: params.keepRecentRounds,
          elidedTailLines: params.elidedTailLines,
          alreadyElided: elidedCalls,
        })
        if (elided.elided > 0) {
          for (const callId of elided.callIds) elidedCalls.add(callId)
          messages = elided.messages
          emit({
            type: 'context',
            agent,
            kind: 'elided',
            before,
            after: budget.share(budget.estimate(messages)),
            detail: `${elided.elided} stale tool result(s) rewritten`,
          })
        }
      }

      // --- rung 2: compact into a checkpoint ------------------------------
      if (params.checkpoints && budget.share(budget.estimate(messages)) >= params.compactAt) {
        const before = budget.share(budget.estimate(messages))
        const checkpoint = await requestCheckpoint(compactions + 1)
        if (checkpoint === null) {
          errorMessage = 'The model did not answer the checkpoint request; nothing was compacted.'
          stuckReason = 'the checkpoint request went unanswered'
          break
        }
        compactions++
        lastCheckpoint = checkpoint
        messages = compactedMessages({
          system: systemPrompt,
          taskMessage: messages[1]?.content ?? START_MESSAGE,
          checkpoint,
          ledger,
          diffs: trackedDiffs(),
          diffChars: params.checkpointDiffChars,
        })
        const l1 = budget.tokens(messages[2]?.content ?? '')
        const after = budget.share(budget.estimate(messages))
        emit({
          type: 'context',
          agent,
          kind: 'compacted',
          before,
          after,
          detail: `${checkpoint.filesChanged.length} file(s) changed; ${l1} token(s) kept`,
        })
        compactionsWithoutProgress = madeProgress(mark, ledger) ? 0 : compactionsWithoutProgress + 1
        mark = markAt(ledger)

        // Rung 3: too big to summarise, or summarising changed nothing.
        if (l1 > params.stuckCheckpointShare * budget.window) {
          stuckReason = `its checkpoint alone needs ${l1} tokens, over ${Math.round(params.stuckCheckpointShare * 100)}% of the window`
        } else if (compactionsWithoutProgress >= params.maxCompactionsWithoutProgress) {
          stuckReason = `${compactionsWithoutProgress} compactions with no new file written and no check newly passing`
        }
        if (stuckReason !== undefined) {
          emit({ type: 'context', agent, kind: 'stuck', detail: stuckReason })
          break
        }
      }
    }

    // The loop stops on the budget as well as on the model finishing, and the
    // record should say which: an attempt that ran out of calls and never said it
    // was done is worth tuning `workerMaxToolCalls` against, and calling it `done`
    // would hide that.
    if (toolCallCount >= params.workerMaxToolCalls && closingText === undefined) budgetSpent = true

    // Time is up and nothing else will be: validation would only tell the run
    // what a cut-short attempt already knows.
    if (outOfTime()) {
      streamer.warning(timedOutMessage())
      return finishAttempt(false)
    }

    // Stuck is a failed attempt even when the files happen to be right. The task
    // is too big or the Worker is going in circles, and reporting success would
    // spend the task's one chance on an attempt that did not know it was done.
    if (stuckReason !== undefined) {
      streamer.warning(`Attempt ended stuck: ${stuckReason}`)
      return finishAttempt(false)
    }

    await waitWhilePaused()
    if (task.validation.length > 0) {
      emit({ type: 'phase', agent, phase: 'validating' })
      let serverProcess: ReturnType<typeof import('node:child_process').spawn> | null = null
      let serverPort: number | null = null
      const serverEntry = needsServer(task.validation)
        ? await findServerEntry(projectDir)
        : null
      const serverLockPath = '<resource:validation-server>'
      const serverLockOwner = `validation-server:${agent.taskId ?? agentId}`
      if (serverEntry && fileLocks) {
        await fileLocks.acquireOrWait([serverLockPath], serverLockOwner, 'write')
      }

      try {
        if (serverEntry) {
          const { spawn } = await import('node:child_process')
          for (let attempt = 0; attempt < 3; attempt++) {
            serverPort = await allocateServerPort()
            let serverError = ''
            const candidate = spawn('node', [serverEntry], {
              cwd: projectDir,
              stdio: 'pipe',
              detached: true,
              env: { ...process.env, PORT: String(serverPort) },
            })
            candidate.on('error', () => {})
            candidate.stdout?.resume()
            candidate.stderr?.on('data', chunk => {
              serverError += String(chunk)
            })
            const started = await waitForServerStartup(candidate, 2000)
            if (started && await probeServerPort(serverPort!)) {
              serverProcess = candidate
              break
            }
            await killProcessGroup(candidate)
            await new Promise(resolve => setTimeout(resolve, 25))
            if ((!started && !serverError.includes('EADDRINUSE')) || attempt === 2) break
          }
          if (!serverProcess) {
            errorMessage = `The validation server for ${task.title} would not start.`
            return finishAttempt(false)
          }
        }

        for (const cmd of task.validation) {
          const validationStarted = Date.now()
          const validationCommand = serverPort === null ? cmd : substituteServerPort(cmd, serverPort)
          const validationArgs = {
            command: validationCommand,
            // C5: task timeout is seconds; run_command timeoutMs is milliseconds.
            // The attempt's own deadline is the ceiling, because a command that
            // outlives it would outlive the attempt that is waiting on it.
            timeoutMs: Math.max(1, Math.min(task.timeoutSeconds * 1000, deadlineMs - activeMs())),
          }
          emit({
            type: 'tool-start',
            agent,
            callId: `validate-${cmd}`,
            tool: 'run_command',
            summary: summarizeToolCall('run_command', validationArgs, projectDir),
          })
          const stopHeartbeat = startHeartbeat(emit, agent)
          try {
            const result = await handle.callTool('run_command', validationArgs)
            const output = typeof result === 'string' ? result : JSON.stringify(result)
            const parsed = parseCommandResult(output)
            const outcome = summarizeToolResult(
              'run_command',
              validationArgs,
              result,
              Date.now() - validationStarted,
            )
            emit({
              type: 'tool-end',
              agent,
              callId: `validate-${cmd}`,
              tool: 'run_command',
              ok: parsed.ok,
              ms: Date.now() - validationStarted,
              detail: outcome.detail,
            })
            // The verification commands are the runtime's own, so they belong in
            // the ledger beside the Worker's: a checkpoint's `lastVerification` is
            // only honest if the failing check is in the record.
            ledger.record({
              round: providerRounds,
              callId: `validate-${cmd}`,
              tool: 'run_command',
              args: validationArgs,
              content: output,
              ok: parsed.ok,
            })

            if (!parsed.ok) {
              streamer.warning(
                `Validation failed: ${cmd} (exit=${parsed.exitCode}${parsed.signal ? ` signal=${parsed.signal}` : ''})`,
              )
              // What the retry needs is the failing command and what it printed,
              // so both are recorded rather than reconstructed later.
              failure = {
                command: validationCommand,
                exitCode: parsed.exitCode,
                outputTail: `${parsed.stdout}\n${parsed.stderr}`.trim().slice(-2000),
              }
              return finishAttempt(false)
            }
          } catch (e) {
            emit({
              type: 'tool-end',
              agent,
              callId: `validate-${cmd}`,
              tool: 'run_command',
              ok: false,
              ms: Date.now() - validationStarted,
              detail: 'threw',
            })
            errorMessage = `Validation command '${cmd}' threw: ${e instanceof Error ? e.message : String(e)}`
            return finishAttempt(false)
          } finally {
            stopHeartbeat()
          }
        }
      } finally {
        if (serverProcess) {
          await killProcessGroup(serverProcess)
        }
        if (serverEntry && fileLocks) {
          fileLocks.releaseFiles([serverLockPath], serverLockOwner)
        }
      }
    }

    return finishAttempt(true)
  } catch (e) {
    // A deadline that fires mid-round arrives as a bare AbortError, which would
    // be reported as an unexplained failure. It is a known one.
    if (outOfTime()) {
      streamer.warning(timedOutMessage())
      return finishAttempt(false)
    }
    errorMessage = e instanceof Error ? e.message : String(e)
    streamer.error(`Worker failed: ${errorMessage}`)
    return finishAttempt(false)
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer)
  }
}
