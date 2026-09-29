# Agent Runtime Package: Current State and Migration Plan

**Status:** Proposed architecture. This document describes the current code and a migration path; it does not change runtime behavior. The current-state notes were checked against `ecbe5df`.

## Goal

Create one `@codekalakaars/vajra-agent` package that owns the common way to define, configure, and run every agent. The Developer, Manager, and Worker use the same runtime lifecycle and tool-call path. Each role supplies its own system prompt, model settings, context builder, and allowed tool set. The package name is `agent` because all code that defines an agent role belongs inside this package.

Keep role authority enforceable in code. A prompt may explain a role, but it must not grant permissions. The runtime must check every tool call against both the role’s allowed tools and the current task or session scope.

Preserve the role authority boundaries in [ADR-0001](docs/adr/0001-developer-only-task-creation.md), [ADR-0002](docs/adr/0002-single-task-workers.md), [ADR-0004](docs/adr/0004-manager-inspects-never-repairs.md), and [ADR-0010](docs/adr/0010-every-role-is-an-llm-agent.md). This plan makes one deliberate workflow change: the Developer remains the only task creator but becomes read-only against the repository; stub, test, and implementation edits become Worker tasks. Update the Phase One role docs and ADRs when that behavior is adopted.

## Where We Are Now

Agent execution is split across several packages and the CLI:

| Concern | Current location | Current responsibility |
|---|---|---|
| Developer LLM loop and plan tools | [`packages/cli/src/agent/developer.ts`](packages/cli/src/agent/developer.ts) | Interprets the request, explores the project, and proposes tasks. |
| Manager scheduling and failure handling | [`packages/cli/src/agent/master.ts`](packages/cli/src/agent/master.ts), [`packages/cli/src/session/service.ts`](packages/cli/src/session/service.ts) | Schedules ready tasks, applies the concurrency limit, retries or stops failed work, and coordinates session state. |
| Task queue and agent registry | [`packages/cli/src/agent/taskqueue.ts`](packages/cli/src/agent/taskqueue.ts), [`packages/cli/src/agent/registry.ts`](packages/cli/src/agent/registry.ts) | Holds task state, dependency readiness, and an in-memory record of which role instance is running. |
| Worker LLM loop and prompt | [`packages/cli/src/tasks/execute.ts`](packages/cli/src/tasks/execute.ts) | Runs a separate model/tool loop for each task and runs that task’s validation commands. |
| Validation support | [`packages/cli/src/tasks/server.ts`](packages/cli/src/tasks/server.ts), [`packages/cli/src/tasks/skip.ts`](packages/cli/src/tasks/skip.ts) | Detects validation commands that need a running server, starts it under a server lock, and evaluates `skipIf` conditions. |
| Model requests | [`packages/cli/src/agent/chat.ts`](packages/cli/src/agent/chat.ts), [`packages/cli/src/agent/context-window.ts`](packages/cli/src/agent/context-window.ts) | Sends model requests and sizes context. Shared by the CLI’s role loops, not owned by a common runtime. |
| Tool schemas and role tool lists | [`packages/protocol/src/tools.ts`](packages/protocol/src/tools.ts), [`packages/agent-core/src/tools.ts`](packages/agent-core/src/tools.ts), [`packages/sandbox/src/tool-rules.ts`](packages/sandbox/src/tool-rules.ts) | Defines tool contracts, the canonical `roleTools` table, role-specific tool lists, and tool permission checks. Role policy is read in three packages. |
| Confined tool process | [`packages/agent-process/src/spawn.ts`](packages/agent-process/src/spawn.ts), [`packages/agent-process/src/worker.ts`](packages/agent-process/src/worker.ts) | Starts child processes that enforce the OS sandbox and execute tool calls over IPC. The LLM conversation itself currently runs in the CLI process; this child is a tool executor, not the complete LLM agent. |
| Sandbox policy and task permissions | [`packages/sandbox/src/`](packages/sandbox/src/) and [`packages/agent-process/src/task-permissions.ts`](packages/agent-process/src/task-permissions.ts) | Builds sandbox configuration, enforces file/tool access, and derives per-task file permissions. `sandbox` also ships a standalone `vajra-sandbox` binary. |
| Locks, rollback, worker pool | [`packages/sandbox/src/file-locks.ts`](packages/sandbox/src/file-locks.ts), [`packages/sandbox/src/change-history.ts`](packages/sandbox/src/change-history.ts), [`packages/sandbox/src/pool.ts`](packages/sandbox/src/pool.ts) | Supplies concurrency and recovery primitives. The CLI creates and applies some of these itself. |
| Native OS operations | Root N-API package and [`packages/core`](packages/core/) | Supplies Rust file, process, path, and Linux sandbox primitives. |

