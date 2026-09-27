import type { Entry, TaskView } from './store.js'
import { __parseBlocks } from './markdown.js'

/**
 * Transcript virtualization math.
 *
 * The session runs in the alternate screen buffer, where the terminal keeps no
 * scrollback — this module is what replaces it. Everything here is pure so the
 * window can be unit-tested without a renderer: heights are estimated from the
 * entry's text at a given width, and the visible slice is computed from a
 * scroll position. Estimates may be off by a line or two; the viewport renders
 * bottom-anchored in follow mode (like a terminal) so an underestimate clips
 * history at the top and an overestimate only leaves blank space — both
 * invisible in practice.
 */

/** Blank rows after every entry, so blocks never run together. */
const ENTRY_GAP = 1

function wraps(text: string, width: number): number {
  if (width <= 0) return 1
  let lines = 0
  for (const raw of text.split('\n')) {
    lines += Math.max(1, Math.ceil(raw.length / width))
  }
  return Math.max(1, lines)
}

/** Rendered line count of plain text at `width` columns. */
export function estimateTextLines(text: string, width: number): number {
  return wraps(text, width)
}

function spanText(spans: { text: string }[]): string {
  return spans.map(s => s.text).join('')
}

/** Rendered line count of a markdown string at `width` columns. */
export function estimateMarkdownLines(text: string, width: number): number {
  const blocks = __parseBlocks(text)
  if (blocks.length === 0) return 1
  let lines = 0
  for (let i = 0; i < blocks.length; i++) {
    if (i > 0) lines += 1 // blocks are separated by a blank line
    const block = blocks[i]
    switch (block.kind) {
      case 'code': {
        lines += block.lang !== '' ? 1 : 0
        for (const line of block.lines) lines += wraps(line, Math.max(1, width - 2))
        if (block.lines.length === 0) lines += 1
        break
      }
      case 'list': {
        for (const item of block.items) {
          lines += wraps(`${'  '.repeat(item.depth + 1)}- ${spanText(item.spans)}`, width)
        }
        break
      }
      case 'rule':
        lines += 1
        break
      default:
        lines += wraps(spanText(block.spans), width)
    }
  }
  return Math.max(1, lines)
}

/** Rendered line count of one transcript entry (without the gap). */
export function estimateEntryLines(entry: Entry, width: number): number {
  switch (entry.kind) {
    case 'banner':
      return 1
    case 'user':
      // Rendered with a two-character "❯ " prefix.
      return wraps(entry.text, Math.max(1, width - 2))
    case 'assistant':
      return estimateMarkdownLines(entry.text, width)
    case 'plan': {
      // Borderless: a title line, then one line per task plus its optional
      // writes/checks/after lines. No border, no margin — the per-entry gap in
      // entryHeights already separates it from its neighbours.
      let lines = 1
      for (const task of entry.plan.tasks) {
        lines += 1
        if (task.writeFile && task.writeFile.length > 0) lines += 1
        if (task.validation && task.validation.length > 0) lines += 1
        if (task.dependsOn && task.dependsOn.length > 0) lines += 1
      }
      return lines
    }
    case 'tool': {
      let lines = 1
      if (entry.expanded && entry.detail) lines += wraps(entry.detail, Math.max(1, width - 4))
      return lines
    }
    case 'blank':
      return 1
    default:
      return wraps(entry.text, width)
  }
}

/** Height of every entry including its trailing gap. */
export function entryHeights(entries: Entry[], width: number): number[] {
  return entries.map(e => estimateEntryLines(e, width) + ENTRY_GAP)
}

export type ScrollState = { mode: 'follow' } | { mode: 'scroll'; topLine: number }

export interface Viewport {
  /** First visible entry (inclusive). */
  start: number
  /** One past the last rendered entry (exclusive). */
  end: number
  mode: 'follow' | 'scroll'
  /** Estimated lines of the whole transcript (entries only, gaps included). */
  totalLines: number
  /** First visible line — the frozen anchor while scrolling. */
  topLine: number
  /** True when the newest entry is fully visible (follow mode). */
  atBottom: boolean
  /** The height the viewport box must have. */
  rows: number
}

export interface ComputeInput {
  entries: Entry[]
  width: number
  rows: number
  scroll: ScrollState
  /** Estimated rows the live tail (streaming/thinking/activity) needs. */
  liveRows?: number
}

/**
 * The visible entry slice for a scroll position.
 *
 * Follow mode pins the bottom: the slice starts where the last
 * `rows - liveRows` lines begin, so the live tail and the newest entries own
 * the bottom of the screen and history clips off the top exactly like terminal
 * output. Scroll mode freezes `topLine`; committed entries never change
 * height, so the window stays on the same content while new text streams in.
 */
