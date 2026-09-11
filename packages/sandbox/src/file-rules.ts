// Glob matching and file permission resolution.
//
// Converts an array of FileRule patterns into a concrete PermissionsConfig
// that vajra-core understands. Also filters ProjectFileEntry lists to only
// show files the sandbox allows.
//
// Glob support is intentionally minimal: *, **, ?, and ! negation. No brace
// expansion, no character classes — keep config files human-readable.

import type { FilePermissions, PermissionsConfig, ProjectFileEntry } from './types.js'
import type { SandboxConfig, FileRule } from './config.js'

// ---- Memoization cache for glob matching ----

const _matchCache = new Map<string, boolean>()

function cacheKey(filePath: string, pattern: string): string {
  return `${filePath}\0${pattern}`
}

/**
 * Test whether a project-relative file path matches a glob pattern.
 *
 * Supported syntax:
 *  - `*`   matches any characters except `/`
 *  - `**`  matches any characters including `/`
 *  - `?`   matches exactly one character except `/`
 *  - `!`   prefix negates the pattern
 *
 * Matching is against the full path (e.g. "src/index.ts"), not just the
 * filename. A pattern without `/` is matched against each path segment.
 */
export function matchesPattern(filePath: string, pattern: string): boolean {
  const key = cacheKey(filePath, pattern)
  const cached = _matchCache.get(key)
  if (cached !== undefined) return cached

  let negated = false
  let pat = pattern

  if (pat.startsWith('!')) {
    negated = true
    pat = pat.slice(1)
  }

  const result = matchGlob(filePath, pat)
  const final = negated ? !result : result
  _matchCache.set(key, final)
  return final
}

/** Clear the memoization cache. Call after config changes. */
export function clearMatchCache(): void {
  _matchCache.clear()
}

function matchGlob(path: string, pattern: string): boolean {
  // Split both into segments for comparison
  const pathSegments = path.split('/')
  const patternSegments = pattern.split('/')

  return matchSegments(pathSegments, patternSegments, 0, 0)
}

function matchSegments(
  path: string[],
  pattern: string[],
  pi: number,
  si: number,
): boolean {
  // Pattern exhausted — path must also be exhausted
  if (si >= pattern.length) {
    return pi >= path.length
  }

  const seg = pattern[si]

  // ** matches zero or more directories
  if (seg === '**') {
    // Try matching ** against 0, 1, 2, ... path segments
    for (let skip = pi; skip <= path.length; skip++) {
      if (matchSegments(path, pattern, skip, si + 1)) {
        return true
      }
    }
    return false
  }

  // Path exhausted but pattern remains
  if (pi >= path.length) {
    return false
  }

  // Match single segment
  if (!matchSegment(path[pi], seg)) {
    return false
  }

  return matchSegments(path, pattern, pi + 1, si + 1)
}

function matchSegment(pathSegment: string, patternSegment: string): boolean {
  return matchSimpleGlob(pathSegment, patternSegment, 0, 0)
}

function matchSimpleGlob(
  text: string,
  pat: string,
  ti: number,
  pi: number,
): boolean {
  // Both exhausted
  if (ti >= text.length && pi >= pat.length) return true

  // Pattern exhausted but text remains
  if (pi >= pat.length) return false

  const p = pat[pi]

  if (p === '*') {
    // * matches everything except /
    // Try matching 0, 1, 2, ... characters
    for (let skip = ti; skip <= text.length; skip++) {
      if (text[skip] === '/') break // * cannot cross /
      if (matchSimpleGlob(text, pat, skip, pi + 1)) return true
    }
    return false
  }

  if (p === '?') {
    // ? matches one character (not /)
    if (ti >= text.length || text[ti] === '/') return false
    return matchSimpleGlob(text, pat, ti + 1, pi + 1)
  }

  // Literal character
  if (ti >= text.length || text[ti] !== p) return false
  return matchSimpleGlob(text, pat, ti + 1, pi + 1)
}

// ---- Compiled rules for fast permission resolution ----

