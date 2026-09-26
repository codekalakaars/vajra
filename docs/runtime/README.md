# Runtime

## Purpose

This section documents the runtime — how context, state, and execution are managed, and what is observable. It is the layer where the conceptual model meets an implementation.

## Table of Contents

- [Context Management](#context-management)
- [Agent Runtime](#agent-runtime)
- [State Management](#state-management)
- [Execution Engine](#execution-engine)
- [Observability](#observability)
- [Open Questions](#open-questions)

Implementation detail belongs here rather than in the conceptual docs. Anything in this section is changeable without contradicting an ADR.

## Context Management

A Worker needs enough context to complete its task without asking questions, and no more than that.

**Assumption:** A Worker's context at assignment contains:

- The task: description, `targetFiles`, `successCriteria`, `dependsOn`.
- The declared permissions.
- The current contents of its target files, and of read-only files it needs.
- Enough surrounding code to make the change coherently.

It does **not** contain: the Human's original requirement, other tasks, other Workers' state, or the full repository.

This is a deliberate limit. A Worker given the whole conversation may infer intent beyond what the task specified and drift outside its scope; the task is the contract, not the conversation that produced it.

TODO: Define how much surrounding code is pulled in, and how target files are located when a task names a path that does not yet exist.

## Agent Runtime

The runtime hosts the three automated roles and mediates every message between them.

**Assumption:**

- **Developer and Manager** are long-lived for a session. They span many tasks and hold the accumulated picture of the work.
- **Workers** are per-task. Provisioned at assignment, destroyed at a terminal state, which keeps permissions from accumulating across tasks.

This follows from permissions being derived per task. The cost is startup latency per task, which needs measuring before the design is safe to commit to.

TODO: Choose the transport between runtime and Worker — local subprocess versus network. This is the decision that constrains sandboxing most heavily, and it should be an ADR.

## State Management

Three distinct kinds of state, with different lifetimes:

| State | Lifetime | Examples |
|-------|----------|----------|
| **Task state** | Until the task is closed, then archived | `Task` objects, state transitions |
| **Execution state** | For one task execution | Worker context, in-flight edits, partial results |
| **Session state** | For a session | The task set, Manager's scheduling view, open escalations |

**Assumption:** The task set is the durable source of truth. Execution state is disposable — destroying a Worker loses in-flight work, which is acceptable because a failed task is answered by a new task from the Developer, not by resuming the old one.

This is why the corrective path is designed around escalation rather than retry: it removes any need to preserve failed execution state.

TODO: Decide the storage medium and whether archived tasks are retained, given the audit requirement in [Security Model](../permissions/security-model.md#audit-logs).

## Execution Engine

The engine drives the Manager's loop, and through it every task in the system. It is a **traversal of a submitted plan**, not a scheduler that builds one — see [ADR-0005](../adr/0005-predefined-parallel-order.md).

Per task:

1. Activate Phase One, then the next phase once the previous is `done`.
2. Within a phase, activate groups per `groupOrder` and `maxParallelGroups`.
3. Select an eligible task in an active group — dependencies `completed`, no higher-priority task holding a shared file, Worker available.
4. Provision permissions; acquire file ownership.
5. Assign, and supervise progress reports.
6. On a terminal report, withdraw permissions; release ownership.
7. Inspect against success criteria; record `completed` or `rejected`.
8. Report upward; continue the loop.

Three properties are load-bearing:

- **The plan is never adjusted.** A suboptimal grouping is executed as given. Correcting it is the Developer's job, and raising it is a suggestion at most.
- **The phase gate is absolute.** A later phase cannot begin while Phase One is incomplete, so a Phase One failure stalls the submission rather than letting implementation proceed against missing groundwork.
- **Scheduling guards are not security boundaries.** Refusing a conflicting assignment prevents a problem; it does not prevent one. The Worker-side and environment-side controls in [Permissions](../permissions/README.md#enforcement-points) are what actually contain execution.
- **Inspection is independent.** The inspecting role neither wrote the task's code nor defined its criteria, so a passing verdict means something.

TODO: Define how inspection evaluates `review`-type criteria, and what evidence it requires beyond the Worker's own report. `test` and `assertion` criteria are handled mechanically — see [Testing](../testing/README.md).

## Observability

**Assumption:** The audit log in [Security Model](../permissions/security-model.md#audit-logs) and the runtime event stream are the same artifact, append-only, recording every task transition, permission grant, file write, and message.

If they must be separate, the audit log needs its own retention and access rules, and this section should say so.

**Assumption:** No metrics or dashboards in the first version. The audit log answers "what happened", which is what the model needs to be debuggable; aggregate metrics are an operational concern that can follow.

TODO: Define the event schema, retention, and who can read the log.

## Open Questions

- [ ] Local subprocess or network transport to Workers? (Largest unresolved decision.)
- [ ] Per-task Worker provisioning — is the startup cost acceptable?
- [ ] How is surrounding code selected for a Worker's context?
- [ ] How does inspection evaluate non-test criteria?
- [ ] Is the audit log the same artifact as the event stream?
- [ ] Where is task state stored, and how long is it retained?
- [ ] What is the context budget for a Worker, and what happens when a task exceeds it?

## See Also

- [Overview](../overview/overview.md)
- [Execution](../execution/README.md)
- [Permissions](../permissions/README.md)
- [Protocol](../communication/protocol.md)
