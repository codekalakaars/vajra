# Permissions

## Purpose

This section documents the conceptual permission model — task-scoped permissions, file ownership, isolation, and the access boundaries between roles.

## Table of Contents

- [Task-Scoped Permissions](#task-scoped-permissions)
- [File Ownership](#file-ownership)
- [Isolation](#isolation)
- [Access Boundaries](#access-boundaries)
- [Enforcement Points](#enforcement-points)

## Task-Scoped Permissions

A Worker's access exists only for the duration of one task, and only within that task's declared target files.

```
Task assigned
   │
   ├── provision: allowedFiles = task.targetFiles
   │                readOnlyFiles = task.readOnlyFiles (if any)
   │                blockedFiles  = everything else
   │
   ├── Worker executes
   │
Task reaches terminal state
   │
   └── withdraw: all access revoked
```

Consequences of this model:

- **Least privilege by construction.** A Worker cannot touch a file its task did not name, so the blast radius of a mistake is bounded by the task definition rather than by the Worker's good judgment.
- **No privilege accumulation.** A Worker that has just finished a sensitive task carries nothing into the next one.
- **Permissions are derived, not assigned.** They come from the task, which only the Developer can write — so a Worker cannot widen its own access.

**Assumption:** A Worker may *read* more than it may write. Read access beyond target files is permitted, since implementing a change often requires reading neighbouring code; write access is the restricted side. Adjust if reads should be scoped too.

## File Ownership

While a task is non-terminal, its target files are **owned** by that task's Worker.

- Only the owning Worker may write an owned file.
- The Manager will not assign a second task whose target files overlap an active task's — including two tasks in the same group, which submission validation should already have rejected.
- Ownership is released when the task reaches a terminal state.

This is what allows parallel execution to be safe. The Developer's grouping is the primary mechanism — grouping and priority are declared up front precisely so that collisions are resolved before any Worker exists. Ownership is the **backstop**: it holds even when the plan is wrong, and it is what makes a collision a wait rather than a corruption.

Two Workers attempting to write one file would otherwise produce a conflict discovered only at inspection — too late to attribute cleanly.

Ownership applies to files, not to directories or the repository as a whole.

**Assumption:** Ownership is exclusive and coarse — one owner per file, no shared or read-only co-ownership. A single Worker executing sequentially can hold ownership of several files at once, so this does not constrain normal work.

## Isolation

Workers are isolated from each other and from the rest of the system.

- A Worker cannot see another Worker's assignment, context, intermediate edits, or results.
- A Worker cannot communicate with the Human or the Developer. All Worker traffic passes through the Manager.
- A Worker cannot observe or influence the Manager's scheduling decisions.

Isolation is what makes inspection meaningful and supervision sound. If Workers could see each other, a Worker might infer what another was doing and adjust its own approach to look consistent rather than correct.

## Access Boundaries

| Capability | Human | Developer | Manager | Worker |
|------------|:-----:|:---------:|:-------:|:------:|
| Create a task | No | **Yes** | No | No |
| Finalize a task | **Yes** | No | No | No |
| Define success criteria | No | **Yes** | No | No |
| Submit work to the Manager | No | **Yes** | No | No |
| Assign a task to a Worker | No | No | **Yes** | No |
| Withhold or grant permissions | No | No | **Yes** | No |
| Inspect completed work | No | No | **Yes** | No |
| Escalate a problem | No | No | **Yes** | Report upward only |
| Execute a task | No | No | No | **Yes** |
| Modify files | No | Stub files only | No | **Own task's files only** |

Two asymmetries are worth naming:

- The Developer creates work but cannot execute it.
- The Worker executes work but cannot influence what work exists.

Neither role can collapse into the other, which is what keeps the Manager's inspection an independent check.

## Enforcement Points

**Assumption:** Permissions are enforced at three points, outermost first:

1. **Submission-time** — the Developer declares grouping, dependencies, and priority; validation rejects an intra-group collision with no dependency justifying it. This prevents the conflict rather than handling it.
2. **Manager-side** — the Manager refuses to assign a task whose group is inactive, whose dependencies are unmet, or whose files are held by a higher-priority active task. This is a scheduling guard, not a security boundary.
3. **Worker-side** — the Worker's own tool surface is restricted to its task's files for the duration of the task. This is the primary access boundary.
4. **Environment-side** — a Worker executes in a confined environment that would prevent writes outside its scope even if the tool layer were bypassed. This is what makes the model trustworthy rather than advisory.

Points 3 and 4 are what contain execution. Points 1 and 2 prevent avoidable contention. See [Security Model](security-model.md) for how the environment boundary is built.

## See Also

- [Security Model](security-model.md)
- [Permission Specification](../specifications/permission-spec.md)
- [Tasks](../tasks/README.md)
- [Execution](../execution/README.md)
