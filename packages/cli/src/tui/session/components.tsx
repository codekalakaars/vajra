/**
 * The session is a fixed-height application, not a print log.
 *
 * The screen splits into five bands — header, transcript viewport, task pane,
 * input, status bar — whose heights are budgeted up front (SessionApp), so the
 * frame is exactly the terminal height and every repaint rewrites the same
 * number of rows. Inside the viewport, settled history is a virtualised slice
 * (viewport.ts): in follow mode the column is bottom-anchored and clipped, so
 * new output scrolls old output off the top exactly like a terminal; in
 * scroll mode the slice is frozen and the live tail is hidden, so browsing
 * history never races the stream. Nothing here repainting can outgrow the
 * terminal — that property is what keeps a long session flicker-free.
 */
import React from 'react'
import { Box, Text, useAnimation, useStdout } from 'ink'
import type { DeveloperPlan } from '@codekalakaars/vajra-protocol'
import type {
  AgentActivity,
  Entry,
  SessionState,
  PendingPrompt,
  ReasoningEffort,
  TaskStatus,
  UsageState,
} from './store.js'
import type { EditorState } from './editor.js'
import type { TaskPaneLayout, Viewport } from './viewport.js'
import { Markdown } from './markdown.js'
import { editorSplits } from './editor.js'
import { estimateMarkdownLines, estimateTextLines, taskPaneLayout } from './viewport.js'
import { formatElapsed } from '../../session/ui.js'

