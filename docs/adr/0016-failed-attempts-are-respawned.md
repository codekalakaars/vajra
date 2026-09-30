# ADR-0016: Failed Attempts Are Respawned, Not Revised

## Status

Accepted. Amends [ADR-0013](0013-manager-verifies-reviews-and-retires-workers.md).

## Date

2026-09-30

## Context

[ADR-0013](0013-manager-verifies-reviews-and-retires-workers.md) gives the Manager three verdicts. `changes_requested` sends the Manager's findings back to the *same* Worker, which keeps its context and tries again. That assumes the Worker's context is an asset. Often it is the problem. A Worker that produced a failing change has a context full of the reasoning that led to it, and a model that is shown its own mistake in that context tends to defend or patch it rather than reconsider.

The shipped CLI does neither. A failed attempt is rolled back and the task runs again from scratch with the same prompt. The new Worker is not told what failed, so it can repeat the same mistake, and all the work of the attempt is thrown away, including the parts that were right.

[ADR-0015](0015-workers-compact-their-own-context.md) gives every Worker a checkpoint: a structured record of what it changed, what it decided and what remains. That makes a third option cheap. Kill the Worker, and start a new one with a clean context, the checkpoint, and the Manager's findings.

## Decision

**Every non-accepting outcome ends the Worker.** When an attempt fails verification, is rejected in review, reports `stuck`, errors or times out, the Manager kills the Worker and withdraws its permissions and locks.

**The Manager then respawns the task.** The new Worker receives:

1. the original task and its brief, unchanged;
2. the last checkpoint of the Worker it replaces;
3. the Manager's findings: what failed, with the evidence, such as the failing ladder step and its output, or the review's reasons.

**The attempt's changes are kept.** Files the killed Worker wrote stay on disk, and the checkpoint tells the new Worker which ones. A failed attempt is usually close, and rolling it back throws away the parts that were right. The task's changes are rolled back only when the task fails for good.

**Respawns are bounded.** A task allows **2 respawns** by default, so 3 Workers in total, and the Developer can set it per task. Every non-accepting outcome uses up one respawn, including a review rejection of work the ladder passed. When they are used up, the task's changes are rolled back and it is escalated to the Developer. The Developer may split or rewrite it, but it must return to the Human before sending a changed plan.

**Findings describe, they do not prescribe.** As in ADR-0013, findings say what is wrong, not how to fix it. The Manager still never writes code.

**Effect on ADR-0013.**

- The three verdicts stand.
- `changes_requested` now means "respawn with findings", not "same Worker, same context".
- ADR-0013's review rounds become respawns, with the same default of two.
- "A Worker never outlives its task's verdict" still holds, and now also applies to every verdict that is not final.

## Consequences

**Positive**

- **Each attempt starts clean, with better information.** The new Worker knows what failed and why, without the reasoning that led to it.
- **Partial work survives.** A failed attempt that was mostly right is continued, not redone.
- **One code path.** A Worker ends the same way whether it was accepted, failed, stuck, crashed or timed out. That keeps permission and lock release in one place.

**Negative**

- **Keeping a failed attempt's changes can mislead.** If the attempt was wrong at its root, the new Worker starts from broken code. The findings and the checkpoint are the only defence, and a new Worker can still build on a bad base.
- **A respawn repeats reading.** A new Worker has to reload what the old one knew and the checkpoint did not keep. The brief and its excerpts reduce this but do not remove it.
- **Review rejections use up respawns.** A strict Manager model can exhaust a task's respawns on work that would have passed a lenient one.

**Neutral**

- The respawn limit replaces the task's `retries` field. The wire name `retries` is kept, and it now counts respawns.

## Open Questions

- Should a respawned Worker use a stronger model than the one it replaces?
- Should the Manager be able to choose to roll back before respawning, when its findings say the approach is wrong rather than incomplete?

## See Also

- [ADR-0004 — The Manager Inspects and Escalates, Never Repairs](0004-manager-inspects-never-repairs.md)
- [ADR-0013 — The Manager Verifies, Reviews, and Retires Workers](0013-manager-verifies-reviews-and-retires-workers.md)
- [ADR-0015 — Workers Compact Their Own Context](0015-workers-compact-their-own-context.md)
