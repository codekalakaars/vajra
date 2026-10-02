import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import type { ContextRef, EditSpec, PlanContract, VerifySpec } from '@codekalakaars/vajra-protocol'
import { ContextBudget } from '../model/budget.js'
import type { ContextPack, Handoff, PackSection } from './context-types.js'
import type { WorkerParams } from '../bench/params.js'

/**
 * The context pack: everything a Worker is given before its first round,
 * compiled from the plan, the files as they are now, and the work already
 * finished upstream.
 *
 * Compiled, not conversed. No model call writes any of it, so the same plan,
 * the same disk and the same handoffs produce the same text and the same sha256 —
 * which is what makes a Worker run reproducible enough to tune, and what makes
 * "the pack changed" a fact rather than a feeling.
 *
 * It is built at dispatch, not at plan time, because a dependency may have
 * rewritten the very files this task anchors against. A file that no longer
 * contains its anchor says so rather than pretending: the anchor is relocated
 * when one distinctive line of it still appears exactly once, and stale when it
 * does not, so the Worker knows the difference between "it moved" and "it is
 * gone".
 *
 * The budget is `packWindowShare` of the model's window. Sections the Worker
 * cannot work without are fixed and are never cut; the excerpts degrade instead,
 * last ref first, and every cut names the call that fetches the text back.
 */

/** The task fields the pack shows. A protocol `PlannedTask` satisfies this. */
export interface PackTask {
  id: string
  title: string
  description: string | null
  instructions: string[]
  readFile: string[]
  writeFile: string[]
  deleteFile: string[]
  createDir: string[]
  validation: string[]
  type?: string
  notes?: string
  successCriteria?: string[]
  edits?: EditSpec[]
  context?: ContextRef[]
  verify?: VerifySpec[]
}

/**
 * A task as the plan states it, with every list optional.
 *
 * `PlannedTaskInput` leaves them optional and the executor's task type does not,
 * so the pack takes the loose shape and fills in the empties once, rather than
 * making every caller build a second object.
 */
export type PackTaskInput = Omit<PackTask, keyof PackTask> &
  Partial<Omit<PackTask, 'id' | 'title' | 'validation' | 'description'>> & {
    id: string
    title: string
    description?: string | null
    /** A plan's own field, which may be one command rather than a list of them. */
    validation?: string | string[]
  }

function packTaskOf(task: PackTaskInput): PackTask {
  return {
    id: task.id,
    title: task.title,
    description: task.description ?? null,
    instructions: task.instructions ?? [],
    readFile: task.readFile ?? [],
    writeFile: task.writeFile ?? [],
    deleteFile: task.deleteFile ?? [],
    createDir: task.createDir ?? [],
    validation:
      task.validation === undefined ? [] : Array.isArray(task.validation) ? task.validation : [task.validation],
    ...(task.type !== undefined ? { type: task.type } : {}),
    ...(task.notes !== undefined ? { notes: task.notes } : {}),
    ...(task.successCriteria !== undefined ? { successCriteria: task.successCriteria } : {}),
    ...(task.edits !== undefined ? { edits: task.edits } : {}),
    ...(task.context !== undefined ? { context: task.context } : {}),
    ...(task.verify !== undefined ? { verify: task.verify } : {}),
  }
}

export interface PackInput {
  task: PackTaskInput
  params: WorkerParams
  /** The Worker model's id: the window and the token ratio come from it. */
  model: string
  /**
   * Read through the task's own tool handle, so masking and the task's
   * permissions hold: the pack can never show a Worker more than `read_file`
   * would have, and a masked file comes back as its stub.
   */
  read: (path: string, symbols?: string[]) => Promise<string>
  /** Directory listing, through the same handle. */
  list: (path: string) => Promise<string>
  /** The plan's contracts; only those naming this task are shown. */
  contracts?: PlanContract[]
  /** Built once per run from the project's manifests. */
  projectCard?: string
  upstream?: { direct: Handoff[]; transitive: Handoff[] }
  /**
   * The "Previous attempt" block, already rendered by `tasks/handoff.ts` and
   * only on a retry with `respawnContext` on. Rendered here rather than by this
   * file so the block is identical whether it goes in the pack or in the user
   * message.
   */
  previousAttempt?: string
}

