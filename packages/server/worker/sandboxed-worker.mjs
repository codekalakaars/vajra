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
}

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
    send({ type: 'result', callId, ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}

function main(job) {
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
