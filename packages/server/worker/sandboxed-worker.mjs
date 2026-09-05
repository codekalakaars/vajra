// The only file in this package that calls applySandbox.
//
// Runs as a forked child (child_process.fork), which gives it its own IPC
// message channel with the parent for free — no special fd plumbing needed,
// unlike an earlier PTY-based design this one replaced.
//
// On startup it re-derives sandboxCapabilities() itself — never trusts a
// value the parent might have passed across the process boundary, since
// this is the process about to confine itself and has to make that call
// with its own, current view of the platform. It applies the sandbox for
// exactly the one project it was given, reports the result back over IPC,
// and only then becomes a pure dispatch loop: {callId, tool, args} in,
// {callId, ok, result|error} out.
//
// It never sees the OpenRouter API key, the system prompt, or the
// conversation — only individual tool invocations the parent forwards to it
// one at a time. The parent process must never call applySandbox itself;
// see src/session/launcher.ts and the security invariant checklist in the
// project plan.

import { createRequire } from 'node:module'
import { toolDefinitions } from '@vajra/protocol'

const require = createRequire(import.meta.url)
const native = require('vajra-native')

// ---------------------------------------------------------------------------
// Glob matching (inline — worker cannot import @vajra/sandbox ESM cleanly)
// ---------------------------------------------------------------------------

function matchSimpleGlob(text, pat, ti, pi) {
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

function matchSegments(path, pattern, pi, si) {
  if (si >= pattern.length) return pi >= path.length
  const seg = pattern[si]
  if (seg === '**') {
    for (let skip = pi; skip <= path.length; skip++) {
      if (matchSegments(path, pattern, skip, si + 1)) return true
    }
    return false
  }
  if (pi >= path.length) return false
  if (!matchSimpleGlob(path[pi], seg, 0, 0)) return false
  return matchSegments(path, pattern, pi + 1, si + 1)
}

function matchesPattern(filePath, pattern) {
  let pat = pattern
  let negated = false
  if (pat.startsWith('!')) {
    negated = true
    pat = pat.slice(1)
  }
  const result = matchSegments(filePath.split('/'), pat.split('/'), 0, 0)
  return negated ? !result : result
}

// ---------------------------------------------------------------------------
// File permission check
// ---------------------------------------------------------------------------

function resolveFilePermission(filePath, fileRules, defaultPermissions) {
  const result = { ...defaultPermissions }
  for (const rule of fileRules) {
    if (matchesPattern(filePath, rule.pattern)) {
      if (rule.read !== undefined) result.read = rule.read
      if (rule.write !== undefined) result.write = rule.write
      if (rule.edit !== undefined) result.edit = rule.edit
      if (rule.delete !== undefined) result.delete = rule.delete
    }
  }
  return result
}

// Extract the file path(s) a tool call targets
function extractPaths(tool, args) {
  switch (tool) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'delete_file':
    case 'delete_dir':
    case 'create_dir':
    case 'list_files':
      return [args.path]
    case 'copy_file':
    case 'rename_file':
      return [args.source, args.destination]
    default:
      return [] // run_command has no file path
  }
}

// Tools that modify state (write/edit/delete/create/copy/rename)
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'delete_dir', 'create_dir', 'copy_file', 'rename_file'])

