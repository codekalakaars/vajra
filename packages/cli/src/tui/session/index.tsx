import React, { useEffect, useReducer, useState, useSyncExternalStore } from 'react'
import { render, Box, useInput, usePaste, useWindowSize } from 'ink'
import { runSession, isExitCommand, type SessionResult } from '../../session/service.js'
import { primeModelCatalog, resolveApiKeyForModel } from '../../env.js'
import { detailModel, hasCatalog, listModels } from '../../models/catalog.js'
import { getModelLimit } from '../../agent/context-window.js'
import { SessionStore } from './store.js'
import { InkSessionUI } from './ink-ui.js'
import { enterAltScreen, exitAltScreen, setAltScreenTeardown } from './alt-screen.js'
import {
  HELP_LINES,
  matchSlashCommands,
  parseSlashCommand,
  type SlashCommand,
} from './commands.js'
import { Pickers, type PickerScreen, type ResumeChoice } from '../pickers.js'
import {
  StatusBar,
  SessionFrame,
  Sidebar,
  Transcript,
  TaskList,
  ChatInput,
  CommandPalette,
  WorkingHint,
  estimateLiveRows,
  formatUsage,
  useSessionStatus,
  STATUS_ROWS,
  WORKING_ROWS,
  SIDEBAR_WIDTH,
  SIDEBAR_MIN_COLUMNS,
} from './components.js'
import {
  computeViewport,
  entryHeights,
  scrollTopReveal,
  taskPaneLayout,
  type ScrollState,
} from './viewport.js'
import { editorReducer, initialEditor, editorRenderRows } from './editor.js'

export interface TuiSessionOptions {
  version: string
  model: string
  projectDir: string
  timeout?: number
  autoConfirm?: boolean
  allowUnenforced?: boolean
  /** Resume this persisted session instead of starting a new one. */
  resumeFrom?: string
  /** Skip the staleness gate — only ever set from an explicit user choice. */
  force?: boolean
  /** Explicit key from `--api-key`; otherwise resolved from env/auth. */
  apiKey?: string
  /** Initial task from `vajra run "…"` — skips the first prompt. */
  initialTask?: string
  /** Max parallel workers (`vajra run -c`). */
  concurrency?: number
}

const MAX_TASK_ROWS = 8

/** Callbacks into the shell that owns settings, restarts and quitting. */
interface ShellActions {
  /** Apply a new model — the running conversation picks it up next task. */
  setModel: (model: string) => void
  /** Apply a new directory — the shell restarts the conversation there. */
  setDir: (dir: string) => void
  /** Resume a persisted session — the shell restarts with resumeFrom. */
  resume: (choice: ResumeChoice) => void
  /** Leave the TUI, whatever state the session is in. */
  quit: () => void
}

