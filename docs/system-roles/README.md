# System Roles

## Purpose

This section documents the architectural roles in the Vajra multi-agent system — their responsibilities, interactions, and constraints.

## Table of Contents

- [Architectural Roles](#architectural-roles)
- [Human](human.md)
- [Developer](developer.md)
- [Manager](manager.md)
- [Worker](worker.md)
- [Agents and Models](#agents-and-models)
- [Role Interactions](#role-interactions)
- [Agent Lifecycle](#agent-lifecycle)

## Architectural Roles

Vajra defines four architectural roles:

| Role | Creates Tasks | Executes Tasks | Orchestrates | Interacts with Human | Agent | Model |
|------|:------------:|:--------------:|:------------:|:--------------------:|:-----:|:-----:|
| Human | No | No | No | — | No | — |
| Developer | Yes | No | No | Yes | **Yes** | Independent |
| Manager | No | No | Yes | No | **Yes** | Independent |
| Worker | No | Yes (one at a time) | No | No | **Yes** | Independent |

**Agent** means an LLM-backed instance of the role, and each of the three agents is configured with its own model. The Human holds a role but is not an agent and has no model. See [Agents and Models](#agents-and-models) and [ADR-0010](../adr/0010-every-role-is-an-llm-agent.md).

## Agents and Models

Developer, Manager and Worker are all **agents** — LLM-backed instances of their roles — and each is configured with **its own model**. The Human is the exception: it holds a role, decides, and has no model.

| Role | Agent | Model configuration | Why the model matters |
|------|:-----:|---------------------|----------------------|
| Developer | Yes | Independent | Reads the requirement and the codebase, then decomposes them into testable tasks. Its quality is upstream of everything |
| Manager | Yes | Independent | Reviews the ladder's evidence and the work against the stated criteria, gives the verdict, and decides access requests. It is the system's only independent check |
| Worker | Yes | Independent | Executes one task within its scope. Runs concurrently, so its cost is multiplied by the parallelism limit |
| Human | No | — | Decides. The distinction is categorical, not a matter of degree |

Two rules follow from this and hold in every configuration:

- **A model is configuration, not authority.** Selecting a model changes how well a role performs, never what it is permitted to do. A Worker on the strongest available model still may not write outside its task, and a Manager still may not repair the work it rejected.
- **The provider is shared.** All three agents reach the single provider fixed by [ADR-0009](../adr/0009-opencode-zen-is-the-only-provider.md). Per-role configuration selects a *model*, not a vendor. A per-role provider is a separate, undecided question.

The decision, and the costs it accepts — that a run is no longer identified by a single model, and that a deliberately weak Manager model weakens the guarantee in [ADR-0004](../adr/0004-manager-inspects-never-repairs.md) — are in [ADR-0010](../adr/0010-every-role-is-an-llm-agent.md).

## Role Interactions

```
Human ←→ Developer ←→ Manager ←→ Worker
```

- The **Human** talks only to the **Developer**. It approves every plan and plan revision before submission, and approves or rejects final results.
- The **Developer** creates tasks, gets the Human's approval, and submits them to the **Manager**. It stays available while a run is active.
- The **Manager** has a mechanical part and an LLM part. The mechanical part assigns tasks to **Workers**, provisions permissions, and runs the verification ladder. The Manager agent reviews results, gives verdicts, and decides access requests. `rejected` tasks are escalated to the **Developer**. See [ADR-0013](../adr/0013-manager-verifies-reviews-and-retires-workers.md).
- **Workers** execute one task at a time with permissions confined to that task and its grants. They read a peer view and send access requests through the Manager. See [ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md).

### Pattern 1 — Task Definition and Submission

The Human works with the Developer to define testable tasks. The Human approves the plan, which is then handed to the Manager as a batch. The Developer creates no files; a declared target file that does not exist yet is created by the Worker that owns it.

```mermaid
sequenceDiagram
    actor H as Human
    participant D as Developer
    participant M as Manager

    H->>D: Requirement
    D->>D: Define tasks<br/>(target files + success criteria<br/>+ verification ladder)
    D->>H: Present plan for approval
    alt Approved
        H->>D: Approve
        D->>M: Submit plan
    else Changes wanted
        H->>D: Request changes
        D->>D: Revise plan
    end
```

A new Human request during a run follows the same path: the Developer proposes a plan revision, the Human approves it, and the Developer submits it. A revision never changes a task that is already `assigned` or `in_progress`.

### Pattern 2 — Task Execution and Verification

The Manager assigns one task to a Worker, which completes it end to end within task-scoped permissions. The mechanical part then runs the task's verification ladder, stopping at the first failing rung. See [ADR-0012](../adr/0012-verification-ladder-replaces-phase-one.md).

```mermaid
sequenceDiagram
    participant MM as Manager (mechanical)
    participant MA as Manager agent
    participant W as Worker

    MM->>W: Assign one task<br/>(with task-scoped permissions)
    W->>W: Execute end to end
    W-->>MM: task.complete
    Note over MM: Task → verifying
    MM->>MM: Run ladder<br/>compiles → runs → dependencies<br/>→ serves → tests
    MM->>MA: Ladder verdicts + evidence,<br/>diff, Worker report, criteria
    MA->>MA: Review → verdict
```

### Pattern 3 — Review, Verdict and Escalation

The Manager agent gives one of three verdicts. It may reject work the ladder passed; it may never accept work the ladder failed. `changes_requested` returns findings to the same Worker, up to the task's review-round limit. Every Worker is killed at its task's verdict. The Manager never fixes problems directly.

```mermaid
sequenceDiagram
    participant D as Developer
    participant MA as Manager agent
    participant MM as Manager (mechanical)
    participant W as Worker

    MA->>MM: Verdict

    alt accepted
        MM->>W: Kill
        MM->>MM: Task → completed<br/>release files and dependents
        MM->>D: Report success
    else changes_requested (rounds left)
        MM->>W: review.feedback (findings, round)
        Note over MM,W: Task → in_progress
        W->>W: Revise, keeping context
        W-->>MM: task.complete
        Note over MM: Ladder and review run again
    else rejected (or rounds exhausted)
        MM->>W: Kill
        MM->>MM: Task → rejected
        MM->>D: escalation.report
        D->>D: Decide with the Human:<br/>revise, remediate or abandon
        opt Remediate or revise
            D->>MM: Submit Human-approved task(s)
        end
    end
```

**Assumption:** the default review-round limit is two, so a task gets three attempts in total.

### Pattern 4 — Access Requests

A Worker that needs a file outside its task asks the Manager. The mechanical part checks whether another active task owns the file; the Manager agent decides; the mechanical part enforces the decision and records every grant.

```mermaid
sequenceDiagram
    participant W as Worker
    participant MM as Manager (mechanical)
    participant MA as Manager agent

    W->>MM: access.request (file, reason)
    MM->>MM: Is the file owned by another active task?

    alt File is free
        MM->>MA: Request
        MA-->>MM: granted | denied
        MM->>MM: On grant: add to scope, take ownership, record
        MM-->>W: access.decision
    else File is owned
        MM->>MA: Request + current owner
        MA-->>MM: not_needed | freeze | continue_meanwhile
        alt not_needed
            MM-->>W: access.decision (proceed without it)
        else freeze
            MM->>MM: Refuse if it would create a wait cycle
            MM-->>W: access.decision (freeze)
            Note over W: Task → frozen
            MM->>MM: Owner finishes, file released
            MM-->>W: task.resume (grantedFiles)
            Note over W: Task → in_progress
        else continue_meanwhile
            MM-->>W: access.decision (keep working)
            MM->>MM: Owner finishes, file released
            MM-->>W: task.resume (grantedFiles)
        end
    end
```

A request that implies new work is escalated to the Developer. A Worker frozen past its task timeout is escalated, and its task becomes `blocked`. See [ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md).

### Interaction Rules

- Workers never communicate with the Human or Developer — all Worker traffic goes through the Manager.
- Workers never message each other. They see their peers only through the Manager's read-only peer view and structured handoffs.
- The Human talks only to the Developer, never to the Manager or Workers.
- The Manager never writes or repairs work itself. Its findings state what is wrong, not the fix.
- The Developer is the only role that creates tasks, including remediation tasks. See [ADR-0001](../adr/0001-developer-only-task-creation.md).

TODO: Add a diagram for multi-worker parallel execution.

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
- A Worker's permissions are provisioned per task: the task's target files plus any access granted during the task. They are withdrawn at the end of the task.
- **Every Worker is killed at its task's verdict.** Whether the verdict is `accepted` or `rejected`, the mechanical part terminates the Worker process and withdraws its permissions. No Worker outlives its task's verdict, so each task gets a fresh Worker. Across `changes_requested` rounds, the same Worker stays alive and keeps its context. See [ADR-0013](../adr/0013-manager-verifies-reviews-and-retires-workers.md).
- **A Worker may be frozen.** On a `freeze` decision it saves its state and pauses inside its own task, keeping its context and its own files, until the file it waits for is released. A frozen Worker past its task timeout is escalated. See [ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md).
- The Developer and Manager are long-lived relative to Workers — they span many tasks. The Developer stays available while a run is active.
- **A Worker's death is contained to its own task.** A crash, hang, kill, or out-of-memory fails that task and nothing else: the run continues, siblings are untouched, and the pool leases a fresh Worker for the next task. This is what stops untrusted work from destroying work that already succeeded. See [Failure Containment](../tasks/README.md#failure-containment).
- **The Manager spawns Workers but does not decide how many.** Assignment, file locking and admission are deterministic code, and the ceiling is the host's rather than a constant — it falls under load. See [The Manager spawns](../execution/README.md#the-manager-spawns-it-does-not-decide-how-many).

### Open Questions

**Deferred** — these decisions are intentionally unresolved for now and will be settled later. Each one is a live design question, not an oversight.

TODO: What context is loaded into a Worker at initialization — the task description, target files, project state, or prior task history?

TODO: How is the derived parallelism ceiling surfaced to the Human, so a slow run on a busy machine is not mistaken for a slow harness?

TODO: Are the Developer and Manager singletons, or can multiple exist per session/project?

## See Also

- [Tasks](../tasks/README.md)
- [Execution](../execution/README.md)
- [Communication](../communication/README.md)
- [Agent Specification](../specifications/agent-spec.md)
