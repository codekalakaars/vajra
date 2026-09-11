# Plan: Conversational Manager → Plan Confirmation → Master Execution

## Overview

The desired flow:

```
User ↔ Manager (conversation) → Manager proposes plan → User reviews → User confirms → Master orchestrates → Workers execute
```

## Current state vs. what's needed

| Component | Currently | Needs |
|---|---|---|
| Manager | Single LLM call → JSON plan | Multi-turn conversation loop + autonomous plan trigger |
| Session states | `starting → planning → executing → done` | `starting → talking → proposing → confirming → planning → executing → done` |
| Plan delivery | Auto-executes immediately | Show to user, await confirmation |
| Master | Already orchestrates workers | No change needed (receives plan after confirmation) |
| Frontend | No plan review UI | Plan review component with confirm/edit |

---

## Sequence diagram

```
User                    Frontend                 Server                    Manager LLM              Master              Workers
 │                         │                       │                          │                       │                    │
 │── create session ──────>│── session.create ────>│                          │                       │                    │
 │                         │                       │── fork sandbox worker ───────────────────────────────────────────────>│
 │                         │                       │<─ sandbox report ────────────────────────────────────────────────────│
 │                         │<─ sessionId ─────────│                          │                       │                    │
 │                         │                       │                          │                       │                    │
 │── "I need to add auth" >│── sendMessage ──────>│── managerTurn(user msg)──────────────────────────>│                    │
 │                         │                       │<─ assistantDelta ───────────────────────────────│                    │
 │<── "Tell me more..." ──│<─────────────────────│                          │                       │                    │
 │                         │                       │                          │                       │                    │
 │── "JWT, middleware" ───>│── sendMessage ──────>│── managerTurn(user msg)──────────────────────────>│                    │
 │                         │                       │                          │ (calls search_files)  │                    │
 │                         │                       │── callTool(search) ───────────────────────────────────────────────>│
 │                         │                       │<─ results ─────────────────────────────────────────────────────────│
 │                         │                       │                          │ (calls propose_plan)  │                    │
 │                         │                       │<── intercept propose_plan ──────────────────────│                    │
 │                         │                       │── emit planProposed ──>│                        │                    │
 │<── plan review UI ─────│<──────────────────────│                          │                       │                    │
 │                         │                       │                          │                       │                    │
 │── confirm ─────────────>│── confirmPlan ───────>│                          │                       │                    │
 │                         │                       │── masterLoop(plan) ─────────────────────────────>│                    │
 │                         │                       │                          │                       │── launch worker ──>│
 │<── progress events ────│<──────────────────────│<── workerCompleted ─────────────────────────────────────────────────│
 │                         │                       │                          │                       │                    │
 │<── done ───────────────│<──────────────────────│<── session.completed ───────────────────────────────────────────────│
```

---

## Changes by package

### 1. `packages/protocol/src/messages.ts` — New types

- Add `SessionStatus` values `'talking'` and `'confirming'`
- Add push event `session.planProposed` with payload `{ sessionId: string; plan: ManagerPlan }`
- Add push event `session.planConfirmed` with payload `{ sessionId: string }`
- Add RPC method `session.confirmPlan` with params `{ sessionId: string; tasks?: PlannedTask[] }`
- Add RPC method `session.rejectPlan` with params `{ sessionId: string }`

### 2. `packages/protocol/src/tools.ts` — Add `propose_plan` tool

```ts
export const proposePlanTool = defineTool({
  name: 'propose_plan',
  description:
    'Propose a structured plan for the user\'s task. Call this when you have ' +
    'gathered enough context through conversation. Do NOT call on the first message.',
  nativeFn: '', // handled in-process, not dispatched to worker
  schema: z.object({
    tasks: z.array(z.object({
      title: z.string(),
      description: z.string(),
      files: z.array(z.string()),
      validation: z.string(),
      dependsOn: z.array(z.string()),
      type: z.enum(['create', 'modify', 'delete', 'refactor']),
    })),
    summary: z.string().describe('Brief summary of the plan'),
  }),
  jsonSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            files: { type: 'array', items: { type: 'string' } },
            validation: { type: 'string', description: 'Command to verify task completion' },
            dependsOn: { type: 'array', items: { type: 'string' }, description: 'Task IDs this depends on' },
            type: { type: 'string', enum: ['create', 'modify', 'delete', 'refactor'] },
          },
          required: ['title', 'description', 'files', 'validation', 'dependsOn', 'type'],
          additionalProperties: false,
        },
      },
      summary: { type: 'string' },
    },
    required: ['tasks', 'summary'],
    additionalProperties: false,
  },
})
```

Update `toolDefinitions` to include `propose_plan`, and add it to `roleTools.manager`.

