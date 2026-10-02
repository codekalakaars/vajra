# ADR-0011: Success Criteria Are Tiered, and the Mechanical Floor Is Never Dropped

## Status

Accepted

**Not implemented.** This describes a design that was never built and is not part of the current repository (see [../architecture.md](../architecture.md)). Kept as a record of the design.

## Date

2026-09-28

## Context

[ADR-0006](0006-phase-one-is-mandatory.md) requires every task to be testable before it is created, and the shipped validator enforces the strictest possible reading: every task must carry at least one verification command that **fails before the change and passes after it**. That is a genuine before/after transition, and it is the only kind of evidence that can say anything about behaviour.

The problem is that a large share of real work has no such command. Creating a few API endpoints, adding a screen, wiring a route, introducing a module — for all of these, the honest answer to "which command fails now and passes after?" is often "a type-checker", and a type-checker says nothing about whether the behaviour is right. A frontend component can type-check, compile, bundle, and still be wrong in every way a user would notice.

Two bad responses are available, and both were live:

- **Refuse the plan.** The strict reading stays absolute, and the harness simply cannot take a large class of work. This is where the system actually is: a Developer proposing an endpoint with no failing command gets the plan rejected, retries, and eventually either fabricates a weak command or gives up. That is a worse failure than accepting a weaker proof, because it wastes the Human's time and produces no work.
- **Drop the floor.** Let a task declare itself unverifiable and move on. Now the harness reports success on things nobody checked, which is the failure mode every other ADR here exists to prevent.

Neither is acceptable. What is missing is a middle position that is *honest* rather than a compromise — a way to say "I can prove something weaker, and I am telling you exactly what."

There is a second, separate pressure in the same requirement. The Manager must be able to spawn as many Workers as the work needs, up to what the **user's machine** can carry. Two properties follow and are easy to conflate:

- **The count is a mechanical decision.** A model choosing how many Workers to run makes scheduling nondeterministic, and scheduling is a traversal with a provably correct answer. See [ADR-0005](0005-predefined-parallel-order.md).
- **The ceiling is a property of the platform.** "As many as required" is bounded by the hardware, and the bound has to move with load rather than sit at a fixed number that is simultaneously too low on a workstation and fatal on a laptop.

And a third, which is not a design question at all but a correctness one: a Worker that dies must cost one task, not the run.

## Decision

### 1. Criteria are tiered

Every task's success criteria sit on three tiers, from strongest to weakest:

| Tier | Name | What it proves | How it is judged |
|------|------|----------------|-----------------|
| 1 | **Behavioural** | The behaviour is right, not merely present | A command that fails before the change and passes after it |
| 2 | **Structural** | The change is real, wired in, and well-formed | A command that fails before and passes after, over a property weaker than behaviour |
| 3 | **Review** | A judgement no command can decide | The Manager reads the output and decides |

**The rule: every task carries at least one Tier 1 or Tier 2 criterion. Tier 3 is additive and never sufficient on its own.**

Tier 2 is what makes the middle position real rather than rhetorical. It is a genuine before/after transition — the import does not resolve before, the route is not registered before, the module does not compile before — it simply does not claim more than it can. `tsc --noEmit`, `node --check`, a build, a schema validation, a lint run: all mechanical, all falsifiable, none of them sufficient alone.

This is the "middle way out" for work with no test yet, and it is not a loophole. A task that compiles and a task that behaves correctly are different states, and Tier 2 is labelled as the weaker one everywhere it appears — in the plan, in the verdict, and in the report to the Human. Choosing Tier 2 is a declaration that this work has a structural proof and no behavioural one *yet*, which is often the truth on day one.

The consequence is deliberate: Tier 2 widens what the harness can accept, and narrows what it can claim. A submission built on Tier 2 is verified, and is not fully verified, and the difference is visible rather than implied.

### 2. The Worker count is mechanical, and the ceiling is the platform's

- The Manager **does not** choose how many Workers run. Assignment, locking and admission are deterministic code. A model in that loop would make the same plan schedule differently and would put liveness beyond reasoning.
- The parallelism limit is a **ceiling, not a target**, and it is derived from the host — not chosen by the Developer, and not fixed at a constant. It is a floor when the machine is loaded and a higher ceiling when it is not.
- The limit degrades **under load rather than failing**. Reducing concurrency is always available to the harness; crashing the host is not.
- The ceiling must be overridable, because the harness cannot know what else the machine is doing.

