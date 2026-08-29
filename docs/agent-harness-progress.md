# Progress: vajra web-app SWE agent harness

Tracks implementation of the plan in
`/home/mrugesh/.claude/plans/glistening-fluttering-frost.md` (approved) —
`packages/protocol`, `packages/server`, `packages/web` on top of the
existing `vajra-native` core. Updated as each slice/task progresses; treat
this file, not chat history, as the source of truth for "what's actually
done" across sessions.

## Architecture summary

vajra's own tool-calling SWE agent (not a mirror of an existing CLI): an LLM
via OpenRouter (user API key) plans a task, then executes it by calling
tools that wrap `vajra-native` functions, running inside the sandbox. No
PTY/node-pty/xterm.js. Two processes per session:

- **Main server process** (unsandboxed): WS, SQLite, the OpenRouter API key,
  the agent loop. **Must never call `applySandbox`.**
- **Sandboxed worker** (`packages/server/worker/sandboxed-worker.mjs`,
  `child_process.fork()`): the *only* file that calls `applySandbox`. Pure
  `{callId, tool, args} -> native.*` dispatch loop after that. Never sees the
  API key or conversation — only individual tool calls.

Key decisions: OpenRouter only, explicit plan-then-execute, structured
activity log (no terminal), autonomous within the sandbox (no per-action
approval), SQLite from the start, `run_shell` excluded from the tool list
(argv-only `run_command`).

Full detail, security invariant checklist, SQL schema, and WS protocol are
in the plan file above — this doc tracks *status*, not the design itself.

## Slice status

| # | Slice | Status |
|---|---|---|
| 1 | `packages/protocol` + `packages/server` skeleton | **done** |
| 2 | `sandboxed-worker.mjs` + dispatch-loop EACCES test | **done** |
| 3 | OpenRouter client + tool schema mapping | **done** |
| 4 | `agent/loop.ts` plan-then-execute orchestration | **done** |
| 5 | `packages/web` skeleton + UI components | **done** |
| 6 | Reconnect/replay from SQLite | **done** |

## Slice 1 detail

### Done

- **Workspace**: `pnpm-workspace.yaml` now includes `.` (root) so
  `packages/server` can depend on the root `vajra-native` package via
  `workspace:*`. Added `allowBuilds: { better-sqlite3: true }` — this pnpm
  version (11.9.0) reads that key, not `onlyBuiltDependencies` in
  `package.json`'s `pnpm` field (tried that first; pnpm warned it's no
  longer read here).
- **`packages/protocol`** — complete, built, tested (4/4 passing):
  - `src/rpc.ts` — `RpcRequest`/`RpcResponse`/`PushEvent` envelope.
  - `src/tools.ts` — 10 tool definitions (`read_file`, `write_file`,
    `edit_file`, `delete_file`, `delete_dir`, `create_dir`, `list_files`,
    `copy_file`, `rename_file`, `run_command`), each with a zod schema (JS
    runtime validation) and a hand-written JSON Schema (for the OpenRouter
    `tools[].function.parameters` field — no `zod-to-json-schema` dependency
    added, kept both by hand since there are only 10). `run_shell`
    deliberately absent. `toOpenAiToolSpecs()` helper.
  - `src/messages.ts` — hand-mirrored `PermissionsConfig`/`ProjectFileEntry`
    (not imported from `vajra-native` — that package's loader can't run in a
    browser bundle) + RPC method param/result shapes + push-event payload
    shapes.
  - Test: `test/tools.test.mjs` — schema validation (good + malformed
    input), confirms `run_shell` absent, confirms `toOpenAiToolSpecs()`
    shape.