The CLI currently brings these pieces together. That means the role loops do not yet share one agent runner, and runtime policy is divided between the CLI, sandbox package, protocol package, and process package.

The `agent-process` package already provides a separate, one-call confined tool executor. That is a useful isolation boundary to relocate under `agent`; it does not contain the LLM conversation or make Developer, Manager, and Worker share a runtime yet.

Workers currently receive their own task prompt and declared paths, not a live view of the plan or peer progress. The CLI creates two lock managers inside each session (`fileLocks` and `commandResourceLocks` in `service.ts`). Those locks coordinate tasks in that run, but they do not coordinate two separate Vajra sessions using the same checkout. The task runner takes write locks for every declared path, including read-only inputs, which is safe but serializes work that only needs shared reads.

There is also a naming mismatch: `agent-process`’s `Agent` is a confined tool-process handle, while “Developer,” “Manager,” and “Worker” refer to LLM-backed roles. ADR-0010 separately defines an `Agent` record (`role`, `currentTaskId`, `model`). The new runtime should name these concepts distinctly: `AgentInstance` realizes ADR-0010’s `Agent` record, `AgentProfile` defines a role, and `ToolExecutor` is the confined process.

The role name `master` is still used in `AgentRole` in `protocol/src/messages.ts`, `agent-core/src/plan.ts`, and `cli/src/agent/registry.ts`. Roles are not written to the session database, so renaming is a wire and API change, not an on-disk migration.

The sandbox package also contains a worktree helper, but the CLI does not use it for task execution. The intended shared-repository mode should continue to give active tasks the same checkout and make ownership explicit through coordination leases.

`packages/tester` has 36 source files and 222 tests, but no package imports it. Worker validation today is the task’s declared shell commands, run by `execute.ts`; the Manager does not independently verify a completed task or gate its dependents on a Tester verdict.

The role design already says all three roles are LLM agents ([ADR-0010](docs/adr/0010-every-role-is-an-llm-agent.md)). In the shipped CLI, the Manager is not yet the role ADR-0004 and ADR-0010 describe. `master.ts` owns scheduling and a mechanical failure policy (`decideFailure`: retry, skip, or abort). Its opt-in LLM path (`useLlmDecisions`) chooses among those same three actions. Neither path inspects completed work against success criteria, which is the Manager’s defined job. The migration must name this gap rather than carry it into the new runtime.

Two implementation facts make this migration higher risk than a package rename:

- The role tool allowlist is declared but is not enforced at the production dispatch boundary today. Moving the catalog alone will not establish the authorization boundary described below; enforcement needs an explicit behavior change and a refusal test.
- Current CI builds the native addon and runs root smoke tests, but does not run the TypeScript package test suites. The reported local suite baseline is useful, but it is not currently a CI regression gate.

### Intended End-to-End Workflow

```text
Human ⇄ Developer ── approved plan revisions ──▶ Manager
          ▲                                         ├── schedules ──▶ Workers
          │                                         ◀── progress/results
          │                                         └── verify ─────▶ Tester
          └──────── status and reports ◀─────────── ◀── verdict/evidence
```

- The Developer stays available while a run is active. New human messages become Developer turns; resulting work is submitted to the Manager as a new plan revision.
- The Manager owns the active queue, assignments, peer status, file leases, and verification gates. Deterministic code enforces scheduling and permissions. The Manager agent inspects results and reports them to the Developer.
- Workers make all repository changes in the shared checkout. They get relevant goal, dependency, ownership, and peer-status context through the Manager, then report progress and handoffs through structured events.
- The Manager invokes the Tester after a Worker reports completion. It receives structured verdicts and evidence before accepting the task and releasing dependent tasks.
- New requests never silently change an active Worker’s task or permissions. Follow-up work is versioned and queued at a safe boundary.

