/**
 * Diffs of what an attempt changed, for a checkpoint and for a retry.
 *
 * Not a patch: a patch is meant to be applied, and nothing here applies anything.
 * This is evidence — the smallest honest account of what a file looked like
 * before and after — built by stripping the common prefix and suffix and showing
 * what is left. Code changes most of a file at one place, so that is almost
 * always exactly the changed part, and it stays that way when the change is
 * large.
 *
 * A diff is always cut to a budget. A diff that does not fit is not a reason to
 * carry it all: the caller names what was dropped, because a Worker told "here
 * is the whole change" and given half of it is worse than one told what it is
 * getting.
 */

export interface DiffFile {
  path: string
  /** `null` when the file did not exist before the attempt. */
  before: string | null
  after: string | null
}

/**
 * A file's lines.
 *
 * The empty string after a trailing newline is not a line the file has, and
 * counting it would add a phantom `+` to every created file's diff.
 */
function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Lines common to the head of both sides. */
function commonPrefix(a: string[], b: string[]): number {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

/**
 * Lines common to the tail of both sides, never crossing the prefix.
 *
 * The bound matters: without it a file that is one duplicated line longer than
 * the other would report a prefix and a suffix that overlap, and the middle
 * would come out negative.
 */
function commonSuffix(a: string[], b: string[], prefix: number): number {
  let n = 0
  while (n < a.length - prefix && n < b.length - prefix && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}

/** `@@ -l,s +l,s @@` the way a reader expects to see a change marked up. */
function hunk(startA: number, countA: number, startB: number, countB: number): string {
  const rangeA = countA === 0 ? `${startA},0` : `${startA + 1},${countA}`
  const rangeB = countB === 0 ? `${startB},0` : `${startB + 1},${countB}`
  return `@@ -${rangeA} +${rangeB} @@`
}

/**
 * One file's diff, or `''` when nothing changed.
 *
 * A created file is all `+`, a deleted file is all `-`, and both say which they
 * are: a diff that only shows added lines is indistinguishable from a rewrite
 * unless the header says new.
 */
export function fileDiff(file: DiffFile): string {
  const before = file.before === null ? [] : splitLines(file.before)
  const after = file.after === null ? [] : splitLines(file.after)
  if (file.before !== null && file.after !== null && file.before === file.after) return ''

  const prefix = commonPrefix(before, after)
  const suffix = commonSuffix(before, after, prefix)
  const removed = before.slice(prefix, before.length - suffix)
  const added = after.slice(prefix, after.length - suffix)

  const head =
    file.before === null
      ? `--- /dev/null\n+++ ${file.path} (new)`
      : file.after === null
        ? `--- ${file.path}\n+++ /dev/null (deleted)`
        : `--- ${file.path}\n+++ ${file.path}`
  const body = [
    hunk(prefix, removed.length, prefix, added.length),
    ...removed.map(line => `-${line}`),
    ...added.map(line => `+${line}`),
  ].join('\n')
  return `${head}\n${body}`
}

/**
 * Several files' diffs inside one budget, in the order given.
 *
 * The order is the caller's, and callers order by importance: the files the
 * attempt actually wrote come before the ones it merely touched. Whatever does
 * not fit is named, so a truncated diff is never mistaken for a complete one.
 */
export function diffsWithin(files: readonly DiffFile[], maxChars: number): string {
  const parts: string[] = []
  const dropped: string[] = []
  for (const file of files) {
    const diff = fileDiff(file)
    if (diff === '') continue
    if (parts.length === 0 && diff.length > maxChars) {
      // One file bigger than the whole budget is shown cut rather than dropped:
      // its hunk header alone would say nothing about what the change was.
      const cut = diff.slice(0, Math.max(0, maxChars))
      parts.push(`${cut}\n[… cut at ${maxChars} characters; the change continues. Call read_file to see the file.]`)
      dropped.push(file.path)
      continue
    }
    const cost = diff.length + 2
    if (parts.join('\n').length + cost > maxChars) {
      dropped.push(file.path)
      continue
    }
    parts.push(diff)
  }
  if (dropped.length > 0) {
    parts.push(`[… ${dropped.length} file(s) not shown: ${dropped.join(', ')}. Call read_file for any of them.]`)
  }
  return parts.join('\n')
}