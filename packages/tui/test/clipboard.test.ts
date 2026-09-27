import { test, expect, describe } from 'bun:test'
import { describeSelection, copySelection, copyReportLine, installSelectionCopy, type CopyReport } from '../src/clipboard'

/**
 * Selecting text and getting it on the clipboard.
 *
 * The renderer does the hard part — mapping cells back to characters — and this
 * module is the part that can be wrong quietly: copy on every drag event and
 * the clipboard is written a hundred times a second; copy a collapsed selection
 * and a user who changed their mind has wiped what they had; report success
 * when the terminal refused and the paste comes out empty. The renderer is stood
 * in for by a fake that records what it was asked to write.
 */

function fakeRenderer(over: Partial<{ write: (text: string) => boolean; support: 'supported' | 'unsupported' | 'unknown' }> = {}) {
  const writes: string[] = []
  return {
    writes,
    clipboard: {
      copyToClipboardOSC52(text: string) {
        if (over.write) return over.write(text)
        writes.push(text)
        return true
      },
      capabilities: { remote: false, osc52_support: over.support ?? 'supported' },
    },
  }
}

describe('describeSelection', () => {
  test('counts characters and lines of what is selected', () => {
    expect(describeSelection('hello')).toEqual({ chars: 5, lines: 1 })
    expect(describeSelection('one\ntwo\nthree')).toEqual({ chars: 13, lines: 3 })
  })

  test('a selection of whitespace is nothing', () => {
    expect(describeSelection('')).toEqual({ chars: 0, lines: 0 })
    expect(describeSelection('   \n  ')).toEqual({ chars: 0, lines: 0 })
  })

  test('trailing blank lines are the selection box, not the text', () => {
    expect(describeSelection('done\n\n\n')).toEqual({ chars: 4, lines: 1 })
  })
})

describe('copySelection', () => {
  test('writes the selection to the clipboard', () => {
    const renderer = fakeRenderer()
    const report = copySelection(renderer.clipboard as never, 'const x = 1')
    expect(report).toEqual({ chars: 11, lines: 1, ok: true })
    expect(renderer.writes).toEqual(['const x = 1'])
  })

  test('does not write trailing whitespace the drag swept up', () => {
    const renderer = fakeRenderer()
    copySelection(renderer.clipboard as never, 'done\n\n')
    expect(renderer.writes).toEqual(['done'])
  })

  test('an empty selection is not a copy', () => {
    const renderer = fakeRenderer()
    const report = copySelection(renderer.clipboard as never, '   ')
    expect(report.ok).toBe(false)
    expect(report.reason).toBe('nothing selected')
    expect(renderer.writes).toEqual([])
  })

  test('an unsupported terminal is reported, not hidden', () => {
    const renderer = fakeRenderer({ write: () => false, support: 'unsupported' })
    const report = copySelection(renderer.clipboard as never, 'text')
    expect(report.ok).toBe(false)
    expect(report.reason).toContain('OSC 52')
  })

  test('a payload that would be a megabyte of escape sequence is refused', () => {
    const renderer = fakeRenderer()
    const report = copySelection(renderer.clipboard as never, 'x'.repeat(200), 100)
    expect(report.ok).toBe(false)
    expect(report.reason).toContain('too long')
    expect(renderer.writes).toEqual([])
  })

  test('a renderer that throws does not take the screen with it', () => {
    const renderer = fakeRenderer({
      write: () => {
        throw new Error('terminal went away')
      },
    })
    const report = copySelection(renderer.clipboard as never, 'text')
    expect(report.ok).toBe(false)
    expect(report.reason).toBe('terminal went away')
  })
})

describe('copyReportLine', () => {
  test('a successful copy says how much', () => {
    expect(copyReportLine({ chars: 12, lines: 1, ok: true })).toBe('copied 1 line')
    expect(copyReportLine({ chars: 40, lines: 3, ok: true })).toBe('copied 3 lines')
  })

  test('a failed copy says why', () => {
    expect(copyReportLine({ chars: 0, lines: 0, ok: false, reason: 'nothing selected' })).toBe(
      'not copied — nothing selected',
    )
    expect(copyReportLine({ chars: 0, lines: 0, ok: false })).toBe('not copied — unknown reason')
  })
})

