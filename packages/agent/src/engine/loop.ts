import type { ModelToolCall, ToolExecutor } from '../contracts/index.js'

/**
 * What the engine needs to know about who it is running for: a name, and the
 * task it is bound to.
 *
 * Deliberately not the package's `AgentLabel`. The engine passes this through
 * to events and never branches on it, so requiring the full role union would
 * couple it to a rename that has not happened yet — the CLI still says
 * `master` where the contracts say `manager`, and an engine that insisted on
 * the new spelling could not be adopted by the code that has the old one.
 */
export interface RunLabel {
  role: string
  taskId?: string
  title?: string
}

/**
 * The three events the engine emits.
 *
 * A subset of the host-facing `AgentEvent`, and structurally identical for
 * these three cases. A host's own emit function takes the wider union, so it
 * accepts these; the engine does not need to know about `phase` or `warning`,
 * which only a role profile produces.
 */
export type LoopEvent<L extends RunLabel = RunLabel> =
  | { type: 'tool-start'; agent: L; callId: string; tool: string; summary: string }
  | {
      type: 'tool-end'
      agent: L
      callId: string
      tool: string
      ok: boolean
      ms: number
      detail?: string
    }
  | { type: 'heartbeat'; agent: L; elapsedMs: number }

/**
 * The tool-call path, once.
 *
 * `developer.ts` and `execute.ts` each wrote this sequence: parse the
 * arguments, announce the call, run it inside a heartbeat, coerce the result,
 * announce the outcome. It was the same code with the same comment in both
 * files, and it is the part a refactor is most likely to break in a way no unit
 * test notices — a swapped announce, a lost coercion, a heartbeat that outlives
 * the call.
 *
 * What is deliberately *not* here: the budget, the batching strategy, and
 * argument validation. All three differ per role today, and unifying them would
 * be a behaviour change wearing a refactor's clothes. The two loops keep their
 * own ordering and pass in what they want; this module owns the part they
 * actually share.
 *
 *   Developer: tool-start → budget check → dispatch
 *   Worker:    budget check → tool-start → dispatch
 */

/**
 * Tools that only read. The model may have many of these in one message, and
 * they are the only ones safe to run concurrently.
 *
 * This set was duplicated byte-for-byte in both loops, comment included, which
 * is the kind of duplication that survives a rename of one copy and not the
 * other. It is a protocol fact — the same thirteen tools in
 * `@codekalakaars/vajra-protocol` — and belongs in one place.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'list_files',
  'search_files',
  'search_content',
])

/** Host policy the engine asks for rather than decides. */
export interface LoopHooks<L extends RunLabel = RunLabel> {
  emit: (event: LoopEvent<L>) => void
  /**
   * The one argument worth showing for a call. Host policy, not engine policy:
   * what is worth showing a human differs between a TUI and a log.
   */
  summariseCall: (tool: string, args: unknown) => string
  /** A short outcome for the transcript: "4.2 KB", "3 matches", "exit 1". */
  summariseResult: (
    tool: string,
    args: unknown,
    raw: unknown,
    ms: number,
  ) => { ok: boolean; detail?: string }
}

export interface DispatchOptions<L extends RunLabel = RunLabel> extends LoopHooks<L> {
  agent: L
  call: ModelToolCall
  executor: ToolExecutor
  signal?: AbortSignal
  /**
   * Whether to emit `tool-start` here.
   *
   * The two loops announce at different moments relative to the budget check —
   * the Developer announces, *then* charges, so a call it refuses is still
   * reported; the Worker charges first and never announces a call it cannot
   * afford. Announcing is therefore the caller's business when the ordering
   * matters, and the engine's when it does not. It is one boolean rather than
   * two code paths because the rest of the sequence is identical.
   */
  announceStart?: boolean
}

