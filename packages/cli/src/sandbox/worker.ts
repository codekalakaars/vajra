// Sandboxed tool-execution worker for the CLI (Group Q).
//
// Forked by launch.ts. Applies the native sandbox (applySandbox) before
// touching any project data, reports the result over IPC, then serves
// {callId, tool, args} → {callId, ok, result|error} dispatch.
//
// Never sees the API key or conversation — only individual tool invocations.

import { createRequire } from 'node:module'
import { checkToolPermission, type LaunchJob } from '@codekalakaars/vajra-sandbox'
import { createToolHandle } from '../tools/handle.js'

type FilePermissions = LaunchJob['defaultFilePermissions']

const require = createRequire(import.meta.url)
const native = require('@codekalakaars/vajra-core')

const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'create_dir'])

function send(message: unknown): void {
  if (typeof process.send === 'function') process.send(message)
}

/** Always-on permission check: empty fileRules still enforce defaults (L1). */
function checkAlwaysOn(
  tool: string,
  args: Record<string, unknown>,
  fileRules: readonly unknown[],
  defaultPermissions: FilePermissions,
  projectDir: string,
): string | null {
  if (fileRules && fileRules.length > 0) {
    return checkToolPermission(
      tool,
      args,
      fileRules as Parameters<typeof checkToolPermission>[2],
      defaultPermissions,
      projectDir,
    )
  }

  // No rules: still apply defaultFilePermissions to path-bearing tools so a
  // write:false default is not silently ignored.
  const path = typeof args.path === 'string' ? args.path : undefined
  if (!path) return null

  const relative = path.startsWith(projectDir)
    ? path.slice(projectDir.length + 1)
    : path

  if (tool === 'write_file' || tool === 'edit_file') {
    if (!defaultPermissions.write && !defaultPermissions.edit) {
      return `Access denied: write not allowed for '${relative}'`
    }
  } else if (tool === 'delete_file') {
    if (!defaultPermissions.delete) {
      return `Access denied: delete not allowed for '${relative}'`
    }
  } else if (tool === 'read_file' || tool === 'list_files' || tool === 'search_files') {
    if (!defaultPermissions.read) {
      return `Access denied: read not allowed for '${relative}'`
    }
  }
  return null
}

function main(job: LaunchJob): void {
  process.env.VAJRA_PROJECT_DIR = job.projectDir

  const capabilities = native.sandboxCapabilities()
  if (capabilities.filesystem === 'unsupported' && !job.allowUnenforced) {
    send({
      type: 'refused',
      message: `Refusing to continue unconfined: ${capabilities.details}`,
    })
    process.exit(1)
    return
  }

  let result: { enforced: boolean; mechanism: string; warnings: string[] }
  try {
    result = native.applySandbox({
      projectDir: job.projectDir,
      permissions: job.permissions,
      allowUnenforced: job.allowUnenforced,
      readExecutePaths: [...job.readExecutePaths],
      readWritePaths: [...job.readWritePaths],
    })
  } catch (e) {
    send({ type: 'refused', message: e instanceof Error ? e.message : String(e) })
    process.exit(1)
    return
  }

  // Report before any tool can run so the parent knows confinement status first.
  send({
    type: 'sandbox-report',
    report: {
      enforced: result.enforced,
      mechanism: result.mechanism,
      warnings: result.warnings,
    },
  })

  // In-process handle provides B-group behaviour (redaction, tokenizer, C1).
  // App-level task permissions are enforced by the parent before forwarding.
  const handle = createToolHandle(job.projectDir)
  const allowedTools = job.allowedTools ?? null

  process.on('message', (message: { type?: string; callId?: string; tool?: string; args?: unknown }) => {
    if (!message || message.type !== 'call') return
    const { callId, tool, args } = message
    if (!callId || !tool) return

    void (async () => {
      try {
        if (allowedTools !== null && !allowedTools.includes(tool)) {
          send({ type: 'result', callId, ok: false, error: `Tool '${tool}' is not permitted for this worker` })
          return
        }

        const parsedArgs = (args ?? {}) as Record<string, unknown>
        const denied = checkAlwaysOn(
          tool,
          parsedArgs,
          job.fileRules,
          job.defaultFilePermissions,
          job.projectDir,
        )
        if (denied) {
          send({ type: 'result', callId, ok: false, error: denied })
          return
        }

        const resultValue = await handle.callTool(tool, parsedArgs)
        send({
          type: 'result',
          callId,
          ok: true,
          result: resultValue,
          mutated: MUTATING_TOOLS.has(tool),
        })
      } catch (e) {
        send({
          type: 'result',
          callId,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    })()
  })
}

process.once('message', (message: { type?: string; job?: LaunchJob }) => {
  if (message && message.type === 'job' && message.job) {
    main(message.job)
  }
})
