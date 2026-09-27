/**
 * Full-screen pickers reached from the session prompt via slash commands
 * (/model, /dir, /defaults, /sessions). Each picker owns its own selection
 * state and closes by reporting back — the session component decides what a
 * change means (apply in place, restart the conversation, resume a session).
 *
 * These screens were lifted from the old main menu; there is no menu screen
 * anymore, so "back" is always a return to the live session.
 */
import React, { useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { resolve } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { listAvailableModels, normalizeModelId } from '../env.js'
import {
  DEFAULT_DIR_KEY,
  DEFAULT_MODEL_KEY,
  isPersistedDefault,
  saveDefaults,
} from '../config.js'
import { deleteSession, listSessions, type SessionSummary } from '../persist/index.js'

export type PickerScreen = 'model' | 'dir' | 'defaults' | 'sessions'

/** A resume chosen from the Sessions picker. */
export interface ResumeChoice {
  sessionId: string
  /** Set when the user asked to resume past a staleness report. */
  force?: boolean
}

/** Compact age for the session list: 4s, 12m, 3h, 5d. */
function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/**
 * Which gateway a model id routes to. Provider is not independently
 * selectable — `resolveBaseURL` in agent/chat.ts derives it from the prefix.
 */
function gatewayFor(model: string): string {
  if (model.startsWith('go/')) return 'OpenCode Zen (go)'
  if (model.startsWith('zen/')) return 'OpenCode Zen'
  return 'unsupported'
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

type ModelChoice =
  | { type: 'preset'; id: string; hint: string }
  | { type: 'custom' }
  | { type: 'back' }

interface PickersProps {
  version: string
  screen: PickerScreen
  /** Current model — displayed, and the value /defaults would persist. */
  model: string
  projectDir: string
  /** Model validated by the picker; parent applies it and closes. */
  onModelSaved: (model: string) => void
  /** Directory validated by the picker; parent applies it and closes. */
  onDirSaved: (dir: string) => void
  /** Session row chosen; parent resumes it and closes. */
  onResumed: (choice: ResumeChoice) => void
  /** Back/Esc (optionally with a note to show in the transcript). */
  onClosed: (note?: string) => void
}

function moveSelection(
  direction: 1 | -1,
  items: readonly unknown[],
  ref: React.MutableRefObject<number>,
  setIdx: (updater: (prev: number) => number) => void,
) {
  setIdx(prev => {
    const next = direction === 1
      ? (prev === items.length - 1 ? 0 : prev + 1)
      : (prev === 0 ? items.length - 1 : prev - 1)
    ref.current = next
    return next
  })
}

export function Pickers({
  version,
  screen,
  model,
  projectDir,
  onModelSaved,
  onDirSaved,
  onResumed,
  onClosed,
}: PickersProps) {
  const [modelIdx, setModelIdx] = useState(0)
  const [customDraft, setCustomDraft] = useState<string | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [dirDraft, setDirDraft] = useState<string | null>(null)
  const [dirError, setDirError] = useState<string | null>(null)
  const [defaultsIdx, setDefaultsIdx] = useState(0)
  const [defaultsError, setDefaultsError] = useState<string | null>(null)
  // Sessions are loaded on mount, so the list is never stale on arrival.
  const [initialSessions] = useState(() => {
    try {
      return { list: listSessions(projectDir), error: null as string | null }
    } catch (e) {
      return { list: [] as SessionSummary[], error: `Could not read sessions: ${e instanceof Error ? e.message : String(e)}` }
    }
  })
  const [sessions, setSessions] = useState<SessionSummary[]>(initialSessions.list)
  const [sessionsIdx, setSessionsIdx] = useState(0)
  const [sessionsNote, setSessionsNote] = useState<string | null>(initialSessions.error)
  const modelIdxRef = useRef(0)
  const defaultsIdxRef = useRef(0)
  const sessionsIdxRef = useRef(0)

  const availableModels = listAvailableModels()
  const modelItems: ModelChoice[] = [
    ...availableModels.map((p): ModelChoice => ({ type: 'preset', id: p.id, hint: p.hint })),
    { type: 'custom' },
    { type: 'back' },
  ]
  const noKeysConfigured = availableModels.length === 0

  const defaultsItems = [
    { key: 'save-both', label: 'Save model and directory as defaults' },
    { key: 'save-model', label: `Save model only (${model})` },
    { key: 'save-dir', label: 'Save directory only' },
    { key: 'back', label: 'Back' },
  ] as const

  function reloadSessions(dir: string): SessionSummary[] {
    try {
      return listSessions(dir)
    } catch (e) {
      setSessionsNote(`Could not read sessions: ${e instanceof Error ? e.message : String(e)}`)
      return []
    }
  }

  function saveModel(id: string) {
    try {
      onModelSaved(normalizeModelId(id))
    } catch (e) {
      setModelError(e instanceof Error ? e.message : String(e))
    }
  }

  function saveDir(raw: string) {
    const trimmed = raw.trim()
    if (!trimmed) {
      setDirError('Path is required')
      return
    }
    const abs = resolve(trimmed)
    if (!isDirectory(abs)) {
      setDirError(`Not a directory: ${abs}`)
      return
    }
    onDirSaved(abs)
  }

  function persistDefaults(what: 'save-both' | 'save-model' | 'save-dir') {
    try {
      const savedPath = saveDefaults({
        model: what === 'save-dir' ? undefined : model,
        projectDir: what === 'save-model' ? undefined : projectDir,
      })
      onClosed(`Defaults saved to ${savedPath}`)
    } catch (e) {
      setDefaultsError(e instanceof Error ? e.message : String(e))
    }
  }

  useInput((input, key) => {
    // Ctrl-C closes whatever picker is open (the session screen owns quitting).
    if (key.ctrl && input === 'c') {
      onClosed()
      return
    }

    // Custom model id entry: literal typing, Enter saves, Esc cancels.
    if (customDraft !== null) {
      if (key.return) {
        saveModel(customDraft)
      } else if (key.escape) {
        setCustomDraft(null)
        setModelError(null)
      } else if (key.backspace || key.delete) {
        setCustomDraft(d => (d ?? '').slice(0, -1))
      } else if (input && !key.ctrl && !key.meta) {
        setCustomDraft(d => (d ?? '') + input)
      }
      return
    }

    // Directory path entry: literal typing, Enter saves, Esc cancels.
    if (dirDraft !== null) {
      if (key.return) {
        saveDir(dirDraft)
      } else if (key.escape) {
        setDirDraft(null)
        setDirError(null)
      } else if (key.backspace || key.delete) {
        setDirDraft(d => (d ?? '').slice(0, -1))
      } else if (input && !key.ctrl && !key.meta) {
        setDirDraft(d => (d ?? '') + input)
      }
      return
    }

    if (screen === 'model') {
      if (key.escape || input === 'q') {
        onClosed()
        return
      }
      if (key.upArrow) {
        setModelError(null)
        moveSelection(-1, modelItems, modelIdxRef, setModelIdx)
      } else if (key.downArrow) {
        setModelError(null)
        moveSelection(1, modelItems, modelIdxRef, setModelIdx)
      } else if (key.return || input === '\r' || input === '\n') {
        const choice = modelItems[modelIdxRef.current]
        if (choice.type === 'preset') {
          saveModel(choice.id)
        } else if (choice.type === 'custom') {
          setModelError(null)
          setCustomDraft('')
        } else {
          onClosed()
        }
      }
      return
    }

    if (screen === 'defaults') {
      if (key.escape || input === 'q') {
        onClosed()
        return
      }
      if (key.upArrow) {
        setDefaultsError(null)
        moveSelection(-1, defaultsItems, defaultsIdxRef, setDefaultsIdx)
      } else if (key.downArrow) {
        setDefaultsError(null)
        moveSelection(1, defaultsItems, defaultsIdxRef, setDefaultsIdx)
      } else if (key.return || input === '\r' || input === '\n') {
        const choice = defaultsItems[defaultsIdxRef.current].key
        if (choice === 'back') {
          onClosed()
        } else {
          persistDefaults(choice)
        }
      }
      return
    }

    if (screen === 'dir') {
      if (key.escape || input === 'q') {
        onClosed()
        return
      }
      if (key.return || input === '\r' || input === '\n') {
        setDirError(null)
        setDirDraft('')
      }
      return
    }

    // sessions
    if (key.escape || input === 'q') {
      onClosed()
      return
    }
    if (sessions.length === 0) {
      setSessionsNote('No sessions recorded for this directory yet.')
      return
    }
    const chosen = sessions[sessionsIdxRef.current]
    if (key.upArrow) {
      setSessionsNote(null)
      moveSelection(-1, sessions, sessionsIdxRef, setSessionsIdx)
    } else if (key.downArrow) {
      setSessionsNote(null)
      moveSelection(1, sessions, sessionsIdxRef, setSessionsIdx)
    } else if (key.return || input === '\r' || input === '\n') {
      onResumed({ sessionId: chosen.sessionId })
    } else if (input === 'f') {
      // Explicit, deliberate override of the staleness gate — never the
      // default, and only on the row the user is looking at.
      onResumed({ sessionId: chosen.sessionId, force: true })
    } else if (input === 'd') {
      const removed = deleteSession(chosen.sessionId, projectDir)
      const next = reloadSessions(projectDir)
      setSessions(next)
      setSessionsIdx(0)
      sessionsIdxRef.current = 0
      setSessionsNote(
        removed
          ? `Removed ${chosen.sessionId.slice(0, 8)}`
          : `Could not remove ${chosen.sessionId.slice(0, 8)}`,
      )
    }
  })

  if (screen === 'sessions') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">⚡ Vajra</Text>
          <Text color="white"> v{version} — Sessions</Text>
        </Box>

        <Box marginBottom={1}>
          <Text color="gray">{projectDir}</Text>
        </Box>

        {sessions.length === 0 ? (
          <Box marginBottom={1}>
            <Text color="gray">No sessions recorded for this directory yet.</Text>
            <Text color="gray">Run the agent first — every run is saved as it progresses.</Text>
          </Box>
        ) : (
          <Box flexDirection="column" marginBottom={1}>
            <Box>
              <Text color="gray">{'  ID'.padEnd(12)}{'PHASE'.padEnd(16)}{'PROGRESS'.padEnd(11)}{'AGE'.padEnd(9)}PLAN</Text>
            </Box>
            {sessions.map((session, idx) => (
              <Box key={session.sessionId}>
                <Text color={idx === sessionsIdx ? 'cyan' : 'white'}>
                  {idx === sessionsIdx ? '▸ ' : '  '}
                  {session.sessionId.slice(0, 8).padEnd(10)}
                  {session.phase.padEnd(16)}
                  {`${session.done}/${session.total}`.padEnd(11)}
                  {formatAge(Date.now() - session.updatedAt).padEnd(9)}
                  {truncate(session.planTitle ?? session.status, 28)}
                </Text>
              </Box>
            ))}
          </Box>
        )}

        {sessionsNote && (
          <Box marginBottom={1}>
            <Text color="yellow">{sessionsNote}</Text>
          </Box>
        )}

        <Box flexDirection="column">
          <Text color="white">↑↓ Navigate  Enter Resume  d Remove</Text>
          <Text color="gray">
            f resumes past the staleness report (a changed tree or moved HEAD)
          </Text>
          <Text color="white">Esc Back</Text>
        </Box>
      </Box>
    )
  }

  if (screen === 'defaults') {
    const modelPersisted = isPersistedDefault(DEFAULT_MODEL_KEY)
    const dirPersisted = isPersistedDefault(DEFAULT_DIR_KEY)
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">⚡ Vajra</Text>
          <Text color="white"> v{version} — Defaults</Text>
        </Box>

        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text color="white">Model     </Text>
            <Text color="green">{model}</Text>
            <Text color="white">{modelPersisted ? '  (saved)' : '  (this session only)'}</Text>
          </Box>
          <Box>
            <Text color="white">Gateway   </Text>
            <Text color="yellow">{gatewayFor(model)}</Text>
            <Text color="white">  (follows the model prefix)</Text>
          </Box>
          <Box>
            <Text color="white">Directory </Text>
            <Text color="green">{projectDir}</Text>
            <Text color="white">{dirPersisted ? '  (saved)' : '  (this session only)'}</Text>
          </Box>
        </Box>

        <Box flexDirection="column" marginBottom={1}>
          {defaultsItems.map((item, idx) => (
            <Box key={item.key}>
              <Text color={idx === defaultsIdx ? 'cyan' : 'white'}>
                {idx === defaultsIdx ? '▸ ' : '  '}{item.label}
              </Text>
            </Box>
          ))}
        </Box>

        {defaultsError && (
          <Box marginBottom={1}>
            <Text color="red">{defaultsError}</Text>
          </Box>
        )}

        <Box>
          <Text color="white">↑↓ Navigate  Enter Save  Esc Back</Text>
        </Box>
      </Box>
    )
  }

  if (screen === 'dir') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">⚡ Vajra</Text>
          <Text color="white"> v{version} — Directory</Text>
        </Box>

        <Box marginBottom={1}>
          <Text color="white">Current: </Text>
          <Text color="yellow">{projectDir}</Text>
        </Box>

        <Box marginBottom={1}>
          <Text color="cyan">New path: </Text>
          <Text color="white">{dirDraft ?? ''}█</Text>
        </Box>

        {dirError && (
          <Box marginBottom={1}>
            <Text color="red">{dirError}</Text>
          </Box>
        )}

        <Box>
          <Text color="white">
            {dirDraft !== null ? 'Enter Save  Esc Cancel' : 'Enter Change  Esc Back'}
          </Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">⚡ Vajra</Text>
        <Text color="white"> v{version} — Model</Text>
      </Box>

      <Box marginBottom={1}>
        <Text color="white">Dir: </Text>
        <Text color="yellow">{projectDir}</Text>
      </Box>

      <Box marginBottom={1}>
        <Text color="white">Current: </Text>
        <Text color="green">{model}</Text>
      </Box>

      {noKeysConfigured && (
        <Box marginBottom={1}>
          <Text color="yellow">
            No API keys configured. Store one with
          </Text>
          <Box>
            <Text color="yellow">  vajra auth login &lt;key&gt;</Text>
          </Box>
        </Box>
      )}

      <Box flexDirection="column" marginBottom={1}>
        {modelItems.map((item, idx) => (
          <Box key={item.type === 'preset' ? item.id : item.type}>
            <Text color={idx === modelIdx ? 'cyan' : 'white'}>
              {idx === modelIdx ? '▸ ' : '  '}
              {item.type === 'preset' ? item.id : item.type === 'custom' ? 'Custom…' : 'Back'}
            </Text>
            {idx === modelIdx && item.type === 'preset' && (
              <Text color="white">  {item.hint}</Text>
            )}
            {idx === modelIdx && item.type === 'custom' && (
              <Text color="white">  Type any model id (zen/*, go/*)</Text>
            )}
          </Box>
        ))}
      </Box>

      {customDraft !== null && (
        <Box marginBottom={1}>
          <Text color="cyan">Model id: </Text>
          <Text color="white">{customDraft}█</Text>
        </Box>
      )}

      {modelError && (
        <Box marginBottom={1}>
          <Text color="red">{modelError}</Text>
        </Box>
      )}

      <Box>
        <Text color="white">
          {customDraft !== null ? 'Enter Save  Esc Cancel' : '↑↓ Navigate  Enter Select  Esc Back'}
        </Text>
      </Box>
    </Box>
  )
}