Conversation state and run state are independent. The Developer can accept input while the Manager run is `running` or `verifying`. The current CLI does not support this: `runSession` awaits `masterLoop` before asking for another Developer turn. Developer tools also include `write_stub` and `delete_stub`, so Phase One scaffolding can currently be written by the Developer; move those mutations into Worker tasks.

## Next Recommended Work

The target product behavior is a **human-facing Developer with Manager-owned background runs**. The Developer understands requests, explores the repository, clarifies requirements, and turns approved intent into versioned tasks. The Manager owns scheduling and run state; Workers make repository changes; the Tester provides independent evidence before the Manager accepts work. The Developer remains available to the human while a run continues.

The first implementation task is **S0: make the existing package test gate real in CI**. CI currently does not run the TypeScript package suites, so behavior-sensitive package moves would otherwise lack a reliable merge gate. The shared worktree now contains uncommitted CI additions for `pnpm build:all` and `pnpm test:all`, plus initial S1 replay artifacts: a shared provider helper and a Developer replay test/fixture. Neither gate has been validated in this planning pass, and the Worker replay is still to be added. The immediate work is to complete S1, validate S0 and S1, then proceed to S2. Follow the serial preparation in [`AGENT_RUNTIME_MIGRATION_EXECUTION.md`](AGENT_RUNTIME_MIGRATION_EXECUTION.md):

1. **S0 — CI gate:** run `pnpm build:all` and `pnpm test:all` in CI and fix any build-order issues those commands expose.
2. **S1 — Behavior replay:** capture representative Developer and Worker provider/tool interactions and replay them to protect tool order, transcript, and event behavior.
3. **S2 — `agent` foundation:** create `packages/agent` (`@codekalakaars/vajra-agent`), define shared contracts and subpath exports, and enforce import boundaries.
4. **S3–S4 — Shared runtime seams:** extract the model/tool loop and provider interface, then express the Developer as a role profile while preserving the current behavior.
5. **Role and runtime lanes:** move Worker, Manager, tool policy, coordination, and the existing confined executor into the package. Resolve behavior-changing decisions before those changes land.
6. **Host integration:** make the CLI a host for the runtime, keep Developer conversation responsive while Manager tasks run, connect the Tester verifier, and persist conversation and run state independently.
7. **Cleanup:** remove old ownership and compatibility shims only after all roles use the new runtime.

Define the **Developer-to-Manager contract before S2**, so the shared package is shaped around the intended interaction instead of preserving the blocking CLI flow. Keep the product milestone and the first implementation task distinct: S0 is the immediate code change; the end-to-end workflow below is the first user-visible acceptance milestone. The execution document contains the per-lane owners, gates, and behavior-change decisions; use it alongside this architecture plan.

Settle these contracts as part of that work:

1. Keep `ConversationState` and `RunState` independent, and define the events that connect them.
2. Make each `PlanRevision` immutable. Follow-up requests may add or reprioritize pending work; they do not silently rewrite active assignments.
3. Give tasks distinct Worker-reported, verifying, accepted, and rejected outcomes. Dependents become runnable only after Manager acceptance.
4. Define the Manager-facing `Verifier` input from task criteria and the Tester registry, plus the structured verdict/evidence it returns.
5. Define the bounded `CoordinationView` and progress/handoff events available to the Developer, Manager, and Workers.

The first user-visible milestone should be one vertical slice through the eventual `packages/agent` runtime and CLI host:

1. Human submits a request; Developer clarifies and creates an approved, versioned task plan.
2. Manager starts at least one Worker and keeps the task scope fixed.
3. Human sends another message while that Worker is still running; Developer responds and may submit follow-up work without blocking or mutating the active assignment.
4. Manager invokes a host-provided `Verifier` backed by `@codekalakaars/vajra-tester`, reviews the structured verdict, and only then accepts the task or reports a problem to the Developer.
5. Conversation and run events persist independently so an interruption can resume both safely.

Keep `tester` a separate package; integrate it through a Manager-facing `Verifier` interface rather than making the general agent package own test-runner implementations. Implement this milestone after the safety gate and runtime seams above, as part of host integration.

