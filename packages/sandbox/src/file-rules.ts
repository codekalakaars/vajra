// Glob matching and file permission resolution.
// Glob support is intentionally minimal: *, **, ?, and ! negation.

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
  if (si >= pattern.length) return pi >= path.length

  const seg = pattern[si]

  if (seg === '**') {
    for (let skip = pi; skip <= path.length; skip++) {
      if (matchSegments(path, pattern, skip, si + 1)) return true
    }
    return false
  }

  if (pi >= path.length) return false
  if (!matchSegment(path[pi], seg)) return false

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
  if (ti >= text.length && pi >= pat.length) return true
  if (pi >= pat.length) return false

  const p = pat[pi]

  if (p === '*') {
    for (let skip = ti; skip <= text.length; skip++) {
      if (text[skip] === '/') break
      if (matchSimpleGlob(text, pat, skip, pi + 1)) return true
    }
    return false
  }

  if (p === '?') {
    if (ti >= text.length || text[ti] === '/') return false
    return matchSimpleGlob(text, pat, ti + 1, pi + 1)
  }

  if (ti >= text.length || text[ti] !== p) return false
  return matchSimpleGlob(text, pat, ti + 1, pi + 1)
}

/**
 * Resolve the effective file permissions for a path by applying rules in order.
 * Rules are evaluated in array order — later rules override earlier ones.
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
      const full = join(dir, entry.path)
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
 * Expand glob-based file rules against actual files on disk, producing
 * a concrete per-path permissions map. This is what lets Landlock/Seatbelt
 * enforce a rule like `{pattern: "secrets/**", read: false}` — a per-tool-call
 * JS check alone cannot, because `run_command` doesn't name a path.
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
 * Build a PermissionsConfig (the shape vajra-core expects) from a SandboxConfig.
 */
export function resolveFilePermissions(config: SandboxConfig): PermissionsConfig {
  return {
    version: 1,
    default: { ...config.defaultPermissions },
    files: expandFileRules(config.projectDir, config.fileRules, config.defaultPermissions),
  }
}

/**
 * Filter project file entries to only those the sandbox allows (read = true).
 */
export function filterFileEntries(
  entries: ProjectFileEntry[],
  config: SandboxConfig,
): ProjectFileEntry[] {
  return entries.filter((entry) => {
    if (entry.isDir) return true
    const perm = resolveFilePermission(config, entry.path)
    return perm.read
  })
}

// ---------------------------------------------------------------------------
// Per-tool-call permission checking (shared between CLI and worker)
// ---------------------------------------------------------------------------

const WRITE_TOOLS = new Set([
  'write_file', 'edit_file', 'delete_file', 'delete_dir',
  'create_dir', 'copy_file', 'rename_file',
])

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
      return []
  }
}

/**
 * Check whether a single tool call is allowed by the file rules.
 * Returns null if permitted, or an error message string if denied.
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