const TASK_ICONS: Record<TaskStatus, { icon: string; color: string }> = {
  pending: { icon: '○', color: 'gray' },
  running: { icon: '◉', color: 'yellow' },
  done: { icon: '✓', color: 'green' },
  failed: { icon: '✗', color: 'red' },
  skipped: { icon: '⊘', color: 'gray' },
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * Layout budget, in rows.
 *
 * The identity line lives at the *bottom*, under the prompt — OpenCode's
 * arrangement — and the session's live state lives in a right-hand sidebar:
 * OpenCode's transcript owns the width, and the status that used to crowd the
 * prompt is the first thing in the side column, with the task list following
 * it. Narrow terminals drop the sidebar and fold the status back into the
 * bottom line, because a 40-column transcript is worse than a crowded bar.
 *
 * Every band is counted so the frame is exactly the terminal height.
 */
export const STATUS_ROWS = 2
/** The working indicator above the prompt, when no input is open. */
export const WORKING_ROWS = 1
/** Columns the sidebar occupies, and the width below which it is not drawn. */
export const SIDEBAR_WIDTH = 30
export const SIDEBAR_MIN_COLUMNS = 100

function truncate(text: string, max: number): string {
  if (max <= 1) return text.slice(0, Math.max(1, max))
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Keep only the tail of a long path: the directory is the useful part. */
function shortPath(text: string, max: number): string {
  if (text.length <= max) return text
  const parts = text.split('/')
  if (parts.length <= 2) return truncate(text, max)
  return `…/${truncate(parts.slice(-2).join('/'), Math.max(1, max - 2))}`
}

/** Estimated rows of the live tail: activity, thinking, streaming markdown. */
export function estimateLiveRows(state: SessionState, width: number): number {
  let rows = 0
  if (state.developer) rows += 1
  if (state.thinking) rows += estimateTextLines(state.thinking, width)
  if (state.streaming) rows += estimateMarkdownLines(state.streaming, width)
  return rows
}

/**
 * Live status: idle, working (spinner) or interrupted.
 *
 * Shared by the sidebar and by the narrow-terminal bottom line, so a terminal
 * too small for a sidebar loses the column, not the information.
 */
export function useSessionStatus(interrupted: boolean, working: boolean): {
  icon: string
  color: string
  label: string
} {
  const { frame } = useAnimation({ interval: 100, isActive: working && !interrupted })
  if (interrupted) return { icon: '■', color: 'red', label: 'interrupted' }
  if (working) {
    return {
      icon: SPINNER_FRAMES[frame % SPINNER_FRAMES.length],
      color: 'green',
      label: 'working',
    }
  }
  return { icon: '●', color: 'gray', label: 'idle' }
}

/**
 * The right-hand column: what the session is doing, and what it is working on.
 *
 * The status and the context meter were the most-changed pixels on screen and
 * the least-read, so they moved off the prompt's row and into a column that has
 * room to grow — the task list lands here next. The column is bounded by
 * `height`, because a sidebar that outgrows the frame pushes the whole layout
 * one row past the terminal, which is the flicker this layout exists to avoid.
 */
export function Sidebar({
  state,
  width,
  height,
  limit,
}: {
  state: SessionState
  width: number
  height: number
  limit: number
}) {
  const status = useSessionStatus(state.interrupted, !state.prompt)
  const inner = Math.max(8, width - 2)
  // The status row, then the blank that separates it from the list. The
  // context meter used to live here too; the prompt row owns that now.
  const taskBudget = Math.max(0, height - 2)

  return (
    <Box flexDirection="column" width={width} borderStyle="single" borderColor="gray" borderLeft borderRight={false} borderTop={false} borderBottom={false} paddingLeft={1}>
      <Text>
        <Text color={status.color as 'green'}>{status.icon} </Text>
        <Text>{status.label}</Text>
      </Text>
      {state.tasks.length > 0 && taskBudget > 2 ? (
        <Box flexDirection="column" marginTop={1}>
          <TaskList
            tasks={state.tasks}
            index={state.executionIndex}
            total={state.executionTotal}
            maxRows={state.tasks.length}
            terminalRows={0}
            width={inner}
            rowBudget={taskBudget}
          />
        </Box>
      ) : state.tasks.length > 0 ? (
        <Text dimColor>tasks {state.executionIndex}/{state.executionTotal}</Text>
      ) : null}
    </Box>
  )
}

/**
 * The one line at the very bottom: which build, which model, which directory.
 * Live state moved to the sidebar; what is left here is identity, and it does
 * not change during a session, so it stops repainting with every token.
 */
/**
 * The session frame: one vertical rule down the left edge, everything else
 * inside it. This is the rule OpenCode draws around the whole screen, and the
 * input and transcript sit against it rather than each ruling themselves.
 *
 * `width` is the content width *inside* the rule and the padding, which is why
 * it is three cells short of the terminal (one rule, one pad, one pad).
 */
export function SessionFrame({
  width,
  children,
}: {
  width: number
  children: React.ReactNode
}) {
  return (
    <Box
      flexDirection="column"
      paddingX={1}
      borderStyle="single"
      borderColor="gray"
      borderLeft
      borderRight={false}
      borderTop={false}
      borderBottom={false}
    >
      {children}
    </Box>
  )
}

export function StatusBar({
  version,
  projectDir,
  width,
  live,
}: {
  version: string
  projectDir: string
  width: number
  /** Live status, shown only when the terminal is too narrow for a sidebar. */
  live?: { icon: string; color: string; label: string }
}) {
  // OpenCode's footer: a rule over one identity line — the path where you are,
  // the build at the right edge. The model is deliberately absent: it is
  // session state, not chrome, and repeating it on every frame was noise.
  const versionText = `v${version}`
  const liveText = live ? `${live.icon} ${live.label}` : ''
  const block = liveText ? `${liveText}  ${versionText}` : versionText
  // The path absorbs the width: it shortens to its last two segments rather
  // than pushing the line past the terminal.
  const dir = shortPath(projectDir, Math.max(8, width - block.length - 2))
  const gap = Math.max(1, width - dir.length - block.length - 1)

  return (
    <Box flexDirection="column" width={width}>
      <Box
        borderStyle="single"
        borderTop
        borderLeft={false}
        borderRight={false}
        borderBottom={false}
        borderColor="gray"
        paddingLeft={1}
      >
        <Text>
          <Text dimColor>{dir}</Text>
          <Text dimColor>{' '.repeat(gap)}</Text>
          <Text dimColor>{block}</Text>
        </Text>
      </Box>
    </Box>
  )
}

/**
 * Transcript slice plus the live tail, inside a clipped fixed-height box.
 * `justifyContent` picks the anchor: follow mode pins the newest content to
 * the bottom (terminal semantics), scroll mode pins the frozen window to the
 * top.
 */
export function Transcript({
  state,
  viewport,
  focusSeq,
}: {
  state: SessionState
  viewport: Viewport
  focusSeq?: number | null
}) {
  const slice = state.entries.slice(viewport.start, viewport.end)
  const follow = viewport.mode === 'follow'
  return (
    <Box
      flexDirection="column"
      height={viewport.rows}
      overflowY="hidden"
      justifyContent={follow ? 'flex-end' : 'flex-start'}
    >
      {slice.map(entry => (
        <EntryView key={entry.seq} entry={entry} focused={follow ? false : entry.seq === focusSeq} />
      ))}
      {follow && (
        <>
          {state.developer && <DeveloperRow activity={state.developer} />}
          {state.thinking && <Text dimColor italic>{state.thinking}</Text>}
          {state.streaming && <Markdown text={state.streaming} />}
        </>
      )}
    </Box>
  )
}

function elapsed(since: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000))
  return seconds < 1 ? '0.1s' : `${seconds}s`
}