function SessionApp({
  store,
  version,
  interrupt,
  forceQuit,
  actions,
}: {
  store: SessionStore
  version: string
  interrupt: () => void
  forceQuit: () => void
  actions: ShellActions
}) {
  const state = useSyncSession(store)
  const [editor, dispatch] = useReducer(editorReducer, undefined, initialEditor)
  const [scroll, setScroll] = useState<ScrollState>({ mode: 'follow' })
  const [focusSeq, setFocusSeq] = useState<number | null>(null)
  const [picker, setPicker] = useState<PickerScreen | null>(null)
  const [paletteIdx, setPaletteIdx] = useState(0)
  const [sigintCount, setSigintCount] = useState(0)
  const { rows: termRows, columns } = useWindowSize()
  // The frame carries OpenCode's left rule, so a column belongs to it and one
  // to each side of the padding inside it.
  const width = Math.max(20, columns - 3)
  const contextLimit = getModelLimit(state.model)

  // New prompt → start with a clean draft, close any open picker, and put the
  // response on screen.
  const promptId = state.prompt?.id
  useEffect(() => {
    dispatch({ type: 'clear' })
    setScroll({ mode: 'follow' })
    setFocusSeq(null)
    setPicker(null)
    setSigintCount(0)
  }, [promptId])

  // First Ctrl-C interrupts; second forces quit (mirrors CLI D6).
  useEffect(() => {
    if (sigintCount >= 2) forceQuit()
  }, [sigintCount, forceQuit])

  /**
   * Fetch the model catalog, then ask the gateway what it is serving right now.
   *
   * Deliberately not awaited before the first paint: the prompt must appear
   * immediately, and every fact the catalog supplies has a defined answer for
   * "not known yet" (the conservative context window, the four-level dial). When
   * it lands, `refreshModelInfo` folds the real numbers in and the store
   * republishes — the sidebar, the reasoning dial and `/model` all re-render
   * from the same snapshot.
   */
  const model = state.model
  useEffect(() => {
    let live = true
    void primeModelCatalog(resolveApiKeyForModel(model)).then(() => {
      if (live) store.refreshModelInfo()
    })
    return () => {
      live = false
    }
  }, [])

  /**
   * Budget every band up front so the frame is exactly the terminal height:
   * viewport + tasks + input/hint + the status line at the bottom. A frame
   * taller than the terminal scrolls on every repaint — the flicker this
   * replaces.
   */
  // Two columns when the terminal can afford it: transcript + prompt on the
  // left, session state on the right. Below the threshold the status folds
  // back into the bottom line and the tasks sit above the input, because a
  // 40-column transcript is worse than a crowded bar.
  const sidebar = columns >= SIDEBAR_MIN_COLUMNS
  const pane = sidebar ? null : taskPaneLayout(state.tasks, MAX_TASK_ROWS, termRows)
  const liveRows = estimateLiveRows(state, width)
  // A leading slash with no space yet is a command being typed: show the
  // matches above the input and let ↑↓ and Enter drive the list.
  const paletteQuery =
    state.prompt && editor.value.startsWith('/') && !/\s/.test(editor.value)
      ? editor.value.slice(1)
      : null
  const paletteMatches = paletteQuery === null ? [] : matchSlashCommands(paletteQuery)
  const paletteOpen = paletteMatches.length > 0

  // The ruled editor box, then the one status row under it (model left, context
  // right), then the palette when it is open.
  const paletteRows = paletteOpen ? paletteMatches.length : 0
  const inputRows = state.prompt
    ? editorRenderRows(editor.value, width) + 1 + paletteRows
    : 0
  const bottomRows = (state.prompt ? inputRows : WORKING_ROWS) + STATUS_ROWS
  const viewportRows = Math.max(4, termRows - (pane?.rows ?? 0) - bottomRows)

  const heights = React.useMemo(
    () => entryHeights(state.entries, width),
    [state.entries, width],
  )
  const viewport = computeViewport({
    entries: state.entries,
    width,
    rows: viewportRows,
    scroll,
    liveRows,
  })

  const scrolled = scroll.mode === 'scroll'

  const openPicker = (screen: PickerScreen) => {
    dispatch({ type: 'clear' })
    setScroll({ mode: 'follow' })
    setFocusSeq(null)
    setPicker(screen)
  }

  const closePicker = (note?: string) => {
    setPicker(null)
    if (note) store.addEntry({ kind: 'success', text: note })
  }

  const handleModelSaved = (saved: string) => {
    actions.setModel(saved)
    setPicker(null)
    store.addEntry({
      kind: 'success',
      text: `Model → ${saved} (applies from the next task)`,
    })
  }

  const handleDirSaved = (dir: string) => {
    actions.setDir(dir)
    setPicker(null)
    store.addEntry({
      kind: 'success',
      text: `Directory → ${dir} — ending this conversation, starting a new one there`,
    })
    // /dir changes what the *next* run sees; exit the current one so the
    // shell can restart with the new directory.
    store.submitPrompt('exit')
  }

  const handleResumed = (choice: ResumeChoice) => {
    actions.resume(choice)
    setPicker(null)
    store.addEntry({
      kind: 'info',
      text: `Resuming session ${choice.sessionId.slice(0, 8)}${choice.force ? ' (staleness override)' : ''}…`,
    })
    store.submitPrompt('exit')
  }

  /**
   * Run a slash command by name. Shared by typed input and the palette, so
   * `/quit` and the highlighted `/quit` in the menu are the same code path.
   */
  const runSlash = (name: string) => {
    const cmd = name as SlashCommand
    dispatch({ type: 'clear' })
    setScroll({ mode: 'follow' })
    setFocusSeq(null)
    setPaletteIdx(0)
    if (cmd === 'help') {
      for (const line of HELP_LINES) store.addEntry({ kind: 'info', text: line })
      return
    }
    if (cmd === 'quit') {
      actions.quit()
      return
    }
    // Reasoning cycles instead of opening a picker: it is one value with four
    // states, and ctrl-r already does the same thing without typing.
    if (cmd === 'reasoning') {
      // Silently, for the same reason as the OpenTUI host: the level is a mode
      // shown in the prompt's meta row, and writing it to the transcript would
      // both bury the conversation and hand the agent a log of keypresses.
      store.cycleReasoning()
      return
    }
    if (cmd === 'models') {
      const info = listModels({ includeUnavailable: true }).find(entry => entry.id === model)
      if (!info) {
        store.addEntry({
          kind: 'warning',
          text: hasCatalog()
            ? `The catalog has no entry for ${model} — it may have been retired. /model lists what is there.`
            : 'The model catalog could not be fetched; context window and reasoning levels are using defaults.',
        })
        return
      }
      for (const line of detailModel(info)) store.addEntry({ kind: 'info', text: line })
      return
    }
    const kind = state.prompt?.kind
    const isUserTurn = kind === 'user' || kind === 'initial-first' || kind === 'initial-reentry'
    if (!isUserTurn) {
      store.addEntry({
        kind: 'warning',
        text: 'Finish the current prompt first — settings open only at a task prompt.',
      })
      return
    }
    openPicker(cmd)
  }

  const submit = () => {
    const value = editor.value
    const trimmed = value.trim()
    const parsed = trimmed ? parseSlashCommand(trimmed) : null
    if (parsed) {
      if (parsed.known) runSlash(parsed.command)
      else {
        store.addEntry({
          kind: 'error',
          text: `Unknown command ${parsed.name} — type /help for the list.`,
        })
      }
      return
    }

    // Only real user turns belong in the ↑ history — a plan confirmation or
    // rejection feedback would pollute it.
    const kind = state.prompt?.kind
    if (kind === 'user' || kind === 'initial-first' || kind === 'initial-reentry') {
      dispatch({ type: 'push-history', text: value })
    }
    setScroll({ mode: 'follow' })
    setFocusSeq(null)
    store.submitPrompt(value)
  }

  const enterScroll = () => {
    setScroll(s => {
      const top = s.mode === 'scroll' ? s.topLine : viewport.topLine
      return { mode: 'scroll', topLine: Math.max(0, top - viewportRows) }
    })
    setFocusSeq(seq => {
      if (seq !== null) return seq
      const last = state.entries[state.entries.length - 1]
      return last?.seq ?? null
    })
  }

  const moveFocus = (delta: number) => {
    const entries = state.entries
    if (entries.length === 0) return
    const currentSeq = focusSeq ?? entries[viewport.end - 1]?.seq
    const idx = Math.max(0, entries.findIndex(e => e.seq === currentSeq))
    const next = Math.max(0, Math.min(entries.length - 1, idx + delta))
    const seq = entries[next].seq ?? null
    setFocusSeq(seq)
    const top = scrollTopReveal(heights, next, viewport.topLine, viewportRows)
    setScroll({ mode: 'scroll', topLine: top })
  }

  const toggleFocused = () => {
    const entries = state.entries
    const seq = focusSeq ?? entries[viewport.end - 1]?.seq
    if (seq == null) return
    if (focusSeq === null) setFocusSeq(seq)
    store.toggleToolEntry(seq)
  }

  usePaste(
    text => {
      if (!state.prompt || picker) return
      setScroll({ mode: 'follow' })
      dispatch({
        type: 'insert',
        text: text.replace(/\r\n|\r/g, '\n').replace(/\n$/, ''),
      })
    },
    { isActive: Boolean(state.prompt) && !picker },
  )

  useInput((input, key) => {
    // A picker owns the keyboard while it is open (its own useInput handles
    // keys, including Ctrl-C which just closes the picker).
    if (picker) return

    if (key.ctrl && input === 'c') {
      setSigintCount(c => c + 1)
      if (sigintCount === 0) interrupt()
      return
    }

    // Ctrl-R is the reasoning dial, sitting with the prompt like OpenCode's.
    if (key.ctrl && input === 'r') {
      const next = store.cycleReasoning()
      store.addEntry({ kind: 'info', text: next === 'off' ? 'Reasoning off' : `Reasoning ${next}` })
      return
    }

    // --- Transcript browsing: works with or without an open prompt. ---
    if (key.pageUp) {
      enterScroll()
      return
    }
    if (key.pageDown) {
      if (scrolled) {
        setScroll(s => {
          if (s.mode !== 'scroll') return s
          const next = s.topLine + viewportRows
          if (next >= viewport.totalLines - viewportRows) return { mode: 'follow' }
          return { mode: 'scroll', topLine: next }
        })
      }
      return
    }
    if (scrolled) {
      if (key.escape || key.end) {
        setScroll({ mode: 'follow' })
        setFocusSeq(null)
        return
      }
      if (key.upArrow) {
        moveFocus(-1)
        return
      }
      if (key.downArrow) {
        moveFocus(1)
        return
      }
      if (input === ' ') {
        toggleFocused()
        return
      }
      if (key.return) {
        // Submitting from scrollback should show the answer, not history.
        submit()
        return
      }
      // Any other printable input leaves scrollback and reaches the editor.
      if (input && !key.ctrl && !key.meta && input !== '\r' && input !== '\n') {
        setScroll({ mode: 'follow' })
        setFocusSeq(null)
        if (state.prompt) dispatch({ type: 'insert', text: input })
        return
      }
      return
    }

    if (!state.prompt) return

    // The palette is modal over the editor: the arrows move the highlight and
    // Enter runs the command, exactly as picking from a menu would.
    if (paletteOpen) {
      if (key.upArrow) {
        setPaletteIdx(i => (i === 0 ? paletteMatches.length - 1 : i - 1))
        return
      }
      if (key.downArrow) {
        setPaletteIdx(i => (i === paletteMatches.length - 1 ? 0 : i + 1))
        return
      }
      if (key.return || input === '\r' || input === '\n') {
        const chosen = paletteMatches[paletteIdx]
        if (chosen) runSlash(chosen.name)
        return
      }
      if (key.escape) {
        dispatch({ type: 'clear' })
        return
      }
    }

    // --- Editor keys. ---
    // Enter submits; Alt/Shift+Enter inserts a newline.
    if (key.return || input === '\r' || input === '\n') {
      if (key.meta || key.shift) dispatch({ type: 'newline' })
      else submit()
      return
    }
    // A multi-character chunk containing line breaks is a paste that slipped
    // through without bracketed-paste support — insert it, don't submit.
    if ((input.includes('\r') || input.includes('\n')) && input.length > 1) {
      dispatch({
        type: 'insert',
        text: input.replace(/\r\n|\r/g, '\n').replace(/\n$/, ''),
      })
      return
    }
    if (key.escape) {
      dispatch({ type: 'clear' })
      return
    }
    if (key.backspace) {
      dispatch({ type: 'backspace' })
      return
    }
    if (key.delete) {
      dispatch({ type: 'delete' })
      return
    }
    if (key.leftArrow) {
      dispatch({ type: key.ctrl || key.meta ? 'word-left' : 'left' })
      return
    }
    if (key.rightArrow) {
      dispatch({ type: key.ctrl || key.meta ? 'word-right' : 'right' })
      return
    }
    if (key.home || (key.ctrl && input === 'a')) {
      dispatch({ type: 'line-start' })
      return
    }
    if (key.end || (key.ctrl && input === 'e')) {
      dispatch({ type: 'line-end' })
      return
    }
    if (key.upArrow || (key.ctrl && input === 'p')) {
      const onFirstLine = editor.value.slice(0, editor.cursor).indexOf('\n') === -1
      if (key.ctrl || onFirstLine) dispatch({ type: 'history-prev' })
      else dispatch({ type: 'line-up' })
      return
    }
    if (key.downArrow || (key.ctrl && input === 'n')) {
      const onLastLine = editor.value.indexOf('\n', editor.cursor) === -1
      if (key.ctrl || onLastLine) dispatch({ type: 'history-next' })
      else dispatch({ type: 'line-down' })
      return
    }
    if (input && !key.ctrl && !key.meta) {
      dispatch({ type: 'insert', text: input })
      // A changed query means a different match list; start at the top.
      if (input !== '/') setPaletteIdx(0)
    }
  })

  const hasPrompt = state.prompt !== null
  // The status is needed either way: in the sidebar, or folded into the
  // bottom line when the terminal is too narrow for a column. It is a hook, so
  // it must be called before the picker's early return below.
  const liveStatus = useSessionStatus(state.interrupted, !hasPrompt)

  // A picker is a full-screen takeover: the session hides until it closes.
  if (picker) {
    return (
      <Pickers
        version={version}
        screen={picker}
        model={state.model}
        projectDir={state.projectDir}
        onModelSaved={handleModelSaved}
        onDirSaved={handleDirSaved}
        onResumed={handleResumed}
        onClosed={closePicker}
      />
    )
  }

  const input = state.prompt ? (
    <>
      {paletteOpen && (
        <CommandPalette matches={paletteMatches} index={paletteIdx} width={width} />
      )}
      <ChatInput
        prompt={state.prompt}
        editor={editor}
        model={state.model}
        thinking={state.thinking ? state.thinking.replace(/\s+/g, ' ').trim() : undefined}
        effort={state.reasoning}
        levels={state.reasoningLevels}
      />
    </>
  ) : (
    <WorkingHint interrupted={state.interrupted} />
  )

  return (
    <SessionFrame width={width}>
      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1} width={sidebar ? width - SIDEBAR_WIDTH : undefined}>
          <Transcript state={state} viewport={viewport} focusSeq={focusSeq} />
          {input}
        </Box>
        {sidebar ? (
          <Sidebar
            state={state}
            width={SIDEBAR_WIDTH}
            height={termRows - STATUS_ROWS}
            limit={contextLimit}
          />
        ) : (
          pane && <TaskList tasks={state.tasks} index={state.executionIndex} total={state.executionTotal} maxRows={MAX_TASK_ROWS} terminalRows={termRows} width={width} />
        )}
      </Box>
      <StatusBar
        version={version}
        projectDir={state.projectDir}
        width={width}
        live={
          sidebar
            ? undefined
            : liveStatus
        }
      />
    </SessionFrame>
  )
}

