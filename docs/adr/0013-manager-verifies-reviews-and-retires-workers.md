# ADR-0013: The Manager Verifies, Reviews, and Retires Workers

## Status

Accepted. Amends [ADR-0004](0004-manager-inspects-never-repairs.md). Amended by [ADR-0016](0016-failed-attempts-are-respawned.md): `changes_requested` respawns a fresh Worker with the checkpoint and findings instead of returning them to the same Worker.

**Not implemented.** This describes a design that was never built and is not part of the current repository (see [../architecture.md](../architecture.md)). Kept as a record of the design.

## Date

2026-09-29

## Context

[ADR-0004](0004-manager-inspects-never-repairs.md) says the Manager inspects and escalates, never repairs, and that every problem goes to the Developer as a full round trip. [ADR-0010](0010-every-role-is-an-llm-agent.md) says the Manager is an LLM agent. Neither says what the Manager's inspection is made of, and in the shipped CLI it was neither: a boolean from validation exit codes, with an optional model choosing retry, skip or abort.

Two things are true of inspection. Much of it is mechanical: whether code compiles, starts, and answers probes is a fact a machine can establish and a model should not guess at. The rest is judgement: whether the change actually does what the task asked, whether it hard-coded its way past a probe, whether it is safe to build on. A model is good at the second and unreliable at the first.

ADR-0004's rule that every rejection is a Developer round trip is also expensive for the common case: a Worker that was close, whose problem the Manager can describe precisely, has to be thrown away and its task re-planned.

## Decision

**The Manager has two parts.**

- **The mechanical part** is deterministic code. It schedules tasks, provisions and withdraws permissions, holds file ownership, supervises Workers, and runs the [verification ladder](0012-verification-ladder-replaces-phase-one.md) for every completed task. It produces structured verdicts and evidence; it makes no judgement calls.
- **The LLM part** is the Manager agent. It reviews all results for a task — the ladder verdicts and evidence, the diff, the Worker's report, and the task's success criteria — and gives the verdict on completion. It also decides access requests ([ADR-0014](0014-peer-aware-workers-and-access-requests.md)).

**The verdict has three outcomes.**

| Verdict | Meaning | What happens |
|---------|---------|--------------|
| `accepted` | The work meets its criteria | Task becomes `completed`. The Manager kills the Worker, releases its files, and releases dependent tasks |
| `changes_requested` | The work is close and the problem can be stated | The Manager sends its findings to the same Worker, which keeps its context and tries again |
| `rejected` | The work cannot be accepted, or review rounds are exhausted | Task becomes `rejected`. The Manager kills the Worker and escalates to the Developer |

**The mechanical floor binds the LLM.** The Manager agent may reject work the ladder passed. It may never accept work the ladder failed. A task whose ladder did not pass can only be `changes_requested` or `rejected`.

**Review rounds are bounded.** A task allows a fixed number of `changes_requested` rounds, set by the Developer per task. When they run out, the next non-accepting verdict is `rejected`. **Assumption:** the default is two rounds, so a task gets three attempts in total.

**Every Worker is killed at the end of its task.** Whether the verdict is `accepted` or `rejected`, the Manager terminates the Worker process and withdraws its permissions. A Worker never outlives its task's verdict.

**What does not change from ADR-0004.** The Manager never writes code, never edits a Worker's output, and never creates a task. Findings describe what is wrong; they do not contain a fix to apply. Every `rejected` task still goes to the Developer, and only the Developer creates follow-up work ([ADR-0001](0001-developer-only-task-creation.md)).

## Consequences

**Positive**

- **Facts are established by code and judged by a model.** Neither part does the other's job.
- **Cheap fixes stay cheap.** A Worker that needs one correction gets it in-context, without a Developer round trip or a lost Worker.
- **The escalation loop is bounded.** Review rounds end in either acceptance or a Developer decision, answering ADR-0004's open question about a retry ceiling.
- **No stale Workers.** Killing the Worker at the verdict keeps permissions and processes from outliving their task.

**Negative**

- **Findings can steer the fix.** A Manager that describes a problem precisely is close to prescribing its solution. Independence depends on findings stating what is wrong, not how to change it, and that discipline lives in the Manager's prompt, not in code.
- **A second model runs on every task.** Review costs tokens for every completed task, not only for failures.
- **The model can still be wrong in the accepting direction** for anything the ladder does not cover. A weak ladder plus a lenient Manager model produces a false pass.

**Neutral**

- Scheduling, admission and the parallelism ceiling remain deterministic ([ADR-0005](0005-predefined-parallel-order.md), [ADR-0011](0011-tiered-success-criteria.md)). The LLM part decides verdicts and access requests, not which task runs next.

## Open Questions

- Should the Manager's findings be visible to the Human, or only to the Developer?
- Does a `changes_requested` round re-run the whole ladder, or only the rungs that failed?
- Should a Manager model weaker than the Worker model be refused, given it now judges every task?

## See Also

- [ADR-0004 — The Manager Inspects and Escalates, Never Repairs](0004-manager-inspects-never-repairs.md)
- [ADR-0012 — A Verification Ladder Replaces Phase One](0012-verification-ladder-replaces-phase-one.md)
- [ADR-0014 — Peer-Aware Workers and Access Requests](0014-peer-aware-workers-and-access-requests.md)
- [Manager](../system-roles/manager.md)
- [Execution](../execution/README.md)
