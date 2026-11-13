import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PermissionsConfig } from '@codekalakaars/vajra-sandbox'
import { loadProjectPolicy, MAX_DEPTH, NOT_WALKED, POLICY_FILE, PolicyFileError } from '../guard/project-policy.js'
import { planView, ViewPolicyError } from '../view/plan.js'

/**
 * What the control page shows and changes: the rights of each path in the project,
 * read from `.vajra.json` and written back to it. Nothing here touches the running
 * shell; a change takes effect when the shell is restarted.
 */

export interface Rights {
  read: boolean
  write: boolean
  delete: boolean
  /** Make new files and folders in this folder, without changing the names already there. Not inherited. */
  create: boolean
}

/** The folders that have `create`, as `ProjectPolicy.create` lists them: `a/b/` for a folder and `''` for the project root. */
export type CreateSet = ReadonlySet<string>

export type Source = 'rule' | 'inherited' | 'default'

export interface Entry {
  name: string
  /** Project-relative, with `/` as the separator. */
  path: string
  isDir: boolean
  rights: Rights
  source: Source
  /** Why the rights cannot be changed here, or null when they can. */
  locked: string | null
}

export class RightsError extends Error {}

const pick = (value: { read: boolean; write: boolean; delete: boolean }, create = false): Rights => ({ read: value.read, write: value.write, delete: value.delete, create })

/** The rights a path gets from the folder around it, ignoring any rule of its own. */
export function inheritedRights(config: PermissionsConfig, rel: string): { rights: Rights; source: Source } {
  const parts = rel.split('/')
  for (let length = parts.length - 1; length >= 1; length--) {
    const own = config.files?.[`${parts.slice(0, length).join('/')}/`]
    if (own) return { rights: pick(own), source: 'inherited' }
  }
  return { rights: pick(config.default), source: 'default' }
}

/** The rights a path has now, and where they come from. */
export function rightsFor(config: PermissionsConfig, rel: string, isDir: boolean, create: CreateSet = new Set()): { rights: Rights; source: Source } {
  const key = isDir ? `${rel}/` : rel
  const own = config.files?.[key]
  if (!own) return inheritedRights(config, rel)
  return { rights: pick(own, create.has(key)), source: 'rule' }
}

/**
 * The `paths` object with `rel` set to `desired`. Only the rights that differ from what the path would get
 * anyway are written, so a path set back to what it inherits loses its rule and the file stays short.
 */
export function withRights(paths: Record<string, unknown>, config: PermissionsConfig, rel: string, isDir: boolean, desired: Rights): Record<string, unknown> {
  if (!isDir && desired.delete) throw new RightsError('delete cannot be given to a single file: removing a file needs delete on its folder, which would also remove the files beside it')
  const inherited = inheritedRights(config, rel).rights
  const rule: Partial<Rights> = {}
  for (const right of ['read', 'write', 'delete'] as const) if (desired[right] !== inherited[right]) rule[right] = desired[right]
  if (!isDir && desired.create) throw new RightsError('create is for folders; to let the command change a file, give the file write')
  // Write already includes create, and create is not inherited, so it is written whenever it is asked for without write.
  if (isDir && desired.create && !desired.write) rule.create = true
  const key = isDir ? `${rel}/` : rel
  const next = { ...paths }
  if (Object.keys(rule).length === 0) delete next[key]
  else next[key] = rule
  return next
}

/** A project-relative path that is safe to join to the project: no `..`, no absolute path, no empty part. */
export function cleanRelative(raw: unknown): string {
  if (typeof raw !== 'string') throw new RightsError('path must be a string')
  if (raw === '') return ''
  if (raw.includes('\0') || raw.startsWith('/') || raw.includes('\\')) throw new RightsError(`${JSON.stringify(raw)} is not a path inside the project`)
  const parts = raw.replace(/\/$/, '').split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) throw new RightsError(`${JSON.stringify(raw)} is not a path inside the project`)
  return parts.join('/')
}

const depth = (rel: string): number => (rel === '' ? 0 : rel.split('/').length)

