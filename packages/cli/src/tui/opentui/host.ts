import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Writable } from 'node:stream'
import { resolveApiKeyForModel } from '../../env.js'
import { listSessions as listPersistedSessions, type SessionSummary } from '../../persist/index.js'
import { bareModel } from '../../models/catalog.js'
import type { ReasoningEffort } from '../../agent/chat.js'
import {
  describeModel,
  hasCatalog,
  listModels,
  loadModelCatalog,
  refreshModelStatus,
} from '../../models/catalog.js'
import { runSession, type SessionResult } from '../../session/service.js'
import { SessionStore } from '../session/store.js'
import { InkSessionUI } from '../session/ink-ui.js'
import { HELP_LINES, SLASH_COMMANDS, findSlashCommand, parseSlashCommand } from '../session/commands.js'
import type { TuiSessionOptions } from '../session/index.js'
import type { ClientMessage, ServerMessage, UiState } from './protocol.js'

/**
 * The Node half of the split runtime: it owns the agent, the sandbox and the
 * session store, and the Bun process draws it.
 *
 * The child is not a renderer we call into — it owns the terminal. Keys go from
 * the tty to the child, frames come back on the tty, and the only thing that
 * crosses the pipe is NDJSON: snapshots down, answers up. That split is what
 * lets the UI be OpenTUI (which needs Bun's FFI) while the agent stays on Node
 * (which owns the native module and the worker pool).
 *
 * There is no delta protocol. The store is the truth and a snapshot cannot
 * drift from it, so every change republishes the whole thing; a few kilobytes
 * over a pipe cost less than the bug where the screen and the store disagree.
 */

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')

/** bun, from PATH or next to the running node. */
function bunBinary(): string {
  const fromEnv = process.env.VAJRA_BUN
  if (fromEnv) return fromEnv
  const sibling = join(dirname(process.execPath), 'bun')
  return existsSync(sibling) ? sibling : 'bun'
}