### 3. `packages/server/src/agent/manager.ts` — Rewrite to conversation-first

Replace the single-call `managerLoop()` with a conversation-based approach.

#### New system prompt

```ts
function buildManagerConversationPrompt(
  projectDir: string,
  tree: string,
  summary: string,
): string {
  return [
    'You are the Manager — a software engineering planning agent. Your job is to:',
    '',
    '1. Understand the user\'s task through conversation',
    '2. Ask clarifying questions about scope, constraints, and preferences',
    '3. Explore the codebase using your tools when needed',
    '4. When you have enough context, produce a structured plan using propose_plan',
    '',
    'You have access to these tools:',
    '- search_files(query): search the summary index to find relevant files (FREE)',
    '- read_file(path): read a file to understand the codebase',
    '- list_files(path): list directory contents',
    '- propose_plan(tasks, summary): propose a structured plan when ready',
    '',
    'IMPORTANT RULES:',
    '- Do NOT call propose_plan on the first message — gather context first',
    '- Ask 2-4 clarifying questions before planning',
    '- Only read files you need to understand the task',
    '- When calling propose_plan, each task must have a unique ID starting from "task-1"',
    '- Tasks should be independent where possible; specify dependencies explicitly',
    '- Each task needs a validation command that actually tests the change',
    '',
    'Project directory: ' + projectDir,
    '',
    'Project structure:',
    tree,
    '',
    'File summaries:',
    summary,
  ].join('\n')
}
```

#### New `managerConversationTurn()` function

Runs one turn of the Manager's conversation loop:

```ts
export interface ManagerTurnInput {
  sessionId: string
  projectDir: string
  userMessage: string
  model: string
  apiKey: string
  events: PushEvents
  db: SqliteDb
  messages: OpenRouterMessage[] // accumulated conversation history
}

export type ManagerTurnResult =
  | { type: 'response'; response: string }  // Manager replied to user
  | { type: 'plan'; plan: ManagerPlan }      // Manager called propose_plan

export async function managerConversationTurn(
  input: ManagerTurnInput,
): Promise<ManagerTurnResult> {
  const { sessionId, projectDir, userMessage, model, apiKey, events, db, messages } = input

  // Append user message to history
  messages.push({ role: 'user', content: userMessage })

  // Build context if first turn
  let tree = ''
  let summaryIndex: SummaryEntry[] = []
  if (messages.length <= 2) { // system + first user message
    try {
      const entries = scanProject(projectDir)
      tree = buildNestedTree(entries)
      summaryIndex = buildSummaryIndex(projectDir, entries)
    } catch {
      tree = '(unable to read project tree)'
    }
  }

  // Build system prompt on first turn, reuse on subsequent turns
  if (messages.length === 2) { // about to add system prompt
    const summaryText = formatSummaryIndex(summaryIndex)
    messages.unshift({
      role: 'system',
      content: buildManagerConversationPrompt(projectDir, tree, summaryText),
    })
  }

  const toolSpecs = getManagerToolSpecs() // includes propose_plan

  // Stream LLM response
  const result = await streamChatCompletion(
    { apiKey, model, messages, tools: toolSpecs },
    (text) => events.push('session.assistantDelta', sessionId, { text }),
    (thinking) => events.push('session.thinkingDelta', sessionId, { text }),
  )

  // Check if LLM called propose_plan
  if (result.message.tool_calls && result.message.tool_calls.length > 0) {
    for (const toolCall of result.message.tool_calls) {
      if (toolCall.function.name === 'propose_plan') {
        // Parse the plan
        const args = JSON.parse(toolCall.function.arguments)
        const plan = parsePlan(args, projectDir)

        // Persist assistant message
        appendMessage(db, sessionId, nextSeq(db, sessionId), 'assistant', JSON.stringify(plan))

        return { type: 'plan', plan }
      }

      // Other tools (search, read, list) — dispatch to sandboxed worker
      // ... (same dispatch logic as existing loop.ts)
    }
  }

  // Regular text response — stream to user
  const content = result.message.content ?? ''
  appendMessage(db, sessionId, nextSeq(db, sessionId), 'assistant', content)

  // Append assistant response to conversation history
  messages.push(result.message)

  return { type: 'response', response: content }
}
```

#### `parsePlan()` — extracted from existing `managerLoop()`

Same logic as today: validates dependency references, normalizes task types, assigns IDs.

### 4. `packages/server/src/session/manager.ts` — New flow

#### Updated `startSession()`

