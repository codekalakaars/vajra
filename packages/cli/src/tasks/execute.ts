import type { LaunchHandle } from '../agent/developer.js'
import type { AgentRegistry } from '../agent/registry.js'
import type { TaskQueue } from '../agent/taskqueue.js'
import { streamChatCompletion, type ChatMessage, type ToolCall } from '../agent/chat.js'
import { getWorkerToolSpecs } from '../agent/tools.js'
import type { ChangeHistory, FileLockManager } from '@codekalakaars/vajra-sandbox'
import type { AgentEvent, AgentLabel, SessionStreamer } from '../session/ui.js'
import { startHeartbeat, summarizeToolCall, summarizeToolResult } from '../session/ui.js'
import { allocateServerPort, findServerEntry, needsServer, probeServerPort, substituteServerPort } from './server.js'

/**
 * Tools that only observe. These may run concurrently within one assistant
 * message; anything that writes keeps the model's original order, because a
 * later mutation may depend on an earlier one.
 */
const READ_ONLY_TOOLS = new Set(['read_file', 'list_files', 'search_files', 'search_content'])

export interface ExecuteTaskInput {  agentId: string
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
  streamer: SessionStreamer
  changeHistory: ChangeHistory
  queue: TaskQueue
  registry: AgentRegistry
  sessionId: string
  fileLocks: FileLockManager
  projectDir: string
  signal?: AbortSignal
  /** Identifies this worker's row; falls back to the title alone. */
  onAgentEvent?: (event: AgentEvent) => void
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
  if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) return
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

function waitForServerStartup(
  serverProcess: ReturnType<typeof import('node:child_process').spawn>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const finish = (started: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      serverProcess.off('error', onError)
      serverProcess.off('exit', onExit)
      resolve(started)
    }
    const onError = () => finish(false)
    const onExit = () => finish(false)
    const timer = setTimeout(() => finish(true), timeoutMs)
    serverProcess.once('error', onError)
    serverProcess.once('exit', onExit)
  })
}

