# System Roles

## Purpose

This section documents the architectural roles in the Vajra multi-agent system — their responsibilities, interactions, and constraints.

## Table of Contents

- [Architectural Roles](#architectural-roles)
- [Human](human.md)
- [Developer](developer.md)
- [Manager](manager.md)
- [Worker](worker.md)
- [Role Interactions](#role-interactions)
- [Agent Lifecycle](#agent-lifecycle)

## Architectural Roles

Vajra defines four architectural roles:

| Role | Creates Tasks | Executes Tasks | Orchestrates | Interacts with Human |
|------|:------------:|:--------------:|:------------:|:--------------------:|
| Human | No | No | No | — |
| Developer | Yes | No | No | Yes |
| Manager | No | No | Yes | Yes |
| Worker | No | Yes (one at a time) | No | No |

## Role Interactions

```
Human ←→ Developer ←→ Manager ←→ Worker
```

- The **Human** talks to the **Developer** and finalizes tasks.
- The **Developer** creates tasks and submits them to the **Manager**.
- The **Manager** assigns tasks to **Workers**, inspects their work, and reports problems back to the **Developer**.
- **Workers** execute one task at a time with permissions confined to that task.

TODO: Add sequence diagrams for common interaction patterns.

### Pattern 1 — Task Definition and Submission

The Human works with the Developer to finalize testable tasks, which are then handed to the Manager as a batch.

```mermaid
sequenceDiagram
    actor H as Human
    participant D as Developer
    participant M as Manager

    H->>D: Requirement
    D->>D: Define tasks<br/>(target files + success criteria)
    opt Stub files needed
        D->>D: Create stub files at defined paths
    end
    D->>H: Present tasks for finalization
    H->>D: Finalize
    D->>M: Submit tasks
```

### Pattern 2 — Task Execution

The Manager assigns one task to a Worker, which completes it end to end within task-scoped permissions.

```mermaid
sequenceDiagram
    participant M as Manager
    participant W as Worker

    M->>W: Assign one task<br/>(with task-scoped permissions)
    W->>W: Execute end to end
    W-->>M: Completion or failure report
```

### Pattern 3 — Inspection and Escalation

After execution, the Manager inspects the output. Problems are reported to the Developer, which creates new tasks. The Manager never fixes problems directly.

```mermaid
sequenceDiagram
    participant M as Manager
    participant D as Developer
    participant W as Worker

    M->>W: Assign one task
    W-->>M: Completion report
    M->>M: Inspect output

    alt Output acceptable
        M->>D: Report success
    else Problems found
        M->>D: Report problems
        D->>D: Create new task(s)
        D->>M: Submit remediation task
    end
```

### Interaction Rules

- Workers never communicate with the Human or Developer — all Worker traffic goes through the Manager.
- The Manager never executes or repairs work itself — it inspects and escalates.
- The Developer is the only role that creates tasks, including remediation tasks. See [ADR-0001](../adr/0001-developer-only-task-creation.md).

TODO: Add diagrams for multi-worker parallel execution and blocked-task handling.

## Agent Lifecycle

Covers how each role comes into existence, becomes ready to act, and shuts down.

### Lifecycle Stages

| Stage | Question to answer |
|-------|--------------------|
| Creation | What causes a role to come into existence? |
| Initialization | What state is loaded before it can act? |
| Ready | What makes it eligible to receive work? |
| Active | What is it doing while working? |
| Termination | When and how does it shut down? |

### Constraints From the Role Model

These follow directly from the architectural roles and are already settled:

- A Worker cannot come into existence with pending work — it has no tasks until a Manager assigns one.
- A Worker holds **at most one** active task at any time. See [ADR-0002](../adr/0002-single-task-workers.md).
- A Worker's permissions are provisioned per task, so they must be (re)scoped whenever a new task is assigned.
- The Developer and Manager are long-lived relative to Workers — they span many tasks.

### Open Questions

**Deferred** — these decisions are intentionally unresolved for now and will be settled later. Each one is a live design question, not an oversight.

TODO: Are Workers spawned on demand per task, or pre-allocated as an idle pool?

TODO: What context is loaded into a Worker at initialization — the task description, target files, project state, or prior task history?

TODO: Does a Worker persist across tasks, or is a fresh Worker created per task?

TODO: What happens to a Worker on failure or timeout — retry, terminate, or escalate to the Manager?

TODO: How are Worker resources reclaimed after termination?

TODO: Are the Developer and Manager singletons, or can multiple exist per session/project?

## See Also

- [Tasks](../tasks/README.md)
- [Execution](../execution/README.md)
- [Communication](../communication/README.md)
- [Agent Specification](../specifications/agent-spec.md)