## Target Package Shape

Create `packages/agent` as the home for every agent definition and the shared lifecycle, tools, and coordination needed to run agents. Keep its source divided into small subpackages so each part has a clear owner:

```text
packages/agent/
  package.json                  # @codekalakaars/vajra-agent
  src/
    contracts/                  # roles, profiles, context, events, tool contracts
    engine/                     # shared model/tool-call loop and lifecycle
    tools/                      # schemas, role catalogs, policy checks, dispatch
    coordination/               # scheduler, task board, handoffs, leases, rollback
    isolation/                  # task permissions, tool-executor host, process pool
    providers/                  # model-client interface and OpenCode adapter
    roles/
      developer/                # prompt, context builder, allowed tools
      manager/                  # prompt, context builder, allowed tools
      worker/                   # prompt, context builder, allowed tools
```

These are source subpackages within one publishable workspace package. `packages/agent` is one pnpm package; the folders under `src/` are code boundaries, not separate packages with their own `package.json` files. Give each folder a narrow `index.ts` and keep internal files private by default. This keeps agent definitions under one package boundary without creating a workspace dependency for every small module.

### What stays outside `agent`

- **`sandbox` remains its own package**, one layer below `agent`. It keeps the OS confinement policy: sandbox configuration, file rules, platform guards, resource limits, and the `vajra-sandbox` binary. `agent/isolation` depends on it. Confinement answers “what may this process touch” and should not depend on LLM role code. Two things move out of `sandbox`: role-based tool selection in `tool-rules.ts` (role policy belongs to `agent/tools`) and the coordination primitives `file-locks.ts` and `change-history.ts` (they belong to `agent/coordination`).
- **The Rust N-API package** remains a low-level dependency of `sandbox` and `isolation`. It implements operating-system primitives rather than agent policy.
- **`protocol`** keeps wire types and tool JSON schemas. The `roleTools` table moves to `agent/tools`, because which role may call which tool is agent policy, not wire format.
- **`tester`** remains separate from `agent`; it is a verification service, not a role definition or code-writing agent. The CLI host adapts `@codekalakaars/vajra-tester` to the Manager’s `Verifier` interface, keeping test-runner implementations out of the general agent package.
- **The CLI and TUI** stay hosts and user interfaces. They provide configuration, credentials, persistence, and events, then call the runtime API.

The resulting dependency order is `core → sandbox → agent → cli`, with `protocol` available to `sandbox`, `agent`, and `cli`.

### Where current code goes

| Current file | Destination |
|---|---|
| `cli/src/agent/chat.ts`, `context-window.ts` | `agent/src/providers` (OpenCode client) and `agent/src/engine` (loop, context sizing) |
| `cli/src/agent/developer.ts` | Model loop → `engine`; prompt, context builder, plan tools → `roles/developer` |
| `cli/src/tasks/execute.ts` | Model loop → `engine`; prompt and context → `roles/worker`; optional self-check stays separate from Manager acceptance |
| `cli/src/tasks/server.ts`, `skip.ts` | `roles/worker` (validation support); the server lock becomes a resource lease in `coordination` |
| `cli/src/agent/master.ts` | Scheduling and `decideFailure` → `coordination/scheduler`; inspection prompt and tools → `roles/manager` |
| `cli/src/agent/taskqueue.ts` | `coordination` (task board) |
| `cli/src/agent/registry.ts` | `engine` (`AgentInstance` records) |
| `cli/src/session/service.ts` | Task attempt lifecycle (locks, permissions, rollback) → `coordination` and `isolation`; session storage, UI events, and configuration stay in the CLI |
| `agent-core/src/tools.ts` | `agent/src/tools` |
| `agent-core/src/plan.ts`, `summary.ts`, `tree.ts` | `roles/developer` (plan and project summary context) |
| `agent-process/src/*` | `agent/src/isolation` |
| `sandbox/src/file-locks.ts`, `change-history.ts` | `agent/src/coordination` |
| `sandbox/src/pool.ts` | `agent/src/isolation` (it pools tool executors) |
| `sandbox/src/tool-rules.ts` role lookup | `agent/src/tools`; the role-independent permission check stays in `sandbox` |

