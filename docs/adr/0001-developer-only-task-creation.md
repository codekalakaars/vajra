# ADR-0001: Developer-Only Task Creation

## Status

Accepted

## Date

TODO: Date this decision was made.

## Context

TODO: Describe the problem space and forces at play.

## Decision

Only the Developer entity can create tasks.

## Consequences

- Workers cannot generate new work.
- Managers must escalate blockers that require new tasks.
- Planning authority is centralized in a single role.
- Task quality depends entirely on the Developer's decomposition skill.

## See Also

- [ADR-0002 — Single-Task Workers](0002-single-task-workers.md)
- [Developer Role](../system-roles/developer.md)
