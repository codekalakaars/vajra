import { existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
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
      return { value: item, label: `${'directory'.padEnd(LABEL_CELLS)}${state.projectDir}` }
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

/**
 * The directories a sub-picker offers: where you are, where you launched from,
 * one level up, and the directories of recent sessions.
 *
 * There is no way to type a path here — the input line is the filter, and
 * inventing a text prompt to work around that would be a second input model
 * for one setting. So the list offers real places instead: the recent-session
 * directories are usually the ones being asked for, and they are the paths a
 * user cannot remember.
 */
export function directoryOptions(
  current: string,
  launchDir: string,
  recent: string[],
  exists: (dir: string) => boolean,
): ConfigOption[] {
  const seen = new Set<string>()
  const out: ConfigOption[] = []
  for (const dir of [current, launchDir, ...recent]) {
    const resolved = dir.trim()
    if (!resolved || seen.has(resolved) || !exists(resolved)) continue
    seen.add(resolved)
    out.push({
      value: resolved,
      label: resolved === current ? `${resolved}  (current)` : resolved,
    })
  }
  // The parent of the current directory, offered last: it is the move people
  // want when the project turned out to be a subdirectory, and it is never the
  // first answer anyone would give.
  const parent = dirname(current)
  if (parent && parent !== current && !seen.has(parent) && exists(parent)) {
    out.push({ value: parent, label: `${parent}  (parent)` })
  }
  return out
}
