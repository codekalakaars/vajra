import { TerminalStreamer } from '../streaming.js'
import type { LaunchHandle } from '../agent/developer.js'
import type { AgentRegistry } from '../agent/registry.js'
import type { TaskQueue } from '../agent/taskqueue.js'
import { streamChatCompletion, type OpenRouterMessage } from '../agent/openrouter.js'
import { getWorkerToolSpecs } from '../agent/tools.js'
import type { ChangeHistory, FileLockManager } from '@codekalakaars/vajra-sandbox'
import { needsServer, findServerEntry } from './server.js'

export interface ExecuteTaskInput {
  agentId: string
  task: {
    id: string
    title: string
    description: string | null
    instructions: string[]
    readFile: string[]
    writeFile: string[]
    deleteFile: string[]
    createDir: string[]
    validation: string[]
    timeoutSeconds: number
    /** C4: internal retry limit (from wire field `retries`). */
    maxRetries: number
    rollback: string[]
    skipIf: string[]
  }
  handle: LaunchHandle
  apiKey: string
  model: string
  streamer: TerminalStreamer
  changeHistory: ChangeHistory
  queue: TaskQueue
  registry: AgentRegistry
  sessionId: string
  fileLocks: FileLockManager
  projectDir: string
  signal?: AbortSignal
}

/**
 * Parse a C1 run_command result. Non-JSON or missing exitCode is failure —
 * never the old `exitCode = 0` fallback (C2t).
 */
export function parseCommandResult(output: string): {
  ok: boolean
  exitCode: number
  signal: string | null
  stdout: string
  stderr: string
} {
  try {
    const parsed = JSON.parse(output) as {
      exitCode?: number
      signal?: string | null
      stdout?: string
      stderr?: string
    }
    if (typeof parsed.exitCode !== 'number') {
      return { ok: false, exitCode: -1, signal: null, stdout: output, stderr: 'Malformed run_command result' }
    }
    const signal = parsed.signal ?? null
    const ok = parsed.exitCode === 0 && signal === null
    return {
      ok,
      exitCode: parsed.exitCode,
      signal,
      stdout: parsed.stdout ?? '',
      stderr: parsed.stderr ?? '',
    }
  } catch {
    // Bare string success from an older handle is still not trusted (C1).
    return {
      ok: false,
      exitCode: -1,
      signal: null,
      stdout: output,
      stderr: 'run_command did not return JSON {exitCode, signal, stdout, stderr}',
    }
  }
}

async function killProcessGroup(
  serverProcess: ReturnType<typeof import('node:child_process').spawn>,
): Promise<void> {
  // Consume piped stdout/stderr so the buffer cannot fill and stall the server.
  serverProcess.stdout?.resume()
  serverProcess.stderr?.resume()
  try {
    if (serverProcess.pid) {
      // Negative pid signals the process group (spawn used detached: true).
      process.kill(-serverProcess.pid, 'SIGTERM')
    }
  } catch {
    try {
      serverProcess.kill('SIGTERM')
    } catch {
      // already dead
    }
  }
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try {
        if (serverProcess.pid) process.kill(-serverProcess.pid, 'SIGKILL')
      } catch { /* ignore */ }
      resolve()
    }, 3000)
    serverProcess.once('close', () => {
      clearTimeout(t)
      resolve()
    })
  })
}

export async function executeTask(
  agentId: string,
  task: ExecuteTaskInput['task'],
  handle: LaunchHandle,
  apiKey: string,
  model: string,
  streamer: TerminalStreamer,
  changeHistory: ChangeHistory,
  queue: TaskQueue,
  registry: AgentRegistry,
  sessionId: string,
  fileLocks: FileLockManager,
  projectDir: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const MAX_WORKER_TOOL_CALLS = 100
  let toolCallCount = 0

  const instructionLines = task.instructions.map((inst, i) => `${i + 1}. ${inst}`).join('\n')
  const readFileList = task.readFile.length > 0 ? task.readFile.join(', ') : '(none)'
  const writeFileList = task.writeFile.length > 0 ? task.writeFile.join(', ') : '(none)'

  const systemPrompt = [
    'You are a worker agent. Follow the instructions EXACTLY. Do not deviate.',
    '',
    `TASK: ${task.title}`,
    task.description ? `WHY: ${task.description}` : '',
    '',
    'INSTRUCTIONS (follow in order):',
    instructionLines,
    '',
    `FILES TO READ: ${readFileList}`,
    `FILES TO WRITE: ${writeFileList}`,
    '',
    'RULES:',
    '- Execute each instruction step by step',
    '- Read each readFile first to understand the current code',
    '- Make precise edits using edit_file (not write_file for existing files)',
    '- Use write_file only for new files',
    '- Use run_command to execute shell commands (npm install, npm test, git, etc.)',
    '- After completing all instructions, respond with a brief summary',
  ].filter(Boolean).join('\n')

  const messages: OpenRouterMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'Execute the task now.' },
  ]

  const toolSpecs = getWorkerToolSpecs()

  try {
    while (toolCallCount < MAX_WORKER_TOOL_CALLS) {
      if (signal?.aborted) break

      const result = await streamChatCompletion(
        { apiKey, model, messages, tools: toolSpecs, signal },
        text => streamer.onTextDelta(text),
      )

      if (!result.message.tool_calls || result.message.tool_calls.length === 0) {
        streamer.finishLine()
        break
      }

      messages.push(result.message)

      for (const toolCall of result.message.tool_calls) {
        toolCallCount++
        if (toolCallCount > MAX_WORKER_TOOL_CALLS) break

        let resultContent: string
        try {
          const result = await handle.callTool(toolCall.function.name, JSON.parse(toolCall.function.arguments))
          resultContent = typeof result === 'string' ? result : JSON.stringify(result)
        } catch (e) {
          resultContent = `Error: ${e instanceof Error ? e.message : String(e)}`
        }

        messages.push({
          role: 'tool',
          content: resultContent,
          tool_call_id: toolCall.id,
        })
      }
    }

    if (task.validation.length > 0) {
      let serverProcess: ReturnType<typeof import('node:child_process').spawn> | null = null

      if (needsServer(task.validation)) {
        const serverEntry = await findServerEntry(projectDir)
        if (serverEntry) {
          const { spawn } = await import('node:child_process')
          serverProcess = spawn('node', [serverEntry], {
            cwd: projectDir,
            stdio: 'pipe',
            detached: true,
          })
          serverProcess.stdout?.resume()
          serverProcess.stderr?.resume()
          // Wait for server to start
          await new Promise(resolve => setTimeout(resolve, 2000))
        }
      }

      try {
        for (const cmd of task.validation) {
          try {
            // C5: task timeout is seconds; run_command timeoutMs is milliseconds.
            const result = await handle.callTool('run_command', {
              command: cmd,
              timeoutMs: task.timeoutSeconds * 1000,
            })
            const output = typeof result === 'string' ? result : JSON.stringify(result)
            const parsed = parseCommandResult(output)

            if (!parsed.ok) {
              streamer.warning(
                `Validation failed: ${cmd} (exit=${parsed.exitCode}${parsed.signal ? ` signal=${parsed.signal}` : ''})`,
              )
              return false
            }
          } catch {
            return false
          }
        }
      } finally {
        if (serverProcess) {
          await killProcessGroup(serverProcess)
        }
      }
    }

    return true
  } catch (e) {
    streamer.error(`Worker failed: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}