`developer.ts` (about 1,400 lines) and `service.ts` (about 1,300 lines) are most of the work. Split them by the rows above rather than moving them whole.

### Shared Agent Interface

Use one profile shape for every LLM-backed role:

```ts
interface AgentProfile<Context> {
  role: 'developer' | 'manager' | 'worker'
  buildSystemPrompt(context: Context): string
  buildContext(input: AgentRunInput): Promise<Context>
  allowedTools: readonly ToolId[]
}

interface AgentRunInput {
  sessionId: string
  /** Chosen by the host per role (ADR-0010); never read from config by the runtime. */
  model: ModelSettings
  taskScope?: TaskScope
  coordination: CoordinationView
  signal: AbortSignal
}

interface AgentRuntime {
  run<Context>(input: AgentRunInput, profile: AgentProfile<Context>): Promise<AgentResult>
}
```

The exact TypeScript types can change during implementation. The important boundary is that `engine` owns the shared model/tool loop, while a role profile supplies role-specific instructions, context, and tools. The runtime validates tool schemas, checks permissions, executes calls through the confined tool executor, and records lifecycle events for every role. Each run creates an `AgentInstance` that records the role, current task, and model used, so every result can be attributed to a model (the attribution question raised in ADR-0010).

A Worker’s bounded context includes the project goal, its dependency and dependent tasks, other tasks’ declared file claims and statuses, and relevant structured handoffs from completed peers. `CoordinationView` is pulled, not pushed. A Worker calls `get_team_status` to refresh during a long run. The runtime does not insert peer updates into the conversation, which keeps context size and prompt caching predictable.

### Role authority

**Developer.** The only role that creates tasks (ADR-0001). Its catalog holds read-only exploration and plan tools. Remove `write_stub` and `delete_stub`; Worker tasks own Phase One stubs and test files as well as implementation edits.

**Manager.** The Manager has two parts, and the plan keeps them apart:

- The **scheduler** is deterministic runtime code in `coordination`, not an agent. It starts ready tasks, applies the concurrency limit, and applies the mechanical failure policy (`decideFailure`: retry, skip, or abort). Scheduling must be predictable, so no model output drives it.
- The **Manager agent** is an LLM profile whose job is ADR-0004’s: inspect a completed task against its success criteria, accept it, or reject it and report observations to the Developer. Its catalog holds read-only inspection tools and `report_to_developer`. It has no write, task-creation, or scheduling tools.

The current opt-in `useLlmDecisions` path, which lets a model choose retry, skip, or abort, is removed rather than converted. It puts a model into scheduling, which this plan keeps deterministic, and it does not inspect work. Building the inspection path is new behavior, delivered in its own step (step 6), not as part of the refactor.

**Worker.** Executes one task (ADR-0002). It may run local checks to guide its work, but the Manager’s Tester result decides acceptance. Coordination tools have fixed limits:

- `get_team_status` is read-only.
- `publish_handoff` attaches a structured note to the Worker’s own task. It cannot change any task’s state, scope, or dependencies.
- `request_coordination` sends a request to the Manager. The Manager may only record it and, if needed, report it to the Developer. It cannot create tasks, reassign work, widen permissions, or repair anything in response (ADR-0001, ADR-0004). Only the Developer can turn a request into new work.

## Required Boundaries

