# Permissions

## Purpose

This section documents the conceptual permission model — task-scoped permissions, file ownership, peer awareness and isolation, access requests, and the access boundaries between roles.

## Table of Contents

- [Task-Scoped Permissions](#task-scoped-permissions)
- [File Ownership](#file-ownership)
- [Peer Awareness and Isolation](#peer-awareness-and-isolation)
- [Access Requests](#access-requests)
- [Access Boundaries](#access-boundaries)
- [Enforcement Points](#enforcement-points)

## Task-Scoped Permissions

A Worker's access exists only for the duration of one task, and only within that task's declared target files plus any files the Manager granted it during the task ([ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md)).

```
Task assigned
   │
   ├── provision: allowedFiles = task.targetFiles
   │                readOnlyFiles = task.readOnlyFiles (if any)
   │                blockedFiles  = everything else
   │
   ├── Worker executes
   │      │
   │      └── access granted (recorded) → allowedFiles = task.targetFiles ∪ write grants
   │
Task reaches terminal state (Worker killed)
   │
   └── withdraw: all access revoked, including grants
```

Consequences of this model:

- **Least privilege by construction.** A Worker cannot touch a file its task did not name, so the blast radius of a mistake is bounded by the task definition rather than by the Worker's good judgment.
- **No privilege accumulation.** A Worker that has just finished a sensitive task carries nothing into the next one.
- **Permissions are derived, not assigned.** They come from the task, which only the Developer can write, and from the task's recorded access grants. A Worker cannot widen its own access; it can only ask, and the widening happens only through a Manager grant that is recorded before it takes effect. A grant lasts only for the task that received it. See [Access Requests](#access-requests).

**Assumption:** A Worker may *read* more than it may write. Read access beyond target files is permitted, since implementing a change often requires reading neighbouring code; write access is the restricted side. Adjust if reads should be scoped too.

## File Ownership

While a task is non-terminal, its target files are **owned** by that task's Worker.

- Only the owning Worker may write an owned file.
- A write grant takes ownership of the granted file for the rest of the task. A grant is never given for a file another active task owns: one writer per file, always.
- A Worker that needs a file owned by another active task can only wait for it — by freezing, or by continuing meanwhile on the parts of its task that do not need the file. The file is granted when its owner releases it. See [Access Requests](#access-requests).
- A freeze that would create a wait cycle (task A waits on B while B waits on A, directly or through others) is refused. The Manager agent must then choose another response or escalate.
- The Manager will not assign a second task whose target files overlap an active task's — including two tasks in the same group, which submission validation should already have rejected.
- Ownership, including ownership taken by a grant, is released when the task reaches a terminal state.

This is what allows parallel execution to be safe. The Developer's grouping is the primary mechanism — grouping and priority are declared up front precisely so that collisions are resolved before any Worker exists. Ownership is the **backstop**: it holds even when the plan is wrong, and it is what makes a collision a wait rather than a corruption. Grants create collisions at runtime that the plan did not foresee; ownership handles them the same way, by waiting.

Two Workers attempting to write one file would otherwise produce a conflict discovered only at inspection — too late to attribute cleanly.

Ownership applies to files, not to directories or the repository as a whole.

**Assumption:** Ownership is exclusive and coarse — one owner per file, no shared or read-only co-ownership. A single Worker executing sequentially can hold ownership of several files at once, so this does not constrain normal work.

## Peer Awareness and Isolation

Workers are peer-aware, but only through the Manager ([ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md)).

A Worker can see a **read-only view** of the run, served by the Manager:

- the project goal and the plan's other tasks;
- each task's status and which Worker holds it;
- which files each active task owns;
- structured handoffs published by completed tasks.

The Worker can refresh this view during its task. It may publish a structured handoff for its own task.

What stays isolated:

- A Worker cannot see another Worker's conversation, context, or intermediate edits.
- A Worker cannot message another Worker. There is no lateral channel; all Worker traffic passes through the Manager.
- A Worker cannot change any other task, or create, reassign, or widen one.
- A Worker cannot communicate with the Human or the Developer.
- A Worker cannot observe or influence the Manager's scheduling decisions.

Peer awareness reduces conflicting assumptions between tasks that run at the same time — a Worker about to change a shared interface can see which task depends on it. The isolation that remains is what keeps inspection meaningful: a Worker sees what its peers own and what they finished, not how they are going about it. Handoffs are structured and limited so a Worker is less likely to copy a peer's approach instead of doing its own task.

## Access Requests

A Worker that needs a file outside its task asks the Manager for it with an `access.request` naming the file, the mode, and the reason. The Manager handles it in two steps ([ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md)):

1. **Mechanical check.** Is the file owned by another active task?
2. **The Manager agent decides.**

| File state | Possible decisions | What the Worker does |
|------------|--------------------|----------------------|
| Free | `granted` | The file joins the task's scope for the rest of the task; the task takes ownership of it |
| Free | `denied` | Proceed without the file |
| Owned by another active task | `not_needed` | Proceed without the file; the Manager explains why it is not required |
| Owned by another active task | `freeze` | Save state and pause (task state `frozen`); resumed with access when the file is released |
| Owned by another active task | `continue_meanwhile` | Keep working on parts of the task that do not need the file; the file is granted when released |

The Manager agent decides; the mechanical part enforces. It records every decision, takes and releases ownership, suspends and resumes Workers, and grants the file when its owner finishes.

Limits that hold regardless of the decision:

- **One writer per file.** A grant never gives a Worker a file another active task owns. Waiting is the only path to an owned file.
- **No deadlock.** A freeze that would create a wait cycle is refused; the Manager agent picks another response or escalates.
- **Bounded waits.** A frozen Worker that waits past its task timeout is escalated to the Developer, and the task becomes `blocked`.
- **Recorded and attributed.** Every grant names the task, the file, the mode, the reason, and the decision. It is recorded before it takes effect, appears in the audit log, and is shown in the review of the task.
- **Grants do not create work.** A request that implies new work — changes that belong to another task, or to no task — is escalated to the Developer, who decides with the Human.
- **Grants last only for the task.** They are withdrawn with the rest of the task's permissions when the task ends.

**Assumption:** a `read` grant adds the file to the task's `readOnlyFiles`; only `write` grants widen `allowedFiles`. Whether a grant is ever read-only is an open question in ADR-0014, since reads beyond target files are already broadly permitted (see the assumption under [Task-Scoped Permissions](#task-scoped-permissions)).

## Access Boundaries

| Capability | Human | Developer | Manager | Worker |
|------------|:-----:|:---------:|:-------:|:------:|
| Create a task | No | **Yes** | No | No |
| Finalize a task | **Yes** | No | No | No |
| Define success criteria | No | **Yes** | No | No |
| Submit work to the Manager | No | **Yes** | No | No |
| Assign a task to a Worker | No | No | **Yes** | No |
| Withhold or grant permissions | No | No | **Yes** | No |
| Grant extra file access to a Worker | No | No | **Yes, bounded** (recorded; never a file another active task owns) | No |
| Request more access | No | No | No | **Yes** |
| See peers' status and file ownership | No | Via `status.report` | **Yes** | **Yes, read-only** (through the Manager) |
| Verify and review completed work, and give the verdict | No | No | **Yes** | No |
| Kill a Worker at its task's verdict | No | No | **Yes** | No |
| Escalate a problem | No | No | **Yes** | Report upward only |
| Execute a task | No | No | No | **Yes** |
| Modify files | No | No | No | **Own task's files and grants only** |

Two asymmetries are worth naming:

- The Developer creates work but cannot execute it.
- The Worker executes work but cannot influence what work exists. It can ask for access, but a grant never creates work.

Neither role can collapse into the other, which is what keeps the Manager's inspection an independent check.

## Enforcement Points

**Assumption:** Permissions are enforced at four points, outermost first:

1. **Submission-time** — the Developer declares grouping, dependencies, and priority; validation rejects an intra-group collision with no dependency justifying it. This prevents the conflict rather than handling it.
2. **Manager-side** — the Manager refuses to assign a task whose group is inactive, whose dependencies are unmet, or whose files are held by a higher-priority active task. It also refuses a grant for a file another active task owns, and a freeze that would create a wait cycle. This is a scheduling guard, not a security boundary.
3. **Worker-side** — the Worker's own tool surface is restricted to its task's files, plus its recorded grants, for the duration of the task. A grant widens this surface only after it is recorded. This is the primary access boundary.
4. **Environment-side** — a Worker executes in a confined environment that would prevent writes outside its scope even if the tool layer were bypassed. This is what makes the model trustworthy rather than advisory.

Points 3 and 4 are what contain execution. Points 1 and 2 prevent avoidable contention. See [Security Model](security-model.md) for how the environment boundary is built.

## See Also

- [Security Model](security-model.md)
- [ADR-0014 — Peer-Aware Workers and Access Requests](../adr/0014-peer-aware-workers-and-access-requests.md)
- [Communication](../communication/README.md)
- [Permission Specification](../specifications/permission-spec.md)
- [Tasks](../tasks/README.md)
- [Execution](../execution/README.md)