export async function executeTask(
  agentId: string,
  task: ExecuteTaskInput['task'],
  handle: LaunchHandle,
  apiKey: string,
  model: string,
  streamer: SessionStreamer,
  changeHistory: ChangeHistory,
  queue: TaskQueue,
  registry: AgentRegistry,
  sessionId: string,
  fileLocks: FileLockManager,
  projectDir: string,
  signal?: AbortSignal,
  onAgentEvent?: (event: AgentEvent) => void,
): Promise<boolean> {
  const MAX_WORKER_TOOL_CALLS = 100
  let toolCallCount = 0

  const agent: AgentLabel = { role: 'worker', taskId: task.id, title: task.title }
  const emit = (event: AgentEvent): void => onAgentEvent?.(event)

  const instructionLines = task.instructions.map((inst, i) => `${i + 1}. ${inst}`).join('\n')
  const readFileList = task.readFile.length > 0 ? task.readFile.join(', ') : '(none)'
  const writeFileList = task.writeFile.length > 0 ? task.writeFile.join(', ') : '(none)'
  const deleteFileList = task.deleteFile.length > 0 ? task.deleteFile.join(', ') : '(none)'
  const createDirList = task.createDir.length > 0 ? task.createDir.join(', ') : '(none)'

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
    `FILES TO DELETE: ${deleteFileList}`,
    `DIRS TO CREATE: ${createDirList}`,
    '',
    'RULES:',
    '- Execute each instruction step by step',
    '- Read each readFile first to understand the current code',
    '- Make precise edits using edit_file (not write_file for existing files)',
    '- Use write_file only for new files',
    '- Use delete_file only for files listed under FILES TO DELETE',
    '- Use create_dir only for directories listed under DIRS TO CREATE',
    '- Use run_command to execute shell commands (npm install, npm test, git, etc.)',
    '- After completing all instructions, respond with a brief summary',
  ].filter(Boolean).join('\n')

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'Execute the task now.' },
  ]

  const toolSpecs = getWorkerToolSpecs()

  try {
    emit({ type: 'phase', agent, phase: 'executing' })
    let providerRounds = 0

    while (toolCallCount < MAX_WORKER_TOOL_CALLS) {
      if (signal?.aborted) break

      providerRounds++
      const result = await streamChatCompletion(
        {
          apiKey,
          model,
          messages,
          tools: toolSpecs,
          signal,
          round: providerRounds,
          onEvent: event => emit({ ...event, agent }),
        },
        text => streamer.onTextDelta(text),
      )

      if (!result.message.tool_calls || result.message.tool_calls.length === 0) {
        streamer.finishLine()
        break
      }

      messages.push(result.message)

      /**
       * Run one tool call end to end: announce, execute, announce the result.
       * The caller decides whether calls like this one may overlap.
       */
      const runToolCall = async (toolCall: ToolCall): Promise<string> => {
        const callStarted = Date.now()
        const toolName = toolCall.function.name
        let args: unknown = undefined
        try {
          args = JSON.parse(toolCall.function.arguments)
        } catch {
          args = undefined
        }
        emit({
          type: 'tool-start',
          agent,
          callId: toolCall.id,
          tool: toolName,
          summary: summarizeToolCall(toolName, args, projectDir),
        })

        let resultContent: string
        let rawResult: unknown
        // A tool call can block for minutes; keep the row moving meanwhile.
        const stopHeartbeat = startHeartbeat(emit, agent)
        try {
          const result = await handle.callTool(toolName, args)
          resultContent = typeof result === 'string' ? result : JSON.stringify(result)
          rawResult = result
        } catch (e) {
          resultContent = `Error: ${e instanceof Error ? e.message : String(e)}`
          rawResult = resultContent
        } finally {
          stopHeartbeat()
        }

        const outcome = summarizeToolResult(toolName, args, rawResult, Date.now() - callStarted)
        emit({
          type: 'tool-end',
          agent,
          callId: toolCall.id,
          tool: toolName,
          ok: outcome.ok,
          ms: Date.now() - callStarted,
          detail: outcome.detail,
        })
        return resultContent
      }

      const toolCalls = result.message.tool_calls
      let index = 0
      while (index < toolCalls.length) {
        if (signal?.aborted) break

        // Models routinely return 3-5 independent reads in one message.
        // Overlapping them is the cheapest parallelism in the whole loop; only
        // read-only tools may overlap, because ordering matters for mutations.
        let end = index
        if (READ_ONLY_TOOLS.has(toolCalls[index].function.name)) {
          while (end < toolCalls.length && READ_ONLY_TOOLS.has(toolCalls[end].function.name)) {
            end++
          }
        } else {
          end = index + 1
        }

        const group = toolCalls.slice(index, end)
        // The budget is charged before running, so an exhausted loop still
        // answers every tool call rather than leaving the chain dangling.
        toolCallCount += group.length
        if (toolCallCount > MAX_WORKER_TOOL_CALLS) {
          for (const toolCall of group) {
            messages.push({
              role: 'tool',
              content: 'Error: Tool call budget exhausted.',
              tool_call_id: toolCall.id,
            })
          }
          break
        }

        if (group.length > 1) {
          // Results are appended in the model's original call order, whatever
          // order they finished in — the provider rejects a mismatch.
          const settled = await Promise.all(group.map(runToolCall))
          for (let k = 0; k < group.length; k++) {
            messages.push({ role: 'tool', content: settled[k], tool_call_id: group[k].id })
          }
        } else {
          const content = await runToolCall(group[0])
          messages.push({ role: 'tool', content, tool_call_id: group[0].id })
        }
        index = end
      }
    }

    if (task.validation.length > 0) {
      emit({ type: 'phase', agent, phase: 'validating' })
      let serverProcess: ReturnType<typeof import('node:child_process').spawn> | null = null
      let serverPort: number | null = null
      const serverEntry = needsServer(task.validation)
        ? await findServerEntry(projectDir)
        : null
      const serverLockPath = '<resource:validation-server>'
      const serverLockOwner = `validation-server:${agent.taskId ?? agentId}`
      if (serverEntry && fileLocks) {
        await fileLocks.acquireOrWait([serverLockPath], serverLockOwner, 'write')
      }

      try {
        if (serverEntry) {
          const { spawn } = await import('node:child_process')
          for (let attempt = 0; attempt < 3; attempt++) {
            serverPort = await allocateServerPort()
            let serverError = ''
            const candidate = spawn('node', [serverEntry], {
              cwd: projectDir,
              stdio: 'pipe',
              detached: true,
              env: { ...process.env, PORT: String(serverPort) },
            })
            candidate.on('error', () => {})
            candidate.stdout?.resume()
            candidate.stderr?.on('data', chunk => {
              serverError += String(chunk)
            })
            const started = await waitForServerStartup(candidate, 2000)
            if (started && await probeServerPort(serverPort!)) {
              serverProcess = candidate
              break
            }
            await killProcessGroup(candidate)
            await new Promise(resolve => setTimeout(resolve, 25))
            if ((!started && !serverError.includes('EADDRINUSE')) || attempt === 2) break
          }
          if (!serverProcess) return false
        }

        for (const cmd of task.validation) {
          const validationStarted = Date.now()
          const validationCommand = serverPort === null ? cmd : substituteServerPort(cmd, serverPort)
          const validationArgs = {
            command: validationCommand,
            timeoutMs: task.timeoutSeconds * 1000,
          }
          emit({
            type: 'tool-start',
            agent,
            callId: `validate-${cmd}`,
            tool: 'run_command',
            summary: summarizeToolCall('run_command', validationArgs, projectDir),
          })
          const stopHeartbeat = startHeartbeat(emit, agent)
          try {
            // C5: task timeout is seconds; run_command timeoutMs is milliseconds.
            const result = await handle.callTool('run_command', validationArgs)
            const output = typeof result === 'string' ? result : JSON.stringify(result)
            const parsed = parseCommandResult(output)
            const outcome = summarizeToolResult(
              'run_command',
              validationArgs,
              result,
              Date.now() - validationStarted,
            )
            emit({
              type: 'tool-end',
              agent,
              callId: `validate-${cmd}`,
              tool: 'run_command',
              ok: parsed.ok,
              ms: Date.now() - validationStarted,
              detail: outcome.detail,
            })

            if (!parsed.ok) {
              streamer.warning(
                `Validation failed: ${cmd} (exit=${parsed.exitCode}${parsed.signal ? ` signal=${parsed.signal}` : ''})`,
              )
              return false
            }
          } catch {
            emit({
              type: 'tool-end',
              agent,
              callId: `validate-${cmd}`,
              tool: 'run_command',
              ok: false,
              ms: Date.now() - validationStarted,
              detail: 'threw',
            })
            return false
          } finally {
            stopHeartbeat()
          }
        }
      } finally {
        if (serverProcess) {
          await killProcessGroup(serverProcess)
        }
        if (serverEntry && fileLocks) {
          fileLocks.releaseFiles([serverLockPath], serverLockOwner)
        }
      }
    }

    return true
  } catch (e) {
    streamer.error(`Worker failed: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}
