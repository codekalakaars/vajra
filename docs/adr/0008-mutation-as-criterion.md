# ADR-0008: Mutation Scoring Is a First-Class Criterion

## Status

Accepted

## Date

TODO: Date this decision was made.

## Context

Every other criterion answers *"did the tests pass"*. None can answer *"would these tests have caught a defect"*.

That distinction is not academic. A suite can be entirely green and worthless: `expect(1).toBe(1)` passes forever, `assert isAdult(20)` passes while the upper bound is never checked, and a test that asserts on a value the code does not compute passes for the wrong reason. The Phase One gate makes this worse rather than better, because it only requires a test to *fail* — an always-failing assertion satisfies the gate completely and is then carried into every later phase as a false signal.

Nothing in the system detected this. Coverage would not: the lines run, they just assert nothing. A stronger expectation would not: nobody can guess the assertion that is missing. More tests would not: they are the thing that is wrong.

## Decision

A `mutation` criterion type, evaluated alongside the others. Seeded defects are injected into the task's own code and the suite must go red.

Three rules make the number mean something:

1. **A green baseline is required.** If the suite already fails on unmodified code, "a test failed on the mutant" is indistinguishable from "the test was already failing", and every mutant would score as killed. Phase One is therefore reported *not applicable*, with a reason, rather than guessed at.
2. **Compile errors and timeouts are excluded from scoring, not charged against it.** A mutant that does not compile is not a defect a test could have caught, and counting it punishes the toolchain rather than the tests.
3. **No coverage is reported separately from survived, and both count as undetected.** They need different fixes — an untested line versus a wrong assertion — and a single blended figure hides the distinction that tells the Developer what to do next.

A surviving mutant is an **oracle failure** and maps onto `failed_assertion`, so it obeys the same rules as every other assertion failure, including never satisfying a task in Phase One.

**The mutation engine is not reimplemented.** Stryker, mutmut and cargo-mut already insert seeded defects; the work here is interpreting their reports consistently, which is what decides whether the number is comparable across projects.

## Consequences

**Positive**

- The first criterion that can fail a task whose tests all pass. A green suite with a 30% kill rate is now detectable, and it is a common state.
- A single comparable number per task, so regression in test quality is trackable over time.
- It partly closes the vacuous-test hole: a test that asserts nothing survives every mutant, so it stops being able to satisfy a mutation criterion.
- `undetected` names the file and line, so the failure is actionable rather than a number to be argued about.

**Negative**

- Expensive. A mutation run re-executes the suite once per mutant, and the Developer must scope the tool to the task's files or the cost is prohibitive on a large repository.
- Only meaningful where a green baseline exists, so it cannot help Phase One. The vacuous-test problem is therefore caught in phase two rather than at the gate — later and more expensively, via an escalation.
- It says nothing about whether the code is *correct*. A suite can kill every mutant and still encode a wrong expectation. Mutation measures sensitivity, not validity.
- Tool output formats differ, so a project with an unusual report needs an adapter. Unrecognised input is treated as *survived* rather than killed, because defaulting the other way would inflate the score on a format change.

**Neutral**

- `minKillRate` defaults to 1.0 because the scope is the task's own code, where an undetected mutant is a real gap rather than background noise. A Developer can lower it, at the cost of a weaker guarantee.

## Open Questions

- Should `minKillRate` default to 1.0, or to a lower figure for larger tasks where a handful of equivalent mutants is normal?
- Should a mutation criterion be *required* for a task, or available? Required makes quality non-optional but is expensive; available makes it optional in exactly the projects that would benefit least.
- Can Phase One use this at all — for instance by mutating the stub and checking the test still fails for the same reason, which would detect a test coupled to nothing?
- Should mutant generation be requested by the Developer or derived from the task's target files automatically?

## See Also

- [ADR-0007 — Mechanical Verdicts with Expectation Inversion](0007-test-verdict-contract.md)
- [ADR-0006 — Phase One Is Mandatory](0006-phase-one-is-mandatory.md)
- [Testing](../testing/README.md)
- [Coverage Gaps](../testing/gaps.md)
