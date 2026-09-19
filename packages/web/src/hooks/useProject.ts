import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { VajraClient } from '../client'
import type { PlannedTask, AgentStatePayload, ConflictPayload, PermissionsConfig, TaskStatus } from '@codekalakaars/vajra-protocol'

const MAX_AGENTS = 100
const MAX_CONFLICTS = 50
const MAX_WORKER_EVENTS = 200

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
  taskStates: Map<string, TaskStatus>
  /** Per-worker streaming text, keyed by agentId. */
  workerStreams: Map<string, { taskId: string; text: string }>
  /** Progress events emitted by the master loop. */
  workerProgress: Array<{ agentId: string; taskId: string; detail: string }>
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
    taskStates: new Map(),
    workerStreams: new Map(),
    workerProgress: [],
  })
  const stateRef = useRef(state)
  stateRef.current = state

  // Separate throttle timers for assistant and thinking streaming
  const assistantThrottleRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; pending: string }>({ timer: null, pending: '' })
  const thinkingThrottleRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; pending: string }>({ timer: null, pending: '' })
  const unsubscribeRef = useRef<(() => void) | null>(null)

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
        unsubscribeRef.current = null
      }
      if (assistantThrottleRef.current.timer) { clearTimeout(assistantThrottleRef.current.timer); assistantThrottleRef.current.timer = null }
      if (thinkingThrottleRef.current.timer) { clearTimeout(thinkingThrottleRef.current.timer); thinkingThrottleRef.current.timer = null }
    }
  }, [])

  // Subscribe to push events for a project
  const subscribe = useCallback((projectId: string) => {
    const unsubs: Array<() => void> = []

    unsubs.push(
      client.on('projects.statusChanged', (payload: any) => {
        if (payload.status === undefined) return
        setState((s) => {
          const terminal = payload.status === 'done' || payload.status === 'failed' || payload.status === 'stopped'
          return {
            ...s,
            status: payload.status as ProjectState['status'],
            ...(terminal ? {
              _streamingText: '',
              thinkingText: '',
            } : {}),
          }
        })
      }),
    )

    unsubs.push(
      client.on('projects.assistantDelta', (payload: any) => {
        // Worker deltas carry agentId — route to per-worker stream
        if (payload.agentId) {
          assistantThrottleRef.current.pending += payload.text
          if (!assistantThrottleRef.current.timer) {
            assistantThrottleRef.current.timer = setTimeout(() => {
              const pending = assistantThrottleRef.current.pending
              assistantThrottleRef.current.pending = ''
              assistantThrottleRef.current.timer = null
              if (pending) {
                const agentId = (stateRef.current.agents.find(a => a.status === 'running')?.id) ?? payload.agentId
                setState((s) => {
                  const existing = s.workerStreams.get(agentId) ?? { taskId: payload.taskId ?? '', text: '' }
                  const next = new Map(s.workerStreams)
                  next.set(agentId, { taskId: existing.taskId || (payload.taskId ?? ''), text: existing.text + pending })
                  return { ...s, workerStreams: next }
                })
              }
            }, 50)
          }
          return
        }
        // Developer delta — no agentId, stream into the main text channel
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
        }))
      }),
    )

    // Worker progress events (pre-warming, validation, rollback, retry info)
    unsubs.push(
      client.on('projects.workerProgress', (payload: any) => {
        setState((s) => {
          const newProgress = [...s.workerProgress, { agentId: payload.agentId, taskId: payload.taskId, detail: payload.detail }]
          if (newProgress.length > MAX_WORKER_EVENTS) newProgress.splice(0, newProgress.length - MAX_WORKER_EVENTS)
          return { ...s, workerProgress: newProgress }
        })
      }),
    )

    // Worker events
    unsubs.push(
      client.on('projects.workerStarted', (payload: any) => {
        setState((s) => {
          const newTaskStates = new Map(s.taskStates)
          if (payload.taskId) newTaskStates.set(payload.taskId, 'running')
          const newAgent = { id: payload.agentId, role: 'worker' as const, status: 'running' as const, taskSummary: payload.taskId }
          const nextAgents = [...s.agents, newAgent]
          if (nextAgents.length > MAX_AGENTS) nextAgents.splice(0, nextAgents.length - MAX_AGENTS)
          return {
            ...s,
            agents: nextAgents,
            taskStates: newTaskStates,
          }
        })
      }),
    )

    unsubs.push(
      client.on('projects.workerCompleted', (payload: any) => {
        setState((s) => {
          const agent = s.agents.find(a => a.id === payload.agentId)
          const newTaskStates = new Map(s.taskStates)
          if (agent?.taskSummary) newTaskStates.set(agent.taskSummary, 'done')
          // Finalize per-worker stream into a message if there's accumulated text
          const newMessages = [...s.messages]
          const workerStream = s.workerStreams.get(payload.agentId)
          if (workerStream?.text.trim()) {
            newMessages.push({ role: 'assistant', content: workerStream.text.trim() })
          }
          const nextWorkerStreams = new Map(s.workerStreams)
          nextWorkerStreams.delete(payload.agentId)
          return {
            ...s,
            agents: s.agents.map((a) =>
              a.id === payload.agentId ? { ...a, status: 'done' as const } : a
            ),
            taskStates: newTaskStates,
            messages: newMessages,
            workerStreams: nextWorkerStreams,
          }
        })
      }),
    )

    unsubs.push(
      client.on('projects.workerFailed', (payload: any) => {
        setState((s) => {
          const agent = s.agents.find(a => a.id === payload.agentId)
          const newTaskStates = new Map(s.taskStates)
          if (agent?.taskSummary) newTaskStates.set(agent.taskSummary, 'failed')
          const nextWorkerStreams = new Map(s.workerStreams)
          nextWorkerStreams.delete(payload.agentId)
          return {
            ...s,
            agents: s.agents.map((a) =>
              a.id === payload.agentId ? { ...a, status: 'failed' as const } : a
            ),
            taskStates: newTaskStates,
            workerStreams: nextWorkerStreams,
          }
        })
      }),
    )

    // Conflict events
    unsubs.push(
      client.on('projects.conflictDetected', (payload: any) => {
        setState((s) => {
          const newConflict = { task1: payload.task1, task2: payload.task2, files: payload.files }
          // Deduplicate by (task1, task2) pair
          const exists = s.conflicts.some(c => c.task1 === newConflict.task1 && c.task2 === newConflict.task2)
          if (exists) return s
          const next = [...s.conflicts, newConflict]
          if (next.length > MAX_CONFLICTS) next.splice(0, next.length - MAX_CONFLICTS)
          return { ...s, conflicts: next }
        })
      }),
    )

    unsubs.push(
      client.on('projects.completed', () => {
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
          // Finalize any remaining per-worker streams
          for (const [, stream] of s.workerStreams) {
            if (stream.text.trim()) {
              newMessages.push({ role: 'assistant', content: stream.text.trim() })
            }
          }
          return {
            ...s,
            messages: newMessages,
            status: 'done',
            thinkingText: '',
            _streamingText: '',
            workerStreams: new Map(),
          }
        })
      }),
    )

    unsubs.push(
      client.on('projects.failed', (payload: any) => {
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
          // Finalize any remaining per-worker streams
          for (const [, stream] of s.workerStreams) {
            if (stream.text.trim()) {
              newMessages.push({ role: 'assistant', content: stream.text.trim() })
            }
          }
          return {
            ...s,
            messages: newMessages,
            status: 'failed',
            error: payload.message,
            thinkingText: '',
            _streamingText: '',
            workerStreams: new Map(),
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
    // Clear any pending throttle timers from previous project
    assistantThrottleRef.current.pending = ''
    thinkingThrottleRef.current.pending = ''
    if (assistantThrottleRef.current.timer) { clearTimeout(assistantThrottleRef.current.timer); assistantThrottleRef.current.timer = null }
    if (thinkingThrottleRef.current.timer) { clearTimeout(thinkingThrottleRef.current.timer); thinkingThrottleRef.current.timer = null }

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
      taskStates: new Map(),
      workerStreams: new Map(),
      workerProgress: [],
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

      // Cleanup previous subscriptions before subscribing
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
      }
      unsubscribeRef.current = subscribe(result.projectId)

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
      }))
    } catch (e) {
      setState((s) => ({ ...s, status: 'failed', error: String(e) }))
    }
  }, [client])

  // Attach to existing project
  const attach = useCallback(async (projectId: string) => {
    // Clear any pending throttle timers from previous project
    assistantThrottleRef.current.pending = ''
    thinkingThrottleRef.current.pending = ''
    if (assistantThrottleRef.current.timer) { clearTimeout(assistantThrottleRef.current.timer); assistantThrottleRef.current.timer = null }
    if (thinkingThrottleRef.current.timer) { clearTimeout(thinkingThrottleRef.current.timer); thinkingThrottleRef.current.timer = null }

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
      taskStates: new Map(),
      workerStreams: new Map(),
      workerProgress: [],
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

      // Cleanup previous subscriptions before subscribing
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
      }
      unsubscribeRef.current = subscribe(projectId)
    } catch (e) {
      setState((s) => ({ ...s, status: 'failed', error: String(e) }))
    }
  }, [client, subscribe])

  // Load permissions + scan
  const loadPermissions = useCallback(async (projectDir: string) => {
    try {
      const [perms, files] = await Promise.all([
        client.call('project.loadPermissions', { projectDir }),
        client.call('project.scan', { projectDir }),
      ])
      return { permissions: perms.files || {}, files: files as Array<{ name: string; path: string; isDir: boolean; isMasked: boolean }> }
    } catch (e) {
      console.error('[useProject] loadPermissions failed:', e)
      throw e
    }
  }, [client])

  const savePermissions = useCallback(async (projectDir: string, permissions: Record<string, { read: boolean; write: boolean; edit: boolean; delete: boolean }>) => {
    try {
      const config: PermissionsConfig = { version: 1, default: { read: true, write: false, edit: false, delete: false }, files: permissions }
      await client.call('project.savePermissions', { projectDir, config })
    } catch (e) {
      console.error('[useProject] savePermissions failed:', e)
      throw e
    }
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

  // Memoize stable actions to prevent unnecessary re-renders
  const actions = useMemo(() => ({
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
  }), [client, createProject, sendMessage, confirmPlan, rejectPlan, stopProject, setModel, attach, loadPermissions, savePermissions])

  return { ...state, ...actions }
}