### 3. A Worker crash costs one task, never the run

A Worker that dies, hangs, or is killed fails **its** task. The failure is attributed, escalated, and the run continues. No unrelated task is failed, no sibling is cancelled, and the submission is not aborted. A pool absorbs the loss by leasing a fresh Worker for the next task.

The invariant exists because the alternative poisons everything around it: if one crash aborted the run, then any untrusted work — a runaway loop, an OOM, a segfault in a build tool — would be able to destroy work that had already succeeded. Blast radius stops at the task, exactly as it does for a file.

## Consequences

**Positive**

- The harness can take work it currently refuses: new endpoints, new screens, new modules, anything whose first honest proof is that it compiles and is wired in.
- The Developer gets a real answer instead of a dead end. "Prove it behaviourally" is unavailable for some work; "prove it structurally and say so" is always available and always honest.
- Nothing becomes unverifiable. The mechanical floor is unchanged; only its *threshold* moved, and a task that cannot clear either tier is still rejected.
- The parallelism ceiling tracks the machine, so the same plan is safe on a laptop and fast on a workstation.
- A crash is contained, so a hostile or merely broken task cannot take the submission with it.

**Negative**

- **Tier 2 is a weaker promise and can be mistaken for a stronger one.** A green Tier 2 submission is not a green Tier 1 submission. Mitigating this is a reporting obligation, not a validation one: the tier must appear in the plan, the verdict, and the final report. A system that reports both as "passed" has reintroduced exactly the false-pass that [ADR-0007](0007-test-verdict-contract.md) forbids.
- **Structural checks are gameable in a way behavioural ones are not.** A `tsc` that passes on a file that exports nothing useful is a clean pass over an empty deliverable. Tier 2 needs a companion that at least asserts the thing exists and is reachable — which pushes the Developer toward Tier 1 sooner than it otherwise would, but not always soon enough.
- **Compilation is slow.** Tier 2's best evidence is a build or a type-check, which routinely costs more wall-clock than the edit being verified. On a large repository this can make verification cost more than the work, and it is the main reason the structural tier should be paired with a narrower command where one exists.
- **A platform-derived ceiling is harder to reason about than a constant.** A plan's wall-clock time stops being predictable, which makes regression detection on the harness itself harder. The mitigation is that the ceiling is reported alongside the results, not hidden.
- **Degrading under load is not free.** Backing off concurrency protects the host at the cost of throughput, and the two are in direct tension on a machine that is already busy with something else. The harness cannot know which wins, so it must always choose the host.

**Neutral**

- The tier model extends the existing `SuccessCriterion` types rather than replacing them; `review` was already a type and simply had no way to be expressed in a plan.
- A model still grants no authority. Choosing Tier 2 does not let a Worker widen its scope. See [ADR-0010](0010-every-role-is-an-llm-agent.md).
- The parallelism limit remains a property of the submission's *shape* — how much work is independent — while the ceiling that bounds it is a property of the host. Those are different questions and are answered in different places.

## Open Questions

- **What is the weakest acceptable Tier 2 criterion?** "It compiles" is currently the floor of the floor. A submission of nothing but `tsc --noEmit` passes on an empty change set, so the validator needs a lower bound on what Tier 2 must assert — a declared export, a reachable route, a registered handler.
- **Can a Tier 2 task be accepted at all, or must it be provisional?** Accepting it closes the task; marking it provisional leaves it open, which is more honest and complicates every downstream count.
- **Should the structural command be cached across tasks?** Compilation results are content-addressed and would pay off enormously on a wide refactor, at the cost of a stale-pass surface that [Testing](../testing/README.md#caching-and-cost) already flags as the more dangerous direction.
- **How is the derived ceiling reported?** A run that took 40s because the machine was busy is not comparable to one that took 40s on an idle host, and nothing currently records which it was.
- **What is the escalation when the host is exhausted?** Reducing to the minimum and continuing is safe; refusing to start is safe; silently taking a long time is neither.

## See Also

- [ADR-0005 — Predefined Parallel Order](0005-predefined-parallel-order.md)
- [ADR-0006 — Phase One Is Mandatory](0006-phase-one-is-mandatory.md)
- [ADR-0007 — Mechanical Verdicts with Expectation Inversion](0007-test-verdict-contract.md)
- [Task Specification](../specifications/task-spec.md)
- [Testing](../testing/README.md)
- [Execution](../execution/README.md)
