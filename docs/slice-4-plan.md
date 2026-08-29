# Slice 4 Plan: `agent/loop.ts` — Plan-Then-Execute Orchestration

## Overview

The agent loop is the brain that wires Slices 1-3 together: it takes a user
task, asks the LLM to plan it, then executes each step by dispatching tool
calls to the sandboxed worker. It persists everything to SQLite and emits
push events for the UI.

## Architecture

```
User task + projectDir + model + permissions
    │
    ▼
┌─ agentLoop() ─────────────────────────────────────────────┐
│                                                            │
│  1. BUILD CONTEXT                                          │
│     - scanProject(projectDir) → file tree                  │
│     - Build system prompt with file tree + task            │
│                                                            │
│  2. PLAN PHASE                                             │
│     - chatCompletion({system, user: task, tools})          │
│     - Parse plan steps from response text                  │
│     - Persist plan_steps to SQLite                         │
│     - Push session.planUpdated                             │
│                                                            │
│  3. EXECUTE PHASE (loop per step)                          │
│     - Push session.stepStatus(active)                      │
│     - Build messages array (system + history + step ctx)   │
│     - Inner loop:                                          │
│       chatCompletion(messages, tools)                      │
│       ├─ tool_calls → parseToolCall() each                 │
│       │             → push session.toolCall                 │
│       │             → handle.callTool() via IPC             │
│       │             → push session.toolResult               │
│       │             → append to messages + history          │
│       │             → loop back                            │
│       └─ no tool_calls → text response                     │
│                      → push session.assistantDelta          │
│                      → step done                           │
│     - Persist messages to SQLite                            │
│     - Push session.stepStatus(done)                         │
│                                                            │
│  4. COMPLETION                                             │
│     - Push session.completed                                │
│     - Return summary                                       │
│                                                            │
│  ERROR RECOVERY:                                           │
│  - Tool errors fed back to model as tool_result            │
│  - Model decides whether to retry or skip                   │
│  - Max tool calls per session: configurable (default 50)   │
│  - On max exceeded: fail session with clear message        │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

## Files to Create/Modify

### 1. CREATE: `packages/server/src/agent/loop.ts`

The main agent loop module. Exports `agentLoop()`.

```typescript
interface AgentLoopInput {
  session: { id: string; projectDir: string; task: string; model: string }
  apiKey: string
  permissions: PermissionsConfig
  handle: LaunchHandle        // from launcher.ts
  events: PushEvents          // from manager.ts
  db: SqliteDb                // for persisting plan_steps + messages
  maxToolCalls?: number       // default 50
}

interface AgentLoopResult {
  summary: string
  toolCallCount: number
}
```

**System prompt structure:**
```
You are a software engineering agent working inside a project directory.

Project structure:
{file_tree from scanProject}

Your task: {user_task}

You have access to these tools: {tool_specs}
Use them to complete the task. When you're done, respond with a summary.
```

**Plan parsing:**
- The model responds with a numbered plan in text
- Parse lines matching `^\d+\.?\s+(.+)` as step titles
- Persist each as a `plan_steps` row with status `pending`
- Push `session.planUpdated` after all steps are inserted

**Execute phase (per step):**
1. Set step status to `active`, push `session.stepStatus`
2. Build messages array:
   - `[0]` system prompt
   - `[1]` user message: "Execute step {index}: {title}"
   - `[2..n]` conversation history from previous steps
3. Call `chatCompletion()` with tools
4. If `finish_reason === 'tool_calls'`:
   - Parse each tool call via `parseToolCall()`
   - For each: push `session.toolCall`, call `handle.callTool()`, push `session.toolResult`
   - Append assistant message (with tool_calls) and tool results to messages
   - Loop back to step 3
5. If `finish_reason === 'stop'` or null:
   - Push `session.assistantDelta` with text
   - Step complete → set status `done`, push `session.stepStatus`
6. Persist all messages for this step to SQLite
7. Check tool call count against `maxToolCalls`

**Error handling:**
- Tool call errors are sent back to the model as `tool_result` with `ok: false`
- The model sees the error and can retry with a different approach
- If `maxToolCalls` exceeded: set session status `failed`, push `session.failed`
- If OpenRouter request fails: set session status `failed`, push `session.failed`
- If `handle.stop()` is called: abort immediately, set status `stopped`

### 2. MODIFY: `packages/server/src/session/manager.ts`

Add `startSession()` method that:
1. Gets the handle from `this.handles.get(sessionId)`
2. Calls `agentLoop()` with the session data, handle, db, events
3. Catches errors and marks session `failed`

```typescript
async startSession(sessionId: string, apiKey: string): Promise<void> {
  const handle = this.handles.get(sessionId)
  if (!handle) throw new Error(`No handle for session ${sessionId}`)

  // Read session data from DB
  const session = this.getSession(sessionId)

  try {
    await agentLoop({
      session,
      apiKey,
      permissions: /* from DB */,
      handle,
      events: this.events,
      db: this.db,
    })
    this.setStatus(sessionId, 'done', Date.now())
    this.events.push('session.completed', sessionId, {})
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    this.setStatus(sessionId, 'failed', Date.now())
    this.events.push('session.failed', sessionId, { message })
  }
}
```

### 3. MODIFY: `packages/server/src/ws/handlers/sessions.ts`

In `session.create` handler:
- After launcher succeeds, call `manager.startSession(sessionId, apiKey)`
- The API key comes from the server config (passed to `startServer()`)

### 4. CREATE: `packages/server/test/agent-loop.test.mjs`

Tests for the agent loop. Mock OpenRouter responses, verify:
- Plan parsing from model response
- Step status transitions (pending → active → done)
- Tool call dispatch and result handling
- Error recovery (tool error → model retries)
- Max tool call limit
- Session completion
- Stop during execution

## Security Invariants Preserved

1. **API key isolation**: `agentLoop()` holds the key in the main process; worker never sees it
2. **Subscribe before emit**: `startSession()` must be called after the creating connection is subscribed
3. **Double validation**: `parseToolCall()` pre-validates, worker re-validates at the security boundary
4. **No `run_shell`**: Only `run_command` in the tool set
5. **Explicit dispatch**: Worker maps tools by name with positional args

## Push Events Emitted

| Event | When | Payload |
|-------|------|---------|
| `session.planUpdated` | After plan steps parsed | `{ steps: PlanStep[] }` |
| `session.stepStatus` | Step status changes | `{ index, status }` |
| `session.assistantDelta` | Model produces text | `{ text }` |
| `session.toolCall` | Before dispatching to worker | `{ callId, tool, args }` |
| `session.toolResult` | After worker returns result | `{ callId, tool, ok, result?, error? }` |
| `session.completed` | All steps done | `{}` |
| `session.failed` | Fatal error | `{ message }` |

## Test Plan

1. **Unit tests**: Plan parsing, message building, tool call count tracking
2. **Integration tests**: Full loop with mocked OpenRouter + real worker
3. **Edge cases**: Empty plan, tool error recovery, max limit, stop during execution

## Estimated LOC

- `loop.ts`: ~250-300 lines
- `manager.ts` additions: ~40 lines
- `sessions.ts` modifications: ~15 lines
- `test/agent-loop.test.mjs`: ~200 lines
