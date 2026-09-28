import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Writable } from 'node:stream'
import { resolveApiKeyForModel } from '../../env.js'
import {
  deleteSession,
  listSessions as listPersistedSessions,
  type SessionSummary,
} from '../../persist/index.js'
import { bareModel } from '../../models/catalog.js'
import type { ReasoningEffort } from '../../agent/chat.js'
import {
  describeModel,
  hasCatalog,
  listModels,
  loadModelCatalog,
  refreshModelStatus,
} from '../../models/catalog.js'
import {
  clearConfig,
  ROLE_PURPOSE,
  readConfig,
  writeConfig,
  type ConfigKey,
  type RoleName,
  type VajraConfig,
} from '../../config.js'
import {
  configOptions,
  directoryOptions,
  effectiveRoleModel,
  hasOverride,
  itemRole,
  modelPickerOptions,
  pathCandidates,
  INHERIT_DEFAULT,
  isWorkingDirectory,
  type ConfigItem,
  type ConfigState,
} from '../session/config-menu.js'
import { runSession, type SessionResult } from '../../session/service.js'
import { SessionStore } from '../session/store.js'
import { askForTask } from '../session/idle-prompt.js'
import { InkSessionUI } from '../session/ink-ui.js'
import { HELP_LINES, SLASH_COMMANDS, findSlashCommand, parseSlashCommand } from '../session/commands.js'
import type { TuiSessionOptions } from '../session/index.js'
import type { ClientMessage, ServerMessage, UiState } from './protocol.js'

/**
 * What a picker answered: a value, and what the user wanted done with it.
 *
 * `pick` is "resume this" or "change to this"; `delete` is the same row with a
 * different intent. Keeping them in one answer is what lets a deletion be
 * answered by the loop below instead of a second conversation with the host.
 */