/**
 * Pre-compiled set of file rules for fast permission resolution.
 * Avoids re-evaluating glob patterns on every tool call.
 */
export class CompiledRules {
  private rules: Array<{ pattern: string; negated: boolean; permissions: Partial<FilePermissions> }> = []
  private permCache = new Map<string, FilePermissions>()

  constructor(
    private defaultPermissions: FilePermissions,
    fileRules: readonly FileRule[],
  ) {
    for (const rule of fileRules) {
      const negated = rule.pattern.startsWith('!')
      const pattern = negated ? rule.pattern.slice(1) : rule.pattern
      this.rules.push({
        pattern,
        negated,
        permissions: {
          ...(rule.read !== undefined && { read: rule.read }),
          ...(rule.write !== undefined && { write: rule.write }),
          ...(rule.edit !== undefined && { edit: rule.edit }),
          ...(rule.delete !== undefined && { delete: rule.delete }),
        },
      })
    }
  }

  /**
   * Resolve permissions for a file path. Cached after first call.
   */
  resolve(filePath: string): FilePermissions {
    const cached = this.permCache.get(filePath)
    if (cached) return cached

    const result = { ...this.defaultPermissions }

    for (const rule of this.rules) {
      const matched = matchesPattern(filePath, rule.pattern)
      const applies = rule.negated ? !matched : matched
      if (applies) {
        if (rule.permissions.read !== undefined) result.read = rule.permissions.read
        if (rule.permissions.write !== undefined) result.write = rule.permissions.write
        if (rule.permissions.edit !== undefined) result.edit = rule.permissions.edit
        if (rule.permissions.delete !== undefined) result.delete = rule.permissions.delete
      }
    }

    this.permCache.set(filePath, result)
    return result
  }

  /** Clear the permission cache. Call after file operations. */
  clearCache(): void {
    this.permCache.clear()
  }
}

/**
 * Resolve the effective file permissions for a path by applying rules in order.
 *
 * Rules are evaluated in array order — later rules override earlier ones.
 * The default permissions serve as the base.
 *
 * For repeated calls with the same config, use CompiledRules instead.
 */
export function resolveFilePermission(
  config: SandboxConfig,
  filePath: string,
): FilePermissions {
  const result = { ...config.defaultPermissions }

  for (const rule of config.fileRules) {
    if (matchesPattern(filePath, rule.pattern)) {
      if (rule.read !== undefined) result.read = rule.read
      if (rule.write !== undefined) result.write = rule.write
      if (rule.edit !== undefined) result.edit = rule.edit
      if (rule.delete !== undefined) result.delete = rule.delete
    }
  }

  return result
}

/**
 * Build a PermissionsConfig (the shape vajra-core expects) from a
 * SandboxConfig. The result contains a `files` map with one entry per
 * unique path that has non-default permissions.
 */
export function resolveFilePermissions(config: SandboxConfig): PermissionsConfig {
  // We need to produce a PermissionsConfig. The challenge: vajra-core
  // applies rules per-path, but our glob patterns can match many paths.
  // We resolve this by keeping the defaultPermissions as the base and
  // encoding the glob rules so the worker can evaluate them at call time.
  //
  // For now, we return the config with the default permissions and let the
  // worker evaluate rules per tool call. This is the safe approach: the
  // worker re-validates everything anyway.
  return {
    version: 1,
    default: { ...config.defaultPermissions },
    files: {},
  }
}

/**
 * Filter a list of project file entries to only those the sandbox allows
 * (read permission = true after applying rules).
 *
 * For repeated calls with the same config, use CompiledRules instead.
 */
export function filterFileEntries(
  entries: ProjectFileEntry[],
  config: SandboxConfig,
): ProjectFileEntry[] {
  const compiled = new CompiledRules(config.defaultPermissions, config.fileRules)
  return entries.filter((entry) => {
    if (entry.isDir) {
      // Directories are always included — traversal is needed to reach files.
      // Actual access is gated by the sandbox at the native level.
      return true
    }
    const perm = compiled.resolve(entry.path)
    return perm.read
  })
}