describe('installSelectionCopy', () => {
  /** The renderer's event bus, with just the surface this module uses. */
  function fakeEventRenderer() {
    const handlers = new Map<string, (arg: unknown) => void>()
    const writes: string[] = []
    return {
      writes,
      emit(event: string, arg: unknown) {
        handlers.get(event)?.(arg)
      },
      listenerCount() {
        return handlers.size
      },
      on(event: string, handler: (arg: unknown) => void) {
        handlers.set(event, handler)
      },
      off(event: string) {
        handlers.delete(event)
      },
      copyToClipboardOSC52(text: string) {
        writes.push(text)
        return true
      },
      capabilities: { remote: false, osc52_support: 'supported' as const },
    }
  }

  const selectionOf = (text: string) => ({ getSelectedText: () => text })

  test('a drag is one copy, of what was selected when the hand stopped', async () => {
    const renderer = fakeEventRenderer()
    const reports: CopyReport[] = []
    installSelectionCopy(renderer as never, report => reports.push(report), { debounceMs: 5 })

    // Four drag moves, 2ms apart: the debounce is longer than the gap, so this
    // is one gesture, not four copies.
    for (const text of ['h', 'he', 'hel', 'hello']) {
      renderer.emit('selection', selectionOf(text))
      await Bun.sleep(2)
    }
    await Bun.sleep(20)

    expect(renderer.writes).toEqual(['hello'])
    expect(reports).toEqual([{ chars: 5, lines: 1, ok: true }])
  })

  test('collapsing the selection cancels the pending copy', async () => {
    const renderer = fakeEventRenderer()
    const reports: CopyReport[] = []
    installSelectionCopy(renderer as never, report => reports.push(report), { debounceMs: 10 })

    renderer.emit('selection', selectionOf('almost'))
    renderer.emit('selection', selectionOf(''))
    await Bun.sleep(30)

    expect(renderer.writes).toEqual([])
    expect(reports).toEqual([])
  })

  test('whitespace-only selection is a collapse, not a copy', async () => {
    const renderer = fakeEventRenderer()
    const reports: CopyReport[] = []
    installSelectionCopy(renderer as never, report => reports.push(report), { debounceMs: 10 })

    renderer.emit('selection', selectionOf('text'))
    renderer.emit('selection', selectionOf('   '))
    await Bun.sleep(30)

    expect(renderer.writes).toEqual([])
  })

  test('two separate gestures are two copies', async () => {
    const renderer = fakeEventRenderer()
    installSelectionCopy(renderer as never, () => {}, { debounceMs: 5 })

    renderer.emit('selection', selectionOf('first'))
    await Bun.sleep(20)
    renderer.emit('selection', selectionOf('second'))
    await Bun.sleep(20)

    expect(renderer.writes).toEqual(['first', 'second'])
  })

  test('a renderable torn down mid-selection is not an error', async () => {
    const renderer = fakeEventRenderer()
    const reports: CopyReport[] = []
    installSelectionCopy(renderer as never, report => reports.push(report), { debounceMs: 5 })

    renderer.emit('selection', {
      getSelectedText() {
        throw new Error('renderable destroyed')
      },
    })
    await Bun.sleep(20)

    expect(reports).toEqual([])
    expect(renderer.writes).toEqual([])
  })

  test('unsubscribing stops the copies and the timer', async () => {
    const renderer = fakeEventRenderer()
    const uninstall = installSelectionCopy(renderer as never, () => {}, { debounceMs: 10 })

    renderer.emit('selection', selectionOf('pending'))
    uninstall()
    await Bun.sleep(30)

    expect(renderer.writes).toEqual([])
    expect(renderer.listenerCount()).toBe(0)
  })
})
