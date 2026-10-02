# ADR-0014: Peer-Aware Workers and Access Requests

## Status

Accepted. Supersedes the scope-immutability rule of [ADR-0003](0003-task-scoped-permissions.md); the rest of ADR-0003 stands.

**Not implemented.** This describes a design that was never built and is not part of the current repository (see [../architecture.md](../architecture.md)). Kept as a record of the design.

## Date

2026-09-29

## Context

[ADR-0003](0003-task-scoped-permissions.md) scoped a Worker's permissions to its task and made that scope immutable: a Worker that found it needed another file had to report `task.blocked`, and only the Developer could fix it by writing a new task. ADR-0003 recorded the cost itself: "This makes some tasks fail that would otherwise have succeeded."

Workers were also fully isolated. A Worker could not see what other Workers were doing, which files they held, or what they had finished. The reasoning was that a Worker that could see its peers might copy their approach rather than do its own task correctly.

Both rules are stricter than they need to be. A Worker that needs one more file, which no one else is using, should not cost a Developer round trip and a new task. A Worker that is about to change a shared interface is better off knowing that the task next to it depends on that interface. What must not change is the underlying guarantee: no two Workers write the same file at once, and every write is attributable to a task.

## Decision

### Workers are peer-aware

A Worker can see, through the Manager, a read-only view of the run:

- the project goal and the plan's other tasks;
- each task's status and which Worker holds it;
- which files each active task owns;
- structured handoffs published by completed tasks.

A Worker can refresh this view during its task. It cannot see other Workers' conversations or intermediate edits, cannot message another Worker, and cannot change any other task. All traffic still goes through the Manager; there is no lateral channel.

### Workers may request more access

A Worker that needs a file outside its task sends an access request to the Manager, saying which file and why. The Manager handles it in two steps.

**1. Mechanical check.** Is the file owned by another active task?

**2. The Manager agent decides.**

- **If the file is free**, the Manager agent decides whether to grant the access. A grant adds the file to the task's scope for the rest of the task, and the mechanical part takes ownership of it for that task. A denial tells the Worker to proceed without it.
- **If the file is owned by another task**, the Manager agent chooses one of three responses:

| Response | What the Worker does |
|----------|----------------------|
| **Not needed** | Proceed without the file; the Manager explains why it is not required |
| **Freeze** | Save its state and pause until the file is released, then resume with access granted |
| **Continue meanwhile** | Keep working on the parts of its task that do not need the file; the Manager grants the file when it is released |

The Manager agent chooses among these responses; the mechanical part enforces the choice. It records every grant, takes and releases ownership, suspends and resumes Workers, and grants the file when its owner finishes.

### Limits that hold regardless of the decision

- **One writer per file.** A grant never gives a Worker a file another active task owns. Waiting is the only path to an owned file.
- **No deadlock.** The mechanical part tracks which task waits on which. If a freeze would create a cycle, it is refused, and the Manager agent must choose another response or escalate.
- **Bounded waits.** A frozen Worker that waits longer than its task timeout is escalated to the Developer.
- **Grants are recorded and attributed.** Every grant names the task, the file, the reason and the decision, and appears in the audit log and in the review of the task.
- **Grants do not create work.** A Worker still cannot create, reassign or widen any task other than its own, and the Manager still cannot create tasks ([ADR-0001](0001-developer-only-task-creation.md)). A request that implies new work is escalated to the Developer.
- **A Worker holds one task.** Freezing and continuing both happen inside the Worker's own task ([ADR-0002](0002-single-task-workers.md)).

## Consequences

**Positive**

- **Fewer failed tasks.** A missing file is a request, not a blocked task and a re-plan.
- **Better-informed Workers.** Knowing peers' files and handoffs reduces conflicting assumptions between tasks that run at the same time.
- **The one-writer rule is unchanged.** Parallel safety still comes from file ownership, not from Workers behaving well.

**Negative**

- **Scope is no longer fixed at planning time.** A task's final file set is its declared files plus its grants, so the Developer's plan no longer fully describes what each task touched. The audit log and the review have to show grants.
- **Collision planning weakens.** [ADR-0005](0005-predefined-parallel-order.md) resolved collisions before any Worker ran; grants create collisions at runtime, handled by waiting. Some idle time moves from the plan into the run.
- **Frozen Workers hold resources.** A paused Worker keeps its context and its own files while it waits, which can delay other tasks.
- **Peer awareness can homogenise work.** A Worker that sees a peer's handoff may follow it instead of its own task. Handoffs are structured and limited to reduce this, not to prevent it.

**Neutral**

- Permissions are still derived from the task and withdrawn at the end of it; a grant lasts only for the task that received it.

## Open Questions

- Should some paths (configuration, lockfiles, migrations) never be grantable without Developer approval?
- Is a grant ever read-only, or always write?
- How much of the peer view goes into a Worker's context by default, versus on request?

## See Also

- [ADR-0003 — Task-Scoped Permissions](0003-task-scoped-permissions.md)
- [ADR-0013 — The Manager Verifies, Reviews, and Retires Workers](0013-manager-verifies-reviews-and-retires-workers.md)
- [Permissions](../permissions/README.md)
- [Communication](../communication/README.md)
