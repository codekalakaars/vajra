import React, { useState, useRef } from 'react'
import { render, Box, Text, useInput, useApp } from 'ink'
import { resolve } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import {
  DEFAULT_DIR_KEY,
  DEFAULT_MODEL_KEY,
  isPersistedDefault,
  listAvailableModels,
  loadEnvIntoProcess,
  normalizeModelId,
  resolveDefaultDir,
  resolveDefaultModel,
  saveDefaults,
} from '../env.js'
import { startSession } from './session/index.js'

type SpawnAction = 'run'
type MenuKey = SpawnAction | 'model' | 'dir' | 'defaults' | 'exit'
type Screen = 'menu' | 'model' | 'dir' | 'defaults'

/**
 * Which gateway a model id routes to. Provider is not independently
 * selectable — `resolveBaseURL` in agent/chat.ts derives it from the prefix.
 */
function gatewayFor(model: string): string {
  if (model.startsWith('go/')) return 'OpenCode Zen (go)'
  if (model.startsWith('zen/')) return 'OpenCode Zen'
  return 'unsupported'
}

type ModelChoice =
  | { type: 'preset'; id: string; hint: string }
  | { type: 'custom' }
  | { type: 'back' }

interface AppProps {
  version: string
  initialModel: string
  initialDir: string
  onModelChange: (model: string) => void
  onDirChange: (dir: string) => void
  onSelect: (action: SpawnAction | 'exit') => void
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

function App({ version, initialModel, initialDir, onModelChange, onDirChange, onSelect }: AppProps) {
  const [screen, setScreen] = useState<Screen>('menu')
  const [menuIdx, setMenuIdx] = useState(0)
  const [modelIdx, setModelIdx] = useState(0)
  const [customDraft, setCustomDraft] = useState<string | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [menuMessage, setMenuMessage] = useState<string | null>(null)
  const [currentModel, setCurrentModelState] = useState(initialModel)
  const [projectDir, setProjectDir] = useState(initialDir)
  const [dirDraft, setDirDraft] = useState<string | null>(null)
  const [dirError, setDirError] = useState<string | null>(null)
  const [defaultsIdx, setDefaultsIdx] = useState(0)
  const [defaultsError, setDefaultsError] = useState<string | null>(null)
  const menuIdxRef = useRef(0)
  const modelIdxRef = useRef(0)
  const defaultsIdxRef = useRef(0)
  const { exit } = useApp()

  function select(action: SpawnAction | 'exit') {
    onSelect(action)
    exit()
  }

  const menuItems: Array<{ key: MenuKey; label: string; description?: string }> = [
    { key: 'run', label: 'Run Agent', description: `Start an interactive session (model: ${currentModel})` },
    { key: 'model', label: 'Model', description: `Change LLM model (current: ${currentModel})` },
    { key: 'dir', label: 'Directory', description: `Change working directory (current: ${projectDir})` },
    { key: 'defaults', label: 'Defaults', description: 'Save model and directory so they persist across restarts' },
    { key: 'exit', label: 'Exit' },
  ]

  const defaultsItems = [
    { key: 'save-both', label: 'Save model and directory as defaults' },
    { key: 'save-model', label: `Save model only (${currentModel})` },
    { key: 'save-dir', label: 'Save directory only' },
    { key: 'back', label: 'Back' },
  ] as const

  const availableModels = listAvailableModels()
  const modelItems: ModelChoice[] = [
    ...availableModels.map((p): ModelChoice => ({ type: 'preset', id: p.id, hint: p.hint })),
    { type: 'custom' },
    { type: 'back' },
  ]
  const noKeysConfigured = availableModels.length === 0

  function saveModel(id: string) {
    try {
      const saved = normalizeModelId(id)
      onModelChange(saved)
      setCurrentModelState(saved)
      setModelError(null)
      setCustomDraft(null)
      setScreen('menu')
      setMenuMessage(`Model set to ${saved}`)
    } catch (e) {
      setModelError(e instanceof Error ? e.message : String(e))
    }
  }

  function persistDefaults(what: 'save-both' | 'save-model' | 'save-dir') {
    try {
      const envPath = saveDefaults({
        model: what === 'save-dir' ? undefined : currentModel,
        projectDir: what === 'save-model' ? undefined : projectDir,
      })
      setDefaultsError(null)
      setScreen('menu')
      setMenuMessage(`Defaults saved to ${envPath}`)
    } catch (e) {
      setDefaultsError(e instanceof Error ? e.message : String(e))
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
    setProjectDir(abs)
    onDirChange(abs)
    setDirDraft(null)
    setDirError(null)
    setScreen('menu')
    setMenuMessage(`Directory set to ${abs}`)
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

  useInput((input, key) => {
    // Custom model id entry: literal typing, Enter saves, Esc cancels.
    if (customDraft !== null) {
      if (key.return) {
        saveModel(customDraft)
      } else if (key.escape || (key.ctrl && input === 'c')) {
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
      } else if (key.escape || (key.ctrl && input === 'c')) {
        setDirDraft(null)
        setDirError(null)
        setScreen('menu')
      } else if (key.backspace || key.delete) {
        setDirDraft(d => (d ?? '').slice(0, -1))
      } else if (input && !key.ctrl && !key.meta) {
        setDirDraft(d => (d ?? '') + input)
      }
      return
    }

    if (screen === 'model') {
      if (key.escape || input === 'q') {
        setModelError(null)
        setScreen('menu')
        return
      }
      if (key.ctrl && input === 'c') {
        select('exit')
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
          setModelError(null)
          setScreen('menu')
        }
      }
      return
    }

    if (screen === 'defaults') {
      if (key.escape || input === 'q') {
        setDefaultsError(null)
        setScreen('menu')
        return
      }
      if (key.ctrl && input === 'c') {
        select('exit')
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
          setDefaultsError(null)
          setScreen('menu')
        } else {
          persistDefaults(choice)
        }
      }
      return
    }

    if (screen === 'dir') {
      if (key.escape || input === 'q') {
        setDirError(null)
        setScreen('menu')
        return
      }
      if (key.ctrl && input === 'c') {
        select('exit')
        return
      }
      if (key.return || input === '\r' || input === '\n') {
        setDirError(null)
        setDirDraft('')
      }
      return
    }

    if (input === 'q' || (key.ctrl && input === 'c')) {
      select('exit')
    } else if (key.upArrow) {
      setMenuMessage(null)
      moveSelection(-1, menuItems, menuIdxRef, setMenuIdx)
    } else if (key.downArrow) {
      setMenuMessage(null)
      moveSelection(1, menuItems, menuIdxRef, setMenuIdx)
    } else if (key.return || input === '\r' || input === '\n') {
      const itemKey = menuItems[menuIdxRef.current].key
      if (itemKey === 'model') {
        setMenuMessage(null)
        setModelError(null)
        setModelIdx(0)
        modelIdxRef.current = 0
        setScreen('model')
      } else if (itemKey === 'dir') {
        setMenuMessage(null)
        setDirError(null)
        setDirDraft('')
        setScreen('dir')
      } else if (itemKey === 'defaults') {
        setMenuMessage(null)
        setDefaultsError(null)
        setDefaultsIdx(0)
        defaultsIdxRef.current = 0
        setScreen('defaults')
      } else {
        select(itemKey)
      }
    }
  })

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
            <Text color="green">{currentModel}</Text>
            <Text color="white">{modelPersisted ? '  (saved)' : '  (this session only)'}</Text>
          </Box>
          <Box>
            <Text color="white">Gateway   </Text>
            <Text color="yellow">{gatewayFor(currentModel)}</Text>
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

  if (screen === 'model') {
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
          <Text color="green">{currentModel}</Text>
        </Box>

        {noKeysConfigured && (
          <Box marginBottom={1}>
            <Text color="yellow">
              No API keys configured. Set OPENCODE_API_KEY (Zen free) via
            </Text>
            <Box>
              <Text color="yellow">  vajra config -s OPENCODE_API_KEY=...</Text>
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

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">⚡ Vajra</Text>
        <Text color="white"> v{version}</Text>
      </Box>

      <Box marginBottom={1}>
        <Text color="white">Dir: </Text>
        <Text color="yellow">{projectDir}</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {menuItems.map((item, idx) => (
          <Text key={item.label} color={idx === menuIdx ? 'cyan' : 'white'}>
            {idx === menuIdx ? '▸ ' : '  '}{item.label}
            {idx === menuIdx && item.description ? `  ${item.description}` : ''}
          </Text>
        ))}
      </Box>

      {menuMessage && (
        <Box marginBottom={1}>
          <Text color="green">{menuMessage}</Text>
        </Box>
      )}

      <Box>
        <Text color="white">↑↓ Navigate  Enter Select  q Quit</Text>
      </Box>
    </Box>
  )
}

export async function startTUI(version: string): Promise<void> {
  if (!process.stdin.isTTY) {
    console.log('Vajra CLI - Run with --help for usage')
    process.exit(0)
  }

  // Loop so returning from a subcommand goes back to the menu.
  // Only 'Exit' (or q / Ctrl+C) leaves the TUI.
  // Seeded from saved defaults (.env), then session-scoped until the user
  // saves again from the Defaults screen.
  let sessionModel = resolveDefaultModel()
  let sessionDir = resolveDefaultDir()
  while (true) {
    // Re-read .env each lap: Config -s runs in a child and only updates the file.
    loadEnvIntoProcess()
    let selection: SpawnAction | 'exit' = 'exit'
    const instance = render(
      <App
        version={version}
        initialModel={sessionModel}
        initialDir={sessionDir}
        onModelChange={(model) => { sessionModel = model }}
        onDirChange={(dir) => { sessionDir = dir }}
        onSelect={(action) => { selection = action }}
      />,
    )
    await instance.waitUntilExit()

    if (selection === 'exit') {
      return
    }

    if (selection === 'run') {
      await startSession({
        version,
        model: sessionModel,
        projectDir: sessionDir,
      })
    }
  }
}
