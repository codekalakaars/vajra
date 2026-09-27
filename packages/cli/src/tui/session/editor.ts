/**
 * A small line editor: cursor-indexed text with word motion and history.
 *
 * Pure so every keystroke path is testable without a terminal. The TUI maps
 * Ink key events onto actions; the reducer owns the value, the cursor (a UTF-16
 * index into `value`) and the history stack.
 */

export interface EditorState {
  value: string
  cursor: number
  history: string[]
  /** Index into history while browsing; null when editing live text. */
  historyIndex: number | null
  /** Text stashed when the first history entry is browsed to. */
  draft: string
}

export type EditorAction =
  | { type: 'insert'; text: string }
  | { type: 'newline' }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'word-left' }
  | { type: 'word-right' }
  | { type: 'line-start' }
  | { type: 'line-end' }
  | { type: 'line-up' }
  | { type: 'line-down' }
  | { type: 'history-prev' }
  | { type: 'history-next' }
  | { type: 'clear' }
  | { type: 'push-history'; text: string }

export const HISTORY_LIMIT = 50

export function initialEditor(): EditorState {
  return { value: '', cursor: 0, history: [], historyIndex: null, draft: '' }
}

function clampCursor(cursor: number, value: string): number {
  return Math.max(0, Math.min(cursor, value.length))
}

/** Back to live editing — browsing history never keeps a stale index. */
function leaveHistory(state: EditorState): EditorState {
  return state.historyIndex === null ? state : { ...state, historyIndex: null }
}

function wordLeft(value: string, cursor: number): number {
  let i = cursor
  while (i > 0 && /\s/.test(value[i - 1])) i--
  while (i > 0 && !/\s/.test(value[i - 1])) i--
  return i
}

function wordRight(value: string, cursor: number): number {
  let i = cursor
  while (i < value.length && /\s/.test(value[i])) i++
  while (i < value.length && !/\s/.test(value[i])) i++
  return i
}

/** Line boundaries for multi-line drafts; single-line values act as one line. */
function lineStart(value: string, cursor: number): number {
  const nl = value.lastIndexOf('\n', cursor - 1)
  return nl + 1
}

function lineEnd(value: string, cursor: number): number {
  const nl = value.indexOf('\n', cursor)
  return nl === -1 ? value.length : nl
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'insert': {
      if (action.text === '') return state
      const next = leaveHistory(state)
      const value = next.value.slice(0, next.cursor) + action.text + next.value.slice(next.cursor)
      return { ...next, value, cursor: next.cursor + action.text.length }
    }
    case 'newline': {
      const next = leaveHistory(state)
      const value = next.value.slice(0, next.cursor) + '\n' + next.value.slice(next.cursor)
      return { ...next, value, cursor: next.cursor + 1 }
    }
    case 'backspace': {
      const next = leaveHistory(state)
      if (next.cursor === 0) return next
      const value = next.value.slice(0, next.cursor - 1) + next.value.slice(next.cursor)
      return { ...next, value, cursor: next.cursor - 1 }
    }
    case 'delete': {
      const next = leaveHistory(state)
      if (next.cursor >= next.value.length) return next
      const value = next.value.slice(0, next.cursor) + next.value.slice(next.cursor + 1)
      return { ...next, value }
    }
    case 'left':
      return { ...leaveHistory(state), cursor: clampCursor(state.cursor - 1, state.value) }
    case 'right':
      return { ...leaveHistory(state), cursor: clampCursor(state.cursor + 1, state.value) }
    case 'word-left':
      return { ...leaveHistory(state), cursor: wordLeft(state.value, state.cursor) }
    case 'word-right':
      return { ...leaveHistory(state), cursor: wordRight(state.value, state.cursor) }
    case 'line-start':
      return { ...leaveHistory(state), cursor: lineStart(state.value, state.cursor) }
    case 'line-end':
      return { ...leaveHistory(state), cursor: lineEnd(state.value, state.cursor) }
    case 'line-up': {
      const nl = state.value.lastIndexOf('\n', state.cursor - 1)
      if (nl === -1) return state
      const curStart = nl + 1
      const col = state.cursor - curStart
      const prevStart = state.value.lastIndexOf('\n', curStart - 2) + 1
      const prevLength = nl - prevStart
      const cursor = prevStart + Math.min(col, prevLength)
      return { ...leaveHistory(state), cursor }
    }
    case 'line-down': {
      const curStart = state.value.lastIndexOf('\n', state.cursor - 1) + 1
      const col = state.cursor - curStart
      const nl = state.value.indexOf('\n', state.cursor)
      if (nl === -1) return state
      const nextStart = nl + 1
      const nextEnd = state.value.indexOf('\n', nextStart)
      const nextLength = (nextEnd === -1 ? state.value.length : nextEnd) - nextStart
      const cursor = nextStart + Math.min(col, nextLength)
      return { ...leaveHistory(state), cursor }
    }
    case 'history-prev': {
      if (state.history.length === 0) return state
      const historyIndex =
        state.historyIndex === null
          ? state.history.length - 1
          : Math.max(0, state.historyIndex - 1)
      const draft = state.historyIndex === null ? state.value : state.draft
      const value = state.history[historyIndex]
      return { ...state, historyIndex, draft, value, cursor: value.length }
    }
    case 'history-next': {
      if (state.historyIndex === null) return state
      const next = state.historyIndex + 1
      if (next >= state.history.length) {
        // Past the newest entry — back to what was being typed.
        return { ...state, historyIndex: null, value: state.draft, cursor: state.draft.length }
      }
      const value = state.history[next]
      return { ...state, historyIndex: next, value, cursor: value.length }
    }
    case 'clear':
      return { ...leaveHistory(state), value: '', cursor: 0 }
    case 'push-history': {
      const text = action.text.trim()
      if (!text) return { ...state, historyIndex: null, value: '', cursor: 0 }
      const history =
        state.history[state.history.length - 1] === text
          ? state.history
          : [...state.history, text].slice(-HISTORY_LIMIT)
      return { history, historyIndex: null, draft: '', value: '', cursor: 0 }
    }
  }
}

/** The editor split into three runs so the cursor can be rendered inverse. */
export function editorSplits(state: EditorState): {
  before: string
  at: string
  after: string
} {
  const cursor = clampCursor(state.cursor, state.value)
  // An empty value still shows a cursor block.
  if (state.value.length === 0) return { before: '', at: '', after: '' }
  const atEnd = cursor >= state.value.length
  const before = state.value.slice(0, cursor)
  if (atEnd) return { before, at: '', after: '' }
  return { before, at: state.value[cursor], after: state.value.slice(cursor + 1) }
}

/**
 * Rows the editor's text will occupy when rendered at `width` columns,
 * including `firstPrefix` characters (the inline prompt label) on row one.
 * The session budgets transcript space from this, so an estimate that ignores
 * wrapping would let the frame outgrow the terminal.
 */
export function editorRenderRows(value: string, width: number, firstPrefix = ''): number {
  const usable = Math.max(1, width)
  const lines = value === '' ? [''] : value.split('\n')
  let rows = 0
  for (let i = 0; i < lines.length; i++) {
    const length = lines[i].length + (i === 0 ? firstPrefix.length : 0)
    rows += Math.max(1, Math.ceil(length / usable))
  }
  return Math.max(1, rows)
}
