# Slice 6 Plan: Reconnect / Replay from SQLite

## Problem Statement

When the browser disconnects (network blip, tab close + reopen, etc.), the
client loses all streamed data. The server continues running the agent loop,
persisting everything to SQLite, but the reconnecting client has no way to
catch up. The session detail view is blank after reconnection.

## Current State Analysis

**What already works:**
- `VajraSocket` has exponential backoff reconnection (ws.ts:95-101)
- The agent loop persists every message, tool call, and tool result to SQLite
  (loop.ts:appendMessage)
- `session.attach` subscribes before reading state (no race condition)

**What is missing (the gaps):**

1. **Server: `attach()` does not return messages.** The method queries
   `sessions` and `plan_steps` but never queries `messages`. The client
   (`session-detail.ts:158`) types the result as having a `messages` array
   but it is always `undefined`.

2. **Server: No in-progress state tracking.** When a session is mid-execution,
   there is no way to tell the client *which* step is active or whether tool
   calls are pending. The `plan_steps` table tracks `status: 'active'` but
   the attach response does not surface this as "current step."

3. **Client: No re-attach on reconnect.** After WebSocket reconnection, the
   `VajraClient` becomes `connected` again but the session detail view never
   re-calls `session.attach`. Subscriptions are lost. The view is stale.

4. **Client: Tool calls not reconstructed from messages.** The `attach()`
   response has no tool call data, so the UI cannot show the history of
   tool calls and results that happened while disconnected.

5. **Protocol types: `SessionAttachResult` lacks messages.** The
   `@vajra/protocol` type definition (`messages.ts:82-86`) does not include
   a `messages` field in `SessionAttachResult`.

## Design Decisions

### Q: Buffer recent events or query the database?

**Answer: Query the database. Do not buffer events.**

Reasoning:
- The agent loop already writes every message to SQLite with proper sequencing.
  The data is authoritative and complete.
- An in-memory buffer would duplicate what SQLite already provides, add
  complexity around buffer lifecycle (how long to keep? what if the server
  restarts?), and create a second source of truth.
- The only thing a buffer buys you is "events that happened in the last N
  seconds before disconnect" which are already in the database by the time
  `appendMessage` returns — SQLite writes are synchronous (WAL mode, single
  connection, no contention).
- Keeping it simple: attach = "give me the full state from the database" and
  the client hydrates from that.

### Q: Should we support reconnecting to a session mid-execution?

**Answer: Yes.** The agent loop keeps running regardless of browser state.
When the client re-attaches, it should see the current state and then receive
live events going forward. The subscription mechanism already handles this
(subscribe before reading state — the existing pattern).

### Q: What about in-flight tool calls that haven't been persisted yet?

**Answer: Not a concern.** The agent loop persists *after* the tool call
completes (loop.ts:276-288), so there is a brief window where a tool call
result is being processed but not yet in the DB. However, this is negligible:
- SQLite WAL writes are sub-millisecond
- If the client reconnects during that tiny window, it will miss one tool
  result, but the very next `session.toolResult` event will catch it up
  anyway (the loop continues regardless)

This is acceptable. No special handling needed.

## Changes Required

### 1. Protocol Types (`packages/protocol/src/messages.ts`)

**Extend `SessionAttachResult` to include messages and active step info.**

```typescript
export interface SessionAttachResult {
  session: SessionListResult[number]
  plan: PlanStep[]
  sandbox: SandboxStatusPayload | null
  messages: AttachMessage[]        // NEW
  activeStep: number | null        // NEW — index of the currently active step, or null
}
```

New type for the message shape returned by attach:

```typescript
export interface AttachMessage {
  seq: number
  role: 'user' | 'assistant' | 'tool'
  content: string | null
  toolName?: string
  toolCallId?: string
  toolArgs?: string     // JSON string
  toolResult?: string   // JSON string
  createdAt: number
}
```

### 2. Server: `SessionManager.attach()` (`packages/server/src/session/manager.ts`)

**Query the `messages` table and the active step.**

Current code (line 128-173) queries `sessions` and `plan_steps`. Add:

