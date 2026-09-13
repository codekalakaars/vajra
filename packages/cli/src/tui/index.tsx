import React, { useState, useEffect } from 'react'
import { render, Box, Text, useInput, useApp } from 'ink'

interface AppProps {
  version: string
}

function App({ version }: AppProps) {
  const [selectedIdx, setSelectedIdx] = useState(0)
  const { exit } = useApp()

  const menuItems = [
    'New Project',
    'List Projects',
    'Config',
    'Exit',
  ]

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit()
    } else if (key.upArrow) {
      setSelectedIdx(prev => prev === 0 ? menuItems.length - 1 : prev - 1)
    } else if (key.downArrow) {
      setSelectedIdx(prev => prev === menuItems.length - 1 ? 0 : prev + 1)
    } else if (key.return) {
      const item = menuItems[selectedIdx]
      if (item === 'Exit') exit()
      // Other menu actions will be handled later
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
          <Box key={item}>
            <Text color={idx === selectedIdx ? 'cyan' : 'white'}>
              {idx === selectedIdx ? '▸ ' : '  '}{item}
            </Text>
          </Box>
        ))}
      </Box>

      <Box>
        <Text color="gray" dimColor>↑↓ Navigate  Enter Select  q Quit</Text>
      </Box>
    </Box>
  )
}

export function startTUI(version: string) {
  const { unmount, waitUntilExit } = render(<App version={version} />)
  return { unmount, waitUntilExit }
}
