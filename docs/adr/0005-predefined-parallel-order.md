# ADR-0005: Parallel Order Is Predefined by the Developer

## Status

Accepted

## Date

TODO: Date this decision was made.

## Context

Once a task set grows past a handful of items, execution order starts to matter. Two tasks touching the same file cannot run at the same time, and a test task run before its implementation is meaningless.

The natural implementation is to let the Manager work this out at runtime: take the task set, find tasks with no dependency between them, run them concurrently, and detect file collisions as they arise. This is what a conventional scheduler or CI system does.

That approach was rejected. It puts a planning decision inside the execution layer, and the Manager is the one role in the system that is explicitly barred from producing work. If the Manager decides that two tasks may run together, it is making a judgement about the codebase — which is the Developer's job, not its own.

It also produces worse failure modes. A runtime-discovered collision is discovered at the moment of collision, after a Worker has already been provisioned and has possibly already written something. A collision declared up front is resolved before any Worker exists.

## Decision

Parallel order is **predefined by the Developer** and executed by the Manager. Three things are declared at submission:

- **Groups** — the unit of parallelism. Tasks in one group are intended to run concurrently. Every task belongs to exactly one group.
- **Dependencies** — intra-group only. A task waits for tasks it depends on to reach `completed`.
- **Priority** — inter-group ordering, resolving cases where two tasks in different groups share a file.

The parallelism limit — how many groups may be in flight at once — is also predefined as part of the submission.

The Manager traverses this plan. It does not derive, optimise, or adjust it.

## Consequences

**Positive**

- Planning stays in the planning role. The Manager's authority over *what runs and when* does not extend to deciding *what may run together*, which is a codebase judgement.
- Collisions are resolved before any Worker is provisioned, not at the moment of collision.
- The execution order is explainable: every ordering decision traces to something the Developer declared.
- The Manager becomes a simple traversal, which is easier to reason about and to test.

**Negative**

- The Developer must decide the parallel structure up front, which requires knowing the codebase well. A poor grouping produces poor scheduling, and there is no runtime recovery from it.
- The parallelism limit becomes a per-submission planning choice, so the Developer must reason about available capacity.
- A grouping that is too coarse serialises work that could have been parallel; too fine and it collides constantly. Neither is detectable without running it.

**Neutral**

- Where file overlap serialises two groups, an execution slot may sit idle while the lower-priority task waits. Correctness outranks utilisation, so the Manager will not work around it.

## Open Questions

- Should the parallelism limit be per submission, or a deployment-level cap? Currently assumed per submission, since it is a planning decision.
- Is priority a total order, or only defined pairwise between overlapping tasks? Currently assumed pairwise — the Developer sets priority only where two tasks actually share a file.
- Should the Manager report when the plan appears to be poorly grouped — for example, repeated file collisions — as a suggestion to the Developer?

## See Also

- [ADR-0001 — Developer-Only Task Creation](0001-developer-only-task-creation.md)
- [ADR-0003 — Task-Scoped Permissions](0003-task-scoped-permissions.md)
- [Tasks](../tasks/README.md)
- [Execution](../execution/README.md)
