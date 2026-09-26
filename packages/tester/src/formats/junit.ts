// JUnit XML — the de facto universal test result format.
//
// Emitted by JUnit itself, pytest, Jest, and most Go, Rust, .NET and PHP
// runners either directly or through a converter. Ingesting it means the
// verification path works against tests written in any language without
// Vajra knowing anything about that language's toolchain.
//
// The format already carries the distinction this package depends on:
// <failure> is a test that ran and failed, while <error> is a test that could
// not run. That maps directly onto the assertion-versus-environment split in
// docs/adr/0007-test-verdict-contract.md, which is why the make-or-break
// classification spike is largely answered for any runner that can emit this.

import type { RawRunResult, RawTestOutcome } from '../runner.js'
import { fileTarget, suiteTarget, testId, type TestTarget } from '../target.js'
import { childrenNamed, findAll, parseXml } from '../xml.js'

export const JUNIT_FORMAT = 'junit' as const

function targetFor(attrs: Record<string, string>, classname: string): TestTarget {
  // The `file` attribute is optional and often absent; `classname` is the more
  // reliable identity, so a file-less suite keeps a suite-kind target rather
  // than pretending to be a file.
  const file = attrs.file
  if (file) return fileTarget(file)
  return suiteTarget(classname || attrs.name || 'unknown')
}

export function parseJunit(source: string): RawRunResult | null {
  const root = parseXml(source)
  if (!root) return null

  // Reports come either as a bare <testsuite> or wrapped in <testsuites>.
  const cases =
    root.name === 'testcase' ? [root] : findAll(root, 'testcase')
  if (root.name === 'testcase') cases.length = 1
  if (cases.length === 0) return null

  const tests: RawTestOutcome[] = []
  let duration = 0

  for (const node of cases) {
    const attrs = node.attrs
    const name = attrs.name ?? 'unnamed'
    const classname = attrs.classname ?? ''
    const target = targetFor(attrs, classname)
    const time = Number.parseFloat(attrs.time ?? '')
    if (Number.isFinite(time)) duration += time

    const failure = childrenNamed(node, 'failure')[0]
    const error = childrenNamed(node, 'error')[0]
    const skipped = childrenNamed(node, 'skipped')[0]
    const base = { id: testId(target, name), ref: target.ref, target }

    if (error) {
      tests.push({
        ...base,
        status: 'errored',
        message: error.attrs.message || error.text || 'test errored',
        location: locationOf(error),
      })
    } else if (failure) {
      tests.push({
        ...base,
        status: 'failed',
        failureKind: 'assertion',
        message: failure.attrs.message || failure.text || 'assertion failed',
        location: locationOf(failure),
      })
    } else if (skipped) {
      tests.push({
        ...base,
        status: 'skipped',
        message: skipped.attrs.message || skipped.text || 'skipped',
      })
    } else {
      tests.push({ ...base, status: 'passed' })
    }
  }

  return { tests, durationMs: Math.round(duration * 1000) }
}

function locationOf(node: { attrs: Record<string, string> }) {
  const file = node.attrs.file
  const line = Number.parseInt(node.attrs.line ?? '', 10)
  if (!file || !Number.isFinite(line)) return undefined
  return { file, line }
}
