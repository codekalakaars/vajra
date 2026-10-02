import { tokenizeCommand, type LaunchHandle } from '@codekalakaars/vajra-sandbox'
import type { FileLockManager } from '@codekalakaars/vajra-sandbox'

/**
 * Commands that cannot safely run twice at once on one project: two `npm`
 * installs corrupt `node_modules`, two `git` commands fight over the index. Each
 * gets a named resource lock, taken around the command and not around the task,
 * so tasks that merely *contain* such a command still overlap everywhere else.
 */
const COMMAND_RESOURCE_PATHS: Record<string, string> = {
  git: 'resource:git',
  npm: 'resource:node_modules',
  npx: 'resource:node_modules',
  pnpm: 'resource:node_modules',
  yarn: 'resource:node_modules',
  cargo: 'resource:cargo',
}

export function commandResourcePath(command: string, argv?: readonly string[]): string | null {
  let executable: string
  if (argv?.[0]) {
    executable = argv[0]
  } else {
    const tokenized = tokenizeCommand(command)
    if (!tokenized.ok) return null
    executable = tokenized.argv[0]
  }
  const name = (executable.split(/[\\/]/).pop() ?? '').toLowerCase()
  return COMMAND_RESOURCE_PATHS[name] ?? null
}

export function withCommandResourceLock(
  handle: LaunchHandle,
  locks: FileLockManager,
  owner: string,
): LaunchHandle {
  let nextLockId = 1
  return {
    callTool: async (tool, args) => {
      if (tool !== 'run_command' || (typeof args !== 'object' || args === null)) {
        return handle.callTool(tool, args)
      }
      const command = String((args as { command?: unknown }).command ?? '')
      const argv = Array.isArray((args as { argv?: unknown }).argv)
        ? (args as { argv: unknown[] }).argv.map(String)
        : undefined
      const path = commandResourcePath(command, argv)
      if (path === null) return handle.callTool(tool, args)

      const lockOwner = `${owner}:command-resource:${nextLockId++}`
      await locks.acquireOrWait([path], lockOwner, 'write')
      try {
        return await handle.callTool(tool, args)
      } finally {
        locks.releaseFiles([path], lockOwner)
      }
    },
  }
}