/** The most of the Worker's window the pack may take, in tokens. */
export function packBudgetTokens(params: WorkerParams, model: string): number {
  return Math.floor(new ContextBudget(model).window * params.packWindowShare)
}

/** Project-relative, without a leading `./`, the way the plan spells a path. */
function normalize(path: string): string {
  return path.replace(/^\.\//, '')
}

/**
 * Declarations, in the four languages the suites are written in.
 *
 * Only column 0 counts: a `const` inside a function body is not an interface
 * anyone codes against, and a file's shape is what its top-level declarations
 * say. Indented `def`/`fn` lines are not declarations of the file either, so
 * requiring the margin costs nothing and keeps a signature a signature.
 */
const DECLARATION = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:def|class|function|func|fn|pub(?:\s*\([^)]*\))?\s+fn|struct|interface|type|const|let|var|enum|module)\b/

/** The declaration lines of some content, which is a file's shape without its body. */
export function declarationLines(content: string): string[] {
  return content
    .split('\n')
    .filter(line => DECLARATION.test(line) && line.trim() !== '')
    .map(line => line.trim())
}

/** `path` and `line N` around it, numbered the way `edit_file` anchors are read. */
function windowOf(lines: string[], at: number, radius: number): string {
  const start = Math.max(0, at - radius)
  const end = Math.min(lines.length - 1, at + radius)
  const out: string[] = []
  if (start > 0) out.push(`    … ${start} earlier line(s)`)
  for (let i = start; i <= end; i++) out.push(`${String(i + 1).padStart(5)} | ${lines[i]}`)
  if (end < lines.length - 1) out.push(`    … ${lines.length - 1 - end} later line(s)`)
  return out.join('\n')
}

/**
 * Where an anchor sits now.
 *
 * Three answers, and the difference matters more than the code that tells them
 * apart: `found` (the anchor is where the plan put it), `relocated` (one
 * distinctive line of it is still unique, so the edit site is known but has
 * moved), and `stale` (nothing is unique any more, so the Worker has to find the
 * site itself). Guessing between the last two would hand a Worker an anchor that
 * silently edits the wrong place.
 */
type AnchorSite =
  | { where: 'found'; line: number }
  | { where: 'relocated'; line: number; by: string }
  | { where: 'stale'; by: string | null }

/** The longest line of an anchor that appears exactly once in the file. */
function relocate(anchor: string, content: string): AnchorSite {
  const lines = content.split('\n')
  const candidates = anchor
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .sort((a, b) => b.length - a.length)
  for (const candidate of candidates) {
    const hits = lines.filter(line => line.trim() === candidate)
    if (hits.length === 1) {
      return { where: 'relocated', line: lines.indexOf(hits[0]), by: candidate }
    }
  }
  return { where: 'stale', by: candidates[0] ?? null }
}

function anchorSite(anchor: string, content: string): AnchorSite {
  const index = content.indexOf(anchor)
  if (index >= 0) {
    const line = content.slice(0, index).split('\n').length - 1
    return { where: 'found', line }
  }
  return relocate(anchor, content)
}

/** The contract a task produced, or consumed. Others are none of its business. */
function contractsFor(contracts: readonly PlanContract[] | undefined, taskId: string): PlanContract[] {
  if (!contracts) return []
  return contracts.filter(c => c.producedBy === taskId || (c.consumedBy ?? []).includes(taskId))
}

/** One handoff, full or reduced to the interfaces a transitive task needs. */
function renderHandoff(handoff: Handoff, full: boolean): string {
  const lines = [`- ${handoff.taskId} (${handoff.title})`]
  lines.push(`  wrote: ${handoff.filesWritten.length === 0 ? '(no files)' : handoff.filesWritten.join(', ')}`)
  if (full) {
    if (handoff.summary.trim() !== '') lines.push(`  said: ${handoff.summary.trim()}`)
  } else {
    lines.push('  (summary omitted: this task is more than one step away)')
  }
  for (const declaration of handoff.interfaces) lines.push(`  interface: ${declaration}`)
  return lines.join('\n')
}