```ts
async startSession(sessionId: string, apiKey: string): Promise<void> {
  // Load session from DB
  const row = /* ... existing query ... */

  // Load permissions
  const permissions = loadPermissions(row.project_dir) ?? defaultPerms

  // Launch sandboxed worker
  const handle = await this.launcher(/* ... */)
  this.handles.set(sessionId, handle)

  // Create manager agent
  const registry = new AgentRegistry(this.db)
  const managerAgent = registry.createAgent(sessionId, 'manager', 'Conversational planning')
  registry.updateStatus(managerAgent.id, 'running')

  // Set status to 'talking'
  this.setStatus(sessionId, 'talking')
  this.events.push('session.statusChanged', sessionId, { status: 'talking' })

  // Initialize conversation history
  const conversationHistory: OpenRouterMessage[] = []

  // Store conversation state for this session
  this.conversations.set(sessionId, {
    history: conversationHistory,
    handle,
    registry,
    managerAgentId: managerAgent.id,
  })
}
```

#### New `sendMessage()` routing

```ts
async sendMessage(sessionId: string, content: string, apiKey: string): Promise<void> {
  const status = this.getStatus(sessionId)

  if (status === 'talking') {
    // Dispatch to Manager conversation turn
    const conv = this.conversations.get(sessionId)
    if (!conv) throw new Error('No conversation state')

    const result = await managerConversationTurn({
      sessionId,
      projectDir: /* from DB */,
      userMessage: content,
      model: /* from DB */,
      apiKey,
      events: this.events,
      db: this.db,
      messages: conv.history,
    })

    if (result.type === 'plan') {
      // Manager called propose_plan — transition to confirming
      this.setStatus(sessionId, 'confirming')
      this.conversations.get(sessionId)!.proposedPlan = result.plan
      this.events.push('session.planProposed', sessionId, { plan: result.plan })
    }
    // If result.type === 'response', the text was already streamed to the user
  }
  else if (status === 'executing') {
    // Dispatch to worker (existing behavior)
    const handle = this.handles.get(sessionId)
    if (!handle) throw new Error('No worker handle')
    // ... existing tool dispatch logic ...
  }
  else {
    throw new Error(`Cannot send message in status '${status}'`)
  }
}
```

#### New `confirmPlan()` method

```ts
async confirmPlan(sessionId: string, editedTasks?: PlannedTask[], apiKey?: string): Promise<void> {
  const conv = this.conversations.get(sessionId)
  if (!conv || !conv.proposedPlan) throw new Error('No proposed plan')

  const plan: ManagerPlan = editedTasks
    ? { ...conv.proposedPlan, tasks: editedTasks }
    : conv.proposedPlan

  this.events.push('session.planConfirmed', sessionId, {})
  this.setStatus(sessionId, 'executing')

  // Run master loop in background
  if (apiKey) {
    masterLoop({
      sessionId,
      projectDir: /* from DB */,
      plan,
      model: /* from DB */,
      apiKey,
      events: this.events,
      db: this.db,
      registry: conv.registry,
      launchWorker: async (job) => {
        const workerHandle = await this.launcher({
          sessionId,
          projectDir: job.projectDir,
          permissions: job.permissions,
          allowUnenforced: false,
          allowedTools: job.allowedTools,
        }, (report) => this.recordSandboxReport(sessionId, report))
        return workerHandle
      },
    }).then((result) => {
      this.appendMessage(sessionId, result.summary)
      this.setStatus(sessionId, 'done', Date.now())
      this.events.push('session.completed', sessionId, {})
    }).catch((e) => {
      this.setStatus(sessionId, 'failed', Date.now())
      this.events.push('session.failed', sessionId, { message: e.message })
    })
  }
}
```

#### New `rejectPlan()` method

```ts
rejectPlan(sessionId: string): void {
  const conv = this.conversations.get(sessionId)
  if (!conv) return

  conv.proposedPlan = undefined
  this.setStatus(sessionId, 'talking')
  this.events.push('session.statusChanged', sessionId, { status: 'talking' })
}
```

#### Conversation state storage

```ts
interface ConversationState {
  history: OpenRouterMessage[]
  handle: LaunchHandle
  registry: AgentRegistry
  managerAgentId: string
  proposedPlan?: ManagerPlan
}

private conversations = new Map<string, ConversationState>()
```

### 5. `packages/server/src/ws/handlers/sessions.ts` — New RPC handlers

```ts
router.register('session.confirmPlan', async (params: { sessionId: string; tasks?: PlannedTask[] }, ctx) => {
  if (!ctx.apiKey) throw new Error('Server not configured with API key')
  await ctx.sessions.confirmPlan(params.sessionId, params.tasks, ctx.apiKey)
  return { ok: true as const }
})

router.register('session.rejectPlan', (params: { sessionId: string }, ctx) => {
  ctx.sessions.rejectPlan(params.sessionId)
  return { ok: true as const }
})
```

### 6. `packages/web/src/hooks/useSession.ts` — New state + event handlers

#### Updated `SessionState`

```ts
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
```

#### New event subscriptions

