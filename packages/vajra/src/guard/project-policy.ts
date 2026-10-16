import { readFileSync, realpathSync, statSync, existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { FilePermissions, PermissionsConfig } from '@codekalakaars/vajra-sandbox'

/**
 * `.vajra.json`: what the command may do to each file and folder in the project.
 *
 * It starts from read-only. A path can be given `read`, `write` and `delete`, and
 * a path that is not given a value inherits it from the folder around it.
 *
 *   {
 *     "version": 1,
 *     "default": { "read": true, "write": false, "delete": false },
 *     "paths": {
 *       "src/":        { "write": true },
 *       "secrets/":    { "read": false },
 *       "README.md":   { "write": true }
 *     }
 *   }
 *
 * The kernel (Landlock) can only add rights below a folder, never take them away,
 * and it grants a folder's rights to everything in it. So a rule that would need
 * to take a right away from something inside a folder that has it is refused, and
 * so is a delete rule on a single file, which would also let the command delete
 * the files beside it. Refusing is better than enforcing something other than what
 * the file says.
 */

export const POLICY_FILE = '.vajra.json'

/** The native walker descends this many levels; a rule deeper than that would be ignored. */
export const MAX_DEPTH = 8

/** The native walker grants these folders read and run only, and does not look inside them. */
export const NOT_WALKED = new Set(['.git', 'node_modules', 'target'])

const TOP_KEYS = new Set(['version', 'default', 'paths'])
const RIGHT_KEYS = new Set(['read', 'write', 'delete', 'create'])

export class PolicyFileError extends Error {}

export interface ProjectPolicy {
  /**
   * The rights as the file states them. `create` is not in here: it has no Landlock form, so it is the list below.
   */
  config: PermissionsConfig
  /**
   * Folders where the command may make new files and folders but change nothing that exists: a key ending in `/`,
   * and `''` for the project root. Landlock cannot grant that for one level, so `kernel` grants more and the view
   * (`view/plan.ts`) pins every existing name read-only; neither is enough alone.
   */
  create: string[]
  /** The rights handed to Landlock: `config`, with write added where `create` is. */
  kernel: PermissionsConfig
  /** One line per path, for the summary before the command starts. */
  lines: string[]
  /** Whether a `.vajra.json` was found. */
  fromFile: boolean
  /** The policy as a `.vajra.json` would hold it: the file, with the command-line rules added. */
  json: string
  /** Whether any command-line rule was added, so the file does not already say all of it. */
  changed: boolean
}

/**
 * Rules given on the command line for one run. A path is project-relative, or an
 * absolute path inside the project; a folder ends in `/`.
 */
export interface PolicyChanges {
  write?: readonly string[]
  delete?: readonly string[]
  denyRead?: readonly string[]
}

type Rights = { read?: boolean; write?: boolean; delete?: boolean; create?: boolean }

const START: FilePermissions = { read: true, write: false, edit: false, delete: false }

/**
 * Load the project's policy: the file if there is one, else the read-only default,
 * with any command-line rules added on top. Throws PolicyFileError.
 */
export function loadProjectPolicy(projectDir: string, changes: PolicyChanges = {}, absent: ReadonlySet<string> = new Set()): ProjectPolicy {
  const file = join(projectDir, POLICY_FILE)
  const fromFile = existsSync(file)
  const top = fromFile ? readPolicyFile(file) : { version: 1 }
  const projectReal = realpathSync(projectDir)

  const paths: Record<string, unknown> = {}
  const existing = top.paths === undefined ? {} : plainObject(top.paths, '"paths"')
  for (const [key, value] of Object.entries(existing)) paths[key] = { ...plainObject(value, `"${key}"`) }

  let changed = false
  const add = (given: readonly string[] | undefined, right: keyof Rights, value: boolean): void => {
    for (const raw of given ?? []) {
      const key = fromCommandLine(raw, projectReal)
      paths[key] = { ...((paths[key] ?? {}) as Record<string, unknown>), [right]: value }
      changed = true
    }
  }
  add(changes.write, 'write', true)
  add(changes.delete, 'delete', true)
  add(changes.denyRead, 'read', false)

  const { config, create, kernel, lines } = resolvePolicy(projectReal, { ...top, paths }, absent)
  const json = JSON.stringify({ version: 1, ...(top.default !== undefined ? { default: top.default } : {}), paths }, null, 2) + '\n'
  return { config, create, kernel, lines, fromFile, json, changed }
}

function readPolicyFile(file: string): Record<string, unknown> {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'))
  } catch (err) {
    throw new PolicyFileError(`${POLICY_FILE} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  return object(raw, POLICY_FILE, TOP_KEYS)
}

/** A command-line path as the key the file uses: project-relative, `/` for a folder. */
function fromCommandLine(given: string, projectReal: string): string {
  if (given.trim() === '') throw new PolicyFileError('a path given on the command line cannot be empty')
  if (!isAbsolute(given)) return given
  const rel = relative(projectReal, resolve(given))
  if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new PolicyFileError(`${given}: not a path inside the project ${projectReal}`)
  }
  return given.endsWith('/') ? `${rel}/` : rel
}

/** Check the rules and work out what each path may do. Throws PolicyFileError. */
function resolvePolicy(projectReal: string, top: Record<string, unknown>, absent: ReadonlySet<string>): { config: PermissionsConfig; create: string[]; kernel: PermissionsConfig; lines: string[] } {
  if (top.version !== 1) throw new PolicyFileError(`${POLICY_FILE}: "version" must be 1`)

  const defaults = rights(top.default ?? {}, 'default')
  if (defaults.write === true) {
    throw new PolicyFileError(`${POLICY_FILE}: default "write" must be false. The policy file has to stay read-only, and that needs the root to deny write; give write to the folders and files that need it`)
  }
  if (defaults.delete === true) {
    throw new PolicyFileError(`${POLICY_FILE}: default "delete" must be false. The policy file has to stay undeletable, and that needs the root to deny delete; give delete to the folders that need it`)
  }
  const { create: createRoot, ...rootRights } = defaults
  const root: FilePermissions = { ...START, ...rootRights, edit: false }
  const create: string[] = createRoot === true ? [''] : []

  const rules = new Map<string, { isDir: boolean; given: Rights }>()
  const paths = top.paths === undefined ? {} : plainObject(top.paths, '"paths"')
  for (const [raw, value] of Object.entries(paths)) {
    const { key, isDir } = normalizeKey(raw, projectReal, absent)
    if (rules.has(key)) throw new PolicyFileError(`${POLICY_FILE}: "${raw}" names a path that is already in the file`)
    rules.set(key, { isDir, given: rights(value, `"${raw}"`) })
  }

  // Resolve shallow paths first, so each rule inherits from the folder around it.
  const resolved = new Map<string, FilePermissions>()
  const lines: string[] = [`default: ${describe(root)}${createRoot === true ? ' (and create)' : ''}`]
  const ordered = [...rules.keys()].sort((a, b) => depth(a) - depth(b))
  for (const key of ordered) {
    const rule = rules.get(key) as { isDir: boolean; given: Rights }
    const parent = nearest(key, resolved) ?? { name: 'the project', perms: root }
    if (rule.given.create !== undefined && !rule.isDir) {
      throw new PolicyFileError(`${POLICY_FILE}: "${key}" is a file, and "create" is for folders. Use "write" to let the command change it`)
    }
    const perms: FilePermissions = {
      read: rule.given.read ?? parent.perms.read,
      write: rule.given.write ?? parent.perms.write,
      edit: false,
      delete: rule.given.delete ?? parent.perms.delete,
    }
    perms.edit = perms.write

    if (parent.perms.write && !perms.write) {
      throw new PolicyFileError(`${POLICY_FILE}: "${key}" cannot lose write inside ${parent.name}, which allows it. Give write to the paths that need it instead`)
    }
    if (parent.perms.delete && !perms.delete) {
      throw new PolicyFileError(`${POLICY_FILE}: "${key}" cannot be kept from delete inside ${parent.name}, which allows it. Give delete to the paths that need it instead`)
    }
    if (!rule.isDir && perms.delete && !parent.perms.delete) {
      throw new PolicyFileError(`${POLICY_FILE}: "${key}" cannot have delete on its own. Removing one file needs delete on its folder, which would also let the command remove every file beside it. Put delete on the folder instead`)
    }

    // Create is not inherited: it is for the names directly in that one folder. Write already includes it.
    const creates = rule.given.create === true && !perms.write
    if (creates && !perms.read) {
      throw new PolicyFileError(`${POLICY_FILE}: "${key}" has "create" and no "read". A folder that is not read is gone from the shell, so there is nothing to create in`)
    }
    if (creates) create.push(key)

    resolved.set(key, perms)
    lines.push(`${key}: ${describe(perms)}${creates ? ', create' : ''}`)
  }

  const files: Record<string, FilePermissions> = {}
  for (const [key, perms] of resolved) files[key] = perms
  const config: PermissionsConfig = { version: 1, default: root, files }
  const kernelFiles: Record<string, FilePermissions> = { ...files }
  for (const key of create) if (key !== '') kernelFiles[key] = { ...(files[key] as FilePermissions), write: true, edit: true }
  const kernel: PermissionsConfig = { version: 1, default: createRoot === true ? { ...root, write: true, edit: true } : root, files: kernelFiles }
  return { config, create, kernel, lines }
}

/** The rights of the nearest folder rule above `key`, if there is one. */
function nearest(key: string, resolved: Map<string, FilePermissions>): { name: string; perms: FilePermissions } | null {
  let best: string | null = null
  for (const candidate of resolved.keys()) {
    if (!candidate.endsWith('/') || candidate === key || !key.startsWith(candidate)) continue
    if (best === null || candidate.length > best.length) best = candidate
  }
  return best === null ? null : { name: best, perms: resolved.get(best) as FilePermissions }
}

function depth(key: string): number {
  return key.replace(/\/$/, '').split('/').length
}

function normalizeKey(raw: string, projectReal: string, absent: ReadonlySet<string>): { key: string; isDir: boolean } {
  if (raw.trim() === '') throw new PolicyFileError(`${POLICY_FILE}: a path cannot be empty`)
  if (raw.startsWith('/')) throw new PolicyFileError(`${POLICY_FILE}: "${raw}" must be relative to the project`)
  if (raw.includes('\\')) throw new PolicyFileError(`${POLICY_FILE}: "${raw}" must use / as the separator`)

  const wantsDir = raw.endsWith('/')
  const body = raw.replace(/\/+$/, '').replace(/^\.\//, '')
  const parts = body.split('/')
  if (body === '' || parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new PolicyFileError(`${POLICY_FILE}: "${raw}" is not a path inside the project. The project as a whole is set by "default"`)
  }
  if (parts.length > MAX_DEPTH) {
    throw new PolicyFileError(`${POLICY_FILE}: "${raw}" is more than ${MAX_DEPTH} folders deep, which the sandbox does not reach`)
  }
  const inside = parts.find(part => NOT_WALKED.has(part))
  if (inside) {
    throw new PolicyFileError(`${POLICY_FILE}: "${raw}" is inside ${inside}, where the sandbox does not apply per-path rules`)
  }
  if (body === POLICY_FILE) {
    throw new PolicyFileError(`${POLICY_FILE}: the policy file cannot have rules of its own. It stays read-only and undeletable through "default"`)
  }

  const full = join(projectReal, body)
  let stat
  try {
    stat = statSync(full)
  } catch {
    // Inside the view, a path with `read: false` is gone on purpose. The outer process checked that it existed.
    if (absent.has(body)) return { key: wantsDir ? `${body}/` : body, isDir: wantsDir }
    throw new PolicyFileError(`${POLICY_FILE}: "${raw}" does not exist in the project. Rules apply to paths that exist when the command starts`)
  }
  if (realpathSync(full) !== full) {
    throw new PolicyFileError(`${POLICY_FILE}: "${raw}" is a symbolic link. Name the file it points to, inside the project`)
  }
  if (stat.isDirectory() !== wantsDir) {
    throw new PolicyFileError(stat.isDirectory()
      ? `${POLICY_FILE}: "${raw}" is a folder; write it with a trailing slash`
      : `${POLICY_FILE}: "${raw}" is a file; remove the trailing slash`)
  }
  return { key: wantsDir ? `${body}/` : body, isDir: stat.isDirectory() }
}

function rights(value: unknown, where: string): Rights {
  const given = object(value, where, RIGHT_KEYS)
  const out: Rights = {}
  for (const [name, flag] of Object.entries(given)) {
    if (typeof flag !== 'boolean') throw new PolicyFileError(`${POLICY_FILE}: ${where} "${name}" must be true or false`)
    out[name as keyof Rights] = flag
  }
  return out
}

function plainObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PolicyFileError(`${POLICY_FILE}: ${where} must be an object`)
  }
  return value as Record<string, unknown>
}

/** A JSON object with only the allowed keys. `hidden` gets its own explanation. */
function object(value: unknown, where: string, allowed: Set<string>): Record<string, unknown> {
  const record = plainObject(value, where)
  for (const key of Object.keys(record)) {
    if (key === 'hidden') {
      throw new PolicyFileError(`${POLICY_FILE}: "hidden" is not supported. The kernel can stop a path being read, but it cannot hide the name from a folder listing, so the name would still show. Use "read": false`)
    }
    if (!allowed.has(key)) throw new PolicyFileError(`${POLICY_FILE}: unknown key "${key}" in ${where}`)
  }
  return record
}

function describe(perms: Pick<FilePermissions, 'read' | 'write' | 'delete'>): string {
  const words = (['read', 'write', 'delete'] as const).filter(name => perms[name] === true)
  return words.length === 0 ? 'none' : words.join(', ')
}
