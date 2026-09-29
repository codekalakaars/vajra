# ADR-0004: The Manager Inspects and Escalates, Never Repairs

## Status

Accepted. Amended by [ADR-0013](0013-manager-verifies-reviews-and-retires-workers.md): before escalating, the Manager may return findings to the same Worker for a bounded number of review rounds. The Manager still never repairs work.

## Date

TODO: Date this decision was made.

## Context

The Manager is responsible for supervising Workers and reporting problems to the Developer, which then creates new tasks.

The tempting alternative is to let the Manager fix problems itself. It is faster, avoids a round trip, and the Manager has more context than anyone — it saw the failure and understands it.

That alternative breaks the model. The Manager's inspection is the system's only independent check on a Worker's work. If the Manager can also write the fix, then a task closed after Manager repair has been validated by the same role that produced the correction. The verification and the thing being verified collapse into one, and a systematic Manager error goes undetected — it would produce and then endorse the same wrong fix.

## Decision

The Manager inspects completed work and escalates problems. It never executes or repairs work itself, including work it has just rejected.

On encountering a problem, the Manager reports its observations to the Developer and stops. Only the Developer can produce follow-up work. See [ADR-0001](0001-developer-only-task-creation.md).

## Consequences

**Positive**

- Inspection stays independent, because the inspecting role neither defined the task's criteria nor wrote the code.
- All corrective work flows through the single task-creation authority, so there is one place where the plan is owned.
- Manager failures are bounded. A Manager that is wrong produces a bad report, which a Human or Developer can catch — it does not silently produce wrong code.

**Negative**

- Slower. Every failure costs a full round trip: Worker to Manager, Manager to Developer, Developer back to the Manager.
- The Manager may report problems it could trivially have fixed, which will feel inefficient.
- Repeated failures of the same kind generate repeated round trips, with no automatic convergence.
- The Manager must report observations without prescribing solutions, which requires discipline in how reports are written.

**Neutral**

- The Human does not interact with the Manager, so escalated problems surface through the Developer rather than directly to the user.

## Open Questions

- Should there be a retry ceiling? Currently nothing bounds an escalate-create loop.
- Should the Manager be able to reject a task as unwinnable, closing it without a remediation task?

## See Also

- [ADR-0001 — Developer-Only Task Creation](0001-developer-only-task-creation.md)
- [Manager](../system-roles/manager.md)
- [Execution](../execution/README.md#failure-recovery)
