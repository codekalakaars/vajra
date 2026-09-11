import { useState, useRef, useCallback } from 'react'
import { VajraClient } from '../client'
import type { PlannedTask, AgentStatePayload, ConflictPayload, PushEventPayloads, PermissionsConfig } from '@codekalakaars/protocol'

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

export interface SessionState {
  sessionId: string | null
  status: 'idle' | 'creating' | 'talking' | 'confirming' | 'planning' | 'executing' | 'streaming' | 'done' | 'failed'
  messages: ChatMessage[]
  thinkingText: string
  error: string | null
  planTasks: PlannedTask[]
  agents: AgentStatePayload[]
  conflicts: ConflictPayload[]
  _streamingText: string
}

export function useSession() {
  const client = useClient()
  const [state, setState] = useState<SessionState>({
    sessionId: null,
    status: 'idle',
    messages: [],
    thinkingText: '',
    error: null,
    planTasks: [],
    agents: [],
    conflicts: [],
    _streamingText: '',
  })
  const stateRef = useRef(state)
  stateRef.current = state

  // Subscribe to push events for a session
  const subscribe = useCallback((sessionId: string) => {
    const unsubs: Array<() => void> = []

    unsubs.push(
      client.on('session.statusChanged', (payload: PushEventPayloads['session.statusChanged']) => {
        if (payload.status === undefined) return
        setState((s) => ({
          ...s,
          status: payload.status as SessionState['status'],
          _streamingText: '',
          thinkingText: '',
        }))
      }),
    )

    unsubs.push(
      client.on('session.assistantDelta', (payload: PushEventPayloads['session.assistantDelta']) => {
        setState((s) => ({
          ...s,
          _streamingText: s._streamingText + payload.text,
          status: s.status === 'talking' || s.status === 'confirming' ? 'streaming' : s.status,
        }))
      }),
    )

    unsubs.push(
      client.on('session.thinkingDelta', (payload: PushEventPayloads['session.thinkingDelta']) => {
        setState((s) => ({ ...s, thinkingText: s.thinkingText + payload.text }))
      }),
    )

    // Plan events
    unsubs.push(
      client.on('session.planStarted', () => {
        setState((s) => ({ ...s, status: 'planning', planTasks: [] }))
      }),
    )

    unsubs.push(
      client.on('session.planTask', (payload: PushEventPayloads['session.planTask']) => {
        setState((s) => ({ ...s, planTasks: [...s.planTasks, payload.task] }))
      }),
    )

    unsubs.push(
      client.on('session.planComplete', (payload: PushEventPayloads['session.planComplete']) => {
        setState((s) => ({ ...s, status: 'executing', planTasks: payload.plan.tasks }))
      }),
    )

    unsubs.push(
      client.on('session.planProposed', (payload: PushEventPayloads['session.planProposed']) => {
        setState((s) => ({
          ...s,
          status: 'confirming',
          planTasks: payload.plan.tasks,
          _streamingText: '',
          thinkingText: '',
        }))
      }),
    )

    unsubs.push(
      client.on('session.planConfirmed', () => {
        setState((s) => ({
          ...s,
          status: 'executing',
          _streamingText: '',
          thinkingText: '',
        }))
      }),
    )

    // Worker events
    unsubs.push(
      client.on('session.workerStarted', (payload: PushEventPayloads['session.workerStarted']) => {
        setState((s) => ({
          ...s,
          agents: [...s.agents, { id: payload.agentId, role: 'worker', status: 'running', taskSummary: payload.taskId }],
        }))
      }),
    )

    unsubs.push(
      client.on('session.workerCompleted', (payload: PushEventPayloads['session.workerCompleted']) => {
        setState((s) => ({
          ...s,
          agents: s.agents.map((a) =>
            a.id === payload.agentId ? { ...a, status: 'done' as const } : a
          ),
        }))
      }),
    )

    unsubs.push(
      client.on('session.workerFailed', (payload: PushEventPayloads['session.workerFailed']) => {
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
      client.on('session.conflictDetected', (payload: PushEventPayloads['session.conflictDetected']) => {
        setState((s) => ({
          ...s,
          conflicts: [...s.conflicts, { task1: payload.task1, task2: payload.task2, files: payload.files }],
        }))
      }),
    )

    unsubs.push(
      client.on('session.completed', () => {
        setState((s) => {
          const newMessages = [...s.messages]
          if (s._streamingText || s.thinkingText) {
            newMessages.push({
              role: 'assistant',
              content: s._streamingText,
              thinking: s.thinkingText || undefined,
            })
          }
          return {
            ...s,
            messages: newMessages,
            status: 'done',
            thinkingText: '',
            _streamingText: '',
          }
        })
      }),
    )

    unsubs.push(
      client.on('session.failed', (payload: PushEventPayloads['session.failed']) => {
        setState((s) => {
          const newMessages = [...s.messages]
          if (s._streamingText || s.thinkingText) {
            newMessages.push({
              role: 'assistant',
              content: s._streamingText,
              thinking: s.thinkingText || undefined,
            })
          }
          return {
            ...s,
            messages: newMessages,
            status: 'failed',
            error: payload.message,
            thinkingText: '',
            _streamingText: '',
          }
        })
      }),
    )

    return () => {
      for (const u of unsubs) u()
    }
  }, [client])

  // Create a new session
  const createSession = useCallback(async (params: {
    projectDir: string
    permissions: Record<string, { read: boolean; write: boolean; edit: boolean; delete: boolean }>
    model: string
  }) => {
    setState({
      sessionId: null,
      status: 'creating',
      messages: [],
      thinkingText: '',
      error: null,
      planTasks: [],
      agents: [],
      conflicts: [],
      _streamingText: '',
    })

    try {
      const result = await client.call('session.create', {
        projectDir: params.projectDir,
        task: '',
        model: params.model,
        permissions: { version: 1, default: { read: true, write: false, edit: false, delete: false }, files: params.permissions },
      })

      setState((s) => ({
        ...s,
        sessionId: result.sessionId,
        status: 'talking',
      }))

      subscribe(result.sessionId)

      return result.sessionId
    } catch (e) {
      setState((s) => ({ ...s, status: 'failed', error: String(e) }))
      throw e
    }
  }, [client, subscribe])

  // Send a message
  const sendMessage = useCallback(async (content: string) => {
    const sid = stateRef.current.sessionId
    if (!sid) return

    setState((s) => ({
      ...s,
      messages: [...s.messages, { role: 'user', content }],
      status: 'streaming',
      thinkingText: '',
      _streamingText: '',
    }))

    try {
      await client.call('session.sendMessage', { sessionId: sid, content })
    } catch (e) {
      setState((s) => ({ ...s, status: 'failed', error: String(e) }))
    }
  }, [client])

  // Confirm the proposed plan
  const confirmPlan = useCallback(async (editedTasks?: PlannedTask[]) => {
    const sid = stateRef.current.sessionId
    if (!sid) return

    setState((s) => ({ ...s, status: 'executing' }))

    try {
      await client.call('session.confirmPlan', { sessionId: sid, tasks: editedTasks as Array<Record<string, unknown>> | undefined })
    } catch (e) {
      setState((s) => ({ ...s, status: 'failed', error: String(e) }))
    }
  }, [client])

  // Reject the proposed plan
  const rejectPlan = useCallback(async () => {
    const sid = stateRef.current.sessionId
    if (!sid) return

    try {
      await client.call('session.rejectPlan', { sessionId: sid })
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

  // Attach to existing session
  const attach = useCallback(async (sessionId: string) => {
    setState({
      sessionId,
      status: 'idle',
      messages: [],
      thinkingText: '',
      error: null,
      planTasks: [],
      agents: [],
      conflicts: [],
      _streamingText: '',
    })

    try {
      const result = await client.call('session.attach', { sessionId })

      const messages: ChatMessage[] = (result.messages as Array<Record<string, unknown>> || [])
        .filter((m) => m.content && (m.role === 'user' || m.role === 'assistant'))
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: String(m.content) }))

      const session = result.session as { status: string }
      const status = session.status === 'done' ? 'done'
        : session.status === 'failed' ? 'failed'
        : session.status === 'talking' ? 'talking'
        : session.status === 'confirming' ? 'confirming'
        : session.status === 'executing' ? 'executing'
        : 'idle'

      setState((s) => ({
        ...s,
        messages,
        status,
      }))

      subscribe(sessionId)
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

  const stopSession = useCallback(async () => {
    const sid = stateRef.current.sessionId
    if (!sid) return
    try {
      await client.call('session.stop', { sessionId: sid })
    } catch {
      // ignore
    }
  }, [client])

  return {
    ...state,
    client,
    createSession,
    sendMessage,
    confirmPlan,
    rejectPlan,
    stopSession,
    attach,
    loadPermissions,
    savePermissions,
  }
}
