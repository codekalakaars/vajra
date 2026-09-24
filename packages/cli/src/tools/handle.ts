import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readdirSync } from 'node:fs'
import type { LaunchHandle } from '../agent/developer.js'
import type { PermissionsConfig } from '@codekalakaars/vajra-protocol'
import {
  readFile,
  writeFile,
  editFile,
  listFiles,
  deleteFile,
  createDir,
  runCommandAsync,
  isMaskedName,
  loadPermissions,
  permissionsFor,
  loadEnvFile,
  redact,
  type EnvVar,
} from '../native.js'
import { buildSummaryIndex, searchSummary, type SummaryEntry } from '../agent/summary.js'
import { scanProject } from '../native.js'
import { normalizeProjectPath, type TaskFilePermissions } from '../tasks/permissions.js'

export interface ToolHandleOptions {
  /** When provided, every file tool is gated on this map/callback. */
  permissions?: (path: string) => TaskFilePermissions
  /** Called after a successful mutating tool (write/edit/delete/create). */
  onMutate?: () => void
}

const MASKED_STUB = '[REDACTED: masked file — contents withheld]'

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

  return {
    callTool: async (tool: string, args: unknown) => {
      const a = args as Record<string, unknown>
      switch (tool) {
        case 'read_file': {
          const path = a.path as string
          const name = basename(path)
          if (isMaskedName(name)) {
            return MASKED_STUB
          }
          gate(path, 'read')
          const content = readFile(path)
          return redact(content, secrets)
        }
        case 'write_file': {
          const path = a.path as string
          if (isMaskedName(basename(path))) {
            throw new Error(`Access denied: ${path} is a masked file`)
          }
          gate(path, 'write')
          writeFile(path, a.content as string)
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
          options.onMutate?.()
          return 'ok'
        }
        case 'create_dir': {
          const path = a.path as string
          gate(path, 'write')
          createDir(path)
          options.onMutate?.()
          return 'ok'
        }
        case 'list_files':
          return JSON.stringify(listFiles(a.path as string, a.recursive as boolean | undefined))
        case 'search_files': {
          if (!summaryCache) {
            try {
              summaryCache = buildSummaryIndex(projectDir, scanProject(projectDir))
            } catch {
              summaryCache = []
            }
          }
          return searchSummary(summaryCache, String(a.query ?? ''))
        }
        case 'run_command': {
          const command = String(a.command ?? '').trim()
          const tokenized = tokenizeCommand(command)
          if (!tokenized.ok) {
            return c1(-1, null, '', tokenized.error)
          }

          const [cmdName, ...cmdArgs] = tokenized.argv
          const bare = cmdName.split('/').pop() ?? ''
          if (!ALLOWED_COMMANDS.has(bare)) {
            return c1(-1, null, '', `Command '${bare}' is not allowed. Allowed: ${[...ALLOWED_COMMANDS].join(', ')}`)
          }

          const cwdResult = resolveCwd(projectDir, a.cwd)
          if (!cwdResult.ok) {
            return c1(-1, null, '', cwdResult.error)
          }

          const timeoutMs = (typeof a.timeoutMs === 'number' && a.timeoutMs > 0) ? a.timeoutMs : 30000

          let timedOut = false
          const timer = setTimeout(() => { timedOut = true }, timeoutMs)
          try {
            const result = await Promise.race([
              runCommandAsync(cmdName, cmdArgs, cwdResult.cwd),
              new Promise<never>((_, reject) => {
                const t = setTimeout(() => {
                  timedOut = true
                  reject(new Error('timeout'))
                }, timeoutMs)
                // cleared via outer timer race path
                void t
              }),
            ])
            if (timedOut) {
              return c1(124, null, redact(result.stdout, secrets), 'Command timed out')
            }
            // code === -1 means killed by signal (native reports signal as -1)
            const exitCode = result.code
            const signal = exitCode === -1 ? 'SIGTERM' : null
            return c1(exitCode, signal, redact(result.stdout, secrets), redact(result.stderr, secrets))
          } catch (e) {
            if (timedOut || (e instanceof Error && e.message === 'timeout')) {
              return c1(124, null, '', 'Command timed out')
            }
            return c1(-1, null, '', e instanceof Error ? e.message : String(e))
          } finally {
            clearTimeout(timer)
          }
        }
        default:
          return `Error: Unknown tool: ${tool}`
      }
    },
  }
}
