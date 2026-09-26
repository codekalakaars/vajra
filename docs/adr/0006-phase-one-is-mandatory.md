# ADR-0006: Phase One Is Mandatory

## Status

Accepted

## Date

TODO: Date this decision was made.

## Context

The task model requires every task to be testable — target files known, success criteria defined. That is a property of the *task definition*, enforced at submission.

It is not the same as a test existing. "Add rate limiting to the login route" is testable in the sense that a Developer can say what done means, but before Phase One there is no artifact on disk that mechanically demonstrates it. Success is judged by whoever reads the diff.

Writing the tests and creating the stub files first, as a mandatory opening stage, changes that. A test that exists and fails is a precise, executable definition of done, present before any implementation is written.

The alternative is to let each implementation task carry its own tests, as a dependency within its group. That is more compact, and it is what most teams do.

## Decision

Every submission begins with a mandatory **Phase One**, containing two kinds of work in order:

1. **Stub files** — every `targetFiles` path exists, minimal but syntactically valid, exporting the symbols the work will reference.
2. **Tests** — a runnable test per behaviour, currently failing on an assertion.

No later phase may begin until Phase One is fully `completed`.

Phases are the sequential spine of a submission: they run one after another, while groups and tasks within a phase may run in parallel.

## Consequences

**Positive**

- **Success criteria are executable before implementation starts.** "Done" becomes a command's exit code rather than a reviewer's judgement.
- **Every target path is guaranteed to exist.** A Worker never decides whether to create a file or which path to use; both were settled at the gate.
- **Expensive discovery happens early.** Questions that would surface mid-implementation surface in Phase One, where the only cost is a stub and a test.
- **A narrow, unambiguous Worker job.** Once Phase One is done, implementation work reduces to making a failing test pass.
- **The gate is inspectable.** Stub and test quality can be reviewed as its own stage, separately from implementation.

**Negative**

- **More tasks, and some are throwaway.** A stub exists to be replaced, and a failing test exists to be made to pass. That is real work that produces no final value on its own.
- **Doubles the task count for small changes.** A one-file fix now needs a stub task and a test task before the fix. The overhead is only worth it when the work is substantial enough to be worth specifying precisely.
- **Phase One can block everything.** A test that cannot be written — because the behaviour is not yet understood — stalls the whole submission until the Developer resolves it.
- **Stub quality becomes load-bearing.** A stub exporting the wrong symbols produces Phase One tests that fail for the wrong reason, which is worse than no test.

**Neutral**

- A test that *passes* at the end of Phase One is a signal worth surfacing: either the behaviour already exists or the test asserts nothing.

## Open Questions

- Is there a threshold below which Phase One is skipped for trivial work? The decision as written has no exemption.
- Are Phase One tests written against the stub's signature, which means a wrong stub signature propagates into every test?
- Should the Manager report a suspiciously passing Phase One test back to the Developer?

## See Also

- [ADR-0001 — Developer-Only Task Creation](0001-developer-only-task-creation.md)
- [ADR-0005 — Predefined Parallel Order](0005-predefined-parallel-order.md)
- [Tasks](../tasks/README.md#phase-one)
- [Execution](../execution/README.md)