```typescript
// Query all messages for this session, ordered by sequence
const messages = this.db
  .prepare(
    `SELECT seq, role, content, tool_name, tool_call_id, tool_args, tool_result, created_at
     FROM messages WHERE session_id = ? ORDER BY seq`
  )
  .all(sessionId) as Array<{
    seq: number
    role: string
    content: string | null
    tool_name: string | null
    tool_call_id: string | null
    tool_args: string | null
    tool_result: string | null
    created_at: number
  }>

// Find the currently active step (if any)
const activeStepRow = steps.find(s => s.status === 'active')
const activeStep = activeStepRow ? activeStepRow.index : null
```

Return both in the result:

```typescript
return {
  session: { ... },
  plan: steps.map(...),
  sandbox: ...,
  messages: messages.map(m => ({
    seq: m.seq,
    role: m.role,
    content: m.content,
    toolName: m.tool_name ?? undefined,
    toolCallId: m.tool_call_id ?? undefined,
    toolArgs: m.tool_args ?? undefined,
    toolResult: m.tool_result ?? undefined,
    createdAt: m.created_at,
  })),
  activeStep,
}
```

### 3. Server: Subscribe the re-attaching connection first (no change needed)

The existing `session.attach` handler in `ws/handlers/sessions.ts:23-28`
already subscribes *before* reading state. This is the correct pattern and
needs no change. When a client reconnects and calls `session.attach`, the
connection is subscribed before the DB read, so no events between read and
subscribe are missed.

### 4. Client: Re-attach on reconnect (`packages/web/src/views/session-detail.ts`)

**The session detail view needs to detect reconnection and re-attach.**

The `VajraSocket` already fires `onStateChange` when the connection moves
from `disconnected` to `connected`. The `VajraClient` exposes this via
`onStateChange()`. The session detail view should subscribe to connection
state changes and call `attach()` when the connection is re-established.

Add after the existing `attach()` call:

```typescript
const unsubState = client.onStateChange((state) => {
  if (state === 'connected') {
    // Re-attach to get the latest state from the database.
    // This covers: (a) browser reconnected after a disconnect,
    // (b) session continued running while browser was offline.
    attach()
  }
})
```

And add `unsubState` to the cleanup array.

**Important subtlety:** When `attach()` is called on reconnect, it should
*reset* the local state before populating from the DB response, not append.
Otherwise you get duplicate assistant text and duplicate tool calls.

Refactor the existing `attach()` function to clear state first:

```typescript
async function attach() {
  try {
    const result = await client.call('session.attach', { sessionId })

    // Reset local state — the DB is the source of truth
    steps = (result as any).plan || []
    assistantText = ''
    toolCalls = []
    sessionData = (result as any).session

    // Rebuild assistant text from messages
    const msgs = (result as any).messages || []
    for (const msg of msgs) {
      if (msg.role === 'assistant' && msg.content) {
        assistantText += msg.content
      }
    }

    // Rebuild tool calls from messages
    for (const msg of msgs) {
      if (msg.role === 'tool' && msg.toolCallId) {
        // Find or create the corresponding tool call entry
        const existing = toolCalls.find(c => c.id === msg.toolCallId)
        if (existing) {
          existing.result = msg.toolResult
        } else {
          // The tool call message itself (assistant role with tool_calls)
          // is what we need — but the messages table stores tool_calls
          // on the assistant row, not as separate entries.
          // We need to reconstruct from the tool result row.
        }
      }
    }

    renderAll()
  } catch (err) {
    assistantText = `Error attaching: ${err}`
    renderAll()
  }
}
```

Wait — there is a subtlety with tool call reconstruction. The `messages`
table stores:
- `role: 'assistant'` rows with `content` (text from the model)
- `role: 'tool'` rows with `tool_name`, `tool_call_id`, `tool_args`, `tool_result`

But the UI also needs the tool call's arguments. These are stored on the
`tool` role row (`tool_args`). The `session.toolCall` push event sends
`{ callId, tool, args }` and `session.toolResult` sends
`{ callId, tool, ok, result, error }`. To reconstruct from the DB:

For each `role: 'tool'` message, we have all the data:
- `tool_call_id` = the call ID
- `tool_name` = the tool name
- `tool_args` = the arguments (JSON)
- `tool_result` = the result (JSON)
- `content` = the result as well (same as tool_result for our loop)

