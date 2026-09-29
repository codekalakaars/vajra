# ADR-0012: A Verification Ladder Replaces Phase One

## Status

Accepted. Supersedes [ADR-0006](0006-phase-one-is-mandatory.md). Amends [ADR-0007](0007-test-verdict-contract.md).

## Date

2026-09-29

## Context

[ADR-0006](0006-phase-one-is-mandatory.md) made every submission open with a mandatory Phase One: stub files, then tests that fail on an assertion, before any implementation. The aim was sound — make "done" executable before work starts — but the price was high and paid on every submission:

- **The task count roughly doubled.** A one-file fix needed a stub task and a test task before the fix.
- **Throwaway work.** A stub exists to be replaced, and a failing test exists to be made to pass.
- **One stalled test stalled everything.** No later phase could start until every Phase One task completed.
- **It needed a second meaning for every verdict.** A failing test was success in Phase One and a defect afterwards, which is why [ADR-0007](0007-test-verdict-contract.md) had to add expectation inversion.

The question the Manager actually has to answer for a task is simpler: *does this work, as far as a machine can tell?* For most real work, that answer comes in steps. First the code has to compile. Then it has to run. Then it has to run against the services it depends on. If it is a server, it has to start and answer requests correctly. Each step is only worth checking once the step before it holds, and each one that fails says exactly where the problem is.

## Decision

**Phase One is removed.** A submission no longer has a mandatory opening phase of stubs and failing tests. Phases remain as ordered stages the Developer may use; none is special. The Developer no longer creates stub files: a declared target file that does not exist yet is created by the Worker whose task owns it.

**Every task is verified by a verification ladder**, run by the Manager's mechanical verifier after the Worker reports completion. The ladder has five rungs, climbed in order, and it stops at the first rung that fails:

| Rung | Question | Typical evidence |
|------|----------|------------------|
| 1. **Compiles** | Does the changed code build or type-check? | `tsc --noEmit`, `cargo check`, `go build`, a bundler build |
| 2. **Runs** | Does it start without crashing? | The entry point, script, or binary runs to a clean exit or reaches ready |
| 3. **Dependencies** | Does it work against the services it needs? | Databases and external services are stubbed, or confirmed reachable and healthy |
| 4. **Serves** | If it is a server, does it start and answer correctly? | Server started on a free port, readiness probed, HTTP/CLI probes asserted |
| 5. **Tests** | Do the project's relevant tests pass? | Selected tests from the project's own runner, ingested as JUnit XML or TAP |

- **The Developer declares the ladder for each task.** A task names which rungs apply and how each is run: the build command, the run command, the services it depends on, the server and its probes, and the tests. A rung that does not apply is declared as not applicable with a reason — for example, a pure library has no rung 4.
- **At least one rung is mechanical and applies.** A task whose ladder is entirely not applicable is invalid, for the same reason a task whose criteria are all `review` is invalid under [ADR-0011](0011-tiered-success-criteria.md).
- **Rung 3 means stubbed or checked, never assumed.** For each service a task depends on, the ladder either starts a stub for it (an in-process fake, a container, a recorded fixture) or confirms the real service is reachable and healthy before continuing. A service that is neither stubbed nor healthy fails rung 3 as `failed_environment`, never as a pass.
- **Tests are optional work, not a gate.** Writing tests is ordinary work the Developer may plan as its own tasks. When tests exist for the changed code, rung 5 runs them.
- **Rungs map onto the existing tiers.** Rungs 1–2 are structural (tier 2). Rungs 4–5 are behavioural (tier 1) when their probes or tests assert behaviour. Rung 3 is structural unless its checks assert behaviour. The report to the Human names the highest rung each task reached, so a task that only compiled is never reported as tested.

**Effect on ADR-0007.** The verdict contract stands: every rung produces a structured `TestVerdict`, `satisfied` is computed rather than asserted, and `flaky`, `timeout` and `failed_environment` never satisfy a task. Expectation inversion is no longer needed by default, because no phase manufactures failing tests on purpose: every rung expects `pass`. The `fail_on_assertion` expectation remains available for a task that is explicitly declared as writing a test for missing behaviour, but nothing requires one.

**Assumption:** the Manager's mechanical verifier owns stubbing for rung 3. The Developer declares the dependencies in the task, and the verifier provisions the stubs or runs the health checks. Workers do not write service stubs unless the Developer planned that as a task.

## Consequences

**Positive**

- **Fewer tasks, no throwaway work.** A one-file fix is one task.
- **No global gate.** A task that cannot be verified stalls itself and what depends on it, not the whole submission.
- **Failures point at the right layer.** "Does not compile", "crashes on start", "database stub missing" and "probe returned 500" are different problems with different fixes, and the ladder separates them.
- **One meaning per verdict.** Without Phase One, a failing check is always a defect.
- **Work with no tests is still verifiable,** because rungs 1–4 do not need a test suite.

**Negative**

- **"Done" is no longer defined before implementation.** Phase One made success executable up front; the ladder checks after the fact. A task whose probes or tests are weak is verified weakly, and nothing forces a test to exist.
- **Stubs can lie.** A stubbed database accepts writes the real one would reject. Rung 3 proves the code works against the stub, not against production.
- **Environment cost moves to verification.** Starting services and servers per task is slow, and parallel tasks can contend for ports and fixtures. See [Coverage Gaps](../testing/gaps.md).
- **The ladder is only as good as its declaration.** A Developer who marks rungs not applicable to avoid work weakens every verdict that follows.

**Neutral**

- Phases, groups, dependencies and priority are unchanged; only the mandatory first phase is gone.
- Mutation scoring ([ADR-0008](0008-mutation-as-criterion.md)) still requires a green baseline, which the ladder provides as soon as rung 5 passes.

## Open Questions

- What is the minimum ladder for a task — is rung 1 alone ever enough to accept?
- Are service stubs generated from a contract (OpenAPI, SQL schema) or supplied per project?
- Are ladder results cached across tasks that share a build?
- How does rung 4 share ports and fixtures between concurrent tasks?

## See Also

- [ADR-0006 — Phase One Is Mandatory](0006-phase-one-is-mandatory.md) (superseded)
- [ADR-0007 — Mechanical Verdicts](0007-test-verdict-contract.md)
- [ADR-0011 — Tiered Success Criteria](0011-tiered-success-criteria.md)
- [ADR-0013 — The Manager Verifies, Reviews, and Retires Workers](0013-manager-verifies-reviews-and-retires-workers.md)
- [Testing](../testing/README.md)