1. **One tool-call path.** Every role’s model tool call goes through the same schema validation, authorization, dispatch, timeout, cancellation, and event reporting code.
2. **Role tools are allowlists, not permissions.** A Worker tool catalog may include `write_file`, but a task permission still decides which paths that call can change. A Developer or Manager cannot gain Worker access from prompt text.
3. **Task scope is enforced at execution.** Leases are acquired before conflicting operations, and task changes are attributable for rollback and review. Declared inputs take shared read leases; declared outputs, deletions, and created directories take exclusive write leases.
4. **One session per checkout in the first version.** Leases are session-scoped and in memory. A session takes a project-level lock at start, and a second Vajra session on the same checkout is refused with a clear message instead of racing. Cross-process leases (a project-scoped store with owner identity and stale-lease recovery) are a later step and need their own design.
5. **Rollback never crosses a released lease.** Rollback applies only to the attempt in progress, which still holds its write leases, so no other task has read its changes. Once a task completes and releases its leases, its changes are never rolled back automatically. If the Manager rejects completed work, it reports to the Developer, which creates follow-up tasks (ADR-0004). This keeps dependent tasks from building on work that later disappears.
6. **The model client is an injected dependency.** The runtime receives model settings per role and a provider client from the host. It does not read CLI config or credential files directly. Provider credentials stay in the host process and are not passed to the confined tool process.
7. **Peer awareness is bounded and manager-mediated.** Workers receive plan context, task status, file claims, and relevant handoffs. They do not receive unrestricted peer transcripts or authority to edit another task’s scope.
8. **One shared checkout per coordinated run.** Workers in the same run operate on the same canonical project directory. A completed task’s changes become visible after its write lease is released and its handoff is published. Isolated worktrees can remain an explicit future mode with their own merge protocol.
9. **No dependency on presentation code.** Runtime modules must not import the CLI, TUI, or terminal renderer. They report typed events; hosts decide how to display and persist them.
10. **No circular runtime imports.** `contracts` is foundational; `engine`, `tools`, `coordination`, and `isolation` depend on its types as needed; role profiles compose these APIs; the CLI composes the runtime. `agent` depends on `sandbox`, never the reverse.

## Migration Steps

### 0. Record current behavior

Before moving code, add replay tests for the Developer and Worker loops. Record model responses and tool calls from representative runs, then assert that each loop produces the same tool calls, transcript, and events when replayed. These tests are the safety net for step 2, which changes the most behavior-sensitive code.

### 1. Define contracts and import rules

Move or define `AgentProfile`, `AgentRunInput`, `AgentResult`, `AgentInstance`, tool IDs, permission grants, task scope, versioned plan submissions, conversation/run status, verification results, and runtime events under `agent/src/contracts`. Document which dependencies each subpackage may import before moving implementation code, and enforce the rules with a lint or dependency check.

### 2. Extract the shared engine

Move the repeated model conversation and tool-call handling out of `developer.ts` and `execute.ts` into `engine`. Add a provider interface and adapt the current OpenCode client (`chat.ts`) to it. Preserve current streaming, cancellation, retry, timeout, and transcript behavior; the step 0 replay tests must pass unchanged after each role is converted.

### 3. Consolidate tools and authorization

Bring tool schemas, the `roleTools` table, Developer and Worker tool catalogs, tool parsing, and dispatch under `tools`. Remove the role lookup from `sandbox/src/tool-rules.ts`, keeping its role-independent checks. Make the dispatcher receive an explicit `AgentProfile` and a separately derived permission grant. Keep the authorization check outside the LLM prompt.

### 4. Move runtime safety and coordination

Move task permissions, the tool-executor process lifecycle, and the process pool into `isolation`, depending on `sandbox` for confinement. Move the task queue, scheduler and `decideFailure`, file locks, change history, and the server lock into `coordination`. Replace write-everything locking with read leases for declared inputs and exclusive write leases for declared outputs. Add the project-level session lock from boundary 4. Keep the distinction clear: isolation controls what a process can access; coordination controls when concurrent tasks may access shared resources.

### 5. Convert Developer and Worker to profiles

Replace the separate Developer and Worker loops with profiles that use the shared engine. Give Workers the bounded plan and peer context from `coordination`, plus `get_team_status`, `publish_handoff`, and `request_coordination` with the limits above. Remove Developer write tools so all project mutations use the Worker permission and lease path.

### 6. Build the Manager inspection profile

Remove the `useLlmDecisions` path. Add the Manager profile: after a Worker reports completion, the Manager invokes the host-provided Tester/Verifier, reviews its structured verdict and evidence against the task’s success criteria, then accepts or rejects the task. Only acceptance releases dependent tasks. A rejection produces a `report_to_developer` event, and the Developer decides on follow-up work. This is new behavior, so it lands behind a flag and gets its own tests. Rename `master` to `manager` in `AgentRole` across `protocol`, `agent-core`, and the CLI. Keep `master` as a deprecated alias on the wire until the TUI and any other message consumers have switched.

### 7. Make the CLI a host

