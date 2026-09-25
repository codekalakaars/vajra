import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readdirSync, statSync } from 'node:fs'
import type { LaunchHandle } from '../agent/developer.js'
import type { PermissionsConfig } from '@codekalakaars/vajra-protocol'
import {
  readFile,
  writeFile,
  editFile,
  listFiles,
  deleteFile,
  createDir,
  runCommandAsyncTimeout,
  isMaskedName,
  loadPermissions,
  permissionsFor,
  loadEnvFile,
  redact,
  type EnvVar,
} from '../native.js'
import { buildSummaryIndex, searchSummary, shouldSkipFile, type SummaryEntry } from '../agent/summary.js'
import { scanProject } from '../native.js'
import { normalizeProjectPath, type TaskFilePermissions } from '../tasks/permissions.js'

export interface ToolCache {
  read: Map<string, { mtimeMs: number; value: string }>
  generation: number
}

export interface ToolHandleOptions {
  /** When provided, every file tool is gated on this map/callback. */
  permissions?: (path: string) => TaskFilePermissions
  /** Called after a successful mutating tool (write/edit/delete/create). */
  onMutate?: () => void
  cache?: ToolCache
}

const MASKED_STUB = '[REDACTED: masked file — contents withheld]'

/** Skip files larger than this when searching content — keeps a runaway
 *  regex or a giant generated file from stalling the tool call. */
const MAX_SEARCH_FILE_BYTES = 1_000_000

/** Longest single line returned by search_content, before truncation. */
const MAX_SEARCH_LINE = 300

const DEFAULT_SEARCH_MAX = 50
const CAP_SEARCH_MAX = 200

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const ALLOWED_COMMANDS = new Set([
  'npm', 'npx', 'node', 'yarn', 'pnpm',
  'git', 'python', 'python3', 'pip', 'pip3',
  'cargo', 'rustc', 'go', 'make', 'cmake',
  'tsc', 'eslint', 'prettier', 'jest', 'mocha', 'vitest',
  'curl', 'wget', 'cat', 'ls', 'find', 'grep',
  'mkdir', 'cp', 'mv', 'rm', 'touch', 'chmod',
  'docker', 'docker-compose',
])

type TokenizeResult =
  | { ok: true; argv: string[] }
  | { ok: false; error: string }

/** Quote-aware argv tokenizer that rejects shell metacharacters (B3). */
export function tokenizeCommand(command: string): TokenizeResult {
  const trimmed = command.trim()
  if (!trimmed) {
    return { ok: false, error: 'Empty command' }
  }

  let inSingle = false
  let inDouble = false
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i]
    if (c === "'" && !inDouble) {
      inSingle = !inSingle
    } else if (c === '"' && !inSingle) {
      inDouble = !inDouble
    } else if (!inSingle && !inDouble) {
      if ('`$;|>&<()'.includes(c)) {
        return {
          ok: false,
          error:
            `Shell metacharacter '${c}' is not allowed in run_command. ` +
            'Issue separate run_command calls instead of chaining with &&, |, ;, >, <, ` or $( ).',
        }
      }
    }
  }

  const argv: string[] = []
  let cur = ''
  let started = false
  inSingle = false
  inDouble = false
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i]
    if (c === "'" && !inDouble) {
      inSingle = !inSingle
      started = true
      continue
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble
      started = true
      continue
    }
    if (!inSingle && !inDouble && /\s/.test(c)) {
      if (started || cur.length > 0) {
        argv.push(cur)
        cur = ''
        started = false
      }
      continue
    }
    cur += c
    started = true
  }
  if (inSingle || inDouble) {
    return { ok: false, error: 'Unclosed quote in command' }
  }
  if (started || cur.length > 0) {
    argv.push(cur)
  }
  if (argv.length === 0) {
    return { ok: false, error: 'Empty command' }
  }
  return { ok: true, argv }
}

