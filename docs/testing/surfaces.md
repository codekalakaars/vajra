# Development Surfaces

## Purpose

This document classifies what people actually build, and maps each surface to the three things a testing system must supply: **how it is invoked**, **what proves it correct**, and **what harness provides the environment**.

It exists because the answer determines the architecture. Testing an HTTP API, a React component, and a Python script look like three systems and reduce to two.

## Table of Contents

- [The Three Questions](#the-three-questions)
- [Surface Taxonomy](#surface-taxonomy)
- [Language × Surface](#language--surface)
- [The Two Mechanisms](#the-two-mechanisms)
- [Surface Definitions](#surface-definitions)
- [Component Testing by Framework](#component-testing-by-framework)
- [Choosing a Harness](#choosing-a-harness)

## The Three Questions

Every testable thing answers three questions. Get them right and the implementation follows; get them wrong and you build the wrong runner.

| Question | Options |
|----------|---------|
| **How is it reached?** | in-process call · HTTP · subprocess · rendered DOM · message queue · SQL |
| **What proves it correct?** | return value · thrown error · status and body · DOM state and roles · stdout and exit code · rows written · file produced |
| **Who provides the environment?** | nothing (pure) · a test framework · a browser · a database · a broker · a compiled toolchain |

A surface is a specific triple. There are far fewer triples than surfaces.

## Surface Taxonomy

| # | Surface | Reached by | Oracle | Needs | Status |
|---|---------|-----------|--------|-------|--------|
| 1 | Pure function / library | in-process | return value, throw | nothing | codegen |
| 2 | CLI / binary | subprocess | stdout, stderr, exit code, files | built binary | **built** |
| 3 | HTTP REST API | HTTP | status, body, headers | running server | **built** |
| 4 | React (or other) component | in-process render | DOM text, roles, callbacks | component library | codegen |
| 5 | Page / route | browser or SSR | rendered HTML, network | browser or SSR runtime | codegen |
| 6 | Worker / job / ETL | subprocess or message | output dataset, side effects | data fixture | partial |
| 7 | Queue consumer / producer | message | handler effect, published message | a broker | not built |
| 8 | gRPC service | RPC | response, status code | running server | not built |
| 9 | Data access / ORM | in-process or SQL | rows, constraints | a database | not built |
| 10 | Schema migration | subprocess | resulting schema | a database | not built |
| 11 | Serverless / edge function | subprocess or emulator | response | emulator | partial |
| 12 | Static analysis / types | subprocess | diagnostics | toolchain | indirect |
| 13 | Infrastructure / config | plan | plan diff, apply | cloud or emulator | not built |
| 14 | AI / model behaviour | in-process | score against a threshold | model access | not built |

Rows marked **built** are implemented in this package. `codegen` means the mechanism exists and the surface needs a generator, not a new runner. `indirect` means reachable today only by wrapping a command.

## Language × Surface

Not every combination is common. The realistic ones:

| Surface | JS/TS | Python | Go | Rust | Java | Ruby | C# |
|---------|:-----:|:------:|:--:|:----:|:----:|:----:|:--:|
| 1 Library | vitest/jest | pytest | `go test` | `cargo test` | JUnit | rspec/minitest | xunit |
| 2 CLI | `node:test` + spawn | pytest + `CliRunner` | `os/exec` | `assert_cmd` | `ProcessBuilder` | `Open3` | `Process` |
| 3 HTTP API | supertest / fetch | httpx / requests | httptest | reqwest + wiremock | MockMvc / RestAssured | rack-test | WebApplicationFactory |
| 4 Component | RTL | pytest-bdd + Playwright | chromedp | — | Playwright Java | Capybara | Playwright .NET |
| 5 Page / route | Playwright | Playwright | chromedp | — | Playwright | Capybara | Playwright |
| 9 Data | testcontainers | pytest + testcontainers | testcontainers | sqlx | Testcontainers | — | Testcontainers |
| 12 Static | `tsc --noEmit` | ruff, mypy | `go vet` | `cargo clippy` | — | rubocop | Roslyn |
| 14 AI eval | vitest | pytest | — | — | — | — | — |

**Go and Rust have no component-testing ecosystem**, and that is not a gap in this system — a component is a browser concern regardless of the backend language. Row 4 is empty for them because the surface does not exist for them.

## The Two Mechanisms

Every row above reduces to one of exactly two mechanisms. This is the most useful thing the taxonomy reveals.

### Mechanism A — spawn and assert on output

Covers CLI, migration, job, serverless, static analysis, and the whole of rows 2, 10, 6, 11, 12.

```
build ─▶ spawn command ─▶ assert stdout / stderr / exit code / files produced
```

Language appears only in the build command. The oracle is textual. This is what `createCommandRunner` and JUnit ingestion already do.

### Mechanism B — generate a test in the project's own idiom, then run it normally

Covers library, component, page, data, and gRPC: rows 1, 4, 5, 7, 8, 9.

```
declarative spec ─▶ generate a test file using the project's own test framework
                 ─▶ run it with the project's runner
                 ─▶ parse the report (JUnit) ─▶ existing verdict pipeline
```

**The critical consequence: a new framework does not need a new runner.** It needs a generator that emits the test file, because the framework's own harness already knows how to render, query and assert. Driving `@testing-library/react` from outside would mean reimplementing a renderer, which is absurd when the package is already a dependency.

Both mechanisms end at the same place — `RawTestOutcome[]` — so verdicts, expectation inversion, attribution, caching and flake detection are identical for all fourteen surfaces, on whichever rung of the [verification ladder](README.md#the-verification-ladder) runs them.

### What does not reduce

Rows 9, 10 and 7 genuinely need infrastructure: a database, a broker. There is no way around provisioning one. The honest options are testcontainers, an in-process substitute (`httptest`, SQLite in memory), or a recorded fixture — and choosing between them is a per-project decision, not something this system can abstract away.

## Surface Definitions

Machine-readable definitions live in `packages/tester/src/surfaces.ts`.

```typescript
interface SurfaceDefinition {
  name: string
  mechanism: 'spawn' | 'codegen'
  /** How the subject is reached. */
  invocation: 'subprocess' | 'http' | 'in-process' | 'message' | 'sql'
  /** What constitutes evidence of correctness. */
  oracle: ('output' | 'status' | 'body' | 'dom' | 'rows' | 'return' | 'diagnostics' | 'files')[]
  /** Infrastructure that must exist before a test can run. */
  requires: ('none' | 'toolchain' | 'runtime' | 'database' | 'broker' | 'browser')[]
  /** Probe kind or generator, when one exists. */
  implemented: boolean
}
```

## Component Testing by Framework

The question "how do we test a React component?" is really "what should the generated test assert?" — and the answer is nearly framework-independent.

A component test needs to establish five things:

| Property | Question | React (RTL) | Vue (Test Utils) | Svelte (Testing Library) |
|----------|----------|-------------|------------------|---------------------------|
| Renders | Does it produce a tree without throwing? | `render(<C />)` | `mount(C)` | `render(C)` |
| Content | Is the right text present? | `screen.getByText` | `wrapper.text()` | `screen.getByText` |
| Accessible | Can it be found by role and name? | `getByRole('button', {name})` | attributes / `aria` | `getByRole` |
| Interacts | Does a handler fire? | `fireEvent.click` + `toHaveBeenCalled` | `trigger` + spy | `fireEvent` + assertion |
| Reacts | Does state update change the output? | rerender / `act` | `await nextTick` | rerender / `act` |

Five properties, four frameworks, and the generated code differs only in imports and two or three call shapes. That is why a generator is the right unit of work: the hard part — knowing what to assert — is shared, and the easy part is a template.

**What a component test deliberately does not do:** assert on class names, internal state, or implementation details. Those break on every refactor while proving nothing about behaviour. The generated tests query by role and accessible name for exactly that reason, and a probe whose expectation is a CSS class is a probe that will need rewriting.

**Snapshot testing is deliberately excluded** from generation. A snapshot records whatever the component currently renders, including whatever is wrong, and then requires a human to review the diff — which is a review, not a test.

## Choosing a Harness

| If the project has | Use | Because |
|--------------------|-----|---------|
| a test runner emitting JUnit | Mechanism A, unmodified | Already compatible |
| a runner emitting TAP only | Mechanism A, with a fidelity warning | Cannot distinguish failure kinds |
| React / Vue / Svelte / Angular | Mechanism B, framework generator | Rendering is the harness's job |
| no test framework at all | Mechanism A against a spawned command | A `curl` is a test |
| a database | testcontainers, or an in-process substitute | No abstraction removes the need to provision |
| a browser-facing surface | Playwright, driven as Mechanism A | The browser *is* the environment |

The last row is worth stating plainly: for a page or route, this system should drive Playwright and parse its JUnit output rather than grow its own browser automation. Playwright is a solved problem and reimplementing it would be a large project that is worse.

## See Also

- [Testing](README.md) — the verification system
- [Coverage Gaps](gaps.md) — what cannot be tested, and why
- [ADR-0007](../adr/0007-test-verdict-contract.md) — the verdict contract every surface ends at
