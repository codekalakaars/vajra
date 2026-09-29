# Developer

## Purpose

The Developer is the bridge between the Human and the rest of the system. It translates Human direction into concrete, testable tasks.

## Table of Contents

- [Task Creation](#task-creation)
- [Responsibilities](#responsibilities)
- [Constraints](#constraints)

## Task Creation

The Developer is the **only** entity allowed to create tasks. See [ADR-0001](../adr/0001-developer-only-task-creation.md). It acts only on its conversation with, and the approval of, the Human.

A task is the smallest self-contained unit of work — target files are known, success criteria are defined, and a single Worker can complete it end to end. See [Tasks](../tasks/README.md) for how tasks are structured.

For each task the Developer declares:

- **Target files** — the exact paths the task may modify. A declared target file that does not exist yet is created by the Worker whose task owns it; the Developer creates no files.
- **Success criteria** — what must hold for the task to be complete.
- **A verification ladder** — which rungs apply (compiles, runs, dependencies, serves, tests), how each is run, and which databases or external services to stub or check. A rung that does not apply is declared not applicable with a reason; at least one rung must apply. See [ADR-0012](../adr/0012-verification-ladder-replaces-phase-one.md).
- **A review-round limit** (`maxReviewRounds`) where the default does not fit. See [ADR-0013](../adr/0013-manager-verifies-reviews-and-retires-workers.md).

There is no mandatory first phase. Phase One was removed by [ADR-0012](../adr/0012-verification-ladder-replaces-phase-one.md); tests are ordinary tasks the Developer may plan.

## Responsibilities

- Receive direction from the Human and structure it into phases, groups, and tasks.
- Declare each task's target files, success criteria and verification ladder.
- Get the Human's approval for every plan and plan revision, then submit it to the Manager.
- Stay available while a run is active. Turn new Human requests into Human-approved plan revisions that never change an assigned or in-progress task.
- Decide, with the Human, what to do with each escalation: revise the plan, create a remediation task, or abandon the work. `failed`, `rejected` and `blocked` tasks are answered with a new task, never by reopening the old one.

## Constraints

- Cannot modify files.
- Cannot execute tasks.
- Cannot directly supervise Workers.
- Cannot bypass the Manager — all work routes through the Manager.
- Cannot submit a plan or plan revision the Human has not approved.
- Cannot submit a task whose verification ladder has no applicable rung, or whose not-applicable rungs lack a reason.

## See Also

- [Manager](manager.md)
- [Tasks](../tasks/README.md)
- [ADR-0001](../adr/0001-developer-only-task-creation.md)
- [ADR-0012](../adr/0012-verification-ladder-replaces-phase-one.md)
