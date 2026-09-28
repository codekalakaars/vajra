# Roadmap

## Purpose

This section tracks what is planned, what is undecided, and what has been decided. It points at the ADRs rather than restating them.

## Table of Contents

- [Status](#status)
- [Architectural Decisions](#architectural-decisions)
- [Open Questions](#open-questions)
- [Planned Work](#planned-work)
- [Before a Release](#before-a-release)
- [Future Experiments](#future-experiments)

## Status

The conceptual model is documented and internally consistent. Every role, the task lifecycle, the permission model, and the message protocol are specified. The runtime is not built.

| Area | State |
|------|-------|
| Role model | Settled — see [System Roles](../system-roles/README.md) |
| Task model | Settled — see [Tasks](../tasks/README.md) |
| Phase One gate | Settled — see [ADR-0006](../adr/0006-phase-one-is-mandatory.md) |
| Verdict contract | Settled — see [ADR-0007](../adr/0007-test-verdict-contract.md) |
| Testing system | Core built — verdicts, JUnit/TAP ingestion, selection, cache, flakes, attribution |
| Language agnosticism | Core built — standard-format ingestion and target-agnostic identity |
| API invocation | Core built — declarative targets, lifecycle, probes, oracles, auth chains |
| Language support | 7 languages — JS/TS, Python, Rust, Go, Java, Ruby, C# |
| CLI / process probes | Built — exit code, stdout, stderr, files, teardown |
| Component generation | React, Vue, Svelte, Angular |
| Library generation | 8 languages |
| Surface taxonomy | 14 surfaces classified, see [Surfaces](../testing/surfaces.md) |
| Route → probe selection | Built — 8 framework route syntaxes, param normalisation |
| Surface dispatch | Built — `createSurfaceRunner`, `checkPlan` |
| Mutation scoring | Built — Stryker/mutmut ingestion, kill rate, per-mutant outcomes |
| Contract-driven test generation | OpenAPI derivation built; AsyncAPI, protobuf, GraphQL, JSON Schema not |
| Permission model | Settled conceptually; enforcement mechanism open |
| Message protocol | Types settled; transport and versioning open |
| Agent identity & per-role models | Settled — see [ADR-0010](../adr/0010-every-role-is-an-llm-agent.md); **not implemented** — one `--model` per session, and the LLM Manager path is unreachable |
| Criterion tiers | Settled — see [ADR-0011](../adr/0011-tiered-success-criteria.md); **not implemented** — the validator still requires a `proves-change` command on every task |
| Parallelism ceiling | Fixed constant only. `adaptiveConcurrency`, `maxCpuUsage`, `maxMemoryUsage` and `minConcurrentWorkers` are declared in config and **read by nothing** |
| Worker crash containment | Built — per-task Worker pool, locks released in `finally`; documented in [ADR-0011](../adr/0011-tiered-success-criteria.md) |
| Manager inspection | **Not implemented** — the Manager receives a boolean from validation exit codes; no `rejected` state exists |
| Runtime | Not started |
| LLM provider (shipped CLI) | Settled — OpenCode Zen only, see [ADR-0009](../adr/0009-opencode-zen-is-the-only-provider.md); a second provider is planned |
| API key configuration (shipped CLI) | Implemented; **not tested end to end** — see [Before a Release](#before-a-release) |

## Architectural Decisions

Decisions are recorded once, as ADRs, and are not restated here.

| ADR | Decision |
|-----|----------|
| [ADR-0001](../adr/0001-developer-only-task-creation.md) | Only the Developer creates tasks |
| [ADR-0002](../adr/0002-single-task-workers.md) | Workers execute one task at a time |
| [ADR-0003](../adr/0003-task-scoped-permissions.md) | Worker permissions are scoped to the assigned task |
| [ADR-0004](../adr/0004-manager-inspects-never-repairs.md) | The Manager inspects and escalates, never repairs |
| [ADR-0005](../adr/0005-predefined-parallel-order.md) | Parallel order is predefined by the Developer, not derived at runtime |
| [ADR-0006](../adr/0006-phase-one-is-mandatory.md) | Every submission opens with a mandatory Phase One of stubs and failing tests |
| [ADR-0007](../adr/0007-test-verdict-contract.md) | Mechanical verdicts with expectation inversion, not a boolean |
| [ADR-0008](../adr/0008-mutation-as-criterion.md) | Mutation scoring is a first-class criterion |
| [ADR-0009](../adr/0009-opencode-zen-is-the-only-provider.md) | OpenCode Zen is the only LLM provider; one `OPENCODE_API_KEY` at `0600` |

## Open Questions

The largest unresolved decision is the transport between the runtime and a Worker, because it constrains sandboxing, isolation strength, and startup cost simultaneously.

Grouped by where they are documented:

**Runtime** — [Runtime open questions](../runtime/README.md#open-questions)

- Worker transport: local subprocess or network.
- Per-task Worker provisioning cost.
- Context selection and budget.
- Inspection of non-test criteria.
- Audit log versus event stream.
- Task state storage and retention.

**Security** — [Security open questions](../permissions/security-model.md#open-questions)

- Sandbox lifetime and isolation mechanism per platform.
- Network access: denied, or opt-in per task.
- Whether output redaction is in scope.
- Whether a Worker may read outside its target set.

**System Roles** — [Agent lifecycle open questions](../system-roles/README.md#open-questions)

- Worker provisioning: on demand or pooled.
- What context a Worker loads.
- Worker reuse across tasks.
- Failure and timeout handling.
- Are Developer and Manager singletons?

**Tasks** — [Task open questions](../tasks/README.md)

- Whether the parallelism limit is per submission or a deployment-level cap. Currently assumed per submission.
- Whether priority is a total order or only pairwise between colliding tasks. Currently assumed pairwise.
- Whether the Manager should report a poorly grouped plan back to the Developer as a suggestion.
- Whether Phase One should be exemptible for trivial work. Currently assumed mandatory with no exemption. The [testing system](../testing/README.md) is what would produce the data to set a threshold.
- Whether the Manager should surface a suspiciously passing Phase One test to the Developer.
- Diagrams for blocked-task handling.

**Testing** — [Testing open questions](../testing/README.md#open-questions)

- Whether the target runner can classify outcomes reliably. **M0 answers this, and it can invalidate the design.**
- Which runner, and whether one suffices across the Rust and TypeScript split.
- Whether selection needs the import graph from the first version.
- The per-task time budget before a task is treated as `timeout`.
- Whether the advisory blast-radius tier blocks a submission or only reports.
- Whether test results are shared across submissions or scoped to one.

## Planned Work

Ordered by what unblocks the most downstream work.

1. **Diff coverage as a criterion** — the next false-pass source after suite sensitivity. A passing suite that never executes the new line reports success today. Related work: [ADR-0008](../adr/0008-mutation-as-criterion.md).
2. **Uncertainty in the verdict** — `satisfied: true` cannot distinguish "verified thoroughly" from "selected 1 of 9 relevant tests". Carrying selection completeness, unmodelled dependencies and coverage would let the Manager escalate a weak pass instead of closing it.
3. **Worker transport** — settles sandboxing, isolation, and the runtime shape together.
4. **Contract-derived tests beyond OpenAPI** — AsyncAPI, protobuf/gRPC, GraphQL SDL, and JSON Schema. OpenAPI derivation is built; the rest share the same shape and are the natural extension.
5. **Non-HTTP invocation targets** — gRPC, subprocess, and WASI targets are modelled in the type system but have no runner. HTTP covers the common case; these are the remainder of "any API".
6. **Observable side effects** — the largest remaining gap. A probe asserts on the response, so a rolled-back write that still returns `201` passes. See [Coverage Gaps](../testing/gaps.md). Read-after-write probes mitigate the common case; email, queueing and third-party calls remain unverified.
7. **Non-HTTP transports** — gRPC, WebSocket, SSE and message queues are modelled in the type system but have no runner.
8. **Streaming expectations** — the model is one request to one response, so a sequence-valued result has no representation.
9. **Page and route testing** — should drive Playwright and parse its JUnit output rather than grow browser automation. Playwright is a solved problem and reimplementing it would be a large project that is worse.
10. **Queue, gRPC and data surfaces** — all three need real infrastructure. Testcontainers or an in-process substitute is a per-project decision, not something this system can abstract away.
4. **Protocol versioning** — needs a version field before a second role implementation exists.
5. **Permission enforcement** — Worker-side and environment-side controls, per [Permissions](../permissions/README.md#enforcement-points).
6. **Scheduling engine** — phases, groups, ownership, and the Manager loop.
7. **Resolvers beyond JavaScript/TypeScript** — a Rust `mod` resolver is the obvious next one given this repo's shape.
8. **Audit log** — required for the accountability claims in the security model.
9. **A second LLM provider** — Vajra is OpenCode Zen only today, and that forecloses every user whose models are hosted elsewhere. The change is contained: a base URL per provider, a model-id namespace, a listing URL, and a decision about how credentials are stored per provider. That last one is the real work, and [ADR-0009](../adr/0009-opencode-zen-is-the-only-provider.md) records it as deliberately deferred. See [LLM Providers](../runtime/llm-providers.md) for the shape of the change.

The classification spike that previously sat at position 2 is resolved: JUnit XML carries the assertion-versus-environment distinction natively.

## Before a Release

Owed by the shipped `vajra` CLI, independent of the harness work above.

1. **Test the API key configuration path end to end.** It is implemented and verified by hand, not by test: `vajra auth login` writing `~/.vajra/auth.json` at `0600`; the precedence order (`--api-key`, environment, `auth.json`) asserted as a whole; `logout` leaving a session that correctly refuses to start; a key set while a session is open being picked up by the live gate; a rejected key failing cleanly rather than retrying; and the credential appearing in no transcript, session row, index file or log line. The first and last are cheap and worth doing regardless. See [Coverage Gaps](../testing/gaps.md).
2. **A pty-level smoke test for both front-ends.** Neither TUI is driven by any test today, which is why two real defects got through: a loop that exhausted the heap in about ten seconds, and a key gate that shipped instructing the user to press Enter on a prompt that would not accept it.
3. **Decide the credential file's fate.** `index/` and its files inherit the umask while everything else in `~/.vajra` is `0600`; stale index files are never evicted and sessions have no retention policy. Neither is dangerous, both grow without asking.

## Future Experiments

Not committed. Recorded so the reasoning is not lost.

- **Task bundling** — if per-task Worker provisioning proves too slow to be practical, allowing a Worker to hold a short queue of tasks would trade away the clean single-task attribution in exchange for throughput. Would need an ADR.
- **Worker peer review** — a Worker inspecting another Worker's output would strengthen the independence argument, but reintroduces lateral communication, which the hub topology currently forbids.
- **Human-in-the-loop gating** — requiring Human approval before a Worker writes anything, at least for high-risk paths. The model already routes all Human interaction through the Developer, so this is a policy question rather than an architectural one.
- **Reusing inspection findings** — if the same failure recurs across tasks, feeding prior inspection results back to the Developer could improve task definition. Depends on audit log retention.

## See Also

- [ADRs](../adr/README.md)
- [Specifications](../specifications/README.md)
- [Overview](../overview/overview.md)
