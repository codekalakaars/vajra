# ADR-0003: Task-Scoped Permissions

## Status

Accepted. The rule that scope is immutable during a task is superseded by [ADR-0014](0014-peer-aware-workers-and-access-requests.md): a Worker may request more access, and the Manager may grant it.

## Date

TODO: Date this decision was made.

## Context

Workers execute code. Without a boundary, a Worker's reachable surface is whatever the underlying environment allows, which means a careless or wrong Worker can modify any file in the repository.

Two properties were wanted:

1. The blast radius of a mistake should be bounded by the task, not by the Worker's judgment.
2. A Worker should not accumulate privilege across tasks.

A Worker-lifetime permission model — grant a Worker a set of capabilities when it starts, reuse it for every task it takes — fails both. The permission set would have to be the union of every task's needs, which makes it monotonically grow and leaves a single task with access the repository as a whole.

## Decision

A Worker's permissions are scoped to the task it is currently assigned, and are derived from that task rather than authored independently.

- `allowedFiles` comes from the task's `targetFiles`.
- `readOnlyFiles` comes from the task's `readOnlyFiles`.
- Everything else is denied.
- Permissions are withdrawn when the task reaches a terminal state.

Ownership of the declared files is held for the duration of the task, so two active Workers cannot write the same file.

## Consequences

**Positive**

- Blast radius is bounded by task definition.
- No privilege accumulation between tasks.
- Permissions are a pure function of the task, so a Worker cannot widen its own access — only the Developer can, by writing a task.
- Parallel execution becomes safe, because disjoint file scopes are a precondition of assignment.

**Negative**

- Permission provisioning and teardown happen per task, which costs startup latency on every task.
- A Worker that discovers mid-execution that it needs another file cannot simply open it. It must report `task.blocked` and wait for the Developer to issue a new task. This makes some tasks fail that would otherwise have succeeded, and makes task definition more demanding up front.
- Requires the environment to enforce the boundary, not just the tool layer, or the model is advisory rather than trustworthy.

**Neutral**

- Read access is broader than write access, since implementation requires reading neighbouring code. The restricted side is writing.

## Open Questions

- Should read access also be scoped to the task's declared set?
- Is the sandbox per task or per Worker, given permissions are per task?

## See Also

- [ADR-0002 — Single-Task Workers](0002-single-task-workers.md)
- [Permissions](../permissions/README.md)
- [Permission Specification](../specifications/permission-spec.md)
