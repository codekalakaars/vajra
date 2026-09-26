// Format dispatch.
//
// A runner does not have to speak Vajra's internal shape. If it can emit
// JUnit XML or TAP — which nearly every runner in every language can — its
// results are ingestible without Vajra learning anything about that language's
// toolchain, build system, or test framework.

import type { RawRunResult } from '../runner.js'
import { JUNIT_FORMAT, parseJunit } from './junit.js'
import { TAP_FORMAT, parseTap, type TapOptions } from './tap.js'

export type ReportFormat = typeof JUNIT_FORMAT | typeof TAP_FORMAT

export interface ParseOptions extends TapOptions {
  format: ReportFormat
}

export function parseReport(source: string, options: ParseOptions): RawRunResult | null {
  switch (options.format) {
    case JUNIT_FORMAT:
      return parseJunit(source)
    case TAP_FORMAT:
      return parseTap(source, options)
  }
}

/**
 * Best-effort format sniffing for reports whose producer is not configured.
 * JUnit is tried first because an XML-looking document that turns out not to
 * be a test report simply fails to parse, whereas guessing TAP on XML would
 * silently produce a wrong-but-plausible result.
 */
export function detectFormat(source: string): ReportFormat {
  const head = source.slice(0, 4096)
  if (/<testsuites?\b/.test(head)) return JUNIT_FORMAT
  if (/^\s*TAP version/im.test(head)) return TAP_FORMAT
  return JUNIT_FORMAT
}

export function parseAuto(source: string, options: Omit<ParseOptions, 'format'> = {}): RawRunResult | null {
  return parseReport(source, { ...options, format: detectFormat(source) })
}

export { JUNIT_FORMAT, parseJunit } from './junit.js'
export { TAP_FORMAT, parseTap, type TapOptions } from './tap.js'