function loadProjectSecrets(projectDir: string): EnvVar[] {
  const secrets: EnvVar[] = []
  try {
    const names = readdirSync(projectDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && isMaskedName(entry.name))
      .map(entry => entry.name)
      .sort()

    for (const name of names) {
      try {
        const loaded = loadEnvFile(join(projectDir, name))
        if (Array.isArray(loaded)) secrets.push(...loaded)
      } catch {
        // unreadable env file is skipped
      }
    }
  } catch {
    // missing project dir is handled by callers
  }
  return secrets
}

function c1(
  exitCode: number,
  signal: string | null,
  stdout: string,
  stderr: string,
): string {
  return JSON.stringify({ exitCode, signal, stdout, stderr })
}

function resolveCwd(projectDir: string, raw: unknown): { ok: true; cwd: string } | { ok: false; error: string } {
  const cwd = raw === undefined || raw === null || raw === ''
    ? projectDir
    : resolve(projectDir, String(raw))
  const rel = relative(projectDir, cwd)
  if (rel.startsWith('..') || (isAbsolute(rel) && rel !== projectDir && cwd !== projectDir)) {
    return { ok: false, error: `cwd '${String(raw)}' escapes the project directory` }
  }
  if (!cwd.startsWith(projectDir + sep) && cwd !== projectDir) {
    return { ok: false, error: `cwd '${String(raw)}' escapes the project directory` }
  }
  return { ok: true, cwd }
}

