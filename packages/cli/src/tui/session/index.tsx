import React, { useEffect, useState } from 'react'
import { render, Box, Text, useInput, useApp } from 'ink'
import { runSession } from '../../session/service.js'
import { resolveApiKeyForModel } from '../../env.js'
import { SessionStore } from './store.js'
import { InkSessionUI } from './ink-ui.js'
import { StatusHeader, Transcript, TaskList, ChatInput, FinishedScreen, WorkingHint } from './components.js'

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
}

function SessionApp({
  store,
  model,
  projectDir,
  interrupt,
  forceQuit,
}: {
  store: SessionStore
  model: string
  projectDir: string
  interrupt: () => void
  forceQuit: () => void
}) {
  const state = useSyncSession(store)
  const [draft, setDraft] = useState('')
  const { exit } = useApp()
  const [sigintCount, setSigintCount] = useState(0)

  // New prompt → start with a clean draft.
  const promptId = state.prompt?.id
  useEffect(() => {
    setDraft('')
  }, [promptId])

  // First Ctrl-C interrupts; second forces quit (mirrors CLI D6).
  useEffect(() => {
    if (sigintCount >= 2) forceQuit()
  }, [sigintCount, forceQuit])

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (state.finished) {
        exit()
        return
      }
      setSigintCount(c => c + 1)
      if (sigintCount === 0) interrupt()
      return
    }

    if (state.finished) {
      if (input || key.return || key.escape) exit()
      return
    }

    if (!state.prompt) return

    // Pasted input can arrive as "text\r" in one chunk — submit the prefix.
    if (input.includes('\r') || input.includes('\n')) {
      const [before] = input.split(/\r|\n/)
      store.submitPrompt(draft + before)
      setDraft('')
      return
    }

    if (key.return || input === '\r' || input === '\n') {
      store.submitPrompt(draft)
      setDraft('')
      return
    }
    if (key.escape) {
      setDraft('')
      return
    }
    if (key.backspace || key.delete) {
      setDraft(d => d.slice(0, -1))
      return
    }
    if (input && !key.ctrl && !key.meta) {
      setDraft(d => d + input)
    }
  })

  const hasPrompt = state.prompt !== null
  const working = !state.finished && !hasPrompt

  return (
    <Box flexDirection="column" paddingX={1}>
      <StatusHeader
        model={model}
        projectDir={projectDir}
        working={working}
        interrupted={state.interrupted}
      />
      <Transcript state={state} />
      <TaskList tasks={state.tasks} index={state.executionIndex} total={state.executionTotal} />
      {state.finished ? (
        <FinishedScreen exitCode={state.exitCode} />
      ) : state.prompt ? (
        <ChatInput prompt={state.prompt} draft={draft} />
      ) : (
        <WorkingHint interrupted={state.interrupted} />
      )}
    </Box>
  )
}

function useSyncSession(store: SessionStore) {
  const [state, setState] = useState(store.getSnapshot())
  useEffect(() => store.subscribe(() => setState(store.getSnapshot())), [store])
  return state
}

/**
 * In-process session replacing the old `vajra run` child process.
 * Renders the Ink session UI and runs runSession against it; returns to the
 * caller (the menu loop) when the user dismisses the finished screen.
 */
export async function startSession(options: TuiSessionOptions): Promise<void> {
  if (!process.stdin.isTTY) return

  const apiKey = resolveApiKeyForModel(options.model)
  const store = new SessionStore()
  const ui = new InkSessionUI(store, options.version)
  const controller = new AbortController()
  let forceCloseSandbox: (() => void) | null = null

  const interrupt = () => {
    store.markInterrupted()
    controller.abort()
    store.addEntry({
      kind: 'warning',
      text: 'Interrupted. Finishing current step — press Ctrl-C again to force quit.',
    })
  }

  let instance: ReturnType<typeof render> | null = null
  const forceQuit = () => {
    forceCloseSandbox?.()
    instance?.unmount()
    process.exit(130)
  }

  instance = render(
    <SessionApp
      store={store}
      model={options.model}
      projectDir={options.projectDir}
      interrupt={interrupt}
      forceQuit={forceQuit}
    />,
    // Ctrl-C is the interrupt key here — Ink must not swallow it.
    { exitOnCtrlC: false },
  )

  try {
    const result = await runSession(
      {
        apiKey,
        model: options.model,
        projectDir: options.projectDir,
        timeout: options.timeout,
        autoConfirm: options.autoConfirm,
        allowUnenforced: options.allowUnenforced,
        resumeFrom: options.resumeFrom,
        force: options.force,
        signal: controller.signal,
        onSandboxClose: close => {
          forceCloseSandbox = close
        },
      },
      ui,
    )
    store.setFinished(result.exitCode)
  } catch (e) {
    store.addEntry({
      kind: 'error',
      text: `Session error: ${e instanceof Error ? e.message : String(e)}`,
    })
    store.setFinished(1)
  }

  // Wait for the user to dismiss the finished screen (any key / Ctrl-C).
  await instance.waitUntilExit()
}
