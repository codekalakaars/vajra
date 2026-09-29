# Runtime

## Purpose

This section documents the runtime — how context, state, and execution are managed, and what is observable. It is the layer where the conceptual model meets an implementation.

## Table of Contents

- [Context Management](#context-management)
- [Agent Runtime](#agent-runtime)
- [State Management](#state-management)
- [Execution Engine](#execution-engine)
- [LLM Providers](#llm-providers)
- [Observability](#observability)
- [Open Questions](#open-questions)

Implementation detail belongs here rather than in the conceptual docs. Anything in this section is changeable without contradicting an ADR.

The sections below describe the harness runtime as designed. Two documents describe the part of the system that runs today — the `vajra` CLI in `packages/cli` — and are marked as such where they are linked: [state.md](state.md) and [llm-providers.md](llm-providers.md).

## Context Management

A Worker needs enough context to complete its task without asking questions, and no more than that.

**Assumption:** A Worker's context at assignment contains:

- The task: description, `targetFiles`, `successCriteria`, `verification`, `dependsOn`.
- The declared permissions, and any access grants made during the task.
- The current contents of its target files, and of read-only files it needs.
- Enough surrounding code to make the change coherently.
- A bounded, read-only peer view from the Manager: the project goal, the plan's other tasks, each task's state and holder, the files each active task owns, and handoffs from completed tasks. The Worker can refresh it with `team.query`. See [ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md).
- On a later review round, the Manager's findings (`review.feedback`), added to the context the Worker already holds.

It does **not** contain: the Human conversation, other Workers' conversations or intermediate edits, or the full repository.

This is a deliberate limit. A Worker given the whole conversation may infer intent beyond what the task specified and drift outside its scope; the task is the contract, not the conversation that produced it. The peer view tells a Worker what its neighbours hold and have finished, not how they are doing it.

TODO: Define how much surrounding code is pulled in, and how much of the peer view goes into context by default versus on request (an open question in [ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md)). A target file that does not exist yet is created by the Worker that owns the task.

## Agent Runtime

The runtime hosts the three automated roles and mediates every message between them.

**Assumption:**

- **Developer and Manager** are long-lived for a session. They span many tasks and hold the accumulated picture of the work.
- **Workers** are per-task. Provisioned at assignment and killed by the Manager's mechanical part when the task reaches a terminal state — at the verdict for a reviewed task. No Worker outlives its task's verdict, which keeps permissions from accumulating across tasks. See [ADR-0013](../adr/0013-manager-verifies-reviews-and-retires-workers.md).
- **A `changes_requested` verdict does not kill the Worker.** The same Worker receives the findings and keeps its context.
- **A frozen Worker keeps its state.** It pauses with its context and its own files held, and resumes when the file it waits for is released. It still holds only its one task.

Every kill is a runtime action, not a message, and is recorded in the audit log.

This follows from permissions being derived per task. The cost is startup latency per task, which needs measuring before the design is safe to commit to.

TODO: Choose the transport between runtime and Worker — local subprocess versus network. This is the decision that constrains sandboxing most heavily, and it should be an ADR.

## State Management

Three distinct kinds of state, with different lifetimes:

| State | Lifetime | Examples |
|-------|----------|----------|
| **Task state** | Until the task is closed, then archived | `Task` objects, state transitions |
| **Execution state** | For one task, across its review rounds and freezes | Worker context, in-flight edits, partial results, review findings |
| **Session state** | For a session | The task set, Manager's scheduling view, open escalations |

**Assumption:** The task set is the durable source of truth. Execution state is preserved for as long as its task is open: across `changes_requested` rounds, so the same Worker can act on the findings, and across a freeze, so the Worker can resume where it stopped. It is discarded when the Worker is killed at a terminal state. A task that ends `failed`, `rejected` or `blocked` is answered by a new task from the Developer, not by resuming the old execution.

TODO: Decide whether a frozen Worker's state is held in memory or saved to disk, and whether it survives a restart of the runtime.

TODO: Decide the storage medium and whether archived tasks are retained, given the audit requirement in [Security Model](../permissions/security-model.md#audit-logs).

The shipped CLI has already answered this for itself, and the answer is worth reading before designing the harness's version: state lives in `~/.vajra` (override: `VAJRA_HOME`) as one SQLite database, one `0600` config file, one `0600` credential file, a model cache and a summary-index cache. Nothing expires automatically. See [state.md](state.md) for the full inventory, including what deliberately does not exist — no keychain, no logs, no lock files, no XDG.

## Execution Engine

The engine drives the Manager's loop, and through it every task in the system. It is a **traversal of a submitted plan**, not a scheduler that builds one — see [ADR-0005](../adr/0005-predefined-parallel-order.md).

Per task:

1. Activate the first phase, then the next phase once the previous is `done`.
2. Within a phase, activate groups per `groupOrder` and `maxParallelGroups`.
3. Select an eligible task in an active group — dependencies `completed`, no higher-priority task holding a shared file, Worker available.
4. Provision permissions; acquire file ownership.
5. Assign, and supervise progress reports, `team.query` and `access.request` messages. Record grants, and freeze or resume the Worker as the Manager agent decides.
6. On `task.complete`, move the task to `verifying` and run the [verification ladder](../tasks/README.md#verification-ladder), stopping at the first failing rung.
7. Pass the ladder result, diff, Worker report, access grants and success criteria to the Manager agent for review.
8. Apply the verdict. `accepted` records `completed`. `changes_requested` sends findings to the same Worker and returns to step 5, until `maxReviewRounds` is used up. `rejected` records `rejected`. The mechanical floor holds: a ladder fail is never recorded as `completed`.
9. On a terminal state — including `failed` or `blocked` — kill the Worker, withdraw permissions, and release ownership.
10. Report upward; continue the loop.

These properties are load-bearing:

- **The plan is never adjusted.** A suboptimal grouping is executed as given. Correcting it is the Developer's job, and raising it is a suggestion at most.
- **Facts are established by code and judged by a model.** The ladder and every scheduling decision are deterministic; the Manager agent decides only verdicts and access requests. See [ADR-0013](../adr/0013-manager-verifies-reviews-and-retires-workers.md).
- **Scheduling guards are not security boundaries.** Refusing a conflicting assignment prevents a problem; it does not prevent one. The Worker-side and environment-side controls in [Permissions](../permissions/README.md#enforcement-points) are what actually contain execution.
- **Review is independent.** The reviewing role neither wrote the task's code nor defined its criteria, so a passing verdict means something.

TODO: Define how the Manager agent evaluates `review`-type criteria, and what evidence it requires beyond the Worker's own report and the ladder result. `test` and `assertion` criteria and ladder rungs are handled mechanically — see [Testing](../testing/README.md).

## LLM Providers

Vajra reaches exactly one LLM provider, OpenCode Zen, over its OpenAI-compatible endpoints. `zen/*` and `go/*` are the only accepted model ids and both use one `OPENCODE_API_KEY`. There is no provider setting, no registry, and no fallback, because there is no second provider yet.

The decision, its costs, and the credential question it deliberately defers are in [ADR-0009](../adr/0009-opencode-zen-is-the-only-provider.md). The surface as implemented — endpoints, model-id routing, credential resolution, the gate that holds the screen until a key exists, and the five places a second provider would have to be added — is in [llm-providers.md](llm-providers.md).

The provider is shared by all three agent roles, and each agent selects its own model within it — see [Every Role Is an LLM Agent](../specifications/agent-spec.md#every-role-is-an-llm-agent). What that means for this layer is narrow and specific: the provider is one seam reached by every agent, and the only thing that varies per agent is which model id goes over it. The client, the endpoint, the credential and the reachability gate are common to all three, because [ADR-0009](../adr/0009-opencode-zen-is-the-only-provider.md) keeps the provider singular.

A per-role *provider* remains undecided and would be a different decision: it would move the credential, the reachability check and the capability table per role, which is most of what ADR-0009 closed. If that is ever wanted, it becomes an ADR rather than a config key.

TODO: The credential path is implemented and not tested end to end — see [Coverage Gaps](../testing/gaps.md).

## Observability

**Assumption:** The audit log in [Security Model](../permissions/security-model.md#audit-logs) and the runtime event stream are the same artifact, append-only, recording every task transition, permission grant, access grant, Worker freeze, resume and kill, file write, and message.

If they must be separate, the audit log needs its own retention and access rules, and this section should say so.

**Assumption:** No metrics or dashboards in the first version. The audit log answers "what happened", which is what the model needs to be debuggable; aggregate metrics are an operational concern that can follow.

TODO: Define the event schema, retention, and who can read the log.

## Open Questions

- [ ] Local subprocess or network transport to Workers? (Largest unresolved decision.)
- [ ] Per-task Worker provisioning — is the startup cost acceptable?
- [ ] How is surrounding code selected for a Worker's context?
- [ ] How does the Manager agent evaluate non-test criteria?
- [ ] Does a `changes_requested` round re-run the whole ladder, or only the rungs that failed? ([ADR-0013](../adr/0013-manager-verifies-reviews-and-retires-workers.md))
- [ ] How does rung 4 share ports and fixtures between concurrent tasks, and are ladder results cached across tasks that share a build? ([ADR-0012](../adr/0012-verification-ladder-replaces-phase-one.md))
- [ ] Where is a frozen Worker's state kept, and does it survive a runtime restart?
- [ ] Is the audit log the same artifact as the event stream?
- [ ] Where is task state stored, and how long is it retained?
- [ ] What is the context budget for a Worker, and what happens when a task exceeds it — now that review rounds and the peer view add to it?
- [ ] When a second LLM provider is added, how are credentials stored per provider? [ADR-0009](../adr/0009-opencode-zen-is-the-only-provider.md) records this as deliberately undecided.

## See Also

- [Overview](../overview/overview.md)
- [Execution](../execution/README.md)
- [Permissions](../permissions/README.md)
- [Protocol](../communication/protocol.md)
- [State on Disk](state.md) and [LLM Providers](llm-providers.md) — the shipped CLI