interface PickAnswer {
  value: string | null
  action: 'pick' | 'delete'
}

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
    else if (message.t === 'signal' && message.name === 'interrupt') {
      if (message.force) forceQuit()
      else interrupt()
    }
    else if (message.t === 'pick') {
      const waiting = pendingPick
      pendingPick = null
      waiting?.resolve(
        message.action === 'delete'
          ? { value: message.value ?? '', action: 'delete' }
          : { value: message.value, action: 'pick' },
      )
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
  /**
   * A picker the UI is showing; the answer comes back as `{ t: 'pick' }`.
   *
   * The answer is a value *and* an intent, because the same row can be the one
   * you want and the one that should not exist, and only the host knows what
   * the second one means.
   */
  let pendingPick: { resolve: (answer: PickAnswer) => void } | null = null

  const ask = (
    title: string,
    options: { value: string; label: string }[],
    initial?: number,
    deletable?: boolean,
    editable?: boolean,
    candidates?: { value: string; label: string }[],
  ): Promise<PickAnswer> =>
    new Promise(resolve => {
      pendingPick = { resolve }
      send({
        t: 'pick',
        title,
        options,
        ...(initial !== undefined ? { initial } : {}),
        ...(deletable === true ? { deletable: true } : {}),
        ...(editable === true ? { editable: true } : {}),
        ...(candidates !== undefined ? { candidates } : {}),
      })
    })

  const interrupt = (): void => {
    store.markInterrupted()
    controller?.abort()
    store.addEntry({
      kind: 'warning',
      text: 'Interrupted. Finishing current step — press Ctrl-C again to force quit.',
    })
  }

  /**
   * Leave now, without waiting for the run to notice.
   *
   * `quit` is a request: it ends the turn, the session unwinds, the sandbox
   * closes and the child is told. This is the second Ctrl-C — the run has
   * already been asked once and is still going, which usually means it is
   * waiting on a provider round trip that will take its time. So: close the
   * sandbox, tell the child, and leave. Anything not yet persisted is lost, and
   * saying so is the honest trade for a keypress that means "I am not waiting".
   */
  const forceQuit = (): void => {
    quitRequested = true
    store.addEntry({ kind: 'warning', text: 'Forced quit. Anything not already saved is lost.' })
    store.markInterrupted()
    controller?.abort()
    closeSandbox?.()
    send({ t: 'exit', code: 130 })
    toScreen.end()
    // Give the child a moment to paint its exit line before the tty is torn
    // down, then stop waiting for it either way.
    setTimeout(() => {
      child.kill('SIGKILL')
      process.exit(130)
    }, 80).unref?.()
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

/**
 * Delete a session and say so in the transcript.
 *
 * The outcome is a line rather than a beep, because the row disappearing from a
 * list the user is looking at is not an answer: a session id is eight hex
 * characters and "the one I meant" is not among them. A refusal is said as a
 * refusal too — a list that silently does not change looks like a key that did
 * not work, and the user tries it again.
 */
  const removeSession = (sessionId: string): boolean => {
    if (!sessionId || sessionId === NEW_SESSION) return false
    const removed = deleteSession(sessionId)
    store.addEntry({
      kind: removed ? 'success' : 'warning',
      text: removed
        ? `Deleted session ${sessionId.slice(0, 8)} and its conversation.`
        : `Could not delete session ${sessionId.slice(0, 8)}.`,
    })
    return removed
  }

  /**
   * The role models this session runs on, and only the ones that differ.
   *
   * Absence is the point: a role with no entry here has no entry in
   * config.json either, so it keeps following the default, and the two cannot
   * drift into disagreeing about what "unset" means.
   */
  const roleModels: Partial<Record<RoleName, string>> = (() => {
    const saved = readConfig()
    const out: Partial<Record<RoleName, string>> = {}
    for (const role of ['developer', 'manager', 'worker'] as const) {
      if (saved[`${role}Model`]) out[role] = saved[`${role}Model`]
    }
    return out
  })()

  /**
   * The store shows the model you are talking to, which is the developer's.
   *
   * The header's context meter and reasoning dial are read off the store's
   * model, and both describe the conversation. Leaving the default there while
   * the developer runs something else would put a confident wrong number in
   * the one place a user checks whether there is room left.
   */
  const applyRoleModels = (): void => {
    store.setSettings({ model: roleModels.developer ?? model })
  }

  /**
   * Whether a session has run in this process.
   *
   * Set by the one place a run begins, so nothing else has to remember it: a
   * conversation that has produced work owns its directory, and /config says so
   * rather than offering a move that would be refused.
   */
  let sessionStarted = false

  /** Directories recent sessions ran in, most recent first, for /config. */
  const recentDirs = (): string[] => {
    const out: string[] = []
    for (const summary of listPersistedSessions()) {
      if (summary.projectDir && !out.includes(summary.projectDir)) out.push(summary.projectDir)
    }
    return out
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

  /**
   * `/config` — every setting a session runs on, on one screen.
   *
   * The screen is a menu of the four settings rather than a walk down them,
   * because the question being asked is "what is this session running on?", and
   * an answer you can only reach by walking past the other three is not an
   * answer. Each row opens a picker of its own and the menu comes back, so all
   * four stay in view while one of them changes.
   *
   * Changes are written to config.json as they are made, not on an exit: a
   * session that gets killed from another terminal should not take the settings
   * with it, and a menu that has to be saved is a menu that gets closed
   * without being saved.
   *
   * Nothing is said in the transcript when a setting changes. The row you just
   * edited is on screen, showing the new value, one row below the cursor that
   * chose it — narrating it into the scrollback is a second copy of a fact the
   * user is looking at, and it pushes the conversation they came to the screen
   * to have further up. Only the two things that can go wrong are said: no
   * catalog to choose from, and a role model the gateway would reject.
   */
  const runConfig = async (): Promise<void> => {
    // The menu remembers the row you were on. Coming back from a sub-picker
    // should put the cursor on the setting you just changed, not on row zero.
    let row = 0
    for (;;) {
      const state = configState()
      const options = configOptions(state)
      const picked = await ask('Configure this session', options, Math.min(row, options.length - 1))
      if (picked.action !== 'pick' || picked.value === null) return
      row = Math.max(0, options.findIndex(option => option.value === picked.value))
      if (picked.value === 'projectDir') {
        await pickDirectory(state)
        continue
      }
      const role = itemRole(picked.value as ConfigItem)
      if (picked.value === 'model') {
        await pickDefaultModel(state)
        continue
      }
      if (role === null) continue
      await pickRoleModel(role, state)
    }
  }

  /**
   * `/config` → the default model's row → the live catalog, and to disk.
   *
   * This row is what `/defaults` used to be for the model half, so choosing here
   * is choosing *the persistent one*: it survives a restart. `/model` remains
   * session-only, which is what it has always been, and the row says which is
   * which rather than leaving it to be discovered.
   */
  const pickDefaultModel = async (state: ConfigState): Promise<void> => {
    await primeModels()
    const models = listModels()
    if (models.length === 0) {
      store.addEntry({
        kind: 'warning',
        text: `No model catalog available (${hasCatalog() ? 'empty' : 'not fetched'}); the default stays ${state.defaultModel}.`,
      })
      return
    }
    const answer = await ask(
      'Default model — what every role runs on unless it has one of its own',
      modelPickerOptions(
        models.map(info => ({ id: info.id, label: describeModel(info) })),
        state.defaultModel,
      ),
      Math.max(0, models.findIndex(info => info.id === state.defaultModel)),
    )
    if (answer.action !== 'pick' || answer.value === null) return
    if (answer.value === state.defaultModel) return
    model = answer.value
    apiKey = explicitKey ?? resolveApiKeyForModel(model)
    writeConfig({ model })
    applyRoleModels()
  }

  /** The models a role has been given, without the ones it has inherited. */
  const configState = (): ConfigState => ({
    defaultModel: model,
    roleOverrides: { ...roleModels },
    projectDir,
    ...(sessionStarted ? { projectDirLocked: true } : {}),
  })

  /** `/config` → a role's row → the live catalog, opened on what it runs now. */
  const pickRoleModel = async (role: RoleName, state: ConfigState): Promise<void> => {
    // Not a forced refresh, unlike `/model`. This picker is nested inside a
    // menu the user just moved the cursor through, so a second spent on a
    // network round-trip between two arrow keys is the difference between a
    // menu and a slideshow. The catalog was primed at startup and has a
    // twelve-hour TTL, so this is a cache read in the normal case and still a
    // refetch when the cache has actually gone stale.
    await primeModels()
    const models = listModels()
    if (models.length === 0) {
      store.addEntry({
        kind: 'warning',
        text: `No model catalog available (${hasCatalog() ? 'empty' : 'not fetched'}); the ${role} stays on ${effectiveRoleModel(state, role)}.`,
      })
      return
    }
    const current = effectiveRoleModel(state, role)
    const answer = await ask(
      `Model for the ${role} — ${ROLE_PURPOSE[role]}`,
      [
        // Inheriting the default is a choice, so it is a row. Making it the
        // absence of an override means the only way back to it is a config file
        // edit, and "I want this role on the default again" is a normal thing
        // to want three minutes after picking a model.
        { value: INHERIT_DEFAULT, label: `default — ${state.defaultModel}` },
        ...modelPickerOptions(
          models.map(info => ({ id: info.id, label: describeModel(info) })),
          current,
        ),
      ],
      hasOverride(state, role) ? Math.max(1, models.findIndex(info => info.id === current)) : 0,
    )
    if (answer.action !== 'pick' || answer.value === null) return
    if (answer.value === INHERIT_DEFAULT) {
      clearConfig([`${role}Model` as ConfigKey])
      delete roleModels[role]
    } else {
      roleModels[role] = answer.value
      writeConfig({ [`${role}Model`]: answer.value } as Partial<VajraConfig>)
    }
    applyRoleModels()
  }

  /**
   * The directory, from places worth being in — and typeable.
   *
   * Recommendations and a text field, because they fail in opposite
   * directions: the recommendations are the paths a user cannot remember, and
   * the field is the path they already know and cannot find in a list of five.
   * A list that cannot be typed into can only offer what it already knew.
   *
   * A path that is not a directory re-asks with the reason in the title rather
   * than saying so in the transcript. The user is standing in a list of
   * directories with something typed; closing it to read a line in the
   * scrollback and come back is the wrong shape for "that one is a file".
   *
   * A session that has already started does not get a new directory at all.
   * Its plans, locks and baselines were all made against that tree, and moving
   * it would apply them somewhere they were never checked. So the row says it
   * is fixed and this never opens.
   */
  const pickDirectory = async (state: ConfigState, problem?: string): Promise<void> => {
    if (sessionStarted) {
      store.addEntry({
        kind: 'warning',
        text: `This session started in ${projectDir}, and that is where it stays — a session's directory is fixed once it begins. Start a new session to work somewhere else.`,
      })
      return
    }
    const candidates = pathCandidates(
      [
        { dir: projectDir, depth: 2 },
        { dir: process.env.HOME ?? process.env.USERPROFILE ?? '', depth: 2 },
      ],
      recentDirs(),
      subDirectories,
    )
    const answer = await ask(
      problem ? `Which directory? — ${problem}` : 'Which directory?',
      directoryOptions(projectDir, process.cwd(), recentDirs(), isWorkingDirectory, undefined, subDirectories),
      0,
      false,
      true,
      candidates.map(dir => ({ value: dir, label: dir })),
    )
    if (answer.action !== 'pick' || answer.value === null) return
    if (answer.value === projectDir) return
    if (!isWorkingDirectory(answer.value)) {
      await pickDirectory(state, `not a directory: ${answer.value}`)
      return
    }
    projectDir = answer.value
    store.setSettings({ projectDir })
    writeConfig({ projectDir })
  }

  /** A directory's sub-directories, or none when it cannot be read. */
  const subDirectories = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    } catch {
      return []
    }
  }

  const runCommand = async (name: string): Promise<void> => {
    const command = findSlashCommand(name)?.name
    if (!command) return
    if (command === 'quit') {
      quit()
      return
    }
    if (command === 'config') {
      await runConfig()
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
      // A level list is never deletable, so `action` can only be 'pick' here —
      // but the answer is a union, and saying so beats a cast that lies.
      if (picked.action !== 'pick' || picked.value === null) return
      store.setSettings({ reasoning: picked.value as ReasoningEffort })
      return
    }
    if (command === 'sessions') {
      // The DB, not a directory. This used to read `~/.vajra/sessions` and take
      // ids out of filenames — a directory nothing has ever written, so the
      // picker offered "new session" and nothing else, and the ids it would have
      // offered were not the ones `loadSession` looks up. Every run is recorded
      // in `~/.vajra/vajra.db`, and that is where the list comes from.
      const options = (): { value: string; label: string }[] => [
        { value: NEW_SESSION, label: 'new session' },
        ...listPersistedSessions(projectDir).map(sessionRow),
      ]
      // A loop, because deleting is not leaving: one deletion is an answer to
      // the same question the user is still asking, and making them reopen the
      // list to delete a second one would be a decision made for them.
      for (;;) {
        const answer = await ask('Resume which session?', options(), 0, true)
        if (answer.value === null) return
        if (answer.action === 'delete') {
          removeSession(answer.value)
          // Nothing left but "new session": there is no longer a list to choose
          // from, so the picker goes back to the prompt rather than sitting
          // there with one unselectable row.
          if (options().length <= 1) return
          continue
        }
        if (answer.value !== NEW_SESSION) {
          nextRun = { resumeFrom: answer.value }
          endRunForNext()
        }
        return
      }
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
      if (picked.action !== 'pick' || picked.value === null) return
      model = picked.value
      apiKey = explicitKey ?? resolveApiKeyForModel(model)
      applyRoleModels()
      // The default changed; a role pinned to a model of its own did not. Saying
      // so is the difference between "my change did nothing" understood and the
      // same thing felt as a bug.
      if (roleModels.developer) {
        store.addEntry({
          kind: 'info',
          text: `Default model is now ${model}. The developer still runs ${roleModels.developer} — /config changes that.`,
        })
      }
      return
    }
  }

  /** One runSession, wired to the interruptible controller. */
  const runTask = async (task: string | undefined, resumeFrom?: string): Promise<SessionResult | null> => {
    // Every run goes through here, including one started by resuming a session,
    // so this is the one place that has to know a session has begun.
    sessionStarted = true
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
          // The roles that have a model of their own. Read per run, like the
          // reasoning dial, so a change made in /config applies to the next
          // task without restarting anything.
          ...(roleModels.developer ? { developerModel: roleModels.developer } : {}),
          ...(roleModels.manager ? { managerModel: roleModels.manager } : {}),
          ...(roleModels.worker ? { workerModel: roleModels.worker } : {}),
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
  let next: { task?: string; resumeFrom?: string } | null =
    options.initialTask !== undefined
      ? { task: options.initialTask }
      : options.resumeFrom !== undefined
        ? { resumeFrom: options.resumeFrom }
        : null
  let askedOnce = false

  try {
    for (;;) {
      /**
       * A key first, then a task.
       *
       * The shell owns the idle prompt rather than delegating it to
       * `runSession(undefined)`: a session that bails before it asks — no key,
       * an unsupported model, a directory that is not there — returned
       * instantly, and the loop read that as "the run ended" and started the
       * next one, over and over, appending an error and republishing the whole
       * snapshot each pass until the heap ran out. Asking here means every
       * pass through the loop waits on the user, which is the only thing that
       * can end it.
       */
      if (next === null) {
        const outcome = await askForTask({
          store,
          model,
          explicitKey,
          currentKey: apiKey,
          asked: askedOnce,
          stopping: () => quitRequested,
        })
        askedOnce = true
        // /dir and /sessions drain this prompt with the exit sentinel to end
        // the run and start the next one elsewhere. That is not the user
        // leaving, so the pending instruction is read before the exit lands.
        const pending = nextRun
        if (pending !== null && outcome.kind === 'exit') {
          nextRun = null
          next = pending === 'ask' ? null : pending
          continue
        }
        if (outcome.kind !== 'task') {
          if (outcome.kind === 'exit' && !quitRequested) {
            store.addEntry({ kind: 'info', text: 'Goodbye!' })
            exitCode = 0
          }
          break
        }
        apiKey = outcome.key
        next = { task: outcome.task }
      } else if (!apiKey) {
        // A task or a resume arrived on the command line with no key behind
        // it. Say so and let the gate hold it rather than starting a run that
        // cannot reach the gateway.
        const outcome = await askForTask({
          store,
          model,
          explicitKey,
          currentKey: apiKey,
          asked: askedOnce,
          stopping: () => quitRequested,
        })
        if (outcome.kind !== 'task') break
        apiKey = outcome.key
        next = { task: outcome.task }
      }
      askedOnce = true

      const result = await runTask(next.task, next.resumeFrom)
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
      // Back to the idle prompt, which is where the key gate lives too.
      next = null
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

/** The picker's "start fresh instead" row, which is not a session. */
const NEW_SESSION = '__none__'

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