function useSyncSession(store: SessionStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

/** What the next loop iteration should run. */
interface NextRun {
  task?: string
  resumeFrom?: string
  force?: boolean
}

/**
 * The unified TUI shell: one alt-screen surface for the whole process.
 *
 * The old main menu is gone — the session screen *is* the app, and its
 * options live at the prompt as slash commands. This function renders the
 * session once, then loops `runSession` against it until the user quits:
 * each conversation (initial task, follow-up tasks until exit, a resume, or a
 * fresh run after /dir) uses the same transcript, header and prompt. A run
 * that ends without asking to quit (interrupt, error, turn cap) returns to a
 * fresh task prompt in the same screen.
 */
export async function startSession(options: TuiSessionOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return 1

  let model = options.model
  let projectDir = options.projectDir
  /** An explicit --api-key survives every /model change; otherwise re-resolve. */
  const explicitKey = options.apiKey ?? null
  let apiKey = explicitKey ?? resolveApiKeyForModel(model)
  const store = new SessionStore({ model, projectDir })
  const ui = new InkSessionUI(store, options.version)

  let controller: AbortController | null = null
  let forceCloseSandbox: (() => void) | null = null
  /**
   * Restart instruction set by /dir ('ask' → a fresh task prompt in the new
   * directory) or /sessions (resumeFrom …). Consumed when the current run
   * returns, so the change applies to the *next* run, never the live one.
   */
  let pendingRun: NextRun | 'ask' | null = null
  let quitRequested = false

  const interrupt = () => {
    store.markInterrupted()
    controller?.abort()
    store.addEntry({
      kind: 'warning',
      text: 'Interrupted. Finishing current step — press Ctrl-C again to force quit.',
    })
  }

  const quit = () => {
    quitRequested = true
    const prompt = store.getSnapshot().prompt
    // A task prompt is answered with "exit", so the run unwinds on its own
    // terms — no interrupt is reported for a deliberate exit. A plan
    // confirmation cannot be answered that way, so drain and abort instead.
    if (prompt && (prompt.kind === 'user' || prompt.kind === 'initial-first' || prompt.kind === 'initial-reentry')) {
      store.submitPrompt('exit')
    } else {
      store.markInterrupted()
      controller?.abort()
    }
  }

  let instance: ReturnType<typeof render> | null = null
  const forceQuit = () => {
    forceCloseSandbox?.()
    instance?.unmount()
    // Leave through the write queue (not the sync exit hook) so a frame Ink
    // already queued lands in the alt buffer, not in the restored one.
    exitAltScreen()
    process.exit(130)
  }

  const actions: ShellActions = {
    setModel(next) {
      model = next
      apiKey = explicitKey ?? resolveApiKeyForModel(next)
      store.setSettings({ model: next })
    },
    setDir(next) {
      projectDir = next
      store.setSettings({ projectDir: next })
      pendingRun = 'ask'
    },
    resume(choice) {
      pendingRun = {
        resumeFrom: choice.sessionId,
        ...(choice.force ? { force: true } : {}),
      }
    },
    quit,
  }

  enterAltScreen()
  let exitCode = 0
  try {
    instance = render(
      <SessionApp
        store={store}
        version={options.version}
        interrupt={interrupt}
        forceQuit={forceQuit}
        actions={actions}
      />,
      // Ctrl-C is the interrupt key here — Ink must not swallow it.
      { exitOnCtrlC: false },
    )
    // A fatal signal tears Ink down first, so its final frame is queued
    // ahead of the alt-screen leave instead of dumping into the restored
    // normal buffer afterwards.
    setAltScreenTeardown(() => instance?.unmount())

    // No task and no resume → null, so the loop starts at the shell's own
    // idle prompt instead of a runSession that would bail without asking.
    let next: NextRun | null =
      options.initialTask !== undefined
        ? { task: options.initialTask }
        : options.resumeFrom !== undefined
          ? { resumeFrom: options.resumeFrom, force: Boolean(options.force) }
          : null
    let firstAsk = true

    for (;;) {
      // Idle: nothing in flight. The shell owns this prompt rather than
      // delegating to runSession's first-task ask, so an early bail (no API
      // key, unsupported model, missing directory) lands back here waiting
      // for input instead of re-running the bail in a tight loop.
      if (next === null) {
        const message = await store.ask(firstAsk ? 'initial-first' : 'initial-reentry')
        firstAsk = false
        const wasInterrupted = store.getSnapshot().interrupted
        store.resetInterrupted()
        if (quitRequested) {
          exitCode = 0
          break
        }
        const pending = pendingRun
        if (pending !== null && isExitCommand(message)) {
          // /dir or /sessions resolved this prompt with "exit" to restart it.
          pendingRun = null
          next = pending === 'ask' ? null : pending
          continue
        }
        if (isExitCommand(message)) {
          if (!wasInterrupted) store.addEntry({ kind: 'info', text: 'Goodbye!' })
          exitCode = 0
          break
        }
        if (!message.trim()) continue
        next = { task: message }
      }

      controller = new AbortController()
      let result: SessionResult
      try {
        result = await runSession(
          {
            task: next.task,
            // A human is at the keyboard: let the developer see how the plan
            // fared and replan, instead of ending the run at the report.
            continueAfterExecution: true,
            apiKey,
            model,
            // Read per run, not once: ctrl-r mid-session changes the next run.
            reasoningEffort: store.getSnapshot().reasoning,
            projectDir,
            timeout: options.timeout,
            autoConfirm: options.autoConfirm,
            allowUnenforced: options.allowUnenforced,
            concurrency: options.concurrency,
            resumeFrom: next.resumeFrom,
            force: next.force,
            signal: controller.signal,
            onSandboxClose: close => {
              forceCloseSandbox = close
            },
          },
          ui,
        )
      } catch (e) {
        store.addEntry({
          kind: 'error',
          text: `Session error: ${e instanceof Error ? e.message : String(e)}`,
        })
        store.resetInterrupted()
        if (quitRequested) {
          exitCode = 0
          break
        }
        next = null
        continue
      }
      controller = null
      store.resetInterrupted()

      if (quitRequested) {
        exitCode = 0
        break
      }

      const pending = pendingRun
      pendingRun = null
      if (pending !== null) {
        // /dir or /sessions: restart with the new settings/resume target.
        next = pending === 'ask' ? null : pending
        continue
      }

      if (result.exited && !result.interrupted) {
        // Typed exit//quit at a prompt — the session asked to leave.
        exitCode = result.exitCode
        break
      }

      // Interrupted: runSession already printed its own note and the prompt
      // reappears below. Any other end (early error, turn cap) gets a summary
      // so the transcript records why the conversation stopped.
      if (!result.interrupted) {
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
      // Fresh conversation: the idle prompt below asks for a task.
      next = null
    }
    return exitCode
  } finally {
    setAltScreenTeardown(null)
    instance?.unmount()
    exitAltScreen()
  }
}
