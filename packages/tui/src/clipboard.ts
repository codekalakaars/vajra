/**
 * Select text, get it on the clipboard.
 *
 * A terminal has no selection of its own: the alternate screen buffer is a grid
 * of cells, the transcript is painted into it, and a mouse drag over the paint
 * means nothing until something maps cells back to characters. OpenTUI already
 * has that mapping — `Selection.getSelectedText()` walks the renderables a
 * selection covers and reassembles their text — and it already knows how to put
 * text on the system clipboard from a terminal, via OSC 52. Neither is wired up
 * here, and both are the whole feature, so this module is the wiring: turn the
 * mouse on, listen for the renderer's selection, hand the text to the terminal.
 *
 * The interesting decisions are all about *when* to copy:
 *
 *  - the renderer emits `selection` on every drag move, not on release, so
 *    copying on the event would write the clipboard a hundred times a second.
 *    A trailing debounce collapses a drag into one copy, of what was selected
 *    when the hand stopped moving;
 *  - an empty selection is not a copy. Dragging back to the anchor and letting
 *    go is how a user says "never mind", and it must not clear the clipboard;
 *  - the report is one line and it goes to the caller, not to the transcript.
 *    Selection is a read gesture; answering it with a chat message would put
 *    every quote in the conversation history.
 *
 * OSC 52 is the only transport available from inside the UI process: it is the
 * one clipboard mechanism that does not need a helper binary, a display server
 * or a writable foreign-selection socket, and it is what makes the feature work
 * over SSH. Terminals that do not implement it are reported, not hidden — the
 * caller shows the line and the user knows the copy did not land.
 */
import { ClipboardTarget, type CliRenderer, type Selection } from '@opentui/core'

/** What one copy attempt did, for the one-line report. */
export interface CopyReport {
  /** Characters handed to the clipboard. */
  chars: number
  lines: number
  /** False when the terminal refused or the payload was not accepted. */
  ok: boolean
  /** Why it did not land, when it did not. */
  reason?: string
}

/** The clipboard shape this module needs, so a test can stand in for it. */
export interface ClipboardRenderer {
  copyToClipboardOSC52(text: string, target?: ClipboardTarget): boolean
  capabilities?: { remote: boolean; osc52_support: 'supported' | 'unsupported' | 'unknown' } | null
}

export interface SelectionCopyOptions {
  /** How long the hand must be still before the copy fires. */
  debounceMs?: number
  /** Longest payload we will send. OSC 52 is a terminal escape, not a file. */
  maxChars?: number
}

const DEFAULT_DEBOUNCE_MS = 120
/** Beyond this the escape sequence is megabytes, and terminals start dropping it. */
const DEFAULT_MAX_CHARS = 100_000

/**
 * Count what was selected, for the report line.
 *
 * Split on newlines rather than counting them, so a selection of one long
 * wrapped line reports as the one line it is on screen — a transcript row that
 * wrapped across five terminal rows is still one line of the answer.
 */
export function describeSelection(text: string): { chars: number; lines: number } {
  const trimmed = text.replace(/\s+$/, '')
  if (trimmed === '') return { chars: 0, lines: 0 }
  return { chars: trimmed.length, lines: trimmed.split('\n').length }
}

/**
 * Copy `text` to the system clipboard through the terminal.
 *
 * Never throws: a clipboard is a convenience, and a terminal that refuses an
 * escape sequence is not a reason to take the screen down.
 */
export function copySelection(
  renderer: ClipboardRenderer,
  text: string,
  maxChars = DEFAULT_MAX_CHARS,
): CopyReport {
  const { chars, lines } = describeSelection(text)
  if (chars === 0) return { chars: 0, lines: 0, ok: false, reason: 'nothing selected' }
  if (chars > maxChars) {
    return { chars, lines, ok: false, reason: `too long to copy (${chars} chars)` }
  }
  try {
    const written = renderer.copyToClipboardOSC52(text.replace(/\s+$/, ''), ClipboardTarget.Clipboard)
    if (written) return { chars, lines, ok: true }
    const support = renderer.capabilities?.osc52_support
    return {
      chars,
      lines,
      ok: false,
      reason:
        support === 'unsupported'
          ? 'this terminal does not support OSC 52 clipboard writes'
          : 'the terminal refused the clipboard write',
    }
  } catch (error) {
    return { chars, lines, ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Copy every selection the user makes, for as long as the screen lives.
 *
 * Returns the unsubscribe, because a screen that is torn down with a live
 * timer on the renderer's event bus is a screen that keeps a dead object alive
 * and logs on exit.
 */
export function installSelectionCopy(
  renderer: CliRenderer,
  onCopy: (report: CopyReport) => void,
  options: SelectionCopyOptions = {},
): () => void {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending = ''

  const onSelection = (selection: Selection | null): void => {
    let text = ''
    try {
      text = selection?.getSelectedText() ?? ''
    } catch {
      // A renderable torn down mid-selection has no text to give. That is a
      // normal race with a streaming answer, not a failure.
      return
    }
    if (describeSelection(text).chars === 0) {
      // Collapsed back to nothing: forget the pending text so the debounce
      // does not fire with a selection the user has already abandoned.
      pending = ''
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      return
    }
    pending = text
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const toCopy = pending
      pending = ''
      onCopy(copySelection(renderer, toCopy, maxChars))
    }, debounceMs)
  }

  renderer.on('selection', onSelection)
  return () => {
    if (timer) clearTimeout(timer)
    timer = null
    pending = ''
    renderer.off('selection', onSelection)
  }
}

/** The one line the status row shows after a selection. */
export function copyReportLine(report: CopyReport): string {
  if (!report.ok) return `not copied — ${report.reason ?? 'unknown reason'}`
  const unit = report.lines === 1 ? 'line' : 'lines'
  return `copied ${report.lines} ${unit}`
}