/** Where the UI entry point lives, so a missing build fails loudly. */
function uiEntry(): string {
  const candidates = [
    process.env.VAJRA_TUI_ENTRY,
    join(PACKAGE_ROOT, 'packages/tui/src/main.tsx'),
    join(PACKAGE_ROOT, 'dist-tui/main.tsx'),
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  throw new Error(
    `The OpenTUI front-end is missing. Looked in:\n${candidates.join('\n')}\nBuild it with 'pnpm --filter @codekalakaars/vajra-tui build', or set VAJRA_TUI_ENTRY.`,
  )
}

/** The store's public shape, minus what only the Ink renderer used. */
function toUiState(store: SessionStore, version: string): UiState {
  const state = store.getSnapshot()
  return {
    version,
    model: state.model,
    projectDir: state.projectDir,
    entries: state.entries.map(entry =>
      entry.kind === 'plan'
        ? {
            kind: 'plan' as const,
            title: `plan · ${entry.plan.tasks.length} task${entry.plan.tasks.length === 1 ? '' : 's'}`,
            steps: entry.plan.tasks.map(task => task.title),
          }
        : entry.kind === 'banner'
          ? { kind: 'banner' as const, version: entry.version }
          : entry,
    ),
    streaming: state.streaming,
    thinking: state.thinking,
    prompt: state.prompt ? { kind: state.prompt.kind, label: state.prompt.label } : null,
    tasks: state.tasks.map(task => ({
      title: task.title,
      status: task.status,
      ...(task.activity ? { activity: task.activity } : {}),
    })),
    executionIndex: state.executionIndex,
    executionTotal: state.executionTotal,
    interrupted: state.interrupted,
    usage: state.usage,
    reasoning: state.reasoning,
    reasoningLevels: state.reasoningLevels,
    modelInfo: state.modelInfo,
    tick: state.tick,
  }
}

/**
 * Read the screen's replies: one JSON object per line, partial lines buffered.
 * Returns a stop function, because the child outlives every listener if the
 * session throws on the way out.
 */
function readAnswers(child: ReturnType<typeof spawn>, onMessage: (message: ClientMessage) => void): () => void {
  const channel = child.stdio[4]
  if (!channel) return () => {}
  let buffered = ''
  const onData = (chunk: Buffer | string): void => {
    buffered += chunk.toString()
    let nl = buffered.indexOf('\n')
    while (nl !== -1) {
      const line = buffered.slice(0, nl)
      buffered = buffered.slice(nl + 1)
      if (line.trim() !== '') {
        try {
          onMessage(JSON.parse(line) as ClientMessage)
        } catch {
          // A truncated line is not worth taking the session down for.
        }
      }
      nl = buffered.indexOf('\n')
    }
  }
  channel.on('data', onData)
  return () => channel.off('data', onData)
}

/** The package root: the nearest ancestor of the entry that has a bunfig.toml. */
function uiRoot(entry: string): string {
  let dir = dirname(entry)
  for (let depth = 0; depth < 5; depth++) {
    if (existsSync(join(dir, 'bunfig.toml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dirname(entry)
}

/**
 * The Solid JSX transform, by path, for `--preload`.
 *
 * Two traps, both of which produce a screen that never appears. The package
 * must be read from the UI package, because pnpm's strict layout hides the UI's
 * dependencies from us. And the *Bun* build must be named explicitly: the
 * package's node entrypoint throws on import by design, and a plain resolve()
 * picks it, because this code is running in Node.
 */
function solidPreload(root: string): string {
  const resolved = createRequire(join(root, 'package.json')).resolve('@opentui/solid/preload')
  return resolved.endsWith('.node.js') ? resolved.replace(/\.node\.js$/, '.js') : resolved
}

export async function startOpenTuiSession(options: TuiSessionOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return 1

  const bun = bunBinary()
  const entry = uiEntry()

  let model = options.model
  let projectDir = options.projectDir
  const explicitKey = options.apiKey ?? null
  let apiKey = explicitKey ?? resolveApiKeyForModel(model)
  const store = new SessionStore({ model, projectDir })
  const ui = new InkSessionUI(store, options.version)

  // The model catalog, then the gateway's own listing. Both are best-effort and
  // neither is awaited before the first paint: a screen that waits on a network
  // round-trip to draw a prompt is a screen that looks broken on a bad network.
  // What they produce — the context window, the reasoning dial, which models
  // exist — is folded in as soon as it lands, and until then every lookup falls
  // back to the conservative defaults.
  const primeModels = async (force = false): Promise<void> => {
    await loadModelCatalog({ force })
    await refreshModelStatus(apiKey)
    store.refreshModelInfo()
  }
  void primeModels()

  // stdin carries snapshots down, descriptor 4 carries answers up. The child
  // keeps the terminal for frames and keys, so it must not own stdout.
  // The child keeps the terminal: stdin for keys, stdout for frames. The
  // renderer only enters raw mode if *stdin* is a tty, so the terminal cannot be
  // traded away for a pipe. The conversation therefore rides two extra
  // descriptors — 3 down, 4 up — and nothing else crosses.
  // Solid's JSX is a compile-time transform, not a runtime import, so Bun needs
  // the plugin before it can run a .tsx file. It is named explicitly rather than
  // left to bunfig.toml: the host's working directory is the user's project, not
  // this package, and without the transform Bun applies its default React one
  // and dies with 'Cannot find module react/jsx-dev-runtime'.
  const root = uiRoot(entry)
  const child = spawn(bun, ['--preload', solidPreload(root), entry], {
    cwd: root,
    stdio: ['inherit', 'inherit', 'inherit', 'pipe', 'pipe'],
    env: { ...process.env, VAJRA_FEED_FD: '3', VAJRA_INPUT_FD: '4' },
  })
  const answers = child.stdio[4]
  // Descriptor 3 is the snapshot channel, 4 is the answer channel.
  const toScreen = child.stdio[3] as Writable | null
  if (!answers || !toScreen) throw new Error('Failed to open the pipes to the UI process')
  // The screen owns the terminal and exits on its own terms, so the pipe to it
  // can be gone by the time this runs. A dead screen is the normal end of a
  // session, not an error worth a stack trace on the way out.
  toScreen.on('error', () => {})
  const send = (message: ServerMessage): void => {
    if (toScreen.destroyed || toScreen.writableEnded) return
    toScreen.write(`${JSON.stringify(message)}\n`)
  }
  const publish = (): void => send({ t: 'state', state: toUiState(store, options.version) })

  // The answer channel: the screen is a terminal, so its replies arrive as
  // NDJSON on the extra pipe rather than as events. Nothing works without this.
  let answering = readAnswers(child, message => {
    if (message.t === 'submit') submit(message.value)
    else if (message.t === 'slash') void runCommand(message.name)
    else if (message.t === 'signal' && message.name === 'interrupt') interrupt()
    else if (message.t === 'pick') {
      const waiting = pendingPick
      pendingPick = null
      waiting?.resolve(message.value)
    }
    // 'ready' only reports the geometry, which the screen already knows.
  })

  // Nothing in this process may read the terminal: the child is the keyboard.
  // A single stray reader here wins the race and swallows every keystroke,
  // which looks exactly like a screen with no input handling.
  process.stdin.pause()
  process.stdin.unref?.()

  const unsubscribe = store.subscribe(publish)
  send({ t: 'commands', commands: SLASH_COMMANDS.map(({ name, summary }) => ({ name, summary })) })
  publish()

  let controller: AbortController | null = null
  /** The live sandbox, so a forced quit can tear it down instead of leaking. */
  let closeSandbox: (() => void) | null = null
  let quitRequested = false
  /** A picker the UI is showing; the answer comes back as { t: 'pick' }. */
  let pendingPick: { resolve: (value: string | null) => void } | null = null

  const ask = (
    title: string,
    options: { value: string; label: string }[],
    initial?: number,
  ): Promise<string | null> =>
    new Promise(resolve => {
      pendingPick = { resolve }
      send({ t: 'pick', title, options, ...(initial !== undefined ? { initial } : {}) })
    })

  const interrupt = (): void => {
    store.markInterrupted()
    controller?.abort()
    store.addEntry({
      kind: 'warning',
      text: 'Interrupted. Finishing current step — press Ctrl-C again to force quit.',
    })
  }

  const quit = (): void => {
    quitRequested = true
    const prompt = store.getSnapshot().prompt
    if (prompt && (prompt.kind === 'user' || prompt.kind === 'initial-first' || prompt.kind === 'initial-reentry')) {
      store.submitPrompt('exit')
    } else {
      store.markInterrupted()
      controller?.abort()
    }
  }

  /**
   * End the run in flight so the loop can pick up what a command just set.
   *
   * A slash command is answered at the prompt *without* answering it, which is
   * right for `/help` and wrong for anything that changes what the next run
   * should be: the session is parked in `ask`, so `nextRun` is set and never
   * read, and `/dir` and `/sessions` look like they did nothing at all. The
   * prompt is answered with `exit`, the run unwinds, and the loop starts the
   * next one — which is what the Ink shell does for the same two commands.
   */
  const endRunForNext = (): void => {
    if (store.getSnapshot().prompt) store.endPromptQuietly()
  }

  /** A line submitted at the prompt: a slash command, or a task. */
  const submit = (value: string): void => {
    const trimmed = value.trim()
    if (trimmed === '') return
    if (!store.getSnapshot().prompt) {
      // Typed at an idle prompt with nothing pending: treat it as a task.
      void runTask(trimmed)
      return
    }
    const parsed = parseSlashCommand(trimmed)
    if (parsed?.known) {
      void runCommand(parsed.command)
      return
    }
    if (parsed) {
      store.addEntry({ kind: 'error', text: `Unknown command ${parsed.name} — type /help for the list.` })
      return
    }
    store.submitPrompt(value)
  }

  const runCommand = async (name: string): Promise<void> => {
    const command = findSlashCommand(name)?.name
    if (!command) return
    if (command === 'quit') {
      quit()
      return
    }
    if (command === 'help') {
      for (const line of HELP_LINES) store.addEntry({ kind: 'info', text: line })
      return
    }
    if (command === 'reasoning') {
      // A list to choose from, not a dial to cycle. The levels differ per model
      // — some take `xhigh` and `max`, some only a toggle, some do not reason at
      // all — and cycling through them means counting presses without ever
      // seeing what the options are. A picker shows them, filters as you type,
      // and opens on the one in play.
      const state = store.getSnapshot()
      const levels = state.reasoningLevels
      if (levels.length <= 1) {
        store.addEntry({
          kind: 'info',
          text: `${state.model} does not reason — there is no level to choose. /models is gone; the sidebar's Model section says what it takes.`,
        })
        return
      }
      const picked = await ask(
        `How hard should ${bareModel(model)} think?`,
        levels.map(level => ({
          value: level,
          label: level === 'off' ? 'off  ·  no reasoning parameter is sent' : level,
        })),
        Math.max(0, levels.indexOf(state.reasoning)),
      )
      if (picked === null) return
      store.setSettings({ reasoning: picked as ReasoningEffort })
      return
    }
    if (command === 'sessions') {
      // The DB, not a directory. This used to read `~/.vajra/sessions` and take
      // ids out of filenames — a directory nothing has ever written, so the
      // picker offered "new session" and nothing else, and the ids it would have
      // offered were not the ones `loadSession` looks up. Every run is recorded
      // in `~/.vajra/vajra.db`, and that is where the list comes from.
      const picked = await ask('Resume which session?', [
        { value: '__none__', label: 'new session' },
        ...listPersistedSessions(projectDir).map(sessionRow),
      ])
      if (picked !== null && picked !== '__none__') {
        nextRun = { resumeFrom: picked }
        endRunForNext()
      }
      return
    }
    if (command === 'model') {
      // The list is the live catalog, not a hardcoded array: a model retired
      // yesterday must not still be offered, and one released this morning must
      // be. A refresh first, because this is the command where being stale is
      // most visible.
      await primeModels(true)
      // Only what this key can actually reach. The catalog knows 150-odd models
      // and the gateway serves a fraction of them; offering the rest would be
      // offering a 400 on the first round of the next task. `/models` still
      // reports the whole catalog, and the count of what is hidden is said out
      // loud rather than quietly dropped.
      const options = listModels()
      if (options.length === 0) {
        store.addEntry({
          kind: 'warning',
          text: `No model catalog available (${hasCatalog() ? 'empty' : 'not fetched'}); keeping ${model}.`,
        })
        return
      }
      const hidden = listModels({ includeUnavailable: true }).length - options.length
      const picked = await ask(
        hidden > 0 ? `Which model? (${hidden} more are not served to this key)` : 'Which model?',
        options.map(info => ({
          value: info.id,
          label: `${describeModel(info)}${info.id === model ? '  · current' : ''}`,
        })),
        // Land on the model in play rather than at the top of the alphabet.
        Math.max(
          0,
          options.findIndex(info => info.id === model),
        ),
      )
      if (picked === null) return
      model = picked
      apiKey = explicitKey ?? resolveApiKeyForModel(model)
      store.setSettings({ model })
      return
    }
    if (command === 'dir') {
      const picked = await ask('Which directory?', [
        { value: projectDir, label: `${projectDir}  (current)` },
        { value: process.cwd(), label: process.cwd() },
      ])
      if (picked !== null && picked !== projectDir) {
        projectDir = picked
        store.setSettings({ projectDir })
        nextRun = 'ask'
        endRunForNext()
      }
      return
    }
  }

  /** One runSession, wired to the interruptible controller. */
  const runTask = async (task: string | undefined, resumeFrom?: string): Promise<SessionResult | null> => {
    const run = new AbortController()
    controller = run
    try {
      return await runSession(
        {
          ...(task !== undefined ? { task } : {}),
          ...(resumeFrom !== undefined ? { resumeFrom } : {}),
          // A human is at the keyboard: let the developer see how the plan fared.
          continueAfterExecution: true,
          apiKey,
          model,
          // Read per run, not once: ctrl-r mid-session changes the next run.
          reasoningEffort: store.getSnapshot().reasoning,
          projectDir,
          signal: run.signal,
          onSandboxClose: close => {
            closeSandbox = close
          },
          ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
          ...(options.autoConfirm !== undefined ? { autoConfirm: options.autoConfirm } : {}),
          ...(options.allowUnenforced !== undefined ? { allowUnenforced: options.allowUnenforced } : {}),
          ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
        },
        ui,
      )
    } catch (error) {
      store.addEntry({ kind: 'error', text: `Session error: ${error instanceof Error ? error.message : String(error)}` })
      store.resetInterrupted()
      return null
    } finally {
      controller = null
      store.resetInterrupted()
    }
  }

  /** What the loop should run next, set by a command while a run is live. */
  let nextRun: { task?: string; resumeFrom?: string } | 'ask' | null = null

  // ---- the loop ------------------------------------------------------------
  let exitCode = 0
  let next: { task?: string; resumeFrom?: string } | 'ask' | null = options.initialTask !== undefined
    ? { task: options.initialTask }
    : options.resumeFrom !== undefined
      ? { resumeFrom: options.resumeFrom }
      : 'ask'

  try {
    while (!quitRequested) {
      const result =
        next === 'ask'
          ? await runTask(undefined)
          : await runTask(next.task, next.resumeFrom)
      next = null

      if (quitRequested) {
        exitCode = 0
        break
      }

      const pending = nextRun
      nextRun = null
      if (pending !== null) {
        next = pending
        continue
      }

      if (result?.exited && !result.interrupted) {
        exitCode = result.exitCode
        break
      }

      if (result && !result.interrupted) {
        const usage = store.getSnapshot().usage
        const k = (n: number): string => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n))
        const rounds =
          usage.calls > 0
            ? ` · ${usage.calls} round${usage.calls === 1 ? '' : 's'} · in ${k(usage.promptTokens)} · out ${k(usage.completionTokens)}`
            : ''
        store.addEntry({
          kind: 'info',
          text: `Session ended (exit ${result.exitCode})${rounds} — type a task to continue.`,
        })
      }
      next = 'ask'
    }
  } finally {
    answering()
    unsubscribe()
    send({ t: 'exit', code: exitCode })
    toScreen.end()
    // Give the child a moment to paint its exit line before the tty is torn down.
    await new Promise(resolve => setTimeout(resolve, 80))
    child.kill('SIGTERM')
  }
  return exitCode
}

/** Persisted sessions for /sessions, newest first. Best effort by design. */
/** Compact age for a session row: 4s, 12m, 3h, 5d. */
function sessionAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * One session as a picker row: the columns the Ink picker shows, so the two
 * front-ends list a session the same way.
 *
 * The id is the row's value, and it is the id the database is keyed by — the
 * one `loadSession` takes and the only one that can resume anything.
 */
function sessionRow(session: SessionSummary): { value: string; label: string } {
  const title = (session.planTitle ?? session.status).replace(/\s+/g, ' ').trim()
  return {
    value: session.sessionId,
    label: [
      session.sessionId.slice(0, 8),
      session.phase.padEnd(12),
      `${session.done}/${session.total}`.padEnd(6),
      sessionAge(Date.now() - session.updatedAt).padEnd(6),
      title,
    ].join('  '),
  }
}

/** Re-exported so the CLI entry can route a raw line without importing both. */
export type { ClientMessage, ServerMessage, UiState }