/** The entries of one folder, folders first, with their rights and whether they can be changed. */
export function listFolder(projectRoot: string, rel: string, config: PermissionsConfig, create: CreateSet = new Set()): Entry[] {
  const folder = rel === '' ? projectRoot : join(projectRoot, rel)
  if (lstatSync(folder).isSymbolicLink() || !lstatSync(folder).isDirectory()) throw new RightsError(`${rel} is not a folder`)
  const entries: Entry[] = []
  for (const name of readdirSync(folder)) {
    const path = rel === '' ? name : `${rel}/${name}`
    const info = lstatSync(join(projectRoot, path))
    const isDir = info.isDirectory()
    const { rights, source } = rightsFor(config, path, isDir, create)
    let locked: string | null = null
    if (name === POLICY_FILE && rel === '') locked = 'the policy file is always read-only for the shell'
    else if (info.isSymbolicLink()) locked = 'a symbolic link cannot have a rule; change the file it points to'
    else if (path.split('/').some(part => NOT_WALKED.has(part))) locked = 'read and run only; per-path rules do not reach inside'
    else if (depth(path) > MAX_DEPTH) locked = `deeper than ${MAX_DEPTH} folders, which the sandbox does not reach`
    entries.push({ name, path, isDir, rights, source, locked })
  }
  return entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
}

function readPolicyObject(file: string): Record<string, unknown> {
  if (!existsSync(file)) return { version: 1 }
  return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
}

/** The text of the policy file, or an empty string when there is none: what a running shell was started from. */
export function policyText(projectRoot: string): string {
  try {
    return readFileSync(join(projectRoot, POLICY_FILE), 'utf-8')
  } catch {
    return ''
  }
}

/** Why the policy on disk cannot be used, or null when the shell could start from it. */
export function policyProblem(projectRoot: string): string | null {
  try {
    const loaded = loadProjectPolicy(projectRoot)
    planView(projectRoot, loaded.config, loaded.create)
    return null
  } catch (error) {
    if (error instanceof PolicyFileError || error instanceof ViewPolicyError) return error.message
    throw error
  }
}

/**
 * Set one path's rights in `.vajra.json`. The new file is checked the way the shell would check it, and if it
 * cannot be used the old file is put back and the reason is returned, so the file is never left unusable.
 */
export function saveRights(projectRoot: string, rawPath: unknown, isDir: boolean, desired: Rights): void {
  const rel = cleanRelative(rawPath)
  const file = join(projectRoot, POLICY_FILE)
  const before = existsSync(file) ? readFileSync(file, 'utf-8') : null
  // Loaded first: it reports a file that is not valid JSON, or not a policy, in words, before anything is parsed here.
  let config: PermissionsConfig
  let create: CreateSet
  try {
    const loaded = loadProjectPolicy(projectRoot)
    config = loaded.config
    create = new Set(loaded.create)
  } catch (error) {
    if (error instanceof PolicyFileError) throw new RightsError(`the current policy is not usable, so it cannot be edited here: ${error.message}`)
    throw error
  }
  const top = readPolicyObject(file)
  const paths = top.paths === undefined ? {} : (top.paths as Record<string, unknown>)
  let next: Record<string, unknown>
  if (rel === '') {
    // The project as a whole: read, write and delete are fixed by "default" in the file, and the root cannot be
    // written or deleted from at all. Create is the one right that can be given here.
    if (desired.read !== config.default.read || desired.write || desired.delete) {
      throw new RightsError('the project as a whole can only be given create here. Its other rights are "default" in the file, and the root cannot be written or deleted from')
    }
    const given = { ...((top.default ?? {}) as Record<string, unknown>) }
    if (desired.create) given.create = true
    else delete given.create
    next = { ...top, version: 1, paths }
    if (Object.keys(given).length > 0) next.default = given
    else delete next.default
  } else {
    next = { ...top, version: 1, paths: withRights(paths, config, rel, isDir, desired) }
  }

  const temp = `${file}.tmp-${process.pid}`
  writeFileSync(temp, JSON.stringify(next, null, 2) + '\n')
  renameSync(temp, file)
  const problem = policyProblem(projectRoot)
  if (problem === null) return
  if (before === null) unlinkSync(file)
  else writeFileSync(file, before)
  throw new RightsError(problem)
}