/** How each excerpt of section 8 is shown. Deeper levels keep less. */
type ExcerptLevel = 'body' | 'signature' | 'path'

interface Excerpt {
  ref: ContextRef
  path: string
  body: string
  signature: string
  level: ExcerptLevel
}

/**
 * Assemble the pack. Deterministic: same input, same sections, same hash.
 *
 * Over budget, the excerpts degrade rather than anything else. They are the only
 * section the Worker can do without — every path is on disk and re-readable —
 * and the first thing a Worker does with a file it was handed is read further
 * into it if it needs to.
 */
export async function buildContextPack(input: PackInput): Promise<ContextPack> {
  const { params, model } = input
  const task = packTaskOf(input.task)
  const budget = new ContextBudget(model)
  const budgetChars = Math.floor(budget.window * params.packWindowShare * budget.ratio)
  const radius = params.anchorContextLines

  const sections: PackSection[] = []
  const staleAnchors: string[] = []
  const relocatedAnchors: string[] = []
  const shown = new Set<string>()

  const section = (number: number, name: string, fixed: boolean, body: string): void => {
    const text = [`## ${number}. ${name}`, '', body].join('\n')
    sections.push({ name, text, tokens: budget.tokens(text), fixed })
  }

  // --- 1. Task ------------------------------------------------------------
  section(
    1,
    'Task',
    true,
    [
      `Title: ${task.title}`,
      `Why: ${task.description ?? '(not given)'}`,
      `Type: ${task.type ?? 'modify'}`,
      '',
      'Instructions:',
      ...(task.instructions.length === 0
        ? ['  (none — the anchors and scope below are the work)']
        : task.instructions.map((line, i) => `  ${i + 1}. ${line}`)),
      ...(task.notes ? ['', `Notes: ${task.notes}`] : []),
    ].join('\n'),
  )

  // --- 2. Done means ------------------------------------------------------
  const criteria = task.successCriteria ?? []
  const verifies = task.verify ?? []
  const checks: string[] = (verifies.length > 0
    ? verifies.map(v => `  - ${[v.command, ...(v.args ?? [])].join(' ')} (expect exit ${v.expectExit})`)
    : task.validation.map(cmd => `  - ${cmd}`)
  )
  const doneMeans = [
    ...(criteria.length === 0 ? [] : ['Success criteria:', ...criteria.map(line => `  - ${line}`)]),
    ...(checks.length === 0
      ? criteria.length === 0
        ? ['Nothing was declared. Do not stop until the instructions above are met.']
        : []
      : [
          ...(criteria.length === 0 ? [] : ['']),
          'Every command below must exit 0 when you finish:',
          ...checks,
        ]),
  ].join('\n')
  section(2, 'Done means', true, doneMeans)

  // --- 3. Previous attempt ------------------------------------------------
  if (input.previousAttempt !== undefined && input.previousAttempt.trim() !== '') {
    section(3, 'Previous attempt', true, input.previousAttempt)
  }

  // --- 4. Edits -----------------------------------------------------------
  const editBlocks: string[] = []
  for (const edit of task.edits ?? []) {
    const path = normalize(edit.path)
    const what = `**${path}** — ${edit.op}: ${edit.change}`
    if (edit.op === 'create') {
      // A new file has no anchor to show. Its neighbours are what decide what
      // belongs beside it, and its directory is what the Worker has to write into.
      const directory = dirname(path) === '.' ? '.' : dirname(path)
      let listing: string
      try {
        listing = (await input.list(directory))
          .split('\n')
          .map(line => line.trim())
          .filter(Boolean)
          .sort()
          .slice(0, 40)
          .join('\n')
      } catch (e) {
        listing = `(could not be listed: ${e instanceof Error ? e.message : String(e)})`
      }
      editBlocks.push([
        what,
        `The file does not exist yet. It goes in \`${directory}\`, which holds:`,
        listing,
        `Create it with write_file. Do not create the directory unless it is missing; create_dir is for that.`,
      ].join('\n'))
      continue
    }
    if (edit.op === 'delete') {
      editBlocks.push(`${what}\nThe file is to be removed with delete_file.`)
      continue
    }
    const anchor = edit.anchor ?? ''
    if (anchor.trim() === '') {
      editBlocks.push(`${what}\nNo anchor was planned, so find the site yourself with read_file.`)
      continue
    }
    let content: string
    try {
      content = await input.read(path)
    } catch (e) {
      editBlocks.push(`${what}\nThe file could not be read: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    const site = anchorSite(anchor, content)
    const lines = content.split('\n')
    if (site.where === 'stale') {
      staleAnchors.push(`${path}#${(edit.change ?? '').slice(0, 60)}`)
      editBlocks.push([
        what,
        `**The planned anchor is stale**: it is no longer in this file`,
        ...(site.by ? [`  (its most distinctive line, "${site.by.slice(0, 80)}", appears 0 or many times)`] : []),
        'Read the file and find the site yourself, then edit from text the read returned.',
      ].join('\n'))
      continue
    }
    if (site.where === 'relocated') relocatedAnchors.push(path)
    shown.add(path)
    editBlocks.push([
      what,
      site.where === 'relocated'
        ? `**The anchor has moved.** It was not found as written; this is where its line "${site.by.slice(0, 80)}" is now. Anchor your edit on the text below, not on the old one.`
        : `Anchor (copied from the current file):`,
      '```',
      anchor,
      '```',
      `Here it is now (${site.where === 'relocated' ? 'relocated' : 'as planned'}, line ${site.line + 1}):`,
      '```',
      windowOf(lines, site.line, radius),
      '```',
    ].join('\n'))
  }
  section(
    4,
    'Edits',
    true,
    editBlocks.length === 0
      ? 'No anchored edits were planned for this task. Work from the instructions and the scope.'
      : editBlocks.join('\n\n'),
  )

  // --- 5. Contracts -------------------------------------------------------
  const mine = contractsFor(input.contracts, task.id)
  section(
    5,
    'Contracts',
    true,
    mine.length === 0
      ? 'This plan declares no contract this task produces or consumes.'
      : mine
          .map(c => [
            `- ${c.id} — ${c.statement}`,
            `  produced by: ${c.producedBy}${c.producedBy === task.id ? ' (this task)' : ''}`,
            `  consumed by: ${(c.consumedBy ?? []).join(', ') || 'none'}`,
          ].join('\n'))
          .join('\n'),
  )

  // --- 6. Scope -----------------------------------------------------------
  const listOr = (paths: readonly string[], fallback: string): string =>
    paths.length === 0 ? fallback : paths.map(normalize).join(', ')
  section(
    6,
    'Scope',
    true,
    [
      `You may write: ${listOr(task.writeFile, '(nothing)')}`,
      `You may delete: ${listOr(task.deleteFile, '(nothing)')}`,
      `You may create directories: ${listOr(task.createDir, '(nothing)')}`,
      'Anything outside these lists is refused by the harness, not by convention.',
    ].join('\n'),
  )

  // --- 7. Upstream results ------------------------------------------------
  const direct = input.upstream?.direct ?? []
  const transitive = input.upstream?.transitive ?? []
  section(
    7,
    'Upstream results',
    true,
    direct.length === 0 && transitive.length === 0
      ? 'This task depends on no completed work.'
      : [
          ...direct.map(h => renderHandoff(h, true)),
          ...(transitive.length > 0 ? ['', 'Further upstream, for interfaces only:', ...transitive.map(h => renderHandoff(h, false))] : []),
        ].join('\n'),
  )

  // --- 8. Context excerpts (the only degradable section) ------------------
  const refs = task.context ?? []
  const excerpts: Excerpt[] = []
  for (const ref of refs) {
    const path = normalize(ref.path)
    let body = ''
    if (ref.symbols && ref.symbols.length > 0) {
      try {
        body = await input.read(path, ref.symbols)
      } catch {
        body = ''
      }
    }
    if (body.trim() === '') {
      try {
        body = await input.read(path)
      } catch (e) {
        excerpts.push({
          ref,
          path,
          body: `(could not be read: ${e instanceof Error ? e.message : String(e)})`,
          signature: '',
          level: 'body',
        })
        continue
      }
    }
    excerpts.push({
      ref,
      path,
      body: body.length > params.toolOutputMaxChars
        ? `${body.slice(0, params.toolOutputMaxChars)}\n[… cut at toolOutputMaxChars=${params.toolOutputMaxChars}. Call read_file to see the rest.]`
        : body,
      signature: declarationLines(body).join('\n'),
      level: 'body',
    })
  }

  const renderExcerpt = (excerpt: Excerpt): string => {
    const header = `**${excerpt.path}** — ${excerpt.ref.reason}`
    if (excerpt.level === 'path') return `${header}\n  (not shown)`
    if (excerpt.level === 'signature') {
      shown.add(excerpt.path)
      return [
        header,
        'Declarations only; the bodies are not shown.',
        '```',
        excerpt.signature === '' ? '(no declaration lines matched)' : excerpt.signature,
        '```',
      ].join('\n')
    }
    shown.add(excerpt.path)
    const slice = excerpt.ref.symbols && excerpt.ref.symbols.length > 0
      ? `sliced to ${excerpt.ref.symbols.join(', ')}`
      : 'whole file'
    return [header, `(${slice})`, '```', excerpt.body, '```'].join('\n')
  }

  const fixedChars = sections.reduce((sum, s) => sum + s.text.length, 0)
  let budgetLeft = Math.max(0, budgetChars - fixedChars)
  /** What an excerpt costs at the level it is currently shown. */
  const sizeOf = (excerpt: Excerpt): number =>
    excerpt.level === 'body'
      ? excerpt.body.length
      : excerpt.level === 'signature'
        ? excerpt.signature.length
        : 0
  const hintFor = (excerpt: Excerpt): string =>
    excerpt.ref.symbols && excerpt.ref.symbols.length > 0
      ? `read_file({ "path": ${JSON.stringify(excerpt.path)}, "symbols": ${JSON.stringify(excerpt.ref.symbols)} })`
      : `read_file({ "path": ${JSON.stringify(excerpt.path)} })`

  // Last ref first: the earlier refs are the ones the plan thought of longest,
  // so they are the last thing to go. Each ref pays for what it is shown, and is
  // degraded only while it does not fit — a file with fifty declarations goes
  // from body to path, a file with one keeps it, because the signature is all
  // the plan ever gave that Worker anyway.
  const hints: string[][] = excerpts.map(() => [])
  for (let i = excerpts.length - 1; i >= 0; i--) {
    const excerpt = excerpts[i]
    budgetLeft -= sizeOf(excerpt)
    while (budgetLeft < 0 && excerpt.level !== 'path') {
      const before = sizeOf(excerpt)
      excerpt.level = excerpt.level === 'body' ? 'signature' : 'path'
      budgetLeft += before - sizeOf(excerpt)
      hints[i].push(
        excerpt.level === 'signature'
          ? `${excerpt.path}: the body was cut to fit the pack budget; declarations kept. Fetch it back with ${hintFor(excerpt)}`
          : `${excerpt.path}: cut to its path to fit the pack budget; nothing of the file is shown. Fetch it back with ${hintFor(excerpt)}`,
      )
    }
  }
  /** Every cut, in plan order, so the hints read the way the refs were declared. */
  const omitted = hints.flat()

  section(
    8,
    'Context excerpts',
    false,
    excerpts.length === 0
      ? 'No excerpts were declared. The anchors above are the code you will change.'
      : excerpts.map(renderExcerpt).join('\n\n'),
  )

  // --- 9. Project card ----------------------------------------------------
  section(9, 'Project card', true, input.projectCard ?? '- Not built: this run has no manifests to read.')

  // --- 10. Retrieval hints ------------------------------------------------
  if (omitted.length > 0) {
    section(
      10,
      'Retrieval hints',
      true,
      [
        'These parts of the pack were cut to fit its budget. Nothing is lost:',
        'the files are on disk, and these are the calls that fetch them back.',
        ...omitted.map(line => `  - ${line}`),
      ].join('\n'),
    )
  }

  const text = sections.map(s => s.text).join('\n\n')
  return {
    text,
    hash: createHash('sha256').update(text).digest('hex'),
    sections,
    tokens: budget.tokens(text),
    omitted,
    staleAnchors,
    relocatedAnchors,
    paths: [...shown].map(normalize).sort(),
  }
}