export function computeViewport(input: ComputeInput): Viewport {
  const { entries, width, rows, scroll, liveRows = 0 } = input
  const heights = entryHeights(entries, width)
  const totalLines = heights.reduce((sum, h) => sum + h, 0)
  const maxTop = Math.max(0, totalLines - rows)

  let topLine: number
  let mode: 'follow' | 'scroll'
  if (scroll.mode === 'follow') {
    mode = 'follow'
    const budget = Math.max(0, rows - liveRows)
    topLine = Math.max(0, totalLines - budget)
  } else {
    if (scroll.topLine >= maxTop) {
      mode = 'follow'
      topLine = maxTop
    } else {
      mode = 'scroll'
      topLine = Math.max(0, scroll.topLine)
    }
  }

  // First entry whose bottom edge crosses topLine. It may straddle the top
  // edge (its first lines sit above `topLine`); remember where it starts so
  // the slice is budgeted from the real window edge, not the entry's top.
  let start = entries.length
  let acc = 0
  let startLine = 0
  for (let i = 0; i < heights.length; i++) {
    if (acc + heights[i] > topLine) {
      start = i
      startLine = acc
      break
    }
    acc += heights[i]
  }

  // Grow the slice forward while it fits the window (always take the first).
  const budget = rows + (topLine - startLine)
  let end = start
  let used = 0
  while (end < entries.length) {
    const h = heights[end]
    if (end > start && used + h > budget) break
    used += h
    end++
  }

  return {
    start,
    end,
    mode,
    totalLines,
    topLine,
    atBottom: mode === 'follow',
    rows,
  }
}

/** Estimated line where entry `idx` begins (its top edge, gap included). */
export function entryTopLine(heights: number[], idx: number): number {
  let top = 0
  for (let i = 0; i < idx && i < heights.length; i++) top += heights[i]
  return top
}

/**
 * Scroll position that keeps entry `idx` visible: at the top when it sits
 * above the window, scrolled just enough when it sits below.
 */
export function scrollTopReveal(
  heights: number[],
  idx: number,
  topLine: number,
  rows: number,
): number {
  const top = entryTopLine(heights, idx)
  const bottom = top + (heights[idx] ?? 0)
  const viewBottom = topLine + rows
  if (top < topLine) return top
  if (bottom > viewBottom) return Math.max(0, bottom - rows)
  return topLine
}

export interface TaskPaneLayout {
  shown: TaskView[]
  hidden: number
  /** Rows the pane will occupy, including border, title and margin. */
  rows: number
}

/**
 * Rows the task pane may paint. A frame taller than the terminal scrolls on
 * every repaint, so both the pane and the transcript budget against a hard
 * window: active tasks first, the rest fill what is left, overflow counted
 * rather than drawn.
 */
export function taskPaneLayout(
  tasks: TaskView[],
  maxRows: number,
  terminalRows: number,
  /** Hard cap on rendered rows, not tasks — a sidebar has none to spare. */
  rowBudget?: number,
): TaskPaneLayout {
  if (tasks.length === 0) return { shown: [], hidden: 0, rows: 0 }
  const room = typeof terminalRows === 'number' && terminalRows > 0 ? terminalRows - 14 : maxRows
  const budget = Math.max(2, Math.min(maxRows, room))
  const running = tasks.filter(t => t.status === 'running')
  const rest = tasks.filter(t => t.status !== 'running')
  const runningShown = running.slice(0, budget)
  const restShown = rest.slice(0, Math.max(0, budget - runningShown.length))
  const picked = new Set([...runningShown, ...restShown])
  let shown = tasks.filter(t => picked.has(t))

  // Counting tasks is not counting rows: one task with an activity line costs
  // two, and a column 12 rows tall cannot hold eight of them. Trim from the
  // bottom and let the overflow line report what was cut.
  const cost = (list: TaskView[]): number =>
    1 + list.reduce((n, t) => n + (t.activity ? 2 : 1), 0) + (tasks.length > list.length ? 1 : 0)
  while (rowBudget !== undefined && shown.length > 1 && cost(shown) > rowBudget) {
    shown = shown.slice(0, -1)
  }

  const hidden = tasks.length - shown.length
  // A dim title, then one row per task plus its activity line, then the
  // overflow count when something was cut.
  let rows = 1
  for (const t of shown) rows += t.activity ? 2 : 1
  rows += hidden > 0 ? 1 : 0
  return { shown, hidden, rows }
}