export interface DispatchResult {
  /** What goes into the tool message. Never a rejection — see below. */
  content: string
  ok: boolean
  /** Parsed arguments, or undefined when the model sent something unparseable. */
  args: unknown
  /** The executor's return value, before coercion. */
  raw: unknown
  ms: number
  detail?: string
}

/** Coerce whatever the executor returned into something a tool message can hold. */
function toContent(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result)
}

/**
 * Run one tool call and report it.
 *
 * A call that throws does not reject: it comes back as `ok: false` with the
 * message as its content, because the model is owed an answer either way. A
 * dangling tool call is what corrupts the next provider request, so the
 * conversation is never left with a call that has no reply.
 */
export async function dispatchToolCall<L extends RunLabel>(options: DispatchOptions<L>): Promise<DispatchResult> {
  const { agent, call, executor, emit, summariseCall, summariseResult, signal } = options
  const announceStart = options.announceStart !== false
  const tool = call.function.name
  const started = Date.now()

  // Parsed for the summary only. Whether the arguments are *valid* is the
  // caller's business: the Developer validates against the tool schema, the
  // Worker does not, and that difference is C3 in the migration plan rather
  // than something to quietly settle here.
  let args: unknown
  let unparseable: string | null = null
  try {
    args = JSON.parse(call.function.arguments)
  } catch (error) {
    args = undefined
    unparseable = error instanceof Error ? error.message : String(error)
  }

  if (announceStart) {
    emit({ type: 'tool-start', agent, callId: call.id, tool, summary: summariseCall(tool, args) })
  }

  const stopHeartbeat = startHeartbeat<L>(emit, agent)
  let raw: unknown
  let ok = false
  let detail: string | undefined
  try {
    if (unparseable !== null) {
      // The tool is not run with arguments it was never given. Calling it with
      // `undefined` made it fail on "reading 'path'", which tells a model
      // nothing about what it did wrong; a model that cannot tell that its JSON
      // was malformed concludes that the *content* is the problem and starts
      // working around backticks and quotes instead of re-sending the call.
      raw =
        `Error: the arguments of this ${tool} call were not valid JSON (${unparseable}), so nothing was run. ` +
        'Send the call again with valid JSON: inside a string, write a newline as \\n, a tab as \\t, ' +
        'a double quote as \\" and a backslash as \\\\. Backticks and single quotes need no escaping.'
    } else {
      raw = await executor.callTool(tool, args, { signal })
      const outcome = summariseResult(tool, args, raw, Date.now() - started)
      ok = outcome.ok
      detail = outcome.detail
    }
  } catch (error) {
    raw = `Error: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    stopHeartbeat()
  }

  emit({ type: 'tool-end', agent, callId: call.id, tool, ok, ms: Date.now() - started, ...(detail === undefined ? {} : { detail }) })

  return { content: toContent(raw), ok, args, raw, ms: Date.now() - started, detail }
}

/**
 * Emit a heartbeat while a call runs, so a screen that is waiting on something
 * slow still moves. Unref'd, because a pending heartbeat must never be the
 * reason a process stays alive.
 */
export function startHeartbeat<L extends RunLabel>(
  emit: (event: LoopEvent<L>) => void,
  agent: L,
  intervalMs = 750,
): () => void {
  const startedAt = Date.now()
  const timer = setInterval(() => {
    emit({ type: 'heartbeat', agent, elapsedMs: Date.now() - startedAt })
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

export interface BudgetState {
  used: number
}

/**
 * The refusal a budget produces.
 *
 * Not an exception and not a silent drop: the model is told the budget is spent
 * and gets a tool result it can read, so the conversation stays well-formed
 * instead of ending on a call nobody answered.
 */
export function budgetExhausted(tool: string, used: number, limit: number): string {
  return `Error: Tool call budget exhausted (${used}/${limit}) before '${tool}'. Report what you have.`
}

/** True when this call is free and must not be charged. */
export function isFreeTool(tool: string, freeTools: ReadonlySet<string> | undefined): boolean {
  return freeTools?.has(tool) === true
}