function ActivityLine({ activity, width }: { activity: AgentActivity; width?: number }) {
  const what = activity.tool
    ? `${activity.tool}${activity.summary ? ` ${activity.summary}` : ''}`
    : (activity.phase ?? '')
  const line = `↳ ${what} ${elapsed(activity.since)}${
    activity.toolCount > 0 ? ` · ${activity.toolCount} tool${activity.toolCount === 1 ? '' : 's'}` : ''
  }`
  return <Text dimColor wrap="truncate">{width ? truncate(line, Math.max(6, width - 3)) : line}</Text>
}

export function DeveloperRow({ activity }: { activity: AgentActivity | undefined }) {
  if (!activity) return null
  return (
    <Text>
      <Text dimColor>◆ developer </Text>
      {activity.tool || activity.phase ? <ActivityLine activity={activity} /> : <Text dimColor>thinking…</Text>}
    </Text>
  )
}

/**
 * The bounded task pane: a bordered box whose row count is computed by the
 * same pure helper the transcript budgets against, so the two can never
 * disagree about how much screen exists.
 */
export function TaskList({
  tasks,
  index,
  total,
  maxRows = 8,
  terminalRows,
  width,
  rowBudget,
}: {
  tasks: SessionState['tasks']
  index: number
  total: number
  maxRows?: number
  terminalRows?: number
  /** Column budget; titles truncate to it instead of wrapping. */
  width?: number
  /** Hard cap on rendered rows, for a column that cannot grow. */
  rowBudget?: number
}) {
  const { stdout } = useStdout()
  const rows =
    typeof terminalRows === 'number' && terminalRows > 0
      ? terminalRows
      : typeof stdout?.rows === 'number'
        ? stdout.rows
        : 24
  if (tasks.length === 0) return null
  const pane = taskPaneLayout(tasks, maxRows, terminalRows === 0 ? 0 : rows, rowBudget)
  // Two cells for the status glyph, and one for the ▸ marker when focused.
  const titleWidth = Math.max(6, (width ?? 80) - 4)
  return (
    <Box flexDirection="column">
      <Text dimColor>
        tasks {index}/{total}
        {pane.hidden > 0 ? ` · ${pane.hidden} more` : ''}
      </Text>
      {pane.shown.map((task, i) => {
        const { icon, color } = TASK_ICONS[task.status]
        return (
          <Box key={i} flexDirection="column">
            <Text wrap="truncate">
              <Text color={color as 'green'}>{icon} </Text>
              <Text dimColor={task.status === 'pending'}>{truncate(task.title, titleWidth)}</Text>
            </Text>
            {task.activity && <ActivityLine activity={task.activity} width={width} />}
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * Memoised on purpose: the transcript re-renders on every streamed token, and
 * each assistant entry parses markdown — re-parsing the whole history per
 * token is what made the view flicker. Committed entries are immutable except
 * for tool-status updates, which legitimately bust just that one row.
 */
const EntryView = React.memo(function EntryView({
  entry,
  focused,
}: {
  entry: Entry
  focused?: boolean
}) {
  switch (entry.kind) {
    case 'banner': {
      // A dim single line, not a box: the status bar at the bottom already
      // carries the identity, and a framed banner is the loudest thing on
      // screen for no information.
      return <Text dimColor>· vajra v{entry.version} ·</Text>
    }
    case 'user':
      return (
        <Text>
          <Text color="cyan">❯ </Text>
          <Text>{entry.text}</Text>
        </Text>
      )
    case 'assistant':
      // Rendered with Ink primitives, not renderMarkdown: that emits ANSI escape
      // bytes, which Ink does not interpret and counts when measuring width.
      return <Markdown text={entry.text} />
    case 'info':
      return <Text dimColor>{entry.text}</Text>
    case 'success':
      return <Text color="green">{entry.text}</Text>
    case 'error':
      return <Text color="red">{entry.text}</Text>
    case 'warning':
      return <Text color="yellow">{entry.text}</Text>
    case 'decision':
      return <Text dimColor>{entry.text}</Text>
    case 'plan':
      return <PlanCard plan={entry.plan} />
    case 'tool': {
      const running = entry.status === 'running'
      const icon = running ? '⋯' : entry.status === 'ok' ? '✓' : '✗'
      const color = running ? 'yellow' : entry.status === 'ok' ? 'green' : 'red'
      const timing = !running && entry.ms !== undefined ? ` · ${formatElapsed(entry.ms)}` : ''
      return (
        <Box flexDirection="column">
          <Text>
            <Text color={focused ? 'cyan' : undefined}>{focused ? '▸' : ' '}</Text>
            <Text color={color as 'green'}> {icon} </Text>
            <Text dimColor>{entry.tool}</Text>
            <Text dimColor> {entry.summary}</Text>
            <Text dimColor>
              {timing}
              {!running && entry.detail ? ` · ${entry.detail}` : ''}
            </Text>
          </Text>
          {entry.expanded && (
            <Text color="gray">     {entry.agent}{running ? ' · running' : ''}</Text>
          )}
        </Box>
      )
    }
    case 'blank':
      return <Text> </Text>
  }
})

export function PlanCard({ plan }: { plan: DeveloperPlan }) {
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text dimColor>plan · {plan.tasks.length} task{plan.tasks.length === 1 ? '' : 's'}</Text>
      {plan.tasks.map((task, i) => (
        <Box key={task.id ?? i} flexDirection="column">
          <Text>
            <Text dimColor>{i + 1}. </Text>
            <Text>{task.title} </Text>
            <Text dimColor>
              [{task.type}]{task.timeoutSeconds ? ` ${task.timeoutSeconds}s` : ''}
            </Text>
          </Text>
          {task.writeFile && task.writeFile.length > 0 && (
            <Text dimColor>   writes: {task.writeFile.join(', ')}</Text>
          )}
          {task.validation && task.validation.length > 0 && (
            <Text dimColor>   checks: {task.validation.join(' && ')}</Text>
          )}
          {task.dependsOn && task.dependsOn.length > 0 && (
            <Text dimColor>   after: {task.dependsOn.join(', ')}</Text>
          )}
        </Box>
      ))}
    </Box>
  )
}

/**
 * The prompt, shaped like OpenCode's: a single left rule, the editor indented
 * two cells inside it, and — under it — one row split between the model (and
 * whatever it is thinking) on the left and the context meter on the right.
 *
 * The question is a *placeholder*: it shows only while the input is empty, so
 * it can never be mistaken for something you typed, and it costs no row once
 * you start writing. The left rule it sits behind is the frame's (see
 * SessionApp); Ink cannot draw OpenCode's `╹` tick or its half-height `▀`
 * bottom rule, which need custom border glyphs.
 */
export function ChatInput({
  prompt,
  editor,
  model,
  thinking,
  effort,
  levels,
}: {
  prompt: PendingPrompt
  editor: EditorState
  model: string
  /** Live reasoning text, shown next to the model while it thinks. */
  thinking?: string
  /** How hard the model should think, right-aligned on the same row. */
  effort: ReasoningEffort
  /** The levels this model accepts; one entry means it cannot reason. */
  levels: ReasoningEffort[]
}) {
  const { before, at, after } = editorSplits(editor)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="column" paddingLeft={2}>
        <Text>
          {editor.value === '' ? (
            // The bolt rides along with the label, and a label can be empty: the
            // user turn has none, and "⚡ " on its own is a glyph asking a
            // question nothing answers. So an unlabelled prompt is an empty row
            // with a cursor in it.
            prompt.label === '' ? <Text> </Text> : <Text dimColor>{'\u26a1 '}{prompt.label}</Text>
          ) : (
            <>
              {before}
              <Text inverse>{at === '' ? ' ' : at}</Text>
              {after}
            </>
          )}
        </Text>
      </Box>
      <Box flexDirection="row" justifyContent="space-between" paddingLeft={2}>
        <Text dimColor wrap="truncate">
          {model}
          {thinking ? `  ${thinking}` : ''}
        </Text>
        {/* The dial only offers what the model accepts, so the hint says so
            when there is nothing to cycle: a ctrl+r that appears to do nothing
            is a bug report waiting to happen. */}
        <Text color={effort === 'off' ? 'gray' : 'cyan'}>
          {levels.length > 1 ? `reasoning ${effort}  ctrl+r` : `reasoning n/a  ctrl+r`}
        </Text>
      </Box>
    </Box>
  )
}

/**
 * The `/` palette: every command that matches what has been typed, above the
 * input, the way OpenCode answers a leading slash. Enter runs the highlighted
 * command; Esc dismisses it and leaves the text alone.
 */
export function CommandPalette({
  matches,
  index,
  width,
}: {
  matches: readonly { name: string; summary: string }[]
  index: number
  width: number
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      borderLeft
      borderRight={false}
      borderTop={false}
      borderBottom={false}
      paddingLeft={2}
    >
      {matches.map((command, i) => (
        <Text key={command.name} wrap="truncate">
          {i === index ? <Text color="cyan">▸ </Text> : <Text>  </Text>}
          <Text color={i === index ? 'cyan' : undefined}>/{command.name.padEnd(9)}</Text>
          <Text dimColor> {truncate(command.summary, Math.max(10, width - 14))}</Text>
        </Text>
      ))}
    </Box>
  )
}

export function formatUsage(usage: UsageState, limit: number): string {
  if (usage.calls === 0) return 'ctx –'
  const k = (n: number): string =>
    n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n)
  const pct = Math.min(100, Math.round((usage.lastPromptTokens / limit) * 100))
  // Compact on purpose: the bar carries the percentage, the totals and the
  // scroll hint, and the model name on the left must not lose its tail to it.
  return `ctx ${pct}% · ${k(usage.promptTokens)}↑ ${k(usage.completionTokens)}↓`
}

export function WorkingHint({ interrupted }: { interrupted: boolean }) {
  const { frame } = useAnimation({ interval: 80, isActive: !interrupted })
  return (
    <Box borderStyle="single" borderColor="gray" borderLeft borderRight={false} borderTop={false} borderBottom={false} paddingLeft={1} marginTop={1}>
      <Text color={interrupted ? 'red' : 'green'}>
        {interrupted ? '■ interrupted — finishing…' : `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} working — Ctrl-C to interrupt`}
      </Text>
    </Box>
  )
}

