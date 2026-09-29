# Testing

## Purpose

This document is the plan for the testing system — the subsystem that lets Vajra verify micro-tasks mechanically instead of by reading diffs. It covers the problem, the verdict contract, the components, and the build order.

## Table of Contents

- [The Problem](#the-problem)
- [The Verification Ladder](#the-verification-ladder)
- [Language Agnosticism](#language-agnosticism)
- [Testing APIs Directly](#testing-apis-directly)
- [Language Support](#language-support)
- [Development Surfaces](surfaces.md)
- [Coverage Gaps](gaps.md)
- [Requirements](#requirements)
- [The Verdict Contract](#the-verdict-contract)
- [Structural Proofs](#structural-proofs)
- [Expectation Inversion](#expectation-inversion)
- [Components](#components)
- [Test Selection](#test-selection)
- [Caching and Cost](#caching-and-cost)
- [Flakiness](#flakiness)
- [Blast Radius](#blast-radius)
- [Cross-Task Attribution](#cross-task-attribution)
- [Global Invariant](#global-invariant)
- [Build Order](#build-order)
- [Risks](#risks)
- [Open Questions](#open-questions)

## The Problem

Vajra's task model is deliberately fine-grained, and every task is verified mechanically by a [verification ladder](#the-verification-ladder) before the Manager agent gives its verdict ([ADR-0012](../adr/0012-verification-ladder-replaces-phase-one.md), [ADR-0013](../adr/0013-manager-verifies-reviews-and-retires-workers.md)). A modest piece of work might create a handful of tasks; a large one, hundreds.

That produces a testing system with an unusual shape:

| Naive assumption | What Vajra actually does |
|---|---|
| Tests pass or fail | A check can pass, fail on an assertion, or fail to run at all — and only one of those is success |
| Every task has tests | Many tasks have none; rungs 1–4 of the ladder verify work without a test suite |
| The suite runs in reasonable time | The suite grows monotonically and never shrinks |
| One task = one test failure | One submission = many tasks verified concurrently, sharing ports, fixtures and services |
| A failing test is a defect | It is — except in a task explicitly declared as writing a test for missing behaviour |
| Running the suite verifies the work | Running the suite may not reach the relevant tests in time |

The last row is the operational crux. At micro-task volume, a full-suite run per task does not scale — and the work that most needs verification is exactly the newest, smallest, least-covered change.

## The Verification Ladder

Every task is verified by a ladder of five rungs, declared by the Developer in the task and run by the Manager's mechanical part after the Worker reports completion ([ADR-0012](../adr/0012-verification-ladder-replaces-phase-one.md)). The rungs are climbed in order, and the ladder stops at the first rung that fails. Phase One, with its stub and failing-test tasks, was removed by ADR-0012; tests are now ordinary, optional tasks.

| Rung | Question | How the testing system runs it | Tier |
|------|----------|-------------------------------|------|
| 1. **Compiles** | Does the changed code build or type-check? | [Command runner](#language-agnosticism), Mechanism A in [Development Surfaces](surfaces.md): spawn the declared command, exit code first | 2 |
| 2. **Runs** | Does it start without crashing? | Command runner: spawn the entry point; a clean exit, or an optional readiness check, passes | 2 |
| 3. **Dependencies** | Does it work against the services it needs? | Each declared service is stubbed or health-checked before rungs 4 and 5 run | 2, unless its checks assert behaviour |
| 4. **Serves** | If it is a server, does it start and answer correctly? | [Testing APIs Directly](#testing-apis-directly): build, serve on a free port, probe readiness, assert probes | 1 when probes assert behaviour |
| 5. **Tests** | Do the project's relevant tests pass? | Command runner with [test selection](#test-selection); results ingested as JUnit XML or TAP | 1 when tests assert behaviour |

A rung that does not apply is declared not applicable with a reason — a pure library has no rung 4, a script with no tests has no rung 5. At least one rung must apply. The schema is in [Task Specification](../specifications/task-spec.md#verification-ladder-schema).

**Rungs 1, 2 and 5 are commands.** They reuse the command runner unchanged: Vajra runs what the task declares and reads the exit code and, for rung 5, the report. A build failure, a missing binary or a timeout is `failed_environment`, never a pass.

**Rung 3 is stubbed or checked, never assumed.** For each declared `ServiceDependency`, the verifier either starts the stub the task names (an in-process fake, a container, a recorded fixture) or runs the task's health check against the real service. A service that is neither stubbed nor healthy fails the rung as `failed_environment`. The stubs stay up for rungs 4 and 5.

**Assumption:** the Manager's mechanical verifier provisions the stubs and runs the health checks for rung 3. Workers do not write service stubs unless the Developer planned that as a task.

**Rung 4 is the API testing described below**, applied per task: the task declares the build and serve commands, the readiness check and the probes.

**Every rung produces verdicts from the same contract.** Each rung yields a `TestVerdict` and evidence, and the ladder as a whole yields a `LadderResult` that names the highest rung that passed. The report to the Human names that rung, so a task that only compiled is never reported as tested.

**"Fails" is not one thing.** On every rung, a check can be in several distinct states, and only one of them is success:

| State | Verdict | Meaning on a rung |
|---|---|---|
| Passes | `passed` | The rung holds; climb to the next |
| Fails on an assertion | `failed_assertion` | The code runs and does the wrong thing — a defect |
| Errors on import / syntax, cannot start, service missing | `failed_environment` | The check could not run at all — not a statement about behaviour |
| Not collected | `not_collected` | The runner never picked the test up — wiring is broken |

Collapsing these into pass/fail is the single most likely way to build this wrong. A test that errors on import looks exactly like a failing test to a naive runner, and the Manager agent's findings would then point at the wrong layer.

**The ladder feeds a review, not an automatic verdict.** The Manager agent reviews the `LadderResult`, the diff, the Worker's report and the success criteria, and gives `accepted`, `changes_requested` or `rejected`. It may reject a ladder pass; it may never accept a ladder fail ([ADR-0013](../adr/0013-manager-verifies-reviews-and-retires-workers.md)).

## Language Agnosticism

**Any API in a standard format, in any language, must be testable.** This is a requirement, not an aspiration, and it constrains the whole design rather than being a feature added at the end.

Three decisions carry it:

**1. Ingest standard result formats, not a bespoke shape.** Nearly every test runner in every language can already emit one of two formats. Vajra parses both:

| Format | Status | Carries the failure/error distinction? |
|--------|--------|---------------------------------------|
| **JUnit XML** | De facto standard — JUnit, pytest, Jest, and most Go/Rust/.NET/PHP runners directly or via a converter | **Yes** — `<failure>` vs `<error>` |
| **TAP** | The other universal format; line-based, trivial to emit | **No** — one `not ok` for both |

This is the single highest-leverage finding. The classification risk flagged in [Risks](#risks) — whether a runner exposes enough to tell an assertion failure from an environment error — is **answered for free by JUnit XML**, which already draws exactly that line. The remaining risk is confined to runners that can emit TAP but not XML.

**2. A test is a target, not a file.** The first implementation identified a test by the file containing it. That silently excluded every Rust `#[test]`, Go test function, Python unittest method, JUnit `classname`, HTTP endpoint, and gRPC method — which is most of what "any API" means. A test case is now `(kind, ref)`, where kind is `file`, `suite`, `http`, `grpc`, `process`, `wasi`, or `contract`. File paths are the common case, not the only case.

**3. Execute a command, not a runner.** `createCommandRunner` invokes a command, passes it test references, and reads the report it produced. Everything language-specific — build system, test framework, invocation flags — lives in that command. Vajra never learns how any language is tested.

```
cargo test -- --exact auth::tests   ─┐
pytest tests/test_auth.py            ─┼─▶ JUnit XML ─▶ RawTestOutcome[] ─▶ verdicts
go test ./... -json                  ─┤
mvn -q test                          ─┘
```

## Testing APIs Directly

A REST API in TypeScript, Python or Java is tested by *calling* it, not by finding a test file. Three pieces make that work.

**1. A declarative target.** Language appears exactly once, in the build and serve commands:

```jsonc
{
  "id": "accounts",
  "language": "java",              // a label, for diagnostics only
  "build": [{ "run": ["./mvnw", "-q", "package", "-DskipTests"] }],
  "serve": { "run": ["java", "-jar", "target/app.jar", "--server.port=${PORT}"],
             "port": 0,             // 0 = OS-assigned, so two targets never collide
             "ready": { "kind": "http", "path": "/health" } },
  "probes": [{
    "id": "login", "method": "POST", "path": "/login",
    "body": { "user": "ada", "password": "…" },
    "expect": { "status": 200, "body": { "$.data.token": { "exists": true } } }
  }]
}
```

Swapping TypeScript for Python changes two command arrays. Nothing else.

**2. Probed, not slept on.** Readiness is a poll — HTTP, TCP, or a log pattern — with a deadline. A slow start costs latency rather than a fixed guess, and a fast start is not penalised by a timeout sized for the slowest language. A process that dies while being waited on fails immediately with its output, instead of polling a dead port until the timeout.

**3. The verdict line on rung 4.** A failed probe maps to a verdict by asking one question — *did the server answer at all?*

| Probe outcome | Verdict | Ladder meaning |
|---|---|---|
| No response: build failed, nothing listening, connection refused, timeout | `failed_environment` | Rung 4 did not run — the server never came up, or a rung 3 dependency it needs is missing |
| A response that is not the expected one: 404, 500, wrong body | `failed_assertion` | Rung 4 ran and failed — the server works, the behaviour is wrong or absent |

A 404 from a running server is a defect the Worker can be told about. A server that never started is a different problem with a different fix, and it never satisfies a probe. Without this line a broken harness would look like a wrong implementation. For a task declared `writesFailingTest`, the second row is the expected outcome; the first never is.

**Contract-derived probes.** A contract already states methods, paths, required parameters and response schemas — the four things a hand-written probe must supply. `deriveProbesFromOpenApi` generates a probe per operation, filling required parameters with type-correct samples and **skipping** any parameter it cannot derive rather than guessing. Generated probes assert response *shape*, never semantics: nobody can derive "a valid password is 8+ characters" from a schema, and pretending otherwise would produce a gate that passes unconditionally.

A worked example covering all three languages, the missing-behaviour case, the dead-server case and contract derivation is at `packages/tester/examples/rest-api.mjs`.

## Language Support

Test selection only works if the system can see which files depend on which, so each language is described as data rather than code: how to spot its files, recognise its tests, extract specifiers, and what paths those specifiers resolve to.

| Language | Recognises tests as | Specifier form |
|----------|---------------------|----------------|
| JavaScript / TypeScript | `*.test.ts`, `*.spec.js`, … | relative paths |
| Python | `test_*.py`, `*_test.py`, `tests/**` | `from x.y import z`, relative `from .x` |
| Rust | `*_test.rs`, `tests/**` | `mod x;`, `use crate::a::b` |
| Go | `*_test.go` | package paths |
| Java / Kotlin | `src/test/**`, `*Test.java`, `*IT.java` | `import a.b.C;` |
| Ruby | `spec/*_spec.rb`, `test/*_test.rb` | `require`, `require_relative` |
| C# | `tests/**`, `*Tests.cs` | `using A.B;` |

Languages coexist: a change to a TypeScript file does not select Python tests, and a change to a Python file does not select TypeScript tests.

**Where a language lies about its dependencies, the system says so.** A Java, Go or C# import names a *package*, not a file. Resolution therefore falls back to "everything under that directory", and a package path that cannot be resolved at all is recorded in `unmodelled` rather than dropped — because an unresolved edge and a clean result are indistinguishable, and only one of them is true. `internalPrefixes` lets a caller declare a module path or groupId in-tree when the layout is non-standard.

## Mutation Scoring — Does the Test Suite Have Teeth?

Every other criterion answers *did the tests pass*. None answers *would these tests have caught a defect*.

That is not academic. A suite can be entirely green and worthless: `expect(1).toBe(1)` passes forever, and `assert isAdult(20)` passes while the upper bound is never checked. Coverage would not catch it — the lines run, they just assert nothing. A stronger expectation would not — nobody can guess the assertion that is missing. More tests would not — they are the thing that is wrong.

```
all tests green, yet:
  total mutants    4 (scorable 3, excluded 1)
  kill rate        33%
  undetected       survived @ src/a.ts, no_coverage @ src/b.ts
  task verifies?   false
```

Three rules make the number mean something:

| Rule | Why |
|------|-----|
| **A green baseline is required** | On an already-failing suite, "a test failed on the mutant" cannot be attributed to the mutant. A task declared `writesFailingTest` is reported *not applicable* rather than guessed at; any other task has a green baseline once rung 5 passes |
| **Compile errors and timeouts are excluded** | A mutant that does not compile is not a defect a test could have caught; charging it punishes the toolchain, not the tests |
| **No coverage is reported apart from survived** | An untested line and a wrong assertion need different fixes; a single blended figure hides the distinction that tells you what to do next |

A surviving mutant is an **oracle failure** and maps onto `failed_assertion`, so it obeys the same rules as every other assertion failure.

**The engine is not reimplemented.** Stryker, mutmut and cargo-mut already insert seeded defects; the work is interpreting their reports consistently, which is what makes the number comparable across projects. Unrecognised input is treated as *survived*, never killed — defaulting the other way would inflate the score on a format change.

What it does **not** tell you: whether the code is *correct*. A suite can kill every mutant and still encode a wrong expectation. Mutation measures sensitivity, not validity.

## Development Surfaces

Testing an HTTP API, a React component and a Python script look like three systems and reduce to two. Full taxonomy in [Development Surfaces](surfaces.md).

| Surface | Reached by | Mechanism | Status |
|---------|-----------|-----------|--------|
| Library / pure function | in-process | codegen | 8 languages |
| CLI / binary | subprocess | spawn | **built** |
| HTTP REST API | HTTP | spawn | **built** |
| React / Vue / Svelte / Angular component | in-process render | codegen | 4 frameworks |
| Page / route | browser | drive Playwright | partial |
| Job / ETL / serverless | subprocess | spawn | **built** |
| Static analysis / types | subprocess | wrap a command | partial |
| Queue, gRPC, data, migration, infra, AI eval | — | — | need real infrastructure |

**Mechanism A — spawn and assert.** Build, run, assert on stdout, stderr, exit code, and files produced. The exit code is checked *first*: a command that printed exactly the right thing and exited non-zero has still failed. A build failure, a missing binary, or a timeout is an environment failure on every probe — never a pass, on any rung.

**Mechanism B — generate a test in the project's own idiom.** A declarative spec becomes a real test file using the framework the project already depends on, which its own runner executes, and the existing JUnit ingestion handles the result.

**Surface dispatch.** `createSurfaceRunner` resolves a surface name to the right runner, and `checkPlan` refuses a plan whose prerequisites are absent — at submission, not three minutes into a build. A surface this package cannot build is reported `unsupported` rather than as a missing prerequisite, so the reader is sent after the right thing.

**Route resolution.** A task that changes a route handler must select the probes for that route. Import-graph selection cannot do this: a route file is not imported by anything, it *defines* the thing being tested. Routes are therefore indexed in the other direction — files that define `GET /users/{id}` map to the probes that exercise it — with parameter spellings normalised so `:id`, `<int:id>` and `{id}` compare equal across frameworks.

The consequence is the important part: **a new framework needs a generator, never a runner.** Driving `@testing-library/react` from outside would mean reimplementing a renderer, which is absurd when the package is already a devDependency.

## What Is Still Missing

A standard format for test *definition* does not exist the way one exists for results. An IETF draft (`draft-cui-bmwg-testcase-spec`, 2025) explicitly notes the absence of a formal standard and proposes a structure, but it is not a standard. Meanwhile API contracts are well specified — OpenAPI, AsyncAPI, protobuf, GraphQL SDL, JSON Schema — and a contract is enough to *derive* stimulus and an oracle.

So the remaining gap is **contract-driven test generation**: given an OpenAPI document, produce a task's rung 4 probes or its tests without a human writing them. That is a milestone, not a finished feature, and it is tracked in [Open Questions](#open-questions).

## Requirements

Derived from the existing ADRs rather than chosen freely:

| # | Requirement | Source |
|---|---|---|
| R1 | Verification is mechanical, not a judgement about a diff | [ADR-0004](../adr/0004-manager-inspects-never-repairs.md), [ADR-0013](../adr/0013-manager-verifies-reviews-and-retires-workers.md) |
| R2 | Every task declares an executable verification ladder when it is created, with at least one applicable rung | [ADR-0012](../adr/0012-verification-ladder-replaces-phase-one.md) |
| R3 | A Worker's completion is a claim; the Manager holds the verdict, and never accepts over a failed ladder. The Worker sees only the findings of a `changes_requested` review | [ADR-0013](../adr/0013-manager-verifies-reviews-and-retires-workers.md), [Validation Flow](../execution/README.md#validation-flow) |
| R4 | Per-task verification must be fast enough to run on every task | Micro-task volume |
| R5 | A failing test must be attributable to the task that caused it | [File Ownership](../permissions/README.md#file-ownership) |
| R6 | The whole plan is judged against tests, not against the Developer's plan | [ADR-0005](../adr/0005-predefined-parallel-order.md) |
| R7 | Any API in a standard format, in any language, is testable | [Language Agnosticism](#language-agnosticism) |
| R8 | A test is identified by a target, never by a file path | [Language Agnosticism](#language-agnosticism) |

## The Verdict Contract

This is the interface everything else is built against, and the reason it is worth an ADR. See [ADR-0007](../adr/0007-test-verdict-contract.md).

```typescript
type TestVerdict =
  | "passed"              // criterion met
  | "failed_assertion"    // real failure: behaviour does not match the criterion
  | "failed_environment"  // could not run: import error, syntax error, missing export
  | "not_collected"       // test file exists, the runner never picked it up
  | "scope_violation"     // a file outside the task was modified
  | "flaky"               // verdict changed across reruns
  | "timeout";            // exceeded the budget

type ExpectedOutcome = "pass" | "fail_on_assertion";

/** One result per rung. A task's rungs together form its LadderResult. */
interface VerificationResult {
  taskId: string;
  rung: "compile" | "run" | "dependencies" | "serve" | "tests";
  /** From the task. Only then can `expected` be "fail_on_assertion". */
  writesFailingTest?: boolean;

  expected: ExpectedOutcome;
  observed: TestVerdict;

  /** The only field the Manager acts on. */
  satisfied: boolean;

  tests: TestOutcome[];
  diagnostics: Diagnostic[];
  durationMs: number;
  cached: boolean;
}

interface TestOutcome {
  id: string;
  file: string;
  verdict: TestVerdict;
  message: string;
  location?: { file: string; line: number };
}

interface Diagnostic {
  kind: "missing_export" | "syntax_error" | "unresolved_import" | "timeout" | "ambiguous";
  message: string;
  /** The task this is attributed to, when it is not the task under test. */
  attributedTo?: string;
}
```

`satisfied` is computed, never asserted:

```typescript
function satisfied(expected: ExpectedOutcome, observed: TestVerdict): boolean {
  if (observed === "flaky" || observed === "timeout") return false;
  return expected === "pass"
    ? observed === "passed"
    : observed === "failed_assertion";
}
```

Two properties are deliberate:

- **Flaky and timeout never satisfy a task**, even one declared `writesFailingTest`. A new test that is merely flaky has not demonstrated that the behaviour is missing.
- **A `failed_environment` never satisfies anything.** It means the test is broken, not that the behaviour is absent.

## Structural Proofs

A verdict answers "did this command go green", not "was the command the right one". Those come apart, and the space between them is where a false pass lives.

Success criteria therefore sit on **tiers**, and the tier is recorded rather than inferred. See [Criterion Tiers](../specifications/task-spec.md#criterion-tiers) and [ADR-0011](../adr/0011-tiered-success-criteria.md).

| Tier | Establishes | Example | Verdict means |
|------|-------------|---------|---------------|
| 1 — Behavioural | The behaviour is right | `npm test -- login` | Probes or tests that assert the claimed behaviour passed |
| 2 — Structural | The change is real, wired in, well-formed | `tsc --noEmit` | The change compiles and is reachable — and nothing about behaviour |

**The same verdict value carries a different claim at each tier.** A green `tsc --noEmit` is `passed` at tier 2 and says nothing at tier 1. This is why the tier travels with the criterion into the verdict and out into the report: a system that reports both as "passed" has thrown away the only information that distinguished them.

### Why the structural tier exists

Not every piece of work has a behavioural test available, and refusing the plan because of it produces a worse outcome than accepting a weaker proof. A new endpoint, a new screen, a new module: the honest first proof is that it compiles and is wired in. That is a genuine before/after transition — the import did not resolve before, the route was not registered before — it simply does not claim more than it can.

The floor is unchanged: **every task carries at least one tier 1 or tier 2 criterion**, and a task whose criteria are all `review` is rejected at submission. Applicable ladder rungs satisfy this floor: rungs 1–3 are tier 2, and rungs 4–5 are tier 1 when they assert behaviour. Nothing became unverifiable. Only the height of the floor moved, and a task that clears neither is still refused.

### What a structural pass does not prove

Worth stating plainly, because the failure mode is quiet:

- **It does not prove behaviour.** Code that compiles can be wrong in every way a user notices. This is the entire gap between the tiers and it does not narrow with effort.
- **It is gameable in a way behavioural proofs are not.** A `tsc` that passes on a file exporting nothing useful is a clean pass over an empty deliverable. Tier 2 needs a stated lower bound on what it must assert — a declared export, a reachable route, a registered handler — and where that bound sits is an open question in [ADR-0011](../adr/0011-tiered-success-criteria.md).
- **It is expensive.** The best structural evidence is a build or a type-check, which routinely costs more wall-clock than the edit being verified. On a large repository, verification can cost more than the work.
- **It is not cacheable yet.** Compilation results are content-addressed and would pay off enormously on a wide refactor, but [Caching and Cost](#caching-and-cost) already flags a stale pass as the more dangerous direction, and that trade is unresolved.

### What a structural pass is good for

It is a real gate, and it catches the majority of what goes wrong in practice: a missing import, a route never registered, a signature that does not line up, a module that does not build. Those are not rare failures and they are not subtle. Tier 2 is a genuine improvement over no proof at all — it is only a weaker improvement than tier 1.

## Expectation Inversion

Every rung expects `pass`. Inversion exists for one case only: a task the Developer explicitly declares as writing a test for behaviour that does not exist yet (`writesFailingTest: true`). Nothing requires such a task ([ADR-0012](../adr/0012-verification-ladder-replaces-phase-one.md)).

```typescript
function expectedOutcome(task: Task, rung: VerificationResult["rung"], test?: TestOutcome): ExpectedOutcome {
  if (task.writesFailingTest && rung === "tests" && test && writtenBy(task, test)) {
    return "fail_on_assertion";
  }
  return "pass";
}
```

| Task | Rung | Expected | Passing means |
|---|---|---|---|
| Any task | Every applicable rung | `pass` | The rung holds |
| `writesFailingTest` | 1–4 | `pass` | The new test code builds and the harness runs |
| `writesFailingTest` | 5, for the tests it wrote | `fail_on_assertion` | The test runs and fails on an assertion |
| A later task implementing that behaviour | 5 | `pass` | The test now passes |

**Assumption:** only the tests the task wrote are inverted. Other tests selected on rung 5 still expect `pass`, so a test-writing task cannot break existing behaviour unnoticed.

For such a task the same verdict means opposite things: its own test failing is the objective, while the identical test failing for a later task is a defect. The verdict layer is where that inversion lives, so no caller has to remember it.

## Components

```
   Task declaration (ladder, tests)
            │
            ▼
   ┌─────────────────┐
   │ Test Registry   │  test ref → owning task, and reverse
   └────────┬────────┘
            │
            ▼
   ┌─────────────────┐      ┌──────────────────┐
   │  Resolver       │─────▶│  Command Runner  │  any language
   │ (per-language)  │      └────────┬─────────┘
   └─────────────────┘               │ JUnit XML / TAP
                                    ▼
                           ┌──────────────────┐
                           │    Classifier    │  raw → TestVerdict
                           └────────┬─────────┘
                                    ▲
                           ┌────────┴─────────┐
                           │  Flake Tracker   │
                           └──────────────────┘
                                    │
                                    ▼
                           ┌──────────────────┐
                           │    Verifier      │  climbs the ladder; rung 3 stubs and checks;
                           └────────┬─────────┘  inversion for writesFailingTest only
                                    ▼
                  VerificationResult per rung → LadderResult → Manager
```

The **Verifier** is the only component the Manager's mechanical part talks to. It climbs the task's ladder, provisions rung 3 stubs and health checks, and composes selection, execution, classification, and expectation inversion into a `satisfied` boolean plus evidence per rung. The Manager agent reviews the resulting `LadderResult`.

## Test Selection

Selection is what makes per-task verification affordable. Given a task's `targetFiles`, find the tests that could possibly be affected — no more, no less.

Selection goes through a `DependencyResolver` interface, so a language contributes an implementation and the core is unaware of it. A `createMultiResolver` unions several ecosystems, and a resolver that cannot model a dependency must over-report rather than return nothing — an empty result is indistinguishable from "no tests are affected", which is how coverage silently disappears.

**The JavaScript/TypeScript implementation** is a reverse dependency index over the module graph.

```typescript
deps: Map<sourceFile, Set<sourceFile>>      // transitive imports
testsFor: Map<sourceFile, Set<testFile>>    // reverse index
```

For a task touching `T`:

```
selected = ⋃ { testsFor[f] : f ∈ affectedBy(T) }

affectedBy(T) = T ∪ { g : ∃ t ∈ T, t ∈ deps[g] }
```

That is, everything that transitively imports anything in `T`.

**Global files** must be handled explicitly. Changes to a test runner config, a setup file, a fixture directory, or a shared mock affect every test regardless of the import graph. These are declared as a set whose membership invalidates the whole selection.

**This is the highest-risk component after the classifier**, for reasons in [Risks](#risks).

## Caching and Cost

Test execution dominates cost, so results are cached by content rather than recomputed.

```
key = hash(testFileContent
         + sorted transitive dependency hashes
         + globalFileHashes
         + runnerVersion
         + envFingerprint)
```

A cache hit short-circuits selection, execution, and classification entirely.

Caching works unusually well here because the invalidation points are exactly the file changes: creating a file changes a dependency hash, writing a test changes the test hash, implementing changes the implementation hash. Every real transition invalidates, and nothing else does.

**Assumption:** Over-invalidation is preferred to under-invalidation. Hashing normalised content (stripping comments and whitespace) would reduce misses, but a normalisation bug causes a stale pass, which is far worse than a slow rebuild.

## Flakiness

At micro-task volume with many concurrent Workers, a flaky test is a serious failure mode: it produces false rejections, which produce escalation round trips, which cost more than the flakeness saved.

Detection is rerun-based. On `failed_assertion` or `timeout`, rerun up to `N` times; a changed verdict promotes the result to `flaky`.

A per-test flake history is kept with decay, and a test crossing a threshold is reported to the Developer. Flaky tests are a task-definition problem, so they belong in the escalation path rather than being retried indefinitely.

**Assumption:** `N = 3` reruns. Higher is expensive and tends to launder genuine nondeterminism; lower misses common patterns.

## Blast Radius

Task-scoped tests are necessary but not sufficient. A task that changes a shared file can break tests outside its own scope, and a system that only checks its own tests will report success on a broken codebase.

Two tiers:

| Tier | Scope | On failure |
|------|-------|-----------|
| **Required** | The task's own declared tests | Task fails |
| **Advisory** | Tests transitively depending on the task's files | Reported upward; does not fail the task |

The advisory tier is what catches collateral damage. A task is not responsible for pre-existing breakage, so failing it for someone else's test would be wrong — but the breakage must still surface.

## Cross-Task Attribution

A ladder failure is sometimes caused by a *different* task. The common case: task B imports a symbol from a file task A owns, A has not exported it, and B fails rung 1 (or rung 5) with an unresolved import. B's own code may be correct.

The classifier should detect this and attribute it correctly:

```json
{
  "kind": "missing_export",
  "message": "src/login.ts imports 'validateUser' which src/auth.ts does not export",
  "attributedTo": "task_auth"
}
```

This turns a confusing "your code is broken" into "a file you depend on is incomplete", and it points at the task that can actually fix it. Without it, the Manager agent would send findings to a Worker that cannot act on them, and the Developer would debug the wrong task. Peer awareness helps prevent this case — B can see A's ownership and handoff — but it does not replace attribution.

## Global Invariant

> **At rest, every test passes.**

After all phases complete, no test should be failing. A persistently failing test means the system is in a broken state that task-level verdicts have not surfaced.

This is worth monitoring directly, because it catches what per-task verification structurally cannot: a task that was verified against its own tests while something else was already broken. It is also the check on the ladder itself — if anything still fails at rest, some task was accepted that should not have been, or a rung was declared not applicable that applied. A test written by a `writesFailingTest` task that still fails at rest means the implementing task was never planned or never accepted.

## Build Order

Each milestone is independently useful, so the system delivers value before it is complete.

| # | Milestone | Delivers | Depends on |
|---|---|---|---|
| **M0** | Verdict contract | Verdict types; classify a parsed report into structured verdicts | — |
| **M1** | Test-to-task binding | Registry mapping test files to owning tasks, from task declarations (rung 5, and tasks that write tests) | — |
| **M2** | Single-task verification | `task.assign` → run → `VerificationResult`. No caching, no selection | M0, M1 |
| **M3** | Test selection | Import graph and reverse index; select instead of running everything | M2 |
| **M4** | Caching | Content-addressed result reuse | M3 |
| **M5** | Flake detection | Rerun-on-failure, `flaky` verdict, flake history | M2 |
| **M6** | Blast radius | Advisory tier over dependent tests | M3 |
| **M7** | Global invariant | At-rest health check and persistent-failure reporting | M4 |
| **M8** | Verification ladder | Rungs 1–5 climbed in order, stopping at the first failure; rung 3 stubs and health checks; `LadderResult` | M2 |

M0 and M1 can start in parallel. M3 and M5 are independent of each other once M2 lands.

**M0 is the make-or-break, and JUnit XML largely defuses it.** The format already distinguishes `<failure>` from `<error>`, which is exactly the split the contract needs. The residual risk is a runner that can emit TAP but not XML — TAP has no such distinction, so a rung 5 failure cannot be *proven* to be a defect rather than a broken environment, and a `writesFailingTest` expectation can only be assumed. Prefer XML where the runner offers it, and record the format alongside the verdict so a TAP-derived pass is never mistaken for a proven one.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Runner emits neither JUnit nor TAP** | The contract is unimplementable for that runner | Probe for XML first — the overwhelming majority can produce it. Fall back to TAP with a recorded fidelity warning |
| **TAP cannot distinguish failure kinds** | A rung 5 failure cannot be proven a defect, and a `writesFailingTest` expectation is assumed rather than proven | Prefer XML; record the source format on the verdict |
| **Import graph is incomplete** | Selection silently misses affected tests — the worst failure mode, because it looks like success | Treat selection as advisory-first: widen rather than narrow, and cross-check against the advisory tier |
| **Dynamic or reflective dependencies** | Same as above; a DI container or dynamic import is invisible statically | Declare these as global files so they invalidate everything |
| **Two languages, two graphs** | JS/TS and Rust need separate import-graph implementations | Scope M3 to one language first and measure whether the other needs it |
| **The ladder is declared too weakly** | Rungs marked not applicable to avoid work make every later verdict weak | Every not-applicable rung needs a reason; reports name the highest rung reached; the Manager agent sees the declaration in review |
| **Stubs can lie** | Rung 3 passes against a stub the real service would reject | Record in the rung 3 evidence which services were stubbed and which were checked, so a stubbed pass is never read as a production pass. See [Coverage Gaps](gaps.md) |
| **Environment cost moves to verification** | Starting services and servers per task is slow; parallel tasks contend for ports and fixtures | OS-assigned ports (`port: 0`). See [Coverage Gaps](gaps.md) |
| **One task's defect surfaces in another** | A task fails for a file another task owns | Cross-task attribution (above) |

## Open Questions

- [ ] Can the chosen runner classify assertion failures versus environment errors reliably? **M0 answers this.**
- [ ] Which test runner is the target, and is one enough given the Rust and TypeScript split?
- [ ] Does selection start with the task's declared tests only, or is the import graph needed from the first version?
- [ ] What is the per-task time budget before a task is treated as `timeout`?
- [ ] Should the advisory blast-radius tier block the submission as a whole, or only report?
- [ ] Is the at-rest invariant checked after every submission, or on a schedule?
- [ ] What is the minimum ladder for a task — is rung 1 alone ever enough to accept? (Open in [ADR-0012](../adr/0012-verification-ladder-replaces-phase-one.md).)
- [ ] Are rung 3 service stubs generated from a contract (OpenAPI, SQL schema) or supplied per project?
- [ ] How does rung 4 share ports and fixtures between concurrent tasks?
- [ ] Does a `changes_requested` round re-run the whole ladder, or only the rungs that failed?
- [ ] Are test results shared across submissions, or scoped to one? Sharing is faster; scoping avoids cross-session coupling.

## See Also

- [ADR-0006 — Phase One Is Mandatory](../adr/0006-phase-one-is-mandatory.md) (superseded)
- [ADR-0007 — Test Verdict Contract](../adr/0007-test-verdict-contract.md)
- [ADR-0012 — A Verification Ladder Replaces Phase One](../adr/0012-verification-ladder-replaces-phase-one.md)
- [ADR-0013 — The Manager Verifies, Reviews, and Retires Workers](../adr/0013-manager-verifies-reviews-and-retires-workers.md)
- [Execution](../execution/README.md)
- [Tasks](../tasks/README.md)
- [Permissions](../permissions/README.md)
- [Runtime](../runtime/README.md)
