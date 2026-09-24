import React from 'react'
import { Box, Text } from 'ink'
import type { DeveloperPlan } from '@codekalakaars/vajra-protocol'
import { renderMarkdown } from '../../streaming.js'
import type { Entry, SessionState, PendingPrompt, TaskStatus } from './store.js'

const TASK_ICONS: Record<TaskStatus, { icon: string; color: string }> = {
  pending: { icon: '○', color: 'gray' },
  running: { icon: '◉', color: 'yellow' },
  done: { icon: '✓', color: 'green' },
  failed: { icon: '✗', color: 'red' },
  skipped: { icon: '⊘', color: 'gray' },
}

export function StatusHeader({
  model,
  projectDir,
  working,
  interrupted,
}: {
  model: string
  projectDir: string
  working: boolean
  interrupted: boolean
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color="cyan">⚡ Vajra Session</Text>
        <Text color="gray">  {model}</Text>
      </Box>
      <Box>
        <Text color="gray">Dir: </Text>
        <Text color="yellow">{projectDir}</Text>
        {interrupted ? (
          <Text color="red">  ● interrupted</Text>
        ) : working ? (
          <Text color="green">  ● working</Text>
        ) : null}
      </Box>
    </Box>
  )
}

export function PlanCard({ plan }: { plan: DeveloperPlan }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginY={1}
    >
      <Text bold color="cyan">📋 Plan</Text>
      {plan.tasks.map((task, i) => (
        <Box key={task.id ?? i} flexDirection="column">
          <Text>
            <Text color="cyan">{i + 1}. </Text>
            <Text>{task.title} </Text>
            <Text color="gray">
              [{task.type}]{task.timeoutSeconds ? ` (${task.timeoutSeconds}s)` : ''}
            </Text>
          </Text>
          {task.writeFile && task.writeFile.length > 0 && (
            <Text color="gray">    writes: {task.writeFile.join(', ')}</Text>
          )}
          {task.validation && task.validation.length > 0 && (
            <Text color="gray">    validation: {task.validation.join(' && ')}</Text>
          )}
          {task.dependsOn && task.dependsOn.length > 0 && (
            <Text color="gray">    depends on: {task.dependsOn.join(', ')}</Text>
          )}
        </Box>
      ))}
    </Box>
  )
}

export function TaskList({
  tasks,
  index,
  total,
}: {
  tasks: SessionState['tasks']
  index: number
  total: number
}) {
  if (tasks.length === 0) return null
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">
        Tasks [{index}/{total}]
      </Text>
      {tasks.map((task, i) => {
        const { icon, color } = TASK_ICONS[task.status]
        return (
          <Text key={i}>
            <Text color={color as 'green'}>{icon} </Text>
            <Text color={task.status === 'pending' ? 'gray' : undefined}>{task.title}</Text>
          </Text>
        )
      })}
    </Box>
  )
}

function EntryView({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case 'banner': {
      const title = `Vajra v${entry.version}`
      const border = '═'.repeat(title.length + 2)
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="magenta">╔{border}╗</Text>
          <Text bold color="magenta">║ {title} ║</Text>
          <Text bold color="magenta">╚{border}╝</Text>
        </Box>
      )
    }
    case 'user':
      return (
        <Box marginBottom={0}>
          <Text color="cyan" bold>❯ </Text>
          <Text color="cyan">{entry.text}</Text>
        </Box>
      )
    case 'assistant':
      return <Text>{renderMarkdown(entry.text).replace(/\n+$/, '')}</Text>
    case 'info':
      return <Text color="cyan">{entry.text}</Text>
    case 'success':
      return <Text color="green">{entry.text}</Text>
    case 'error':
      return <Text color="red">{entry.text}</Text>
    case 'warning':
      return <Text color="yellow">{entry.text}</Text>
    case 'decision':
      return (
        <Box marginBottom={0}>
          <Text color="magenta">{entry.text}</Text>
        </Box>
      )
    case 'plan':
      return <PlanCard plan={entry.plan} />
    case 'blank':
      return <Text> </Text>
  }
}

export function Transcript({ state }: { state: SessionState }) {
  return (
    <Box flexDirection="column">
      {state.entries.map((entry, i) => (
        <EntryView key={i} entry={entry} />
      ))}
      {state.thinking && (
        <Text dimColor italic>{state.thinking}</Text>
      )}
      {state.streaming && <Text>{state.streaming}</Text>}
    </Box>
  )
}

export function ChatInput({
  prompt,
  draft,
}: {
  prompt: PendingPrompt
  draft: string
}) {
  const isConfirm = prompt.kind === 'confirm-plan'
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text bold color="magenta">{prompt.label} </Text>
        <Text>{draft}</Text>
        <Text inverse> █</Text>
      </Box>
      <Text color="gray">
        {isConfirm
          ? 'Type y or n, Enter to submit (empty = no)'
          : 'Enter send  Esc clear  type "exit" to quit'}
      </Text>
    </Box>
  )
}

export function FinishedScreen({ exitCode }: { exitCode: number }) {
  const failed = exitCode !== 0
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={failed ? 'red' : 'green'}>
        Session ended (exit {exitCode}).
      </Text>
      <Text color="gray">Press any key to return to the menu.</Text>
    </Box>
  )
}

export function WorkingHint({ interrupted }: { interrupted: boolean }) {
  return (
    <Box marginTop={1}>
      <Text color={interrupted ? 'red' : 'green'}>
        {interrupted ? '⏹ Interrupted — finishing…' : '⏳ Working… (Ctrl-C to interrupt)'}
      </Text>
    </Box>
  )
}
