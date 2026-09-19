import * as readline from 'node:readline'
import { existsSync } from 'node:fs'
import { TerminalStreamer } from './streaming.js'
import { developerConversationTurn, type LaunchHandle, type DeveloperTurnResult } from './agent/developer.js'
import { AgentRegistry } from './agent/registry.js'
import { TaskQueue } from './agent/taskqueue.js'
import { streamChatCompletion, type OpenRouterMessage } from './agent/openrouter.js'
import { getWorkerToolSpecs, parseToolCall } from './agent/tools.js'
import { readFile, writeFile, editFile, listFiles } from './native.js'
import { FileLockManager, ChangeHistory, type ResourceLimits } from '@codekalakaars/vajra-sandbox'
import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface RunOptions {
  task?: string
  apiKey?: string
  model: string
  verbose: boolean
  projectDir: string
  autoConfirm?: boolean
  timeout?: number
}

const DEFAULT_MAX_RETRIES = 2

async function evaluateSkipIf(conditions: string[], projectDir: string): Promise<boolean> {
  if (conditions.length === 0) return false

  for (const condition of conditions) {
    const trimmed = condition.trim()

    if (trimmed.toLowerCase().startsWith('file exists:')) {
      const filePath = trimmed.slice('file exists:'.length).trim()
      const fullPath = resolve(projectDir, filePath)
      try {
        await access(fullPath)
      } catch {
        return false
      }
      continue
    }

    if (trimmed.toLowerCase().startsWith('file missing:')) {
      const filePath = trimmed.slice('file missing:'.length).trim()
      const fullPath = resolve(projectDir, filePath)
      try {
        await access(fullPath)
        return false
      } catch {
        continue
      }
    }
  }

  return true
}

const SERVER_REQUIRED_PATTERNS = [
  /\bnpm\s+test\b/,
  /\bjest\b/,
  /\bmocha\b/,
  /\bvitest\b/,
  /\bcurl\s+.*localhost/,
  /\bcurl\s+.*127\.0\.0\.1/,
  /\bwget\s+.*localhost/,
  /\bwget\s+.*127\.0\.0\.1/,
  /\bapi[_-]?test/,
  /\bintegration[_-]?test/,
]

function needsServer(validationCommands: string[]): boolean {
  return validationCommands.some(cmd =>
    SERVER_REQUIRED_PATTERNS.some(pattern => pattern.test(cmd))
  )
}

async function findServerEntry(projectDir: string): Promise<string | null> {
  const candidates = ['src/index.js', 'src/server.js', 'src/app.js', 'index.js', 'server.js', 'app.js']
  for (const candidate of candidates) {
    const fullPath = resolve(projectDir, candidate)
    try {
      await access(fullPath)
      return fullPath
    } catch {
      continue
    }
  }
  return null
}

function computeTaskPermissions(task: { readFile: string[]; writeFile: string[]; deleteFile: string[] }): Record<string, { read: boolean; write: boolean; edit: boolean; delete: boolean }> {
  const files: Record<string, { read: boolean; write: boolean; edit: boolean; delete: boolean }> = {}

  for (const file of task.readFile) {
    files[file] = { read: true, write: false, edit: false, delete: false }
  }
  for (const file of task.writeFile) {
    files[file] = { read: true, write: true, edit: true, delete: false }
  }
  for (const file of task.deleteFile) {
    files[file] = { read: true, write: false, edit: false, delete: true }
  }

  const allFiles = [...task.readFile, ...task.writeFile, ...task.deleteFile]
  const dirs = new Set(allFiles.map(f => {
    const parts = f.split('/')
    parts.pop()
    return parts.join('/')
  }).filter(Boolean))

  for (const dir of dirs) {
    if (!files[dir]) {
      // Grant write on parent dirs of writeFile entries so workers can create
      // new files in those directories.
      const isWriteParent = task.writeFile.some(f => {
        const parent = f.split('/').slice(0, -1).join('/')
        return parent === dir || dir.startsWith(parent + '/')
      })
      const isDeleteParent = task.deleteFile.some(f => {
        const parent = f.split('/').slice(0, -1).join('/')
        return parent === dir || dir.startsWith(parent + '/')
      })
      files[dir] = {
        read: true,
        write: isWriteParent,
        edit: isWriteParent,
        delete: isDeleteParent,
      }
    }
  }

  return files
}

