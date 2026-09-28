import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ROLE_NAMES, ROLE_PURPOSE, type RoleName } from '../../config.js'

/**
 * The one screen `/config` is: every setting that decides how a session runs, in
 * one list, in the order work flows through them.
 *
 * Kept in its own module and kept pure because it is the part worth testing.
 * The host owns the questions and the persistence; this owns the words, and a
 * row that says "this role runs the default" when it does not is a bug that
 * would otherwise only show up on someone's screen.
 */

/** The rows of the screen. The value is the machine key a pick comes back as. */
export type ConfigItem = 'model' | 'developerModel' | 'managerModel' | 'workerModel' | 'projectDir'

/** Every item, in the order the screen shows them. */
export const CONFIG_ITEMS: readonly ConfigItem[] = [
  'model',
  'developerModel',
  'managerModel',
  'workerModel',
  'projectDir',
]

/**
 * True for the four keys that name a model, as opposed to a directory.
 *
 * `model` is included deliberately: it is the default every role falls back to,
 * and it is a model, so it opens a list of models like the other three do.
 */
export function isRoleItem(item: ConfigItem): item is ConfigItem & `${RoleName}Model` {
  return item !== 'projectDir'
}

/**
 * The role whose model an item names, or null for the directory and for the
 * default — the default is not a role, it is what roles without one get.
 */
export function itemRole(item: ConfigItem): RoleName | null {
  if (item === 'model' || item === 'projectDir') return null
  return item.replace(/Model$/, '') as RoleName
}

export interface ConfigState {
  /** The fallback: what a role runs on when it has no model of its own. */
  defaultModel: string
  /** Only the roles that have been given a model; absence means inherit. */
  roleOverrides: Partial<Record<RoleName, string>>
  projectDir: string
  /**
   * A session under way owns its directory.
   *
   * The plans, the locks and the baselines in progress were all made against
   * that tree, and a session that quietly moved to another one would be
   * applying them somewhere they were never checked. So the row says it is
   * fixed rather than offering a change that will be refused.
   */
  projectDirLocked?: boolean
}

/**
 * The model a role will actually run on.
 *
 * This is the number that matters on the screen. Showing the *override* alone
 * would leave a role with no model of its own displaying nothing at all, which
 * reads as broken rather than as inherited.
 */
export function effectiveRoleModel(state: ConfigState, role: RoleName): string {
  return state.roleOverrides[role] ?? state.defaultModel
}

/** Whether a role has been given a model, as opposed to following the default. */
export function hasOverride(state: ConfigState, role: RoleName): boolean {
  return typeof state.roleOverrides[role] === 'string' && state.roleOverrides[role] !== ''
}

export interface ConfigOption {
  value: string
  label: string
}

/**
 * The pick value that means "no model of its own".
 *
 * A sentinel rather than an empty value because the picker filters on the
 * value: an empty string matches every query, which would put "use the default"
 * at the top of every filtered list.
 */
export const INHERIT_DEFAULT = '\u0000default'

/**
 * Whether a path is a directory you could actually work in.
 *
 * `existsSync` alone would offer a file as a working directory, and the run
 * would fail on the first tool call with a message about a path the user never
 * chose. The list is short enough that a stat per row is free.
 */
export function isWorkingDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * The name column, wide enough for the longest row plus a space.
 *
 * "developer model" is exactly fifteen characters, so a column of fifteen puts
 * that row's value against its name while every other row is padded.
 */
const LABEL_CELLS = 16

/**
 * The rows.
 *
 * A row states the value in play and, when a role is following the default,
 * says so — because "the manager is on gpt-5.4" and "the manager is on gpt-5.4
 * because I never touched it" are different facts, and only one of them
 * survives a restart.
 *
 * The default is the first row rather than a footnote because it is what the
 * other three are measured against, and because the command it replaces
 * (`/defaults`) made it persist. A setting that used to be saved and is now
 * only shown is a setting that looks like it works until you restart.
 */