So the client can reconstruct `ToolCall[]` directly from the tool-role
messages:

```typescript
// Rebuild tool calls from tool-role messages
toolCalls = msgs
  .filter(msg => msg.role === 'tool' && msg.toolCallId)
  .map(msg => ({
    id: msg.toolCallId,
    name: msg.toolName,
    arguments: msg.toolArgs || '{}',
    result: msg.toolResult || undefined,
  }))
```

This is clean and correct — no dual tracking needed.

### 5. Client: Handle the assistant text correctly

Currently the client accumulates `assistantText` by appending deltas. After
reconnect, it needs to replace, not append. The `attach()` refactor above
handles this by resetting `assistantText = ''` and rebuilding from messages.

**But there is a gap in the current data model.** The agent loop
(loop.ts:233) persists `assistantMsg.content` as the assistant message, then
pushes `session.assistantDelta` with the same text. But the assistant message
can have *both* `content` and `tool_calls`. The `content` field may be null
when the model only issues tool calls. The persisted data handles this correctly
(`content` is stored as NULL in that case), and the client's `attach()` only
appends non-null content, so this is fine.

### 6. No new RPC methods needed

The existing `session.attach` method is the right place for this. It already:
- Subscribes the connection
- Returns session state
- Returns plan steps

We just extend what it returns. No new methods required.

### 7. No database schema changes needed

The `messages` table already has everything:
- `seq` for ordering
- `role` for user/assistant/tool distinction
- `content` for text
- `tool_name`, `tool_call_id`, `tool_args`, `tool_result` for tool calls

The schema is complete. No migrations needed.

## Implementation Order

1. **Protocol types** — add `messages` and `activeStep` to `SessionAttachResult`,
   add `AttachMessage` type. Rebuild `@vajra/protocol`.

2. **Server: `SessionManager.attach()`** — query `messages` table, find active
   step, return both in the result.

3. **Server: tests** — update existing `attach` test to verify messages and
   activeStep are returned. Add test for mid-execution session (active step).

4. **Client: `session-detail.ts`** — refactor `attach()` to reset + rebuild
   state from DB response, add re-attach on reconnect via `onStateChange`.

5. **Client: tests** — if any client tests exist, verify hydration works.
   (Currently no client test files found — manual verification likely.)

## Edge Cases

| Case | Handling |
|------|----------|
| Session is `done` when client reconnects | `attach()` returns full history. No active step. Client renders complete view. |
| Session is `executing` when client reconnects | `attach()` returns history so far + `activeStep`. Client renders current state, then receives live events. |
| Session is `failed` when client reconnects | `attach()` returns history + status `'failed'`. Client renders error. |
| No messages yet (session is `planning`) | `messages` is empty array. Client shows "Waiting for plan..." as it does now. |
| Browser reconnects multiple times | Each `attach()` call replaces state from DB. Idempotent. |
| Server restarts while session was running | Session status is `planning`/`executing` in DB but no handle exists. `startSession` was never called for the reconnecting browser. The session is orphaned. **Out of scope for slice 6** — this is a separate problem (server-side session resumption) that requires re-launching the agent loop. For now, the session would show as stuck in `planning`/`executing` with no new events. The user can stop it and create a new one. |

## Files Changed

| File | Change |
|------|--------|
| `packages/protocol/src/messages.ts` | Add `AttachMessage` interface, extend `SessionAttachResult` |
| `packages/server/src/session/manager.ts` | Query messages + active step in `attach()` |
| `packages/web/src/views/session-detail.ts` | Refactor `attach()` to reset+rebuild, add re-attach on reconnect |
| `packages/server/test/server.test.mjs` | Update attach test assertions |
| `packages/server/test/agent-loop.test.mjs` | (optional) Test attach returns messages after loop writes them |

## Summary

The core insight is: **everything needed already exists in SQLite**. The agent
loop persists every message, tool call, and result. The schema has the right
columns. The only work is:
1. Have `attach()` actually return the messages (it currently ignores them)
2. Have the client rebuild state from those messages on reconnect

No buffering, no new tables, no new RPC methods. Just wire up what's already
there.
