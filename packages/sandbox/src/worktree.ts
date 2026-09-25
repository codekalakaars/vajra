// Worktree manager for isolated task execution.
//
// Creates git worktrees per task so workers write to an isolated copy
// instead of the live project tree. On success, changes are merged back.
// On failure, the worktree is simply discarded.

import { execSync, exec } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

export interface WorktreeInfo {
  /** Unique ID for this worktree */
  id: string
  /** Absolute path to the worktree directory */
  worktreePath: string
  /** The original project directory */
  mainPath: string
  /** Whether this is a git worktree or a copy */
  isGitWorktree: boolean
}

export interface WorktreeResult {
  /** Files that were added or modified */
  changedFiles: string[]
  /** Whether the merge was successful */
  success: boolean
  /** Error message if merge failed */
  error?: string
}

/**
 * Check if a directory is a git repository.
 */
function isGitRepo(dir: string): boolean {
  try {
    execSync('git rev-parse --git-dir', { cwd: dir, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * Create a worktree for isolated task execution.
 *
 * Strategy:
 * - If the project is a git repo: use git worktree (copy-on-write, efficient)
 * - Otherwise: use a filesystem copy (slower but universal)
 *
 * @param projectDir The main project directory
 * @param taskId The task ID (used for worktree naming)
 * @returns WorktreeInfo with paths and metadata
 */
export function createWorktree(projectDir: string, taskId: string): WorktreeInfo {
  const id = `${taskId}-${randomUUID().slice(0, 8)}`

  if (isGitRepo(projectDir)) {
    return createGitWorktree(projectDir, id)
  } else {
    return createCopyWorktree(projectDir, id)
  }
}

/**
 * Create a git worktree for a task.
 */
function createGitWorktree(projectDir: string, id: string): WorktreeInfo {
  const worktreePath = join(projectDir, '.vajra-worktrees', id)

  // Ensure parent directory exists
  const parentDir = join(projectDir, '.vajra-worktrees')
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true })
  }

  // Create worktree from current HEAD
  try {
    execSync(`git worktree add "${worktreePath}" HEAD`, {
      cwd: projectDir,
      stdio: 'pipe',
    })
  } catch (e) {
    // If worktree creation fails, fall back to copy
    return createCopyWorktree(projectDir, id)
  }

  return {
    id,
    worktreePath,
    mainPath: projectDir,
    isGitWorktree: true,
  }
}

/**
 * Create a filesystem copy for a task.
 */
function createCopyWorktree(projectDir: string, id: string): WorktreeInfo {
  const worktreePath = join(projectDir, '.vajra-worktrees', id)

  // Ensure parent directory exists
  const parentDir = join(projectDir, '.vajra-worktrees')
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true })
  }

  // Copy project directory, excluding .git, node_modules, etc.
  cpSync(projectDir, worktreePath, {
    recursive: true,
    filter: (src) => {
      const relativePath = relative(projectDir, src)
      // Skip common large directories
      if (relativePath === '.git' || relativePath.startsWith('.git/')) return false
      if (relativePath === 'node_modules' || relativePath.startsWith('node_modules/')) return false
      if (relativePath === '.vajra-worktrees' || relativePath.startsWith('.vajra-worktrees/')) return false
      if (relativePath === 'dist' || relativePath.startsWith('dist/')) return false
      if (relativePath === 'build' || relativePath.startsWith('build/')) return false
      return true
    },
  })

  return {
    id,
    worktreePath,
    mainPath: projectDir,
    isGitWorktree: false,
  }
}

/**
 * Merge worktree changes back to the main project directory.
 *
 * For git worktrees: uses git diff + apply to transfer changes.
 * For copy worktrees: copies changed files back.
 *
 * @param worktree The worktree info
 * @param changedFiles List of files that were modified (project-relative paths)
 * @returns WorktreeResult with merge status
 */
