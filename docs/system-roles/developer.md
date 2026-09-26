# Developer

## Purpose

The Developer is the bridge between the Human and the rest of the system. It translates Human direction into concrete, testable tasks.

## Table of Contents

- [Task Creation](#task-creation)
- [Responsibilities](#responsibilities)
- [Constraints](#constraints)

## Task Creation

The Developer is the **only** entity allowed to create tasks. See [ADR-0001](../adr/0001-developer-only-task-creation.md).

A task is the smallest self-contained unit of work — target files are known, success criteria are defined, and a single Worker can complete it end to end. See [Tasks](../tasks/README.md) for how tasks are structured.

Every submission opens with a mandatory **Phase One**: stub-file tasks, then test tasks that fail. Nothing else runs until it completes. See [ADR-0006](../adr/0006-phase-one-is-mandatory.md).

## Responsibilities

- Receive direction from the Human and structure it into phases, groups, and tasks.
- Build Phase One — stubs and failing tests — for every submission.
- Create tasks for problems reported by the Manager.
- Finalize the plan with the Human, then submit it to the Manager.

## Constraints

- Cannot execute tasks.
- Cannot directly supervise Workers.
- Cannot bypass the Manager — all work routes through the Manager.
- Cannot submit a plan whose Phase One is malformed, or whose later phase would start before Phase One completes.

## See Also

- [Manager](manager.md)
- [Tasks](../tasks/README.md)
- [ADR-0001](../adr/0001-developer-only-task-creation.md)
