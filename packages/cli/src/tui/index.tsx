import React, { useState, useRef } from 'react'
import { render, Box, Text, useInput, useApp } from 'ink'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

interface AppProps {
  version: string
}

function App({ version }: AppProps) {
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const selectedIdxRef = useRef(0)
  const { exit } = useApp()

  function runCommand(command: string, args: string[] = []) {
    // Re-invoke the same entry script (works for both dist/index.js and dev src runs).
    const self = process.argv[1] ?? resolve(__dirname, '..', 'index.js')
    const child = spawn(process.execPath, [self, command, ...args], {
      stdio: 'inherit',
      cwd: process.cwd(),
    })
    child.on('close', (code) => {
      process.exitCode = code ?? 0
      exit()
    })
  }

  const menuItems = [
    { label: 'Run Agent', description: 'Start an interactive session with the developer agent', action: () => { exit(); runCommand('run') } },
    { label: 'Video Tools', description: 'Create and manage HyperFrames videos', action: () => { exit(); runCommand('video', ['--help']) } },
    { label: 'Config', description: 'View or update configuration', action: () => { exit(); runCommand('config') } },
    { label: 'Help', description: 'Show usage information', action: () => { exit(); runCommand('--help') } },
    { label: 'Exit', action: () => exit() },
  ]

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit()
    } else if (key.upArrow) {
      setMessage(null)
      setSelectedIdx(prev => {
        const next = prev === 0 ? menuItems.length - 1 : prev - 1
        selectedIdxRef.current = next
        return next
      })
    } else if (key.downArrow) {
      setMessage(null)
      setSelectedIdx(prev => {
        const next = prev === menuItems.length - 1 ? 0 : prev + 1
        selectedIdxRef.current = next
        return next
      })
    } else if (key.return || input === '\r' || input === '\n') {
      const idx = selectedIdxRef.current
      menuItems[idx].action()
    }
  })

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">⚡ Vajra</Text>
        <Text color="gray"> v{version}</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {menuItems.map((item, idx) => (
          <Box key={item.label}>
            <Text color={idx === selectedIdx ? 'cyan' : 'white'}>
              {idx === selectedIdx ? '▸ ' : '  '}{item.label}
            </Text>
            {idx === selectedIdx && item.description && (
              <Text color="gray">  {item.description}</Text>
            )}
          </Box>
        ))}
      </Box>

      {message && (
        <Box marginBottom={1}>
          <Text color="yellow">{message}</Text>
        </Box>
      )}

      <Box>
        <Text color="gray" dimColor>↑↓ Navigate  Enter Select  q Quit</Text>
      </Box>
    </Box>
  )
}

export async function startTUI(version: string): Promise<void> {
  if (!process.stdin.isTTY) {
    console.log('Vajra CLI - Run with --help for usage')
    process.exit(0)
  }

  const { waitUntilExit } = render(<App version={version} />)
  await waitUntilExit()
}