- **`packages/server`** — scaffolded, builds clean, **6/6 tests passing**:
  - `src/db/schema.sql` — `sessions`/`plan_steps`/`messages` tables per plan
    (structured turns, no byte-blob scrollback table — that was specific to
    the abandoned PTY design).
  - `src/db/client.ts` — `better-sqlite3` wrapper; `schema.sql` is copied
    into `dist/db/` by `scripts/copy-schema.mjs` (a **portable Node script**,
    not `cp`/`mkdir -p` — those are Unix-only and this project's whole point
    is Windows parity too).
  - `src/native.ts` — the **capabilities-only** choke point:
    `scanProject`/`defaultPermissions`/`loadPermissions`/`savePermissions`/
    `sandboxCapabilities`. **Deliberately does not export `applySandbox`** —
    return types are annotated with `@vajra/protocol`'s mirrored shapes
    (structural typing catches drift for real, no casts needed; confirmed
    the root `index.d.ts` shapes are structurally identical first).
  - `src/ws/rpc.ts` — `RpcRouter`: register-by-method-name, dispatch wraps
    handler success/throw into `RpcResponse`.
  - `src/ws/server.ts` — `ClientConnection` wrapper (per-connection
    subscription set for push events), `createAppServer(httpServer, {db,
    launcher})`.
  - `src/ws/handlers/{projects,sessions}.ts` — RPC handlers. Note in
    `sessions.ts`: `session.attach` subscribes the connection *before*
    reading current state, so no push event between read and subscribe can
    be missed.
  - `src/session/manager.ts` — `SessionManager` with an **injected**
    `SessionLauncher` (slice 2 supplies the real one). Default
    `notImplementedLauncher` always throws — `session.create` catches that,
    marks the session `failed`, and pushes `session.failed`. This is
    deliberate fail-closed behavior for this slice, not a placeholder to
    relax: there is no code path where a session silently ends up "running"
    unsandboxed because a launcher wasn't wired up yet.
  - `src/index.ts` — `startServer({port, dbPath, launcher})` returns
    `{port, close()}`; CLI entrypoint guarded by `import.meta.url` check.
    Default port 4820 (legacy CLI's old GUI used 4823 — kept distinct).
  - Tests: `test/db.test.mjs` (2 tests — schema/FK/round-trip) +
    `test/server.test.mjs` (4 tests — project.scan+permissions round-trip
    over a real `ws` client, unknown-method error, session.create
    fail-closed, session.list). All 6 passing.

### Resolved issues (slice 1)

**`http.Server#close()` hang.** Node's `close()` callback waits for every
open connection, including already-upgraded WebSocket sockets, which can
race with a client's `ws.close()` called a moment earlier. Fixed in
`src/index.ts`'s `close()` by terminating `wss.clients` before calling
`wss.close()`/`httpServer.close()`.

**`session.create` test hang — a real design bug, not a test artifact.**
Push events were only ever delivered to connections that had subscribed via
`session.attach`. But `session.create`'s stub launcher
(`notImplementedLauncher`) fails *synchronously within* `create()` — before
the handler even has a `sessionId` to hand back to the client — so
`events.push('session.failed', ...)` fired into an empty subscriber set and
was silently dropped. A client waiting on that event (or the real UI, once
built) would hang forever with no way to learn the session failed.

Fix: `SessionManager.create()` now takes a `subscribe(sessionId)` callback
and calls it *immediately after* inserting the session row, *before*
invoking the launcher — so the creating connection is subscribed to that
session's event channel before anything can be pushed to it. The handler in
`ws/handlers/sessions.ts` passes `ctx.connection.subscribe`. This same
principle will matter again in slice 2 (worker's sandbox report) and slice 4
(early plan/tool-call events) — always subscribe before starting whatever
might emit, never after.

## Slice 2 detail

### Done

- **`worker/sandboxed-worker.mjs`** — the only file in the tree that calls
  `applySandbox` (verified mechanically: `grep -rn applySandbox src/`
  returns only comments). Forked via `child_process.fork()`, not
  `node-pty` — there's no PTY, no third-party CLI ever exec'd. On startup:
  re-derives `sandboxCapabilities()` itself, refuses if `unsupported` and
  not `allowUnenforced` (sends `{type:'refused', message}` and exits before
  ever calling `applySandbox`), else applies the sandbox and sends
  `{type:'sandbox-report', report}` over IPC — before registering the
  `'call'` message handler, so nothing can be dispatched before the report
  is sent. Dispatch table maps each of the 10 tool names to its native
  function with an **explicit positional-argument mapping** (not a generic
  object-spread) — argument order matters (`deleteDir(path, recursive)`,
  not alphabetical) and a generic spread would be one field-reorder away
  from silently calling the wrong function correctly-shaped but
  wrong-ordered. Tool args are validated against `@vajra/protocol`'s zod
  schemas again inside the worker itself — this process is the actual
  security boundary, so it doesn't trust that whatever sent the message
  upheld the tool's contract.
- **`src/session/launcher.ts`** (`forkSessionLauncher`) — the real
  `SessionLauncher` slice 1 left as an injected stub. Forks the worker with
  an **explicit env allowlist** (`PATH`, `SystemRoot`, `TEMP`, `TMP`, `HOME`,
  `USERPROFILE` — never `{...process.env}`), waits for its sandbox report or
  refusal, resolves a `WorkerHandle` implementing `callTool()`/`stop()`.
  `LaunchHandle` (slice 1's interface) extended with `callTool(tool, args)`.
- Tests (11 new, all passing; 1 skip is the Windows-only refusal path,
  correctly unreachable on Linux):
  - `test/sandbox-tool-dispatch.test.mjs` (5) — forks the worker directly
    (mirrors the root package's `test/fixtures/sandbox-child.mjs` pattern,
    fixtures under `$HOME` via the same `outsideAnyGrant` helper, not
    `os.tmpdir()` — that macOS footgun is already documented in the root
    repo). Proves the *dispatch loop*, not just `applySandbox` itself,
    denies an out-of-project `read_file`/`write_file`/`run_command`; also
    covers unknown-tool and malformed-args rejection without killing the
    worker.
  - `test/launcher.test.mjs` (6) — the TypeScript-side client: report
    delivery, `callTool` end to end, `stop()` rejecting pending calls, the
    Windows refusal path (skipped here), and the **API-key isolation test**
    from the security checklist — sets a sentinel `OPENROUTER_API_KEY` in
    the test process's real env, dispatches a `run_command` tool call that
    reads that env var from *inside* the worker, asserts the sentinel never
    appears in the output. Uses `printenv`/`cmd` (already covered by the
    sandbox's default system-path grants), not the test's own Node binary —
    that first attempt failed for an unrelated, real reason (below).

### A real finding, not a test bug

The first version of the API-key test spawned `process.execPath` (the
runner's own Node binary) as the `run_command` target and got `EACCES`
(`Permission denied`). Root cause: this environment's Node is NVM-installed
under `$HOME/.nvm/versions/node/...`, which is **not** covered by the
sandbox's default read+execute grants (`/usr`, `/bin`, `/lib`, `/etc`, …
only). That's not a test artifact — it means any real `run_command` tool
call in this environment that tries to invoke a bare `node`/`npm`/etc. would
hit the same denial, since NVM-installed toolchains live outside the
default allowlist. **Worth remembering for slice 4/5**: if the agent needs
to run project tooling installed via NVM (or similarly non-`/usr`-rooted
version managers), the session's `SandboxConfig.readExecutePaths` will need
to include that toolchain's actual install directory — it will not work by
default. Not fixed now (out of scope for this slice, and the right fix is
"the harness resolves and grants it," not "widen the default grants").

## Slice 3 detail

### Done

- **`src/agent/openrouter.ts`** — OpenAI-compatible chat-completions client
  against `https://openrouter.ai/api/v1/chat/completions`. No HTTP library
  dependency: Node's global `fetch`/`ReadableStream`/`TextDecoder` (18+)
  cover it. `fetchImpl` is injectable (defaults to global `fetch`) so every
  test below runs with zero network access and no API key.
  - `chatCompletion()` — non-streaming; parses `choices[0].message` +
    `finish_reason`, throws with the response body included on a non-2xx
    status.
  - `streamChatCompletion()` — SSE streaming. `consumeSseStream()` handles
    the two things that actually make this hard: chunk boundaries that
    don't align with SSE line boundaries (buffered, tested by feeding the
    fixture stream through in arbitrary 7-byte slices rather than one
    aligned write), and tool-call deltas that arrive **fragmented by
    index** across many chunks — `id`/`function.name` typically only on the
    first fragment, `function.arguments` a partial JSON string that must be
    *concatenated*, never replaced, across fragments. A malformed individual
    SSE frame is skipped, not fatal to the whole stream.
- **`src/agent/tools.ts`** — bridges OpenRouter's wire format
  (`{id, function:{name, arguments: <JSON string>}}`) to the internal
  `{callId, tool, args}` shape the worker's dispatch loop expects.
  `parseToolCall()` validates the tool name against `@vajra/protocol`'s
  `toolDefinitions`, JSON-parses `arguments`, and validates against the same
  zod schema the worker re-validates independently — this layer exists so a
  malformed model response (unknown tool, non-JSON arguments, a schema
  mismatch) produces an immediate tool-result error without spending an IPC
  round trip on something already known to be invalid. It does not replace
  the worker's own check; both layers validate independently on purpose.
- Tests (15 new, all passing): request-shape assertions (headers, body,
  `tool_choice`, `stream: false`/`true`), non-2xx and no-choices error
  paths, non-streaming `tool_calls` parsing, streaming content-delta
  accumulation with live `onTextDelta` callback verification, streaming
  tool-call fragment accumulation (including **multiple concurrent tool
  calls interleaved by index** — the model can ask for more than one tool
  in a single turn), malformed-frame tolerance, and the full
  `parseToolCall` validation matrix (good call, unknown tool, non-JSON
  arguments, schema mismatch, confirms `run_shell` — deliberately excluded
  from the tool set — is rejected as unknown rather than silently handled).

## Slice 4 detail

### Done

- **`src/agent/loop.ts`** (~330 lines) — the plan-then-execute orchestration:
  - `buildSystemPrompt()` — includes project file tree via `scanProject()` as
    context so the agent can plan without tool calls during the plan phase.
  - `parsePlanSteps()` — extracts numbered steps from model text responses
    (handles `1.` and `1)` styles, skips blank lines, falls back to single
    step for unnumbered text).
  - `agentLoop()` — the main orchestration function:
    1. **Plan phase**: calls OpenRouter with `toolChoice: 'none'`, parses
       numbered steps, persists to `plan_steps` table, pushes
       `session.planUpdated`.
    2. **Execute phase**: for each step, sets status `active`, builds
       messages array (system + history + step instruction), calls OpenRouter
       with tools, dispatches tool calls via `handle.callTool()`, collects
       results, feeds errors back to model for auto-retry, loops until text
       response.
    3. **Completion**: pushes `session.completed`, returns summary.
  - Persists all messages to SQLite with proper sequence numbers.
  - Configurable `maxToolCalls` (default 50) prevents runaway loops.

- **`src/session/manager.ts`** — added `startSession()` method:
  - Reads session data from SQLite, loads permissions via native layer.
  - Calls `agentLoop()` with the session, handle, db, and events.
  - Updates session status to `done` on success or `failed` on error.
  - Emits `session.completed` or `session.failed` push events.
  - Deletes handle from map on completion (no stale handles).

- **`src/ws/server.ts`** — added `apiKey` to `ServerContext` and
  `CreateAppServerOptions`. The API key flows from `startServer()` through
  the context to the handler.

- **`src/index.ts`** — CLI entry now requires `OPENROUTER_API_KEY`
  environment variable, passes it to `startServer()`.

- **`src/ws/handlers/sessions.ts`** — `session.create` handler now calls
  `startSession()` in the background after the launcher succeeds. The handler
  returns immediately with the `sessionId`, and the loop runs concurrently,
  emitting push events as it progresses.

- Tests (9 new, all passing):
  - `test/agent-loop.test.mjs` — `parsePlanSteps` unit tests (numbered list,
    parentheses style, unnumbered fallback, empty input, blank lines),
    structural tests for event types and tool error handling.

### Security invariants preserved

1. **API key isolation**: key flows through `ServerContext` to `agentLoop()`
   in the main process; worker never sees it.
2. **Subscribe before emit**: `session.create` subscribes the connection
   before invoking the launcher (from slice 1), and `startSession()` is
   called after the connection is subscribed.
3. **Double validation**: `parseToolCall()` pre-validates, worker
   re-validates at the security boundary.
4. **No `run_shell`**: only `run_command` in the tool set.
5. **Explicit dispatch**: worker maps tools by name with positional args.

### Test results

Full suite across all three packages:
- Root: 31 tests (30 pass, 1 skip)
- Protocol: 4/4 passing
- Server: 40 tests (39 pass, 1 skip)

No regressions.

## Slice 5 detail

### Done

- **`packages/web`** — browser UI skeleton, vanilla TypeScript + esbuild,
  zero runtime dependencies (only `@vajra/protocol` for type imports):
  - `package.json` + `tsconfig.json` — workspace package, `type: "module"`,
    scripts: `build`, `dev`, `lint`.
  - `esbuild.config.mjs` — bundles `src/index.ts` to `dist/bundle.js`,
    copies static assets, watch + serve mode for dev (port 8080), minified
    production build.
  - `public/index.html` — single HTML shell with nav (Scan, Sessions),
    connection status indicator, `#app-root` mount point.
  - `public/style.css` — full dark theme (GitHub-inspired), responsive,
    CSS custom properties, status badges, file tree, permission toggles,
    plan steps, tool call log, modal overlay.
  - `src/lib/ws.ts` — `VajraSocket` class: WebSocket wrapper with
    exponential backoff reconnection, typed message/state callbacks.
  - `src/lib/rpc.ts` — `RpcClient`: typed RPC caller over `VajraSocket`,
    unique request IDs, promise-based with timeout, handles `rpc-result`
    responses.
  - `src/lib/events.ts` — `EventBus`: typed push event subscription,
    `on(event, handler)` returns unsubscribe function.
  - `src/client.ts` — `VajraClient`: high-level wrapper combining socket,
    RPC, and event bus. `connect()`, `call()`, `on()`, `onStateChange()`.
  - `src/state.ts` — minimal reactive `signal<T>()` with `get`/`set`/
    `subscribe`. No framework dependency.
  - `src/router.ts` — hash-based `Router` with `on(pattern, handler)` for
    `:param` routes, plus `h()` DOM helper (tag, attrs, children).
  - Components:
    - `status-badge.ts` — colored pill for session status.
    - `file-tree.ts` — recursive file tree renderer with icons.
    - `permission-toggle.ts` — permission row with 4 toggle switches.
    - `plan-steps.ts` — numbered plan step list with status icons.
    - `tool-call-log.ts` — scrollable tool call/result log.
  - Views:
    - `scan.ts` — directory input, scan button, file tree display.
    - `permissions.ts` — load/save permissions, inline toggles per file.
    - `sessions.ts` — session list table, new session modal with task/model
      fields.
    - `session-detail.ts` — real-time session view: plan steps, assistant
      text, tool calls, sandbox status, stop button. Subscribes to all
      `session.*` push events, renders live updates.
  - `src/index.ts` — entry point: boots `VajraClient` (connects to
    `ws://localhost:4820`), starts router, wires views to routes.

### Test results

Full suite across all packages:
- Root: 31 tests (30 pass, 1 skip)
- Protocol: 4/4 passing
- Server: 40 tests (39 pass, 1 skip)

No regressions.

## Slice 6 detail

### Done

- **`packages/protocol/src/messages.ts`** — added `AttachMessage` interface
  and extended `SessionAttachResult` with `messages` and `activeStep` fields.
  No schema changes needed — the `messages` table already had everything.

- **`packages/server/src/session/manager.ts`** — `attach()` method now:
  - Queries `messages` table: `SELECT seq, role, content, tool_name,
    tool_call_id, tool_args, tool_result, created_at FROM messages WHERE
    session_id = ? ORDER BY seq`.
  - Finds the active step from `plan_steps` (`status = 'active'`).
  - Returns `messages: AttachMessage[]` and `activeStep: number | null` in
    addition to the existing `session`, `plan`, `sandbox` fields.

- **`packages/server/test/server.test.mjs`** — updated `session.attach`
  assertions to verify the new `messages` (empty array for failed session)
  and `activeStep` (null) fields are present.

- **`packages/web/src/views/session-detail.ts`** — refactored for
  reconnect/replay:
  - `attach()` now **resets** state from DB (not appends): clears
    `assistantText` and `toolCalls`, rebuilds them from persisted messages.
  - Rebuilds tool calls from `tool`-role messages (matching `toolCallId`,
    `toolName`, `toolArgs`, `toolResult`).
  - Subscribes to `client.onStateChange()` — on `'connected'`, calls
    `attach()` again to re-hydrate from DB.
  - Cleanup now also unsubscribes the state listener.

### How it works

```
Browser disconnects
    │
    ├─ Server continues running agent loop (unchanged)
    ├─ All messages persisted to SQLite (unchanged)
    │
Browser reconnects
    │
    ├─ VajraSocket reconnects (exponential backoff)
    ├─ onStateChange('connected') fires
    └─ attach() called again
         │
         ├─ SELECT session, plan_steps, messages FROM db
         ├─ Reset: assistantText = '', toolCalls = []
         ├─ Rebuild assistantText from assistant-role messages
         ├─ Rebuild toolCalls from tool-role messages
         ├─ renderAll() → UI matches DB state
         └─ Push events resume from new subscription
```

### Test results

Full suite across all packages:
- Root: 31 tests (30 pass, 1 skip)
- Protocol: 4/4 passing
- Server: 40 tests (39 pass, 1 skip)

No regressions.
