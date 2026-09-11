// Glob matching and file permission resolution.
//
// Converts an array of FileRule patterns into a concrete PermissionsConfig
// that vajra-native understands. Also filters ProjectFileEntry lists to only
// show files the sandbox allows.
//
// Glob support is intentionally minimal: *, **, ?, and ! negation. No brace
// expansion, no character classes — keep config files human-readable.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { FilePermissions, PermissionsConfig, ProjectFileEntry } from './types.js'
import type { SandboxConfig, FileRule } from './config.js'

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
  let negated = false
  let pat = pattern

  if (pat.startsWith('!')) {
    negated = true
    pat = pat.slice(1)
  }

  const result = matchGlob(filePath, pat)
  return negated ? !result : result
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

/**
 * Resolve the effective file permissions for a path by applying rules in order.
 *
 * Rules are evaluated in array order — later rules override earlier ones.
 * The default permissions serve as the base.
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

/** Simple directory walk to collect project-relative file paths. */
function walkProject(projectDir: string, maxDepth = 8): string[] {
  const files: string[] = []
  const skip = new Set(['.git', 'node_modules', 'target', '.next', 'dist'])

  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue
      if (entry.name.startsWith('.') && entry.name !== '.sample.env') continue
      const full = join(dir, entry.name)
      const rel = full.slice(projectDir.length + 1)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
      } else if (entry.isFile()) {
        files.push(rel)
      }
    }
  }

  walk(projectDir, 0)
  return files
}

/**
 * Expand glob-based file rules against the actual files on disk, producing
 * a concrete per-path permissions map. This is what lets Landlock/Seatbelt
 * (OS-level, mechanism-agnostic to which tool a caller uses — including
 * `run_command`) enforce a rule like `{pattern: "secrets/**", read: false}`.
 * A per-tool-call JS check alone cannot: it only runs for tools whose args
 * name a path, and `run_command` doesn't.
 */
export function expandFileRules(
  projectDir: string,
  fileRules: readonly FileRule[],
  defaultPermissions: FilePermissions,
): Record<string, FilePermissions> {
  const files = walkProject(projectDir)
  const result: Record<string, FilePermissions> = {}

  for (const file of files) {
    const perms = { ...defaultPermissions }
    for (const rule of fileRules) {
      if (matchesPattern(file, rule.pattern)) {
        if (rule.read !== undefined) perms.read = rule.read
        if (rule.write !== undefined) perms.write = rule.write
        if (rule.edit !== undefined) perms.edit = rule.edit
        if (rule.delete !== undefined) perms.delete = rule.delete
      }
    }
    // Only add entries that differ from default
    if (
      perms.read !== defaultPermissions.read ||
      perms.write !== defaultPermissions.write ||
      perms.edit !== defaultPermissions.edit ||
      perms.delete !== defaultPermissions.delete
    ) {
      result[file] = perms
    }
  }

  return result
}

/**
 * Build a PermissionsConfig (the shape vajra-native expects) from a
 * SandboxConfig. The result's `files` map has one entry per project file
 * whose resolved permissions differ from the default — this is what gets
 * enforced at the OS level, not just re-checked per tool call.
 */
export function resolveFilePermissions(config: SandboxConfig): PermissionsConfig {
  return {
    version: 1,
    default: { ...config.defaultPermissions },
    files: expandFileRules(config.projectDir, config.fileRules, config.defaultPermissions),
  }
}

/**
 * Filter a list of project file entries to only those the sandbox allows
 * (read permission = true after applying rules).
 */
export function filterFileEntries(
  entries: ProjectFileEntry[],
  config: SandboxConfig,
): ProjectFileEntry[] {
  return entries.filter((entry) => {
    if (entry.isDir) {
      // Directories are always included — traversal is needed to reach files.
      // Actual access is gated by the sandbox at the native level.
      return true
    }
    const perm = resolveFilePermission(config, entry.path)
    return perm.read
  })
}

// ---------------------------------------------------------------------------
// Per-tool-call permission checking (shared between CLI and worker)
// ---------------------------------------------------------------------------

/** Tools that modify state (write/edit/delete/create/copy/rename). */
const WRITE_TOOLS = new Set([
  'write_file', 'edit_file', 'delete_file', 'delete_dir',
  'create_dir', 'copy_file', 'rename_file',
])

/** Extract the file path(s) a tool call targets. */
function extractPaths(tool: string, args: unknown): string[] {
  const a = args as Record<string, unknown>
  switch (tool) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'delete_file':
    case 'delete_dir':
    case 'create_dir':
    case 'list_files':
      return typeof a.path === 'string' ? [a.path] : []
    case 'copy_file':
    case 'rename_file':
      return [a.source, a.destination].filter((p): p is string => typeof p === 'string')
    default:
      return [] // run_command has no file path
  }
}

/**
 * Check whether a single tool call is allowed by the file rules.
 *
 * Returns null if permitted, or an error message string if denied.
 * Used by both the worker (per-tool-call) and can be used by CLI agents
 * to pre-validate before dispatching.
 *
 * `projectDir` is used to convert absolute paths to project-relative
 * before pattern matching — rules are always project-relative.
 */
export function checkToolPermission(
  tool: string,
  args: unknown,
  fileRules: readonly FileRule[],
  defaultPermissions: FilePermissions,
  projectDir?: string,
): string | null {
  if (fileRules.length === 0) return null

  const paths = extractPaths(tool, args)
  for (const filePath of paths) {
    // Convert to project-relative for pattern matching
    let relPath = filePath
    if (projectDir && filePath.startsWith(projectDir)) {
      relPath = filePath.slice(projectDir.length + 1)
    }

    const result = { ...defaultPermissions }
    for (const rule of fileRules) {
      if (matchesPattern(relPath, rule.pattern)) {
        if (rule.read !== undefined) result.read = rule.read
        if (rule.write !== undefined) result.write = rule.write
        if (rule.edit !== undefined) result.edit = rule.edit
        if (rule.delete !== undefined) result.delete = rule.delete
      }
    }

    if (!result.read) {
      return `Access denied: '${filePath}' is not readable in the current sandbox configuration.`
    }
    if (WRITE_TOOLS.has(tool) && !result.write) {
      return `Access denied: '${filePath}' is not writable in the current sandbox configuration.`
    }
    if (tool === 'edit_file' && !result.edit) {
      return `Access denied: '${filePath}' is not editable in the current sandbox configuration.`
    }
  }

  return null
}