export function createToolHandle(
  projectDir: string,
  options: ToolHandleOptions = {},
): LaunchHandle {
  const secrets = loadProjectSecrets(projectDir)
  const projectPermissions: PermissionsConfig | null = loadPermissions(projectDir)
  let summaryCache: SummaryEntry[] | null = null

  /** 6E file-read cache — scoped to this handle (= one session/task), keyed by
  *  absolute path + mtime. The stored value is exactly what read_file
   *  returned, i.e. already redacted; a masked file's contents can never enter
   *  it because masked files return the stub before any cache interaction. */
  const sharedCache = options.cache
  const readCache = sharedCache?.read ?? new Map<string, { mtimeMs: number; value: string }>()
  let cacheGeneration = sharedCache?.generation ?? 0
  const READ_CACHE_MAX = 512

  const syncCacheGeneration = (): void => {
    if (!sharedCache || sharedCache.generation === cacheGeneration) return
    cacheGeneration = sharedCache.generation
    readCache.clear()
    summaryCache = null
  }

  const invalidateAllReads = (): void => {
    readCache.clear()
    summaryCache = null
    if (sharedCache) {
      sharedCache.generation++
      cacheGeneration = sharedCache.generation
    }
  }
  const invalidateRead = (_path: string): void => {
    invalidateAllReads()
  }

  const rememberRead = (path: string, mtimeMs: number, value: string): void => {
    const key = resolve(path)
    readCache.delete(key) // refresh insertion order for FIFO eviction
    if (readCache.size >= READ_CACHE_MAX) {
      const oldest = readCache.keys().next().value
      if (oldest !== undefined) readCache.delete(oldest)
    }
    readCache.set(key, { mtimeMs, value })
  }

  /** Read through the cache. mtime is taken BEFORE the read, so a write racing
   *  the read leaves a mismatched entry (re-read next time) rather than
   *  serving stale content with a fresh stamp. */
  const readThrough = (path: string): string => {
    const key = resolve(path)
    let mtimeMs: number | undefined
    try {
      mtimeMs = statSync(key).mtimeMs
    } catch {
      // Missing or unstatable: drop any entry and let readFile throw (or
      // return) exactly as it did before the cache existed.
      readCache.delete(key)
    }
    if (mtimeMs !== undefined) {
      const hit = readCache.get(key)
      if (hit && hit.mtimeMs === mtimeMs) return hit.value
    }
    const value = redact(readFile(path), secrets)
    if (mtimeMs !== undefined) rememberRead(path, mtimeMs, value)
    return value
  }

  const gate = (path: string, op: keyof TaskFilePermissions): void => {
    if (options.permissions) {
      const perm = options.permissions(path)
      if (!perm[op]) {
        throw new Error(`Access denied: ${path}`)
      }
      return
    }
    if (op === 'read' && projectPermissions) {
      const perm = permissionsFor(projectPermissions, path)
      if (!perm.read) {
        throw new Error(`Access denied: ${path}`)
      }
    }
  }

  /** Shared execution path for run_command and run_baseline: no shell, the
   *  same allow-list, cwd containment, timeout, and redacted C1 result. */
  const execArgv = async (
    cmdName: string,
    cmdArgs: string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<string> => {
    try {
      const result = await runCommandAsyncTimeout(cmdName, cmdArgs, cwd, timeoutMs)
      if (result.code === 124 && result.stderr === 'Command timed out') {
        return c1(124, null, redact(result.stdout, secrets), 'Command timed out')
      }

      // code === -1 means killed by signal (native reports signal as -1)
      const exitCode = result.code
      const signal = exitCode === -1 ? 'SIGTERM' : null
      return c1(exitCode, signal, redact(result.stdout, secrets), redact(result.stderr, secrets))
    } catch (e) {
      return c1(-1, null, '', e instanceof Error ? e.message : String(e))
    }
  }

  /** argv-form dispatch shared by run_command and run_baseline. */
  const runArgv = async (argv: string[], rawCwd: unknown, timeoutMs: number): Promise<string> => {
    const [cmdName, ...cmdArgs] = argv
    const bare = cmdName.split('/').pop() ?? ''
    if (!ALLOWED_COMMANDS.has(bare)) {
      return c1(-1, null, '', `Command '${bare}' is not allowed. Allowed: ${[...ALLOWED_COMMANDS].join(', ')}`)
    }

    const cwdResult = resolveCwd(projectDir, rawCwd)
    if (!cwdResult.ok) {
      return c1(-1, null, '', cwdResult.error)
    }

    return execArgv(cmdName, cmdArgs, cwdResult.cwd, timeoutMs)
  }

  return {
    callTool: async (tool: string, args: unknown) => {
      syncCacheGeneration()
      const a = args as Record<string, unknown>
      switch (tool) {
        case 'read_file': {
          const path = a.path as string
          const name = basename(path)
          if (isMaskedName(name)) {
            // 6E: masked files never touch the cache — the only value this
            // tool ever returns for them is the derived stub, and file
            // contents must be unreachable through the cache even in principle.
            return MASKED_STUB
          }
          gate(path, 'read')
          return readThrough(path)
        }
        case 'write_file': {
          const path = a.path as string
          if (isMaskedName(basename(path))) {
            throw new Error(`Access denied: ${path} is a masked file`)
          }
          gate(path, 'write')
          writeFile(path, a.content as string)
          invalidateRead(path)
          options.onMutate?.()
          return 'ok'
        }
        case 'edit_file': {
          const path = a.path as string
          if (isMaskedName(basename(path))) {
            throw new Error(`Access denied: ${path} is a masked file`)
          }
          gate(path, 'edit')
          editFile(path, a.oldString as string, a.newString as string, a.replaceAll as boolean | undefined)
          invalidateRead(path)
          options.onMutate?.()
          return 'ok'
        }
        case 'delete_file': {
          const path = a.path as string
          if (isMaskedName(basename(path))) {
            throw new Error(`Access denied: ${path} is a masked file`)
          }
          gate(path, 'delete')
          deleteFile(path)
          invalidateRead(path)
          options.onMutate?.()
          return 'ok'
        }
        case 'create_dir': {
          const path = a.path as string
          gate(path, 'write')
          createDir(path)
          invalidateRead(path)
          options.onMutate?.()
          return 'ok'
        }
        case 'list_files':
          return JSON.stringify(listFiles(a.path as string, a.recursive as boolean | undefined))
        case 'search_files': {
          if (!summaryCache) {
            try {
              // Redact at cache-build time: previews are file content, and a
              // secret copied into a source comment must not surface here
              // either (same contract as search_content).
              summaryCache = buildSummaryIndex(projectDir, scanProject(projectDir)).map((entry) => ({
                ...entry,
                preview: redact(entry.preview, secrets),
                symbols: entry.symbols.map((s) => redact(s, secrets)),
              }))
            } catch {
              summaryCache = []
            }
          }
          return searchSummary(summaryCache, String(a.query ?? ''))
        }
        case 'search_content': {
          const query = String(a.query ?? '')
          if (!query) {
            return 'Error: search_content requires a non-empty query.'
          }
          const maxResults =
            typeof a.maxResults === 'number' && Number.isFinite(a.maxResults) && a.maxResults > 0
              ? Math.min(Math.floor(a.maxResults), CAP_SEARCH_MAX)
              : DEFAULT_SEARCH_MAX

          let matcher: RegExp
          if (a.isRegex === true) {
            try {
              matcher = new RegExp(query, 'g')
            } catch (e) {
              return `Error: invalid regular expression: ${e instanceof Error ? e.message : String(e)}`
            }
          } else {
            matcher = new RegExp(escapeRegExp(query), 'g')
          }

          let entries
          try {
            entries = scanProject(projectDir)
          } catch (e) {
            return `Error: ${e instanceof Error ? e.message : String(e)}`
          }

          const matches: string[] = []
          for (const entry of entries) {
            if (matches.length >= maxResults) break
            if (entry.isDir) continue
            // Masked files are never opened — their contents must be
            // unreachable through this tool (P3). Check both the native flag
            // and the name rule so neither side's drift can leak a file.
            if (entry.isMasked || isMaskedName(entry.name)) continue
            // Honour SKIP_DIRS: dist/, node_modules/, target/, … never appear.
            if (shouldSkipFile(entry)) continue
            try {
              gate(entry.path, 'read')
            } catch {
              continue
            }
            const fullPath = join(projectDir, entry.path)
            try {
              if (statSync(fullPath).size > MAX_SEARCH_FILE_BYTES) continue
            } catch {
              continue
            }
            let content: string
            try {
              content = readFile(fullPath)
            } catch {
              continue
            }
            // Redact before matching, so every line this tool can ever return
            // has already passed through redact().
            content = redact(content, secrets)
            const lines = content.split('\n')
            for (let i = 0; i < lines.length; i++) {
              if (matches.length >= maxResults) break
              matcher.lastIndex = 0
              if (matcher.test(lines[i])) {
                const line = lines[i].replace(/\r$/, '')
                const shown =
                  line.length > MAX_SEARCH_LINE ? `${line.slice(0, MAX_SEARCH_LINE)}…` : line
                matches.push(`${entry.path}:${i + 1}: ${shown}`)
              }
            }
          }

          if (matches.length === 0) return 'No matches found.'
          const capped =
            matches.length >= maxResults ? `\n(capped at ${maxResults} results)` : ''
          return matches.join('\n') + capped
        }
        case 'run_command': {
          const command = String(a.command ?? '').trim()
          const internalArgv = Array.isArray(a.argv) ? a.argv.map(String) : null
          const tokenized = internalArgv
            ? ({ ok: true, argv: internalArgv } as const)
            : tokenizeCommand(command)
          if (!tokenized.ok) {
            return c1(-1, null, '', tokenized.error)
          }
          const timeoutMs = (typeof a.timeoutMs === 'number' && a.timeoutMs > 0) ? a.timeoutMs : 30000
          try {
            return await runArgv(tokenized.argv, a.cwd, timeoutMs)
          } finally {
            invalidateAllReads()
          }
        }
        case 'run_baseline': {
          const command = String(a.command ?? '').trim()
          const tokenized = tokenizeCommand(command)
          if (!tokenized.ok) {
            return c1(-1, null, '', tokenized.error)
          }
          const extraArgs = Array.isArray(a.args) ? a.args.map(String) : []
          const timeoutMs = (typeof a.timeoutMs === 'number' && a.timeoutMs > 0) ? a.timeoutMs : 120000
          try {
            return await runArgv([...tokenized.argv, ...extraArgs], a.cwd, timeoutMs)
          } finally {
            invalidateAllReads()
          }
        }
        default:
          return `Error: Unknown tool: ${tool}`
      }
    },
  }
}