export function mergeWorktree(worktree: WorktreeInfo, changedFiles: string[]): WorktreeResult {
  if (!existsSync(worktree.worktreePath)) {
    return {
      changedFiles: [],
      success: false,
      error: `Worktree directory does not exist: ${worktree.worktreePath}`,
    }
  }

  try {
    if (worktree.isGitWorktree) {
      return mergeGitWorktree(worktree, changedFiles)
    } else {
      return mergeCopyWorktree(worktree, changedFiles)
    }
  } catch (e) {
    return {
      changedFiles: [],
      success: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * Merge git worktree changes back to the main directory.
 */
function mergeGitWorktree(worktree: WorktreeInfo, changedFiles: string[]): WorktreeResult {
  const result: WorktreeResult = { changedFiles: [], success: true }

  // Copy each changed file from worktree to main
  for (const file of changedFiles) {
    const srcPath = join(worktree.worktreePath, file)
    const dstPath = join(worktree.mainPath, file)

    if (existsSync(srcPath)) {
      cpSync(srcPath, dstPath, { recursive: true })
      result.changedFiles.push(file)
    }
  }

  return result
}

/**
 * Merge copy worktree changes back to the main directory.
 */
function mergeCopyWorktree(worktree: WorktreeInfo, changedFiles: string[]): WorktreeResult {
  const result: WorktreeResult = { changedFiles: [], success: true }

  // Copy each changed file from worktree to main
  for (const file of changedFiles) {
    const srcPath = join(worktree.worktreePath, file)
    const dstPath = join(worktree.mainPath, file)

    if (existsSync(srcPath)) {
      cpSync(srcPath, dstPath, { recursive: true })
      result.changedFiles.push(file)
    }
  }

  return result
}

/**
 * Discard a worktree without merging.
 *
 * This is the "rollback" for worktree isolation — instead of restoring
 * individual files, we just delete the entire worktree directory.
 */
export function discardWorktree(worktree: WorktreeInfo): void {
  try {
    if (worktree.isGitWorktree) {
      // Remove git worktree
      execSync(`git worktree remove "${worktree.worktreePath}" --force`, {
        cwd: worktree.mainPath,
        stdio: 'pipe',
      })
    } else {
      // Remove copy
      rmSync(worktree.worktreePath, { recursive: true, force: true })
    }
  } catch {
    // Best effort — worktree might already be removed
  }
}

/**
 * Get the list of files that were modified in a worktree.
 *
 * For git worktrees, uses `git diff --name-only`.
 * For copy worktrees, compares file modification times.
 */
export function getChangedFiles(worktree: WorktreeInfo): string[] {
  try {
    if (worktree.isGitWorktree) {
      return getGitWorktreeChanges(worktree)
    } else {
      return getCopyWorktreeChanges(worktree)
    }
  } catch {
    return []
  }
}

/**
 * Get changed files from a git worktree.
 */
function getGitWorktreeChanges(worktree: WorktreeInfo): string[] {
  try {
    const output = execSync('git diff --name-only HEAD', {
      cwd: worktree.worktreePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    return output.trim().split('\n').filter(f => f.length > 0)
  } catch {
    return []
  }
}

/**
 * Get changed files from a copy worktree by comparing mtimes.
 */
function getCopyWorktreeChanges(worktree: WorktreeInfo): string[] {
  const changed: string[] = []

  function walk(dir: string, relative: string) {
    let entries
    try {
      entries = require('node:fs').readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue

      const path = relative ? `${relative}/${entry.name}` : entry.name
      const srcPath = join(worktree.worktreePath, path)
      const dstPath = join(worktree.mainPath, path)

      if (entry.isDirectory()) {
        walk(join(dir, entry.name), path)
      } else if (entry.isFile()) {
        // Check if file exists in main and compare content
        try {
          const srcContent = readFileSync(srcPath)
          const dstContent = readFileSync(dstPath)
          if (!srcContent.equals(dstContent)) {
            changed.push(path)
          }
        } catch {
          // File doesn't exist in main or worktree — it's new or deleted
          changed.push(path)
        }
      }
    }
  }

  walk(worktree.worktreePath, '')
  return changed
}

/**
 * Clean up all worktrees for a project.
 * Called when the project is stopped or cleaned up.
 */
export function cleanupWorktrees(projectDir: string): void {
  const worktreeDir = join(projectDir, '.vajra-worktrees')
  if (existsSync(worktreeDir)) {
    rmSync(worktreeDir, { recursive: true, force: true })
  }
}
