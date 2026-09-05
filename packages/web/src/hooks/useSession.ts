import { useState, useEffect, useRef, useCallback } from 'react'
import { VajraClient } from '../client'
import type { PlannedTask, AgentStatePayload, ConflictPayload, ManagerPlan } from '@vajra/protocol'

// Singleton client — persists across re-renders
let clientSingleton: VajraClient | null = null
function getClient(): VajraClient {
  if (!clientSingleton) {
    const WS_URL = `ws://${window.location.hostname}:4820`
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
  status: 'idle' | 'creating' | 'planning' | 'executing' | 'streaming' | 'done' | 'failed'
  messages: ChatMessage[]
  thinkingText: string
  error: string | null
  // Multi-agent state
  planTasks: PlannedTask[]
  agents: AgentStatePayload[]
  conflicts: ConflictPayload[]
  // Accumulator for the current streaming response
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
      client.on('session.assistantDelta', (payload) => {
        const p = payload as { sessionId: string; text: string }
        if (p.sessionId !== sessionId) return
        setState((s) => ({
          ...s,
          _streamingText: s._streamingText + p.text,
          status: 'streaming',
        }))
      }),
    )

    unsubs.push(
      client.on('session.thinkingDelta', (payload) => {
        const p = payload as { sessionId: string; text: string }
        if (p.sessionId !== sessionId) return
        setState((s) => ({ ...s, thinkingText: s.thinkingText + p.text }))
      }),
    )

    // Manager events
    unsubs.push(
      client.on('session.planStarted', (payload) => {
        const p = payload as { sessionId: string }
        if (p.sessionId !== sessionId) return
        setState((s) => ({ ...s, status: 'planning', planTasks: [] }))
      }),
    )

    unsubs.push(
      client.on('session.planTask', (payload) => {
        const p = payload as { sessionId: string; task: PlannedTask }
        if (p.sessionId !== sessionId) return
        setState((s) => ({ ...s, planTasks: [...s.planTasks, p.task] }))
      }),
    )

    unsubs.push(
      client.on('session.planComplete', (payload) => {
        const p = payload as { sessionId: string; plan: ManagerPlan }
        if (p.sessionId !== sessionId) return
        setState((s) => ({ ...s, status: 'executing', planTasks: p.plan.tasks }))
      }),
    )

    // Worker events
    unsubs.push(
      client.on('session.workerStarted', (payload) => {
        const p = payload as { sessionId: string; agentId: string; taskId: string }
        if (p.sessionId !== sessionId) return
        setState((s) => ({
          ...s,
          agents: [...s.agents, { id: p.agentId, role: 'worker', status: 'running', taskSummary: p.taskId }],
        }))
      }),
    )

    unsubs.push(
      client.on('session.workerCompleted', (payload) => {
        const p = payload as { sessionId: string; agentId: string; taskId: string; validationPassed: boolean }
        if (p.sessionId !== sessionId) return
        setState((s) => ({
          ...s,
          agents: s.agents.map((a) =>
            a.id === p.agentId ? { ...a, status: 'done' as const } : a
          ),
        }))
      }),
    )

    unsubs.push(
      client.on('session.workerFailed', (payload) => {
        const p = payload as { sessionId: string; agentId: string; taskId: string; error: string }
        if (p.sessionId !== sessionId) return
        setState((s) => ({
          ...s,
          agents: s.agents.map((a) =>
            a.id === p.agentId ? { ...a, status: 'failed' as const } : a
          ),
        }))
      }),
    )

    // Conflict events
    unsubs.push(
      client.on('session.conflictDetected', (payload) => {
        const p = payload as { sessionId: string } & ConflictPayload
        if (p.sessionId !== sessionId) return
        setState((s) => ({
          ...s,
          conflicts: [...s.conflicts, { task1: p.task1, task2: p.task2, files: p.files }],
        }))
      }),
    )

    unsubs.push(
      client.on('session.completed', (payload) => {
        const p = payload as { sessionId: string }
        if (p.sessionId !== sessionId) return
        setState((s) => {
          const newMessages = [...s.messages]
          // Always flush — even if only thinking, no content
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
      client.on('session.failed', (payload) => {
        const p = payload as { sessionId: string; message: string }
        if (p.sessionId !== sessionId) return
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
            error: p.message,
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

  // Create a new session and start summarizing
  const createSession = useCallback(async (params: {
    projectDir: string
    permissions: Record<string, { read: boolean; write: boolean; edit: boolean; delete: boolean }>
    model: string
  }) => {
    const SUMMARIZE_TASK = 'Analyze this project thoroughly. Read all source files, configuration files, and documentation. Provide a comprehensive summary covering: 1) What the project does, 2) Tech stack and dependencies, 3) Directory structure and file purposes, 4) Key architecture and patterns, 5) Entry points and main flows.'

    setState({
      sessionId: null,
      status: 'creating',
      messages: [{ role: 'user', content: SUMMARIZE_TASK }],
      thinkingText: '',
      error: null,
      _streamingText: '',
    })

    try {
      const result = await client.call('session.create', {
        projectDir: params.projectDir,
        task: SUMMARIZE_TASK,
        model: params.model,
        permissions: { version: 1, default: { read: true, write: false, edit: false, delete: false }, files: params.permissions },
      }) as { sessionId: string }

      setState((s) => ({ ...s, sessionId: result.sessionId }))

      // Subscribe to events — must happen before startSession begins streaming
      subscribe(result.sessionId)

      return result.sessionId
    } catch (e) {
      setState((s) => ({ ...s, status: 'failed', error: String(e) }))
      throw e
    }
  }, [client, subscribe])

  // Send a follow-up message
  const sendMessage = useCallback(async (content: string) => {
    const sid = stateRef.current.sessionId
    if (!sid) return

    // Add user message immediately
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

  // Attach to existing session (for reconnect / direct navigation)
  const attach = useCallback(async (sessionId: string) => {
    setState({
      sessionId,
      status: 'idle',
      messages: [],
      thinkingText: '',
      error: null,
      _streamingText: '',
    })

    try {
      const result = await client.call('session.attach', { sessionId }) as {
        session: { status: string; model: string }
        messages: Array<{ role: string; content: string | null }>
      }

      // Rebuild messages from persisted DB records
      const messages: ChatMessage[] = (result.messages || [])
        .filter((m) => m.content && (m.role === 'user' || m.role === 'assistant'))
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content! }))

      const status = result.session.status === 'done' ? 'done'
        : result.session.status === 'failed' ? 'failed'
        : 'idle'

      setState((s) => ({
        ...s,
        messages,
        status,
      }))

      // Subscribe to live events
      subscribe(sessionId)
    } catch (e) {
      setState((s) => ({ ...s, status: 'failed', error: String(e) }))
    }
  }, [client, subscribe])

  // Load permissions + scan
  const loadPermissions = useCallback(async (projectDir: string) => {
    const [perms, files] = await Promise.all([
      client.call('project.loadPermissions', { projectDir }) as Promise<{ version: number; default: Record<string, boolean>; files: Record<string, { read: boolean; write: boolean; edit: boolean; delete: boolean }> }>,
      client.call('project.scan', { projectDir }) as Promise<Array<{ name: string; path: string; isDir: boolean; isMasked: boolean }>>,
    ])
    return { permissions: perms.files || {}, files }
  }, [client])

  const savePermissions = useCallback(async (projectDir: string, permissions: Record<string, { read: boolean; write: boolean; edit: boolean; delete: boolean }>) => {
    await client.call('project.savePermissions', { projectDir, config: { version: 1, default: { read: true, write: false, edit: false, delete: false }, files: permissions } } as never)
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
    stopSession,
    attach,
    loadPermissions,
    savePermissions,
  }
}
