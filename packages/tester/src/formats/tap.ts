// TAP — the Test Anything Protocol.
//
// Line-based, trivial to emit, and supported by Perl, Python, Ruby, PHP, Node
// and shell tooling. It is the second universal result format after JUnit XML,
// and the only practical option for runners that cannot produce XML.
//
// The important limitation: TAP has no distinction between a test that ran and
// failed and a test that could not run. Both are `not ok`. This parser maps
// `not ok` to an assertion failure by convention, which is a known fidelity
// loss — a TAP suite cannot be used to prove that a Phase One test fails for
// the right reason, and that limitation should be surfaced rather than hidden.

import type { RawRunResult, RawTestOutcome } from '../runner.js'
import { fileTarget, testId } from '../target.js'

export const TAP_FORMAT = 'tap' as const

const RESULT = /^(not ok|ok)\b\s*(\d+)?\s*-?\s*(.*)$/
const DIRECTIVE = /#\s*(SKIP|TODO|skip|todo)\b\s*(.*)$/

export interface TapOptions {
  /**
   * The file these results belong to. TAP output carries no filenames, so
   * without this every case collapses onto one anonymous target.
   */
  file?: string
}

export function parseTap(source: string, options: TapOptions = {}): RawRunResult | null {
  const target = fileTarget(options.file ?? 'tap')
  const lines = source.split(/\r?\n/)
  const tests: RawTestOutcome[] = []
  let bailOut = false
  let sawResult = false
  let index = 0

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    if (/^TAP version/i.test(line)) continue
    if (/^1\.\./.test(line)) continue
    if (/^Bail out!/i.test(line)) {
      bailOut = true
      break
    }

    const match = RESULT.exec(line)
    if (!match) continue
    sawResult = true
    index += 1

    const [, marker, rawNumber, description] = match
    const name = (description || `test ${rawNumber ?? index}`).trim()
    const directive = DIRECTIVE.exec(name)
    const id = testId(target, name)
    const base = { id, ref: target.ref, target }

    if (directive) {
      const kind = directive[1].toLowerCase()
      if (kind === 'skip') {
        tests.push({ ...base, status: 'skipped', message: directive[2] || 'skipped' })
        continue
      }
      tests.push({ ...base, status: 'passed', message: 'TODO — not a failure' })
      continue
    }

    if (marker === 'ok') {
      tests.push({ ...base, status: 'passed' })
      continue
    }

    // Consume the YAML diagnostic block that follows a `not ok`.
    const detail = readDiagnostic(lines, i)
    if (detail.nextIndex > i) i = detail.nextIndex - 1

    tests.push({
      ...base,
      status: 'failed',
      failureKind: 'assertion',
      message: detail.message || `not ok ${rawNumber ?? index}`,
    })
  }

  if (!sawResult && !bailOut) return null
  if (bailOut) {
    tests.push({
      id: testId(target, 'bail out'),
      ref: target.ref,
      target,
      status: 'errored',
      message: 'TAP bailed out before completing the plan',
    })
  }
  return { tests, durationMs: 0 }
}

function readDiagnostic(lines: string[], from: number): { message: string; nextIndex: number } {
  let i = from + 1
  if (lines[i]?.trim() !== '---') return { message: '', nextIndex: from + 1 }
  i += 1
  const parts: string[] = []
  for (; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '...') break
    const match = /^\s*(message|severity|got|expected)\s*:\s*(.*)$/.exec(line)
    if (match) parts.push(`${match[1]}: ${match[2]}`)
  }
  return { message: parts.join('; '), nextIndex: i + 1 }
}
