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

// Explicit positional-argument mapping per tool, rather than generically
// spreading a parsed object in declaration order — argument order matters
// (e.g. deleteDir's `recursive` is the second positional argument, not
// alphabetically first) and a generic spread would be one field-reorder away
// from silently calling the wrong native function incorrectly.
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