function checkFilePermission(tool, args, fileRules, defaultPermissions) {
  const paths = extractPaths(tool, args)
  for (const filePath of paths) {
    const perm = resolveFilePermission(filePath, fileRules, defaultPermissions)
    if (!perm.read) {
      return `Access denied: '${filePath}' is not readable in the current sandbox configuration.`
    }
    if (WRITE_TOOLS.has(tool) && !perm.write) {
      return `Access denied: '${filePath}' is not writable in the current sandbox configuration.`
    }
    if (tool === 'edit_file' && !perm.edit) {
      return `Access denied: '${filePath}' is not editable in the current sandbox configuration.`
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

const dispatchTable = {
  read_file: (args) => native.readFile(args.path),
  list_files: (args) => native.listFiles(args.path, args.recursive),
  search_files: (args) => native.searchSummary(args.query),
  write_file: (args) => native.writeFile(args.path, args.content),
  edit_file: (args) => native.editFile(args.path, args.oldString, args.newString, args.replaceAll),
  run_command: (args) => {
    const { execSync } = require('child_process')
    const cmd = args.command
    const cwd = args.cwd || process.env.VAJRA_PROJECT_DIR || process.cwd()
    const timeout = args.timeout || 30000
    try {
      const stdout = execSync(cmd, { cwd, timeout, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
      return stdout || '(command completed successfully)'
    } catch (e) {
      // execSync throws on non-zero exit — include stdout/stderr
      const stdout = e.stdout ? `\nstdout:\n${e.stdout}` : ''
      const stderr = e.stderr ? `\nstderr:\n${e.stderr}` : ''
      throw new Error(`Command failed (exit ${e.status}): ${e.message}${stdout}${stderr}`)
    }
  },
}

// Set of tools this worker is allowed to call. Populated from the job.
let allowedTools = null
// File rules from the sandbox config
let fileRules = []
let defaultFilePermissions = { read: true, write: false, edit: false, delete: false }

function send(message) {
  if (process.send) process.send(message)
}

function handleToolCall(message) {
  const { callId, tool, args } = message
  const def = toolDefinitions[tool]

  if (!def) {
    send({ type: 'result', callId, ok: false, error: `Unknown tool '${tool}'` })
    return
  }

  // Tool permission check: if allowedTools is set, only those tools are permitted
  if (allowedTools !== null && !allowedTools.includes(tool)) {
    send({ type: 'result', callId, ok: false, error: `Tool '${tool}' is not permitted for this worker` })
    return
  }

  // Validated again here, not just wherever the call originated — this
  // process is the security boundary, so it cannot trust that whatever sent
  // this message upheld the tool's contract.
  let parsedArgs
  try {
    parsedArgs = def.schema.parse(args)
  } catch (e) {
    send({ type: 'result', callId, ok: false, error: `Invalid arguments for '${tool}': ${e.message}` })
    return
  }

  // File permission check via sandbox rules
  if (fileRules.length > 0) {
    const denied = checkFilePermission(tool, parsedArgs, fileRules, defaultFilePermissions)
    if (denied) {
      send({ type: 'result', callId, ok: false, error: denied })
      return
    }
  }

  try {
    const result = dispatchTable[tool](parsedArgs)
    send({ type: 'result', callId, ok: true, result })
  } catch (e) {
    // Forwarded verbatim: this is the same message vajra-native itself
    // produced (editFile's ambiguous-match refusal, deleteFile's directory
    // guard, etc.) — no rewording layer that could soften or hide a refusal.
    const msg = e instanceof Error ? e.message : String(e)
    // Enhance EACCES errors with a clearer message about permissions
    const enhanced = msg.includes('EACCES') || msg.includes('Permission denied')
      ? `${msg} — this file is not readable in the current permission configuration. Use search_files to find other files, or adjust permissions before starting a new session.`
      : msg
    send({ type: 'result', callId, ok: false, error: enhanced })
  }
}

function main(job) {
  // Store the project dir for run_command
  process.env.VAJRA_PROJECT_DIR = job.projectDir

  // Set up tool permissions if provided
  if (job.allowedTools) {
    allowedTools = Array.isArray(job.allowedTools) ? job.allowedTools : null
  }

  // Set up file rules if provided
  if (job.fileRules && Array.isArray(job.fileRules)) {
    fileRules = job.fileRules
  }
  if (job.defaultFilePermissions) {
    defaultFilePermissions = job.defaultFilePermissions
  }

  const capabilities = native.sandboxCapabilities()

  if (capabilities.filesystem === 'unsupported' && !job.allowUnenforced) {
    send({ type: 'refused', message: `Refusing to continue unconfined: ${capabilities.details}` })
    process.exit(1)
    return
  }

  let result
  try {
    result = native.applySandbox({
      projectDir: job.projectDir,
      permissions: job.permissions,
      allowUnenforced: job.allowUnenforced,
    })
  } catch (e) {
    send({ type: 'refused', message: e instanceof Error ? e.message : String(e) })
    process.exit(1)
    return
  }

  // Sent before anything else can happen — the parent must learn whether
  // this session is actually confined before it ever shows as running.
  send({
    type: 'sandbox-report',
    report: { enforced: result.enforced, mechanism: result.mechanism, warnings: result.warnings },
  })

  process.on('message', (message) => {
    if (message && message.type === 'call') handleToolCall(message)
  })
}

process.once('message', (message) => {
  if (message && message.type === 'job') {
    main(message.job)
  }
})
