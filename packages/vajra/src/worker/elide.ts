import type { ChatMessage } from '../model/chat.js'
import type { WorkLedger } from './ledger.js'

/**
 * Rung 1 of the compaction ladder: rewrite the tool results that no longer carry
 * anything, in place, without a model call.
 *
 * The conversation keeps its shape — the same messages, the same order, the same
 * tool_call_ids — and only the stale results shrink. That is what makes it safe
 * to do mid-conversation: no dangling call, no reordering, and nothing is dropped
 * silently. Every rewrite says what it replaced and how to fetch it again, the
 * way `output-cap.ts` does, because a Worker that finds a result reduced to a
 * note must be able to tell the difference between "I already saw this" and
 * "this is gone".
 *
 * What is left alone matters as much as what is rewritten. The last
 * `keepRecentRounds` rounds are never touched, and a read that nothing has
 * superseded keeps its contents: it is the only copy the Worker has.
 */

/** What each mutating tool is said to have done, when its result is reduced. */
const EDIT_RESULT: Record<string, string> = {
  edit_file: 'edited',
  write_file: 'wrote',
  delete_file: 'deleted',
  create_dir: 'created',
}

export interface ElideOptions {
  /** Rounds at the end of the conversation that are never rewritten. */
  keepRecentRounds: number
  /** Lines kept of a spent command's output. */
  elidedTailLines: number
  /** Results already rewritten in this attempt, so they are not counted twice. */
  alreadyElided?: ReadonlySet<string>
}

export interface ElideResult {
  messages: ChatMessage[]
  /** How many tool results were rewritten. */
  elided: number
  /** The call ids rewritten, so the caller can remember them. */
  callIds: string[]
}

/**
 * The index before which a tool result may be rewritten. Everything from here to
 * the end of the conversation is the protected tail.
 *
 * A round is one assistant message that asked for tools. `keepRecentRounds` of
 * them, counted back from the end, are protected; everything before the oldest
 * of those is eligible. A conversation with fewer rounds than that protects all
 * of them, which is the correct answer for a Worker three tools deep.
 */
function protectedFrom(messages: readonly ChatMessage[], keepRecentRounds: number): number {
  if (keepRecentRounds <= 0) return messages.length
  const rounds: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0) rounds.push(i)
  }
  if (rounds.length < keepRecentRounds) return 0
  return rounds[rounds.length - keepRecentRounds]
}

/** The last `n` lines of text, which is where a failure is. */
function tail(text: string, n: number): string {
  if (n <= 0) return ''
  const lines = text.split('\n')
  if (lines.length <= n) return text
  return lines.slice(lines.length - n).join('\n')
}

/**
 * The end of what a command printed.
 *
 * A command result is one JSON line, so tailing the envelope would keep the
 * whole thing — including the output that was already read and acted on. The
 * stdout and stderr inside it are the lines that matter, so those are what is
 * kept, and a result that is not that shape falls back to the raw text.
 */
function commandTail(content: string, n: number): string {
  try {
    const parsed = JSON.parse(content) as { stdout?: unknown; stderr?: unknown }
    if (typeof parsed !== 'object' || parsed === null) return tail(content, n)
    const stdout = typeof parsed.stdout === 'string' ? parsed.stdout : ''
    const stderr = typeof parsed.stderr === 'string' ? parsed.stderr : ''
    const combined = `${stdout}${stderr === '' ? '' : `\n${stderr}`}`.trim()
    return combined === '' ? '' : tail(combined, n)
  } catch {
    return tail(content, n)
  }
}

/**
 * The paths a search result names.
 *
 * Both search tools answer with text, not a structure: `search_content` gives
 * `path:line: text` and `search_files` gives `path [meta]`. Reducing one to a
 * path list is only worth doing while the list still tells the Worker where to
 * look, so a result whose shape is not recognised is left alone rather than
 * emptied into something that reads like "nothing matched".
 */
export function pathsInSearchResult(tool: string, content: string): string[] {
  if (content === 'No matches found.' || content === 'No matching files found.') return []
  const paths: string[] = []
  for (const line of content.split('\n')) {
    const match =
      tool === 'search_content'
        ? /^([^\s:]+):\d+:/.exec(line)
        : /^([^\s[]+)\s\[/.exec(line)
    if (!match) continue
    if (!paths.includes(match[1])) paths.push(match[1])
  }
  return paths
}

/** The note that replaces one stale tool result, or `null` to leave it alone. */
function elisionFor(
  message: ChatMessage,
  ledger: WorkLedger,
  options: ElideOptions,
): string | null {
  const callId = message.tool_call_id
  if (callId === undefined) return null
  const entry = ledger.forCall(callId)
  if (!entry) return null
  const content = message.content ?? ''
  const path = entry.path ?? '(no path)'

  const verb = EDIT_RESULT[entry.tool]
  if (verb !== undefined && entry.mutated) {
    return `ok: ${verb} ${path}`
  }

  if (entry.tool === 'read_file') {
    if (!ledger.supersededBy(entry)) return null
    return (
      `[elided] ${path} was read here. It has since been read again or changed, so this copy is stale. ` +
      `Call read_file({ "path": ${JSON.stringify(path)} }) if you need it.`
    )
  }

  if (entry.command !== undefined) {
    if (!ledger.rerunAfter(entry)) return null
    const kept = commandTail(content, options.elidedTailLines)
    return [
      `[elided] \`${entry.command}\` was run here and later run again. Its result was: exit ${entry.exitCode ?? -1}.`,
      kept.trim() === '' ? '' : `The end of its output:\n${kept}`,
    ]
      .filter(line => line !== '')
      .join('\n')
  }

  if (entry.tool === 'search_content' || entry.tool === 'search_files') {
    const paths = pathsInSearchResult(entry.tool, content)
    if (paths.length === 0) return null
    return `[elided] ${entry.tool} matched ${paths.length} path(s): ${paths.join(', ')}. Call it again to see the matches.`
  }

  return null
}

/**
 * Rewrite the stale results in `messages`, in place, and report how many.
 *
 * The input array is never mutated: `execute.ts` passes the live conversation,
 * and a rewrite that could fail halfway must not leave a half-rewritten history
 * behind.
 */
export function elideMessages(
  messages: readonly ChatMessage[],
  ledger: WorkLedger,
  options: ElideOptions,
): ElideResult {
  const from = protectedFrom(messages, options.keepRecentRounds)
  const out = messages.map(message => ({ ...message }))
  const callIds: string[] = []
  for (let i = 0; i < from && i < out.length; i++) {
    if (out[i].role !== 'tool') continue
    if (options.alreadyElided?.has(out[i].tool_call_id ?? '')) continue
    const replacement = elisionFor(out[i], ledger, options)
    if (replacement === null) continue
    out[i] = { ...out[i], content: replacement }
    callIds.push(out[i].tool_call_id ?? '')
  }
  return { messages: out, elided: callIds.length, callIds }
}