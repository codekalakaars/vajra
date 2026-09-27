import { resolveApiKeyForModel } from '../../env.js'
import { isExitCommand } from '../../session/service.js'
import type { SessionStore } from './store.js'

/**
 * The credential gate, shared by both front-ends.
 *
 * A session with no API key cannot start: `runSession` returns before it asks
 * anything. Both shells used to discover that by *running* one — the user
 * typed a task, watched it bounce, and was told only that a key was missing
 * after the fact. Worse, the OpenTUI host read the bail as "the run ended" and
 * started the next one immediately, so a machine with no key sat in a loop
 * appending an error and republishing the whole snapshot until the heap died.
 *
 * So the key comes first, and it is asked for on screen: a `no-key` prompt
 * that says what is missing, the two commands that fix it, and a typed task
 * held rather than thrown away. The moment a key exists — from the env, from
 * `~/.vajra/auth.json`, or from `--api-key` — the held task runs.
 */

/** What the screen says, once, the first time it has to wait. */
const NO_KEY_NOTICE: readonly string[] = [
  'No API key configured — vajra cannot reach the model gateway yet.',
  "Set one with 'vajra auth login <key>' or 'export OPENCODE_API_KEY=…'. This screen picks it up on its own; a task typed now is held until then.",
]

/** Stores that have already been told, so a second Enter does not repeat it. */
const told = new WeakSet<SessionStore>()

/**
 * How often a gated gate looks for a key that appeared.
 *
 * A poll rather than a keypress, for two reasons. Enter on an empty prompt is
 * nothing to either front-end — OpenTUI will not submit an empty line at all —
 * so "press Enter to retry" would be a lie the user could not act on. And a key
 * arrives from outside this process: `vajra auth login` in another terminal,
 * or an `export` in the shell they are about to come back to. Watching for it
 * means the screen moves on by itself the moment it exists.
 */
const GATE_POLL_MS = 1000

/** Resolves to undefined after `ms`, so a race against a prompt can time out. */
function after(ms: number): Promise<undefined> {
  return new Promise<undefined>(resolve => {
    // Unref'd: a pending gate must never be the reason the process stays up.
    setTimeout(() => resolve(undefined), ms).unref?.()
  })
}

export type IdleOutcome =
  /** A task to run, and the key to run it with. */
  | { kind: 'task'; task: string; key: string }
  /** The user typed exit/quit at the prompt. */
  | { kind: 'exit'; key: string | undefined }
  /** The shell is shutting down (Ctrl-C, /quit): stop, run nothing. */
  | { kind: 'quit'; key: string | undefined }

export interface IdleParams {
  store: SessionStore
  /** The model whose key is being resolved — zen/* and go/* share one. */
  model: string
  /** `--api-key`, when the user gave one on the command line. */
  explicitKey?: string | null
  /** The key resolved for the previous run, if there was one. */
  currentKey?: string
  /** True once an idle prompt has been shown; picks the re-entry wording. */
  asked: boolean
  /**
   * True once the shell is shutting down. Checked between prompts so a
   * Ctrl-C at the gate leaves instead of parking on a prompt nobody will fill.
   */
  stopping: () => boolean
  /** Gate poll cadence. Tests pass a small one; the app takes the default. */
  pollMs?: number
}

/**
 * One idle turn: a key if there is not one already, then a task.
 *
 * The shells call this where they used to ask for a task directly, so both
 * get the gate, the held task and the exit handling from one place.
 */
export async function askForTask(params: IdleParams): Promise<IdleOutcome> {
  const { store, model, explicitKey = null, currentKey, asked, stopping } = params
  const pollMs = params.pollMs ?? GATE_POLL_MS
  const resolve = (): string | undefined => currentKey ?? resolveApiKeyForModel(model, explicitKey ?? undefined)
  /** A task typed while the gate was up, run as soon as there is a key. */
  let held: string | undefined
  /** The open prompt, kept so the poll can race it instead of replacing it. */
  let prompt: Promise<string> | null = null

  for (;;) {
    if (stopping()) return { kind: 'quit', key: resolve() }
    const key = resolve()
    if (key) {
      prompt = null
      if (held !== undefined) {
        const task = held
        held = undefined
        return { kind: 'task', task, key }
      }
      const message = await store.ask(asked ? 'initial-reentry' : 'initial-first')
      if (stopping()) return { kind: 'quit', key }
      if (isExitCommand(message)) return { kind: 'exit', key }
      if (!message.trim()) continue
      return { kind: 'task', task: message.trim(), key }
    }

    if (!told.has(store)) {
      told.add(store)
      for (const text of NO_KEY_NOTICE) store.addEntry({ kind: 'warning', text })
    }
    prompt ??= store.ask('no-key')
    const answered = await Promise.race([prompt, after(pollMs)])
    // The poll won: the prompt is still open, so only the key was re-read.
    if (answered === undefined) continue
    prompt = null
    if (isExitCommand(answered)) return { kind: 'exit', key: resolve() }
    const typed = answered.trim()
    if (typed) {
      held = typed
      store.addEntry({
        kind: 'info',
        text: `Task held — "${typed}" starts as soon as an API key is configured.`,
      })
    }
  }
}
