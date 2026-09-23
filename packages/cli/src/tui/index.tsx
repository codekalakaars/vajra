import React, { useState, useRef } from 'react'
import { render, Box, Text, useInput, useApp } from 'ink'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { MODEL_PRESETS, normalizeModelId, resolveDefaultModel } from '../env.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

type SpawnAction = 'run' | 'video' | 'config' | 'help'
type MenuKey = SpawnAction | 'model' | 'exit'
type Screen = 'menu' | 'model'

type ModelChoice =
  | { type: 'preset'; id: string; hint: string }
  | { type: 'custom' }
  | { type: 'back' }

interface AppProps {
  version: string
  initialModel: string
  onModelChange: (model: string) => void
  onSelect: (action: SpawnAction | 'exit') => void
}

function App({ version, initialModel, onModelChange, onSelect }: AppProps) {
  const [screen, setScreen] = useState<Screen>('menu')
  const [menuIdx, setMenuIdx] = useState(0)
  const [modelIdx, setModelIdx] = useState(0)
  const [customDraft, setCustomDraft] = useState<string | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [menuMessage, setMenuMessage] = useState<string | null>(null)
  const [currentModel, setCurrentModelState] = useState(initialModel)
  const menuIdxRef = useRef(0)
  const modelIdxRef = useRef(0)
  const { exit } = useApp()

  function select(action: SpawnAction | 'exit') {
    onSelect(action)
    exit()
  }

  const menuItems: Array<{ key: MenuKey; label: string; description?: string }> = [
    { key: 'run', label: 'Run Agent', description: `Start an interactive session (model: ${currentModel})` },
    { key: 'model', label: 'Model', description: `Change LLM model (current: ${currentModel})` },
    { key: 'video', label: 'Video Tools', description: 'Create and manage HyperFrames videos' },
    { key: 'config', label: 'Config', description: 'View or update configuration' },
    { key: 'help', label: 'Help', description: 'Show usage information' },
    { key: 'exit', label: 'Exit' },
  ]

  const modelItems: ModelChoice[] = [
    ...MODEL_PRESETS.map((p): ModelChoice => ({ type: 'preset', id: p.id, hint: p.hint })),
    { type: 'custom' },
    { type: 'back' },
  ]

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

  function moveSelection(
    direction: 1 | -1,
    items: unknown[],
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
      } else {
        select(itemKey)
      }
    }
  })

  if (screen === 'model') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">⚡ Vajra</Text>
          <Text color="gray"> v{version} — Model</Text>
        </Box>

        <Box marginBottom={1}>
          <Text color="gray">Current: </Text>
          <Text color="green">{currentModel}</Text>
        </Box>

        <Box flexDirection="column" marginBottom={1}>
          {modelItems.map((item, idx) => (
            <Box key={item.type === 'preset' ? item.id : item.type}>
              <Text color={idx === modelIdx ? 'cyan' : 'white'}>
                {idx === modelIdx ? '▸ ' : '  '}
                {item.type === 'preset' ? item.id : item.type === 'custom' ? 'Custom…' : 'Back'}
              </Text>
              {idx === modelIdx && item.type === 'preset' && (
                <Text color="gray">  {item.hint}</Text>
              )}
              {idx === modelIdx && item.type === 'custom' && (
                <Text color="gray">  Type any OpenRouter model id</Text>
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
          <Text color="gray" dimColor>
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
        <Text color="gray"> v{version}</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {menuItems.map((item, idx) => (
          <Box key={item.label}>
            <Text color={idx === menuIdx ? 'cyan' : 'white'}>
              {idx === menuIdx ? '▸ ' : '  '}{item.label}
            </Text>
            {idx === menuIdx && item.description && (
              <Text color="gray">  {item.description}</Text>
            )}
          </Box>
        ))}
      </Box>

      {menuMessage && (
        <Box marginBottom={1}>
          <Text color="green">{menuMessage}</Text>
        </Box>
      )}

      <Box>
        <Text color="gray" dimColor>↑↓ Navigate  Enter Select  q Quit</Text>
      </Box>
    </Box>
  )
}

const MENU_COMMANDS: Record<Exclude<SpawnAction, 'run'>, { command: string; args: string[] }> = {
  video: { command: 'video', args: ['--help'] },
  config: { command: 'config', args: [] },
  help: { command: '--help', args: [] },
}

function runEntry(command: string, args: string[] = []): Promise<void> {
  // Re-invoke the same entry script (works for both dist/index.js and dev src runs).
  const self = process.argv[1] ?? resolve(__dirname, '..', 'index.js')
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [self, command, ...args], {
      stdio: 'inherit',
      cwd: process.cwd(),
    })
    child.on('close', () => resolvePromise())
    child.on('error', () => resolvePromise())
  })
}

export async function startTUI(version: string): Promise<void> {
  if (!process.stdin.isTTY) {
    console.log('Vajra CLI - Run with --help for usage')
    process.exit(0)
  }

  // Loop so subcommands (config, help, ...) return to the menu when they finish.
  // Only 'Exit' (or q / Ctrl+C) leaves the TUI.
  // The model is session-scoped: picked in the Model screen, passed to `run` via -m.
  let sessionModel = resolveDefaultModel()
  while (true) {
    let selection: SpawnAction | 'exit' = 'exit'
    const instance = render(
      <App
        version={version}
        initialModel={sessionModel}
        onModelChange={(model) => { sessionModel = model }}
        onSelect={(action) => { selection = action }}
      />,
    )
    await instance.waitUntilExit()

    if (selection === 'exit') {
      return
    }

    if (selection === 'run') {
      await runEntry('run', ['-m', sessionModel])
    } else {
      const { command, args } = MENU_COMMANDS[selection]
      await runEntry(command, args)
    }
  }
}
