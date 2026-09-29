# ADR-0007: Mechanical Verdicts with Expectation Inversion

## Status

Accepted. Amended by [ADR-0012](0012-verification-ladder-replaces-phase-one.md): with Phase One removed, every ladder rung expects `pass`, and expectation inversion applies only to a task explicitly declared as writing a test for missing behaviour.

## Date

TODO: Date this decision was made.

## Context

Every task's success criteria must be verifiable, and the Manager must produce the verdict. [ADR-0006](../adr/0006-phase-one-is-mandatory.md) makes this sharper than usual: Phase One deliberately creates tests in a failing state, so a failing test is sometimes the objective and sometimes a defect.

The Manager currently has two plausible ways to decide.

The first is to read the diff and judge. This is what [ADR-0004](../adr/0004-manager-inspects-never-repairs.md) already leans toward for `review`-type criteria, and it is unreliable here: a diff that looks correct may not satisfy a test, and a natural-language judgement is not reproducible.

The second is to run the tests and take the result at face value — passed, failed. This is worse, because it conflates states that must be distinguished. A Phase One test that fails on an assertion has succeeded. A test that errors on import has failed, and the fix is in the stub, not the test. A test the runner never collected has failed. A test that passes in Phase One has either found existing behaviour or asserts nothing. All four look identical to a boolean.

Accepting the second option would let a broken Phase One pass the gate, which defeats the purpose of the gate entirely.

## Decision

Verification produces a **structured verdict**, not a boolean, and the verdict layer — not the caller — applies **expectation inversion** based on the task's phase and kind.

- Verdicts are one of `passed`, `failed_assertion`, `failed_environment`, `not_collected`, `scope_violation`, `flaky`, or `timeout`.
- The expected outcome is derived from the task: a Phase One `test` task expects `fail_on_assertion`; everything else expects `pass`.
- `satisfied` is computed from expected and observed, and is the only field the Manager acts on.
- `flaky` and `timeout` never satisfy a task, in any phase.
- `failed_environment` never satisfies a task, in any phase.

The Manager does not receive raw test output and does not interpret it. See [Testing](../testing/README.md) for the contract and build plan.

## Consequences

**Positive**

- Phase One becomes verifiable. A test that fails on an assertion is a positive result, and the gate means what it claims.
- Broken scaffolding is caught. A test that cannot run is distinguished from a behaviour that is absent, so a bad stub cannot masquerade as a good test.
- Verdicts are reproducible and auditable, unlike a judgement about a diff.
- The same code path serves both phases; the inversion is one function, not a convention every caller must remember.
- `flaky` and `timeout` are surfaced as their own states rather than being retried into a misleading pass or fail.

**Positive**

- Ingesting JUnit XML satisfies the contract for essentially every existing runner. The format's native `<failure>`/`<error>` split is exactly the assertion-versus-environment distinction this contract turns on, so the classification risk is resolved for the overwhelming majority of toolchains without Vajra learning anything about them.

**Negative**

- Depends on the underlying test runner exposing enough detail to classify outcomes. JUnit XML does; TAP does not, having a single `not ok` for both cases. A TAP-only runner can therefore produce verdicts but cannot *prove* a Phase One gate, and the fidelity loss should be recorded rather than hidden.
- Semantic distinctions such as "fails for the right reason" are encoded as rules, and they will need refining against real cases.
- A passing Phase One test is a signal that has no obvious verdict. It is neither success nor clean failure, and needs a policy.

**Neutral**

- `review`-type criteria remain outside this contract. Mechanical verdicts cover `test` and `assertion`; a judgement call is still a judgement call, and is documented as such.

## Open Questions

- ~~Which runner can be classified reliably?~~ **Resolved: JUnit XML.** Remaining question is which runners need adapters, and whether a TAP-derived verdict should be marked as unproven.
- Should the source report format be recorded on the verdict, so a TAP-derived pass is never mistaken for a proven one?
- What should a Phase One test that unexpectedly passes report — success, failure, or a distinct signal?
- Should `failed_environment` be retryable after the Developer fixes the stub, or always terminal?
- How much of the verdict is exposed to the Human, and how much is internal to the Manager?

## See Also

- [ADR-0004 — The Manager Inspects and Escalates, Never Repairs](0004-manager-inspects-never-repairs.md)
- [ADR-0006 — Phase One Is Mandatory](0006-phase-one-is-mandatory.md)
- [Testing](../testing/README.md)
- [Execution](../execution/README.md#validation-flow)
