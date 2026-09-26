/**
 * The transcript is split in two, and the split is the whole point:
 *
 * - Settled history goes into `<Static>`, which paints each entry exactly once
 *   into scrollback and never repaints it.
 * - Only live content — the streaming tail, thinking, and what an agent is doing
 *   right now — sits in the repainted region.
 *
 * Repainting settled history is what makes a long session flicker: the taller the
 * frame, the more there is to erase and redraw on every token, so the cost grew
 * with the length of the session. History that is written once cannot flicker.
 */
export function Transcript({ state }: { state: SessionState }) {
  return (
    <Box flexDirection="column">
      <Static items={state.entries}>{entry => <EntryView key={entry.seq} entry={entry} />}</Static>
      {state.developer && <DeveloperRow activity={state.developer} />}
      {state.thinking && <Text dimColor italic>{state.thinking}</Text>}
      {state.streaming && <Text>{state.streaming}</Text>}
    </Box>
  )
}

/**
 * Rows of the task list the live region will paint. A 40-task plan would
 * otherwise push the input and the current activity off the screen, and make
 * every repaint proportionally taller.
 */
const MAX_TASK_WINDOW = 10

/**
 * Rows of task list the live region may paint, given the terminal it is in.
 *
 * A frame taller than the terminal does not degrade gracefully — Ink scrolls to
 * keep the bottom visible, so every repaint shifts the whole view. Reserving
 * room for the header, the live activity, the input and the hint line keeps the
 * frame inside the viewport on a small window as well as a large one.
 */
function taskWindowFor(rows: number | undefined): number {
  if (typeof rows !== 'number' || rows <= 0) return MAX_TASK_WINDOW
  const room = rows - 12
  return Math.max(3, Math.min(MAX_TASK_WINDOW, room))
}

import React from 'react'
import { Box, Static, Text, useStdout } from 'ink'
import type { DeveloperPlan } from '@codekalakaars/vajra-protocol'
import { renderMarkdown } from '../../streaming.js'
import type { AgentActivity, Entry, SessionState, PendingPrompt, TaskStatus } from './store.js'

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

function elapsed(since: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000))
  return seconds < 1 ? '0.1s' : `${seconds}s`
}

function ActivityLine({ activity }: { activity: AgentActivity }) {
  const what = activity.tool
    ? `${activity.tool}${activity.summary ? ` ${activity.summary}` : ''}`
    : (activity.phase ?? '')
  return (
    <Text color="gray">
      {' '}
      ↳ {what} {elapsed(activity.since)}
      {activity.toolCount > 0 ? ` · ${activity.toolCount} tool${activity.toolCount === 1 ? '' : 's'}` : ''}
    </Text>
  )
}

export function DeveloperRow({ activity }: { activity: AgentActivity | undefined }) {
  if (!activity) return null
  return (
    <Text>
      <Text color="magenta">◆ developer </Text>
      {activity.tool || activity.phase ? <ActivityLine activity={activity} /> : <Text color="gray"> thinking…</Text>}
    </Text>
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
  const { stdout } = useStdout()
  const taskWindow = taskWindowFor(stdout?.rows)
  if (tasks.length === 0) return null
  // Active work comes first — a long plan must not scroll the task you are
  // watching out of view — then everything else fills the remaining rows in plan
  // order. The window is still a hard bound: if more tasks are running than fit,
  // the overflow is counted rather than drawn, because a frame taller than the
  // terminal scrolls on every repaint, which is the flicker this avoids.
  const running = tasks.filter(t => t.status === 'running')
  const rest = tasks.filter(t => t.status !== 'running')
  const shown = new Set([
    ...running.slice(0, taskWindow),
    ...rest.slice(0, Math.max(0, taskWindow - Math.min(running.length, taskWindow))),
  ])
  const visible = tasks.filter(t => shown.has(t))
  const hidden = tasks.length - visible.length
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">
        Tasks [{index}/{total}]
      </Text>
      {hidden > 0 && (
        <Text color="gray">
          {'  '}
          … {hidden} more task{hidden === 1 ? '' : 's'}
        </Text>
      )}
      {visible.map((task, i) => {
        const { icon, color } = TASK_ICONS[task.status]
        return (
          <Box key={i} flexDirection="column">
            <Text>
              <Text color={color as 'green'}>{icon} </Text>
              <Text color={task.status === 'pending' ? 'gray' : undefined}>{task.title}</Text>
            </Text>
            {task.activity && <ActivityLine activity={task.activity} />}
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * Memoised on purpose. The transcript re-renders on every streamed token, and
 * each assistant entry runs marked-terminal over its markdown — re-parsing the
 * whole history per token is what made the view flicker. Entries are immutable
 * once committed, so an unchanged one can bail out immediately.
 */
const EntryView = React.memo(function EntryView({ entry }: { entry: Entry }) {
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
})

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
