import { useState, useRef, useCallback } from 'react'
import { VajraClient } from '../client'
import type { PlannedTask, AgentStatePayload, ConflictPayload, PermissionsConfig } from '@codekalakaars/vajra-protocol'

// Singleton client — persists across re-renders
let clientSingleton: VajraClient | null = null
function getClient(): VajraClient {
  if (!clientSingleton) {
    const WS_PORT = 4820
    const WS_URL = `ws://${window.location.hostname}:${WS_PORT}`
    clientSingleton = new VajraClient(WS_URL)
    clientSingleton.connect()
  }
  return clientSingleton
}

export function useClient(): VajraClient {
  return getClient()
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  thinking?: string
}

export interface ProjectState {
  projectId: string | null
  model: string
  status: 'idle' | 'creating' | 'talking' | 'confirming' | 'planning' | 'executing' | 'streaming' | 'done' | 'failed'
  messages: ChatMessage[]
  thinkingText: string
  error: string | null
  planTasks: PlannedTask[]
  independentGroups: string[][]
  estimatedWorkers: number
  agents: AgentStatePayload[]
  conflicts: ConflictPayload[]
  _streamingText: string
  _streamingChunks: string[]
  _thinkingChunks: string[]
}

export function useProject() {
  const client = useClient()
  const [state, setState] = useState<ProjectState>({
    projectId: null,
    model: 'openrouter/free',
    status: 'idle',
    messages: [],
    thinkingText: '',
    error: null,
    planTasks: [],
    independentGroups: [],
    estimatedWorkers: 1,
    agents: [],
    conflicts: [],
    _streamingText: '',
    _streamingChunks: [],
    _thinkingChunks: [],
  })
  const stateRef = useRef(state)
  stateRef.current = state

  // Separate throttle timers for assistant and thinking streaming
  const assistantThrottleRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; pending: string }>({ timer: null, pending: '' })
  const thinkingThrottleRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; pending: string }>({ timer: null, pending: '' })

  // Subscribe to push events for a project
  const subscribe = useCallback((projectId: string) => {
    const unsubs: Array<() => void> = []

    unsubs.push(
      client.on('projects.statusChanged', (payload: any) => {
        if (payload.status === undefined) return
        setState((s) => {
          // Only clear streaming text on terminal statuses — not during streaming itself
          const terminal = payload.status === 'done' || payload.status === 'failed' || payload.status === 'stopped'
          return {
            ...s,
            status: payload.status as ProjectState['status'],
            ...(terminal ? {
              _streamingText: '',
              thinkingText: '',
              _streamingChunks: [],
              _thinkingChunks: [],
            } : {}),
          }
        })
      }),
    )

    unsubs.push(
      client.on('projects.assistantDelta', (payload: any) => {
        // Append directly to accumulator — no separate chunks buffer
        assistantThrottleRef.current.pending += payload.text
        if (!assistantThrottleRef.current.timer) {
          assistantThrottleRef.current.timer = setTimeout(() => {
            const pending = assistantThrottleRef.current.pending
            assistantThrottleRef.current.pending = ''
            assistantThrottleRef.current.timer = null
            if (pending) {
              setState((s) => ({
                ...s,
                _streamingText: s._streamingText + pending,
                status: s.status === 'talking' || s.status === 'confirming' ? 'streaming' : s.status,
              }))
            }
          }, 50)
        }
      }),
    )

    unsubs.push(
      client.on('projects.thinkingDelta', (payload: any) => {
        // Append directly to accumulator — no separate chunks buffer
        thinkingThrottleRef.current.pending += payload.text
        if (!thinkingThrottleRef.current.timer) {
          thinkingThrottleRef.current.timer = setTimeout(() => {
            const pending = thinkingThrottleRef.current.pending
            thinkingThrottleRef.current.pending = ''
            thinkingThrottleRef.current.timer = null
            if (pending) {
              setState((s) => ({
                ...s,
                thinkingText: s.thinkingText + pending,
              }))
            }
          }, 50)
        }
      }),
    )

    // Plan events
    unsubs.push(
      client.on('projects.planStarted', () => {
        setState((s) => ({ ...s, status: 'planning', planTasks: [] }))
      }),
    )

    unsubs.push(
      client.on('projects.planTask', (payload: any) => {
        setState((s) => ({ ...s, planTasks: [...s.planTasks, payload.task] }))
      }),
    )

    unsubs.push(
      client.on('projects.planComplete', (payload: any) => {
        setState((s) => ({
          ...s,
          status: 'executing',
          planTasks: payload.plan.tasks,
          independentGroups: payload.plan.independentGroups || [],
          estimatedWorkers: payload.plan.estimatedWorkers || 1,
        }))
      }),
    )

    unsubs.push(
      client.on('projects.planProposed', (payload: any) => {
        setState((s) => ({
          ...s,
          status: 'confirming',
          planTasks: payload.plan.tasks,
          independentGroups: payload.plan.independentGroups || [],
          estimatedWorkers: payload.plan.estimatedWorkers || 1,
          _streamingText: '',
          thinkingText: '',
          _streamingChunks: [],
          _thinkingChunks: [],
        }))
      }),
    )

    unsubs.push(
      client.on('projects.planConfirmed', () => {
        setState((s) => ({
          ...s,
          status: 'executing',
          _streamingText: '',
          thinkingText: '',
          _streamingChunks: [],
          _thinkingChunks: [],
        }))
      }),
    )

    // Worker events
    unsubs.push(
      client.on('projects.workerStarted', (payload: any) => {
        setState((s) => ({
          ...s,
          agents: [...s.agents, { id: payload.agentId, role: 'worker', status: 'running', taskSummary: payload.taskId }],
        }))
      }),
    )

    unsubs.push(
      client.on('projects.workerCompleted', (payload: any) => {
        setState((s) => ({
          ...s,
          agents: s.agents.map((a) =>
            a.id === payload.agentId ? { ...a, status: 'done' as const } : a
          ),
        }))
      }),
    )

    unsubs.push(
      client.on('projects.workerFailed', (payload: any) => {
        setState((s) => ({
          ...s,
          agents: s.agents.map((a) =>
            a.id === payload.agentId ? { ...a, status: 'failed' as const } : a
          ),
        }))
      }),
    )

    // Conflict events
    unsubs.push(
      client.on('projects.conflictDetected', (payload: any) => {
        setState((s) => ({
          ...s,
          conflicts: [...s.conflicts, { task1: payload.task1, task2: payload.task2, files: payload.files }],
        }))
      }),
    )

    unsubs.push(
      client.on('projects.completed', () => {
        // Flush any pending throttle text before finalizing
        const pendingAssistant = assistantThrottleRef.current.pending
        const pendingThinking = thinkingThrottleRef.current.pending
        assistantThrottleRef.current.pending = ''
        thinkingThrottleRef.current.pending = ''
        if (assistantThrottleRef.current.timer) { clearTimeout(assistantThrottleRef.current.timer); assistantThrottleRef.current.timer = null }
        if (thinkingThrottleRef.current.timer) { clearTimeout(thinkingThrottleRef.current.timer); thinkingThrottleRef.current.timer = null }

        setState((s) => {
          const newMessages = [...s.messages]
          const finalStreamText = (s._streamingText + pendingAssistant).trim()
          const finalThinkingText = (s.thinkingText + pendingThinking).trim()
          if (finalStreamText || finalThinkingText) {
            newMessages.push({
              role: 'assistant',
              content: finalStreamText,
              thinking: finalThinkingText || undefined,
            })
          }
          return {
            ...s,
            messages: newMessages,
            status: 'done',
            thinkingText: '',
            _streamingText: '',
            _streamingChunks: [],
            _thinkingChunks: [],
          }
        })
      }),
    )

    unsubs.push(
      client.on('projects.failed', (payload: any) => {
        // Flush any pending throttle text before finalizing
        const pendingAssistant = assistantThrottleRef.current.pending
        const pendingThinking = thinkingThrottleRef.current.pending
        assistantThrottleRef.current.pending = ''
        thinkingThrottleRef.current.pending = ''
        if (assistantThrottleRef.current.timer) { clearTimeout(assistantThrottleRef.current.timer); assistantThrottleRef.current.timer = null }
        if (thinkingThrottleRef.current.timer) { clearTimeout(thinkingThrottleRef.current.timer); thinkingThrottleRef.current.timer = null }

        setState((s) => {
          const newMessages = [...s.messages]
          const finalStreamText = (s._streamingText + pendingAssistant).trim()
          const finalThinkingText = (s.thinkingText + pendingThinking).trim()
          if (finalStreamText || finalThinkingText) {
            newMessages.push({
              role: 'assistant',
              content: finalStreamText,
              thinking: finalThinkingText || undefined,
            })
          }
          return {
            ...s,
            messages: newMessages,
            status: 'failed',
            error: payload.message,
            thinkingText: '',
            _streamingText: '',
            _streamingChunks: [],
            _thinkingChunks: [],
          }
        })
      }),
    )

    return () => {
      for (const u of unsubs) u()
    }
  }, [client])

  // Create a new project
  const createProject = useCallback(async (params: {
    projectDir: string
    permissions: Record<string, { read: boolean; write: boolean; edit: boolean; delete: boolean }>
    model: string
  }) => {
    setState({
      projectId: null,
      model: params.model,
      status: 'creating',
      messages: [],
      thinkingText: '',
      error: null,
      planTasks: [],
      independentGroups: [],
      estimatedWorkers: 1,
      agents: [],
      conflicts: [],
      _streamingText: '',
      _streamingChunks: [],
      _thinkingChunks: [],
    })

    try {
      const result = await client.call('projects.create', {
        projectDir: params.projectDir,
        task: '',
        model: params.model,
        permissions: { version: 1, default: { read: true, write: false, edit: false, delete: false }, files: params.permissions },
      })

      setState((s) => ({
        ...s,
        projectId: result.projectId,
        status: 'talking',
      }))

      subscribe(result.projectId)

      return result.projectId
    } catch (e) {
      setState((s) => ({ ...s, status: 'failed', error: String(e) }))
      throw e
    }
  }, [client, subscribe])

  // Send a message
  const sendMessage = useCallback(async (content: string) => {
    const sid = stateRef.current.projectId
    if (!sid) return

    // Clear any pending throttle timers and accumulated text from the previous stream
    assistantThrottleRef.current.pending = ''
    thinkingThrottleRef.current.pending = ''
    if (assistantThrottleRef.current.timer) { clearTimeout(assistantThrottleRef.current.timer); assistantThrottleRef.current.timer = null }
    if (thinkingThrottleRef.current.timer) { clearTimeout(thinkingThrottleRef.current.timer); thinkingThrottleRef.current.timer = null }

    setState((s) => ({
      ...s,
      messages: [...s.messages, { role: 'user', content }],
      status: 'streaming',
      thinkingText: '',
      _streamingText: '',
      _streamingChunks: [],
      _thinkingChunks: [],
    }))

    try {
      await client.call('projects.sendMessage', { projectId: sid, content })
    } catch (e) {
      setState((s) => ({ ...s, status: 'failed', error: String(e) }))
    }
  }, [client])

  // Confirm the proposed plan
  const confirmPlan = useCallback(async (editedTasks?: PlannedTask[]) => {
    const sid = stateRef.current.projectId
    if (!sid) return

    setState((s) => ({ ...s, status: 'executing' }))

    try {
      await client.call('projects.confirmPlan', { projectId: sid, tasks: editedTasks as Array<Record<string, unknown>> | undefined })
    } catch (e) {
      setState((s) => ({ ...s, status: 'failed', error: String(e) }))
    }
  }, [client])

  // Reject the proposed plan
  const rejectPlan = useCallback(async () => {
    const sid = stateRef.current.projectId
    if (!sid) return

    try {
      await client.call('projects.rejectPlan', { projectId: sid })
      setState((s) => ({
        ...s,
        status: 'talking',
        planTasks: [],
        _streamingText: '',
        thinkingText: '',
        _streamingChunks: [],
        _thinkingChunks: [],
      }))
    } catch (e) {
      setState((s) => ({ ...s, status: 'failed', error: String(e) }))
    }
  }, [client])

  // Attach to existing project
  const attach = useCallback(async (projectId: string) => {
    setState({
      projectId,
      model: 'openrouter/free',
      status: 'idle',
      messages: [],
      thinkingText: '',
      error: null,
      planTasks: [],
      independentGroups: [],
      estimatedWorkers: 1,
      agents: [],
      conflicts: [],
      _streamingText: '',
      _streamingChunks: [],
      _thinkingChunks: [],
    })

    try {
      const result = await client.call('projects.attach', { projectId })

      const messages: ChatMessage[] = (result.messages as Array<Record<string, unknown>> || [])
        .filter((m) => m.content && (m.role === 'user' || m.role === 'assistant'))
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: String(m.content) }))

      // Extract plan from assistant messages (look for last message containing plan JSON)
      let planTasks: PlannedTask[] = []
      let independentGroups: string[][] = []
      let estimatedWorkers = 1
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role !== 'assistant') continue
        try {
          const obj = JSON.parse(messages[i].content)
          if (obj && Array.isArray(obj.tasks) && obj.tasks.length > 0 && obj.tasks[0].id && obj.tasks[0].title && obj.tasks[0].instructions) {
            planTasks = obj.tasks
            independentGroups = obj.independentGroups || []
            estimatedWorkers = obj.estimatedWorkers || 1
            break
          }
        } catch {}
      }

      const projectData = result.project as { status: string; model: string }
      const status = projectData.status === 'done' ? 'done'
        : projectData.status === 'failed' ? 'failed'
        : projectData.status === 'talking' ? 'talking'
        : projectData.status === 'confirming' ? 'confirming'
        : projectData.status === 'executing' ? 'executing'
        : 'idle'

      setState((s) => ({
        ...s,
        model: projectData.model || s.model,
        messages,
        status,
        planTasks,
        independentGroups,
        estimatedWorkers,
      }))

      subscribe(projectId)
    } catch (e) {
      setState((s) => ({ ...s, status: 'failed', error: String(e) }))
    }
  }, [client, subscribe])

  // Load permissions + scan
  const loadPermissions = useCallback(async (projectDir: string) => {
    const [perms, files] = await Promise.all([
      client.call('project.loadPermissions', { projectDir }),
      client.call('project.scan', { projectDir }),
    ])
    return { permissions: perms.files || {}, files: files as Array<{ name: string; path: string; isDir: boolean; isMasked: boolean }> }
  }, [client])

  const savePermissions = useCallback(async (projectDir: string, permissions: Record<string, { read: boolean; write: boolean; edit: boolean; delete: boolean }>) => {
    const config: PermissionsConfig = { version: 1, default: { read: true, write: false, edit: false, delete: false }, files: permissions }
    await client.call('project.savePermissions', { projectDir, config })
  }, [client])

  const stopProject = useCallback(async () => {
    const sid = stateRef.current.projectId
    if (!sid) return
    try {
      await client.call('projects.stop', { projectId: sid })
    } catch {
      // ignore
    }
  }, [client])

  const setModel = useCallback(async (model: string) => {
    const sid = stateRef.current.projectId
    setState((s) => ({ ...s, model }))
    if (!sid) return
    try {
      await client.call('projects.setModel', { projectId: sid, model })
    } catch {
      // ignore
    }
  }, [client])

  return {
    ...state,
    client,
    createProject,
    sendMessage,
    confirmPlan,
    rejectPlan,
    stopProject,
    setModel,
    attach,
    loadPermissions,
    savePermissions,
  }
}
