import { lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PermissionsConfig } from '@codekalakaars/vajra-sandbox'

/**
 * The project as the confined shell sees it, as bubblewrap mounts.
 *
 * Bubblewrap starts from the whole machine bound read-only, so the project is
 * already read-only in the view. This plan changes two things inside it:
 *
 *  - A path with `read: false` is made not to exist. Landlock can close a file but
 *    not remove its name from a listing; a mount can. The parent folder is rebuilt
 *    as an empty read-only filesystem with every sibling bound back in, minus the
 *    hidden name.
 *  - A path with `write` or `delete` is bound read-write. Whether it may create,
 *    change or remove is still decided by Landlock, which runs inside the view;
 *    the bind only stops the read-only mount from refusing first.
 *
 * What a mount cannot do is hide a name inside a folder that is shared with the
 * host and writable: the folder would have to be rebuilt, and a rebuilt folder
 * keeps nothing the command writes to it. Such a policy is refused.
 */

export class ViewPolicyError extends Error {}

export interface ViewPlan {
  /** Arguments for bubblewrap, to follow the base mounts and precede the command. */
  args: string[]
  /** Project-relative paths that do not exist in the view. */
  hidden: string[]
  /** Project-relative paths bound read-write. */
  writable: string[]
}

interface Entry {
  name: string
  symlinkTo?: string
}

/** What the plan needs from the filesystem, so a test can say what is there. */
export interface ViewFs {
  exists(path: string): boolean
  isSymlink(path: string): boolean
  /** The directory's real path, to see whether a rule's parent folder is reached through a link. */
  real(path: string): string
  list(path: string): Entry[]
}

const nodeFs: ViewFs = {
  exists(path) {
    try {
      lstatSync(path)
      return true
    } catch {
      return false
    }
  },
  isSymlink: path => lstatSync(path).isSymbolicLink(),
  real: path => realpathSync(path),
  list: path => readdirSync(path).map(name => {
    const full = join(path, name)
    return lstatSync(full).isSymbolicLink() ? { name, symlinkTo: readlinkSync(full) } : { name }
  }),
}

const withoutSlash = (key: string): string => key.replace(/\/$/, '')

/** The folders above a project-relative path, nearest last: `a/b/c` gives `a`, `a/b`. */
function ancestors(rel: string): string[] {
  const parts = rel.split('/')
  const found: string[] = []
  for (let index = 1; index < parts.length; index++) found.push(parts.slice(0, index).join('/'))
  return found
}

export function planView(projectReal: string, config: PermissionsConfig, fs: ViewFs = nodeFs): ViewPlan {
  const files = config.files ?? {}
  const hidden = new Set<string>()
  const writable: string[] = []

  for (const [key, rights] of Object.entries(files)) {
    const rel = withoutSlash(key)
    const absolute = join(projectReal, rel)
    if (!fs.exists(absolute)) continue
    if (rights.read === false) hidden.add(rel)
    else if (rights.write || rights.delete) writable.push(rel)
  }

  const folderRights = (rel: string) => files[`${rel}/`]

  for (const rel of hidden) {
    for (const above of ancestors(rel)) {
      if (hidden.has(above)) throw new ViewPolicyError(`"${rel}" is inside "${above}/", which is hidden, so its own rule has no effect. Remove the rule for "${rel}"`)
      const rights = folderRights(above)
      if (rights && (rights.write || rights.delete)) {
        throw new ViewPolicyError(`"${rel}" cannot be hidden inside "${above}/", which allows ${rights.write ? 'write' : 'delete'}. A writable folder is shared with the real project, so every name in it shows. Hide "${above}/" itself, or make it read-only`)
      }
    }
  }
  for (const rel of writable) {
    const covering = ancestors(rel).find(above => hidden.has(above))
    if (covering) throw new ViewPolicyError(`"${rel}" is inside "${covering}/", which is hidden. A path cannot be writable where it does not exist`)
  }

  const args: string[] = []

  // Shallow folders first: a deeper rebuild must land on top of the one above it.
  const rebuilt = [...new Set([...hidden].map(rel => dirname(rel)))].sort((a, b) => depth(a) - depth(b))
  for (const folder of rebuilt) {
    const absolute = folder === '.' ? projectReal : join(projectReal, folder)
    if (fs.real(absolute) !== absolute) throw new ViewPolicyError(`"${folder}" is reached through a symbolic link; a rule must name a path inside the project`)
    args.push('--tmpfs', absolute)
    for (const entry of fs.list(absolute)) {
      const rel = folder === '.' ? entry.name : `${folder}/${entry.name}`
      if (hidden.has(rel)) continue
      const path = join(absolute, entry.name)
      // A link stays a link, so it points where it always did and cannot be used to reach a hidden name.
      if (entry.symlinkTo !== undefined) args.push('--symlink', entry.symlinkTo, path)
      else args.push('--ro-bind', path, path)
    }
    // The rebuilt folder is an empty filesystem and would otherwise accept files that vanish.
    args.push('--remount-ro', absolute)
  }

  for (const rel of writable) {
    const path = join(projectReal, rel)
    if (fs.isSymlink(path)) throw new ViewPolicyError(`"${rel}" is a symbolic link; a rule must name a path inside the project`)
    args.push('--bind', path, path)
  }

  return { args, hidden: [...hidden].sort(), writable: [...writable].sort() }
}

function depth(rel: string): number {
  return rel === '.' ? 0 : rel.split('/').length
}