async function executeTask(
  agentId: string,
  task: { id: string; title: string; description: string | null; instructions: string[]; readFile: string[]; writeFile: string[]; deleteFile: string[]; createDir: string[]; validation: string[]; timeout: number; maxRetries: number; rollback: string[]; skipIf: string[] },
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
      const result = await streamChatCompletion(
        { apiKey, model, messages, tools: toolSpecs },
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
          // Wait for server to start
          await new Promise(resolve => setTimeout(resolve, 2000))
        }
      }

      try {
        for (const cmd of task.validation) {
          try {
            const result = await handle.callTool('run_command', { command: cmd, timeout: task.timeout })
            const output = typeof result === 'string' ? result : JSON.stringify(result)

            let exitCode = 0
            try {
              const parsed = JSON.parse(output)
              exitCode = parsed.exitCode ?? 0
            } catch {
              exitCode = 0
            }

            if (exitCode !== 0) {
              return false
            }
          } catch {
            return false
          }
        }
      } finally {
        if (serverProcess) {
          serverProcess.kill('SIGTERM')
        }
      }
    }

    return true
  } catch (e) {
    streamer.error(`Worker failed: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

export async function runCommand(options: RunOptions): Promise<void> {
  const streamer = new TerminalStreamer(options.verbose, '0.1.0')

  if (!options.apiKey) {
    streamer.error('No API key provided. Set OPENROUTER_API_KEY or OPENCODE_API_KEY, or use --api-key')
    process.exit(1)
  }

  const projectDir = resolve(options.projectDir)
  if (!existsSync(projectDir)) {
    streamer.error(`Project directory does not exist: ${projectDir}`)
    process.exit(1)
  }

  let interrupted = false
  const onSigInt = () => {
    interrupted = true
    streamer.warning('\nInterrupted. Cleaning up...')
  }
  process.on('SIGINT', onSigInt)

  streamer.banner()

  const sessionId = randomUUID()
  const registry = new AgentRegistry()
  const fileLocks = new FileLockManager()
  const changeHistory = new ChangeHistory()

  const masterAgent = registry.createAgent(sessionId, 'master', 'Orchestrate task execution')
  registry.updateStatus(masterAgent.id, 'running')

  streamer.info(`Model: ${options.model}`)
  streamer.info(`Timeout: ${options.timeout ?? 300}s per task`)

  const dummyHandle: LaunchHandle = {
    callTool: async (tool: string, args: unknown) => {
      const a = args as Record<string, unknown>
      switch (tool) {
        case 'read_file':
          return readFile(a.path as string)
        case 'write_file':
          writeFile(a.path as string, a.content as string)
          return 'ok'
        case 'edit_file':
          editFile(a.path as string, a.oldString as string, a.newString as string, a.replaceAll as boolean | undefined)
          return 'ok'
        case 'list_files':
          return JSON.stringify(listFiles(a.path as string))
        case 'run_command': {
          const command = (a.command as string).trim()
          const cmdParts = command.split(/\s+/)
          const cmdName = cmdParts[0]?.split('/').pop() ?? ''

          const ALLOWED_PREFIXES = [
            'npm', 'npx', 'node', 'yarn', 'pnpm',
            'git', 'python', 'python3', 'pip', 'pip3',
            'cargo', 'rustc', 'go', 'make', 'cmake',
            'tsc', 'eslint', 'prettier', 'jest', 'mocha',
            'curl', 'wget', 'cat', 'ls', 'find', 'grep',
            'mkdir', 'cp', 'mv', 'rm', 'touch', 'chmod',
            'docker', 'docker-compose',
          ]

          if (!ALLOWED_PREFIXES.includes(cmdName)) {
            return `Error: Command '${cmdName}' is not allowed. Allowed: ${ALLOWED_PREFIXES.join(', ')}`
          }

          const { spawn } = await import('node:child_process')
          const timeoutMs = (a.timeout as number) || 30000
          return await new Promise<string>((resolve) => {
            const proc = spawn(cmdName, cmdParts.slice(1), {
              cwd: a.cwd as string | undefined,
              timeout: timeoutMs,
              stdio: ['ignore', 'pipe', 'pipe'],
              shell: false,
            })
            let stdout = ''
            let stderr = ''
            proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString() })
            proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })
            proc.on('close', (code) => {
              const exitCode = code ?? 0
              if (exitCode === 0) {
                resolve(stdout || '(no output)')
              } else {
                resolve(JSON.stringify({ exitCode, stdout, stderr }))
              }
            })
            proc.on('error', (err) => {
              resolve(JSON.stringify({ exitCode: -1, stdout: '', stderr: err.message }))
            })
          })
        }
        default:
          return `Unknown tool: ${tool}`
      }
    },
  }

  const messages: OpenRouterMessage[] = []
  const summaryIndex: Array<{ path: string; symbols: string[]; preview: string; lineCount: number; importCount: number; exportCount: number }> = []

  let initialMessage = options.task
  if (!initialMessage) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    initialMessage = await new Promise<string>(resolve => {
      rl.question('\x1b[1mWhat would you like me to work on? \x1b[0m', answer => {
        rl.close()
        resolve(answer.trim())
      })
    })
  }

  while (!initialMessage) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    initialMessage = await new Promise<string>(resolve => {
      rl.question('\x1b[1mPlease enter a task (or type "exit" to quit): \x1b[0m', answer => {
        rl.close()
        resolve(answer.trim())
      })
    })
    if (initialMessage.toLowerCase() === 'exit' || initialMessage.toLowerCase() === 'quit') {
      streamer.info('Goodbye!')
      process.exit(0)
    }
  }

  streamer.info(`\n🔍 Scanning project in ${projectDir}...`)
  streamer.info(`💬 Starting conversation with developer...\n`)

  let result: DeveloperTurnResult
  let userMessage = initialMessage

  let turn = 0
  for (turn = 0; turn < 20; turn++) {
    if (interrupted) break

    try {
      result = await developerConversationTurn({
        sessionId,
        projectDir,
        userMessage,
        model: options.model,
        apiKey: options.apiKey,
        handle: dummyHandle,
        messages,
        summaryIndex,
        onTextDelta: text => streamer.onTextDelta(text),
        onThinkingDelta: text => streamer.onThinkingDelta(text),
        isInterrupted: () => interrupted,
      })
    } catch (e) {
      streamer.error(`API error: ${e instanceof Error ? e.message : String(e)}`)
      streamer.warning('Check your API key and network connection.')
      break
    }

    streamer.finishLine()

    if (result.type === 'plan') {
      streamer.planSummary(result.plan)

      if (options.autoConfirm) {
        streamer.info('Auto-confirming plan (--yes flag)\n')
      } else {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        const confirm = await new Promise<string>(resolve => {
          rl.question('\x1b[1m? Confirm plan? \x1b[0m', answer => {
            rl.close()
            resolve(answer.trim().toLowerCase())
          })
        })

        if (confirm === 'n' || confirm === 'no') {
          streamer.warning('Plan rejected. What would you like to change?')
          userMessage = await new Promise<string>(resolve => {
            const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout })
            rl2.question('\x1b[1mFeedback: \x1b[0m', answer => {
              rl2.close()
              resolve(answer.trim())
            })
          })
          continue
        }
      }

      streamer.info('\n🚀 Executing tasks...\n')

      const queue = new TaskQueue(sessionId)
      for (const task of result.plan.tasks) {
        queue.addTask(task)
      }

      let completedCount = 0
      const totalCount = result.plan.tasks.length

      while (true) {
        if (interrupted) break
        const status = queue.getStatus()
        if (status.done + status.failed + status.skipped >= status.total) break

        const readyTasks = queue.getReadyTasks()

        if (readyTasks.length === 0) {
          break
        }

        for (const task of readyTasks) {
          if (task.skipIf && task.skipIf.length > 0) {
            const shouldSkip = await evaluateSkipIf(task.skipIf, options.projectDir)
            if (shouldSkip) {
              queue.skipTask(task.id)
              completedCount++
              streamer.warning(`Skipped: ${task.title}`)
              continue
            }
          }

          const allTaskFiles = [...task.readFile, ...task.writeFile, ...task.deleteFile]
          if (!fileLocks.tryAcquire(allTaskFiles, task.id, 'write')) {
            fileLocks.release(task.id)
            streamer.warning(`  Skipping "${task.title}" - files locked by another task`)
            queue.skipTask(task.id)
            completedCount++
            continue
          }

          const agent = registry.createAgent(sessionId, 'worker', task.title, masterAgent.id)
          queue.assignTask(task.id, agent.id)
          registry.updateStatus(agent.id, 'running')
          queue.startTask(task.id)

          streamer.info(`\n⏳ [${completedCount + 1}/${totalCount}] ${task.title}`)

          const taskHandle: LaunchHandle = {
            callTool: async (tool: string, args: unknown) => {
              const a = args as Record<string, unknown>
              const permissions = computeTaskPermissions(task)
              const filePermission = permissions[a.path as string]

              if (tool === 'read_file' && !filePermission?.read) {
                throw new Error(`Access denied: ${a.path}`)
              }
              if ((tool === 'write_file' || tool === 'edit_file') && !filePermission?.write) {
                throw new Error(`Access denied: ${a.path}`)
              }

              return dummyHandle.callTool(tool, args)
            },
          }

          for (const filePath of allTaskFiles) {
            await changeHistory.recordBefore(task.id, filePath)
          }

          let success = false
          let retries = 0
          const maxRetries = task.maxRetries ?? DEFAULT_MAX_RETRIES

          while (retries <= maxRetries) {
            success = await executeTask(agent.id, task, taskHandle, options.apiKey, options.model, streamer, changeHistory, queue, registry, sessionId, fileLocks, options.projectDir)

            if (success) break

            const hasFileChanges = changeHistory.hasChanges(task.id)
            if (!hasFileChanges) {
              streamer.warning(`  No changes made - skipping retry for "${task.title}"`)
              break
            }

            if (retries < maxRetries) {
              await changeHistory.rollback(task.id)
              streamer.warning(`  Retrying (${retries + 1}/${maxRetries})...`)
              retries++
            } else {
              break
            }
          }

          if (success) {
            queue.completeTask(task.id, true)
            registry.updateStatus(agent.id, 'done')
            streamer.success(`Done: ${task.title}`)
          } else {
            if (changeHistory.hasChanges(task.id)) {
              await changeHistory.rollback(task.id)
            }
            queue.failTask(task.id)
            registry.updateStatus(agent.id, 'failed')
            streamer.error(`Failed: ${task.title}`)
          }

          fileLocks.release(task.id)
          completedCount++
        }
      }

      const finalStatus = queue.getStatus()
      console.log('')
      streamer.info('📊 Results:')
      streamer.success(`  Completed: ${finalStatus.done}`)
      if (finalStatus.failed > 0) streamer.error(`  Failed: ${finalStatus.failed}`)
      if (finalStatus.skipped > 0) streamer.warning(`  Skipped: ${finalStatus.skipped}`)
      console.log('')
      streamer.success('✅ Done!')
      break
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    userMessage = await new Promise<string>(resolve => {
      rl.question('\x1b[1mYou: \x1b[0m', answer => {
        rl.close()
        resolve(answer.trim())
      })
    })

    if (!userMessage) {
      streamer.warning('Empty message. Type "exit" to quit.')
      userMessage = 'exit'
    }

    if (userMessage.toLowerCase() === 'exit' || userMessage.toLowerCase() === 'quit') {
      streamer.info('Goodbye!')
      break
    }
  }

  if (turn >= 20 && !interrupted) {
    streamer.warning('Reached the 20-turn conversation limit. Starting execution with current progress.')
  }

  registry.updateStatus(masterAgent.id, 'done')
  process.removeListener('SIGINT', onSigInt)
  if (interrupted) {
    streamer.warning('Session interrupted. Progress has been saved.')
  }
}