```ts
unsubs.push(
  client.on('session.planProposed', (payload) => {
    const p = payload as { sessionId: string; plan: ManagerPlan }
    if (p.sessionId !== sessionId) return
    setState((s) => ({
      ...s,
      status: 'confirming',
      planTasks: p.plan.tasks,
      _streamingText: '',
      thinkingText: '',
    }))
  }),
)

unsubs.push(
  client.on('session.planConfirmed', (payload) => {
    const p = payload as { sessionId: string }
    if (p.sessionId !== sessionId) return
    setState((s) => ({
      ...s,
      status: 'executing',
      _streamingText: '',
    }))
  }),
)

unsubs.push(
  client.on('session.statusChanged', (payload) => {
    const p = payload as { sessionId: string; status: string }
    if (p.sessionId !== sessionId) return
    setState((s) => ({
      ...s,
      status: p.status as SessionState['status'],
    }))
  }),
)
```

#### New actions

```ts
const confirmPlan = useCallback(async (editedTasks?: PlannedTask[]) => {
  const sid = stateRef.current.sessionId
  if (!sid) return
  try {
    await client.call('session.confirmPlan', { sessionId: sid, tasks: editedTasks })
  } catch (e) {
    setState((s) => ({ ...s, status: 'failed', error: String(e) }))
  }
}, [client])

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
```

### 7. `packages/web/src/views/ChatView.tsx` — Plan confirmation UI

When status is `confirming`, show the plan review screen:

```tsx
{session.status === 'confirming' && (
  <div className="p-6 max-w-3xl mx-auto w-full">
    <h2 className="text-lg font-bold text-white mb-2">Proposed Plan</h2>
    <p className="text-sm text-gray-400 mb-4">
      Review the tasks below. You can edit them or confirm to start execution.
    </p>

    <PlanView
      tasks={session.planTasks}
      editable={true}
      onTasksChange={(updated) => setEditedTasks(updated)}
    />

    <div className="flex gap-3 mt-6">
      <button
        onClick={() => session.confirmPlan(editedTasks)}
        className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 rounded-lg text-white font-medium transition-colors"
      >
        Confirm & Execute
      </button>
      <button
        onClick={() => session.rejectPlan()}
        className="px-4 py-2.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-gray-300 transition-colors"
      >
        Keep Talking
      </button>
    </div>
  </div>
)}
```

Update `isStreaming` to include new statuses:

```ts
const isStreaming = session.status === 'streaming' || session.status === 'creating'
  || session.status === 'talking' || session.status === 'planning'
  || session.status === 'executing'
```

Show input when status is `talking` (allow user to keep chatting):

```tsx
{!isStreaming && session.status !== 'confirming' && (
  /* input area */
)}
```

---

## Implementation order

1. **`@vajra/protocol`** — Add `propose_plan` tool, new push events, new RPC methods, new session statuses
2. **`manager.ts`** — Rewrite to conversation loop with `propose_plan` interception
3. **`session/manager.ts`** — Wire up `confirmPlan`/`rejectPlan`, new `sendMessage` routing
4. **`handlers/sessions.ts`** — Register new RPC handlers
5. **Frontend `useSession.ts`** — New state, actions, event subscriptions
6. **Frontend `ChatView.tsx`** — Plan confirmation UI
7. **Tests** — Update stale tests, add conversation loop tests

---

## Open questions

1. **Manager tool dispatch**: The Manager currently runs in the main process and dispatches file tools (`read_file`, `list_files`, `search_files`) to the sandboxed worker via `handle.callTool()`. `propose_plan` is intercepted before dispatch. This means the Manager can read the project's files through the worker's sandbox — is this the desired security boundary, or should the Manager have its own read-only access?

2. **Conversation persistence**: Currently, conversation history lives in memory (`ConversationState.history`). If the server restarts, the conversation is lost. Should we persist the full conversation to the `messages` table and reconstruct it on attach? The existing `attach()` already loads messages from DB.

3. **Plan editing granularity**: Should users be able to edit individual task descriptions, or only toggle/reorder tasks? Full editing requires a richer UI component.

4. **Manager autonomy**: The Manager autonomously decides when to call `propose_plan`. Should there be a minimum number of conversation turns before it's allowed to propose? Or should the system prompt handle this guidance?

---

## Test plan

1. **Unit tests for `managerConversationTurn()`**: Mock OpenRouter responses, verify tool interception
2. **Integration test for full flow**: Create session → send messages → verify plan proposed → confirm → verify master started
3. **Frontend tests**: Plan confirmation UI renders, confirm/reject buttons work
4. **Update stale tests**: `agent-tools.test.mjs` expects 3 tools but schema has 6 — fix assertion count
5. **Schema tests**: Verify new session statuses are accepted by the DB