export function configOptions(state: ConfigState): ConfigOption[] {
  return CONFIG_ITEMS.map(item => {
    if (item === 'projectDir') {
      const note = state.projectDirLocked === true ? '  · fixed — this session has started' : ''
      return { value: item, label: `${'directory'.padEnd(LABEL_CELLS)}${state.projectDir}${note}` }
    }
    if (item === 'model') {
      const inheriting = ROLE_NAMES.filter(role => !hasOverride(state, role))
      const note = inheriting.length === 0 ? 'nothing follows it' : `${inheriting.join(', ')} follow`
      return {
        value: item,
        label: `${'default model'.padEnd(LABEL_CELLS)}${state.defaultModel}  · ${note}`,
      }
    }
    const role = itemRole(item) as RoleName
    const name = `${role} model`
    const model = effectiveRoleModel(state, role)
    const notes = [ROLE_PURPOSE[role]]
    if (!hasOverride(state, role)) notes.push('default')
    return {
      value: item,
      label: `${name.padEnd(LABEL_CELLS)}${model}  · ${notes.join('  · ')}`,
    }
  })
}

/**
 * The model rows a role's sub-picker offers, current one marked.
 *
 * The mark is on the label rather than as a separate first row because a row
 * that exists only to say "this one" is a row the arrow keys can land on, and
 * landing on it does nothing.
 */
export function modelPickerOptions(
  models: { id: string; label: string }[],
  current: string,
): ConfigOption[] {
  return models.map(info => ({
    value: info.id,
    label: info.id === current ? `${info.label}  · current` : info.label,
  }))
}

/** Directories that are never worth offering: noise, and never the answer. */
const SKIPPED = new Set(['node_modules', '.git', 'target', 'dist', 'build', '.cache'])

/**
 * Whether a directory name is worth offering at all.
 *
 * One rule for the recommendations and the candidates, because a name that is
 * noise in a fuzzy match is still noise when it is a recommendation — and
 * `node_modules` under "(deeper)" is a directory nobody is ever looking for.
 */
export const isOfferable = (name: string): boolean =>
  name.length > 0 && !name.startsWith('.') && !SKIPPED.has(name)

/**
 * The directories a sub-picker offers, and why each one is on the list.
 *
 * The ordering is by how likely the answer is, not by path length or the order
 * the filesystem returns. Each row says what put it there, because a list of
 * five bare absolute paths is a list with no way to choose between them: all of
 * them look equally plausible and equally arbitrary.
 *
 * Deeper, not above. The parent of the working directory was on this list
 * because it is a one-line addition to a list of directories, and it is wrong:
 * the move people make is into a package inside the project they are in, not
 * out of it. So the current directory's own children are here instead, and its
 * parent is not.
 */
export function directoryOptions(
  current: string,
  launchDir: string,
  recent: string[],
  exists: (dir: string) => boolean,
  home: string = process.env.HOME ?? process.env.USERPROFILE ?? '',
  children: (dir: string) => string[] = () => [],
): ConfigOption[] {
  const seen = new Set<string>()
  const out: ConfigOption[] = []
  const add = (dir: string, why: string): void => {
    const resolved = dir.trim()
    if (!resolved || seen.has(resolved) || !exists(resolved)) return
    seen.add(resolved)
    out.push({ value: resolved, label: `${resolved}  (${why})` })
  }
  // Priority order, and the dedupe falls out of it: the current directory is
  // added first, so when it is also in the recent list the row keeps saying
  // "current", which is the truer of the two things about it.
  add(current, 'current')
  // Recent sessions first: where the work has actually been is a better guess
  // than anywhere else on this list.
  for (const dir of recent) add(dir, 'recent')
  for (const child of children(current)) {
    if (isOfferable(child)) add(join(current, child), 'deeper')
  }
  add(launchDir, 'launched here')
  if (home) add(home, 'home')
  return out
}

/**
 * Every directory worth fuzzy-matching while a path is being typed.
 *
 * This is the difference between a list you can only choose from and one you
 * can type into. Typing `vj` has to be able to reach `~/projects/vajra`, and
 * that is two levels down from home — so each root is read to a depth of two
 * rather than one, and the recursion stops there. It is a readdir per directory
 * at pick time, and a few hundred paths is what makes the filter feel like it
 * knows something; going deeper than that would be a filesystem walk dressed up
 * as a completion.
 */
export function pathCandidates(
  roots: { dir: string; depth: number }[],
  recent: string[],
  children: (dir: string) => string[],
  limit = 250,
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (dir: string): void => {
    if (out.length >= limit || seen.has(dir)) return
    seen.add(dir)
    out.push(dir)
  }
  const walk = (dir: string, depth: number): void => {
    push(dir)
    if (depth <= 0 || out.length >= limit) return
    for (const name of children(dir)) {
      if (isOfferable(name)) walk(join(dir, name), depth - 1)
    }
  }
  for (const { dir, depth } of roots) {
    if (dir) walk(dir, depth)
  }
  for (const dir of recent) push(dir)
  return out
}
