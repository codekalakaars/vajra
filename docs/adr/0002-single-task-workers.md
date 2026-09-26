# ADR-0002: Single-Task Workers

## Status

Accepted

## Date

TODO: Date this decision was made.

## Context

TODO: Describe the problem space and forces at play.

## Decision

Workers execute one task at a time.

## Consequences

- Workers cannot self-schedule or pick up additional work.
- Managers control all task assignment.
- Parallelism requires multiple Workers.
- Worker state is simple — at most one active task.

## See Also

- [ADR-0001 — Developer-Only Task Creation](0001-developer-only-task-creation.md)
- [Worker Role](../system-roles/worker.md)