Update `session/service.ts` to compose the runtime and supply per-role model settings, provider credentials, session storage, task plans, a Tester-backed `Verifier`, and UI event sinks. Keep the Developer input loop responsive while the Manager runs background work. Persist conversation and execution state independently. Keep TUI and CLI command parsing outside the runtime. During migration, old packages may re-export from the new package so each move can land independently.

### 8. Remove duplicate ownership and document the result

After all roles use the runtime, delete `agent-core` and `agent-process`, and remove moved code from `sandbox` and `protocol`. These packages have version numbers but no known outside users. Remove them outright unless a published consumer is found, in which case publish one deprecation release that re-exports from `agent`. Update the root README and architecture docs so there is one accurate package map.

## Readability Rules

- Prefer descriptive names such as `AgentRuntime`, `AgentInstance`, `ToolExecutor`, `TaskLease`, and `WorkerProfile`; avoid overloaded names such as `Agent` for both a role and a child process.
- Keep one main responsibility per module. Avoid giant role classes and generic framework layers with no current caller.
- Put the important invariant beside the code that enforces it. Comments should explain why a boundary exists, not paraphrase the next line.
- Keep role differences visible in small profile files: prompt builder, context builder, tool IDs, and role-specific result handling.
- Make authorization flow explicit in function arguments. Do not rely on mutable global role state or hidden singleton registries.
- Export a small root API. Use internal imports between subpackages and document any supported subpath exports.
- Add a short package README with its responsibility, allowed dependencies, and one usage example when a subpackage has a meaningful public surface.

## Completion Criteria

The migration is complete when:

- Developer, Manager, and Worker all start through the same `AgentRuntime` API and shared model/tool loop.
- The role profile is the only source of role-specific prompt and tool-catalog choices; permissions remain separately enforced by runtime code.
- Scheduling and failure policy are deterministic code; no model output starts, retries, skips, or aborts a task.
- The Manager agent inspects completed work and reports to the Developer; it has no tool that writes files, creates tasks, or changes scheduling.
- The Developer remains available during a run. Follow-up human requests become plan revisions and cannot silently widen or replace active task scopes.
- The Manager uses an independent Tester verdict and evidence before accepting a Worker’s result or releasing dependent tasks.
- All repository mutations, including stubs and tests, happen in Worker tasks; the Developer’s repository tools are read-only.
- Workers can inspect current task and peer status, declared file ownership, and relevant handoffs through the runtime without receiving unrestricted peer conversations or changing their scopes.
- Leases, rollback, task permissions, the tool executor, tool dispatch, and all role definitions are owned under the `agent` package boundary; OS confinement is owned by `sandbox`.
- Declared inputs take shared read leases, conflicting tasks in one run cannot write the same path concurrently, and a second session on the same checkout is refused.
- Every `AgentResult` records the role and model that produced it.
- The CLI and TUI do not contain a second implementation of agent lifecycle or tool authorization.
- No runtime subpackage imports CLI or TUI code, and the package dependency graph has no cycles.
- A new role can be added by defining a profile and its policy, without copying the model conversation loop.

## Open Questions

- **Cross-session coordination.** When should two sessions share one checkout, and what lease store would support it? This is deferred by boundary 4.
- **Unset role models.** ADR-0010 leaves open what happens when a role has no configured model. The runtime should refuse to start that role rather than fall back silently; the host decides the defaults.
- **Tester adapters.** Which project test runners and criteria should the CLI host register for `@codekalakaars/vajra-tester`? The Manager-facing `Verifier` returns a structured verdict; runner coverage can grow incrementally.

## References

- [Agent process package](packages/agent-process/package.json)
- [Sandbox package](packages/sandbox/package.json)
- [Protocol package](packages/protocol/package.json)
- [Agent core package](packages/agent-core/package.json)
- [CLI package](packages/cli/package.json)
- [Agent specification](docs/specifications/agent-spec.md)
- [Runtime design](docs/runtime/README.md)
- [ADR-0001: developer-only task creation](docs/adr/0001-developer-only-task-creation.md)
- [ADR-0002: single-task workers](docs/adr/0002-single-task-workers.md)
- [ADR-0004: the Manager inspects and escalates, never repairs](docs/adr/0004-manager-inspects-never-repairs.md)
- [ADR-0010: every role is an LLM agent](docs/adr/0010-every-role-is-an-llm-agent.md)
