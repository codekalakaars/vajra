# Vajra: Worker Tuning Plan

**Status:** Draft, replaces every earlier plan.
**Date:** 2026-10-02

## Purpose

Vajra is judged here on one thing: **how fast it finishes a fixed set of predefined tasks, all of them, in one run.** The tasks do not change. What changes is a set of parameters that control the Workers and the scheduler. We measure each configuration, keep the fastest one that always finishes, and make it the default.

This plan replaces `VAJRA_BUILD_PLAN.md`, `VAJRA_END_TO_END.md` and the three `AGENT_RUNTIME_*` plans, which have been removed, along with the `examples/` folder. The ADRs stay as background. Nothing in them is being built by this plan unless a step below says so.

## Table of Contents

- [The Goal, Precisely](#the-goal-precisely)
- [Out of Scope](#out-of-scope)
- [Starting Point](#starting-point)
- [The Parameters](#the-parameters)
- [Order of Work](#order-of-work)
- [PR 1 — Headless Plan Runner](#pr-1--headless-plan-runner)
- [PR 2 — The Parameter Surface](#pr-2--the-parameter-surface)
- [PR 3 — Run Metrics](#pr-3--run-metrics)
- [PR 4 — The Task Suites](#pr-4--the-task-suites)
- [PR 5 — The Tuning Sweep](#pr-5--the-tuning-sweep)
- [PR 6 — New Speed Levers](#pr-6--new-speed-levers)
- [The Tuning Procedure](#the-tuning-procedure)
- [Definition of Done](#definition-of-done)
- [Risks](#risks)

## The Goal, Precisely

**A run** is one invocation of `vajra bench <suite>` against a fresh copy of the suite's fixture. It has no human input and no Developer conversation: the plan is predefined and goes straight to the Manager.

**A run succeeds** when every task in the suite completes and the suite's acceptance command passes afterwards. A task that fails, is skipped or is escalated fails the run. There is no partial credit and no second invocation.

**The score** is wall-clock time, from the first Worker spawned to the last task completed. A failed run has no score.

**A configuration qualifies** only if it succeeds on every repetition (default 5). Among qualifying configurations, the lowest median score wins. Token cost is recorded and breaks ties; it is not the target.

## Out of Scope

- The Developer conversation and plan confirmation. Suites bypass both.
- Compaction, checkpoints and respawn-with-findings (ADR-0015, ADR-0016). Suite tasks are small enough not to fill a context window. If a sweep shows otherwise, that is a finding, and it gets its own plan.
- The Manager review, the SQLite state tables and the TUI status lines.
- The `packages/agent` relocation.
- Changing the tasks to make them faster. The suites are fixed; only parameters move.

## Starting Point

As of `7d2f49c`, on `feat/cli-agent-v1-config`:

| Area | Fact | Where |
|------|------|-------|
| Scheduler | `masterLoop` tops up the pool when a task settles, bounded by `maxWorkers` | `packages/cli/src/agent/master.ts:205` |
| Concurrency | `--concurrency` overrides `resolveConcurrencyConfig().maxConcurrentWorkers` (default 4) | `packages/cli/src/session/service.ts:63` |
| Locks | Every file, including read-only inputs, is locked in `'write'` mode | `service.ts:911`, `:1139` |
| Shared reads | `FileLockManager` supports `'read'` mode and has no production caller | `packages/sandbox/src/file-locks.ts` |
| Worker loop | `executeTask` has a hard-coded budget of 100 tool calls | `packages/cli/src/tasks/execute.ts:141` |
| Worker reasoning | The Worker's `streamChatCompletion` call passes no `reasoningEffort` | `execute.ts:209` |
| Worker prompt | Tells the Worker to read each `readFile` first: one or more model rounds before any edit | `execute.ts:185` |
| Parallel reads | Consecutive read-only tool calls in one message already run concurrently | `execute.ts:254` |
| Timeout | `-t` (default 300 s) applies only to validation commands | `execute.ts:342` |
| Retries | Task field `retries`, default 2; a retry rolls back and reruns the same prompt | `packages/cli/src/agent/taskqueue.ts:88`, `master.ts:294` |
| Sandbox pool | `maxIdleWorkers` (1) and `idleTimeoutMs` (60 s) keep sandboxes warm | `packages/sandbox/src/resources.ts:42` |
| Task suites | None. `examples/` was removed; every suite is written fresh in PR 4 | — |
| Fake provider | `scriptedProvider` replays rounds; used by every model test | `packages/cli/test/_provider.mjs` |

## The Parameters

These are the knobs. Each has a name, an environment variable, and a default equal to today's behaviour, so introducing them changes nothing.

| Parameter | Env | Default | Exists today | Expected effect |
|-----------|-----|---------|--------------|-----------------|
| `concurrency` | `VAJRA_CONCURRENCY` | 4 | Yes (`--concurrency`) | More parallel Workers until write conflicts or rate limits bind |
| `workerModel` | `VAJRA_WORKER_MODEL` | the default model | Yes | Faster models per round; weaker models retry more |
| `workerReasoning` | `VAJRA_WORKER_REASONING` | `off` (as today) | No | Less thinking is faster per round; may cost retries |
| `workerMaxToolCalls` | `VAJRA_WORKER_MAX_TOOL_CALLS` | 100 | Hard-coded | A tighter cap ends runaway Workers sooner |
| `taskTimeoutSec` | `VAJRA_TASK_TIMEOUT` | 300 | Yes (`-t`), validation only | Applied to the whole attempt, it bounds a stalled Worker |
| `retries` | `VAJRA_RETRIES` | 2 | Per task only | Default for tasks that do not set it |
| `readLocks` | `VAJRA_READ_LOCKS` | `exclusive` | No (code exists, unused) | `shared` lets tasks that only read the same file run together |
| `preloadReads` | `VAJRA_PRELOAD_READS` | `false` | No | Put `readFile` contents in the prompt; saves the first read round |
| `parallelReads` | `VAJRA_PARALLEL_READS` | `true` | Always on | Kept as a knob so its effect can be measured |
| `warmSandboxes` | `VAJRA_WARM_SANDBOXES` | 1 | Yes (`maxIdleWorkers`) | Fewer cold sandbox launches between tasks |

Precedence is the existing one: environment, then a params file passed with `--params <file.json>`, then the default. A bench run records the fully resolved set in its result, so every score says exactly what produced it.

## Order of Work

```
PR 1  Headless plan runner ──┐
PR 2  Parameter surface ─────┼──▶ PR 5  Tuning sweep ──▶ Tuning procedure ──▶ PR 6  New levers ──▶ re-tune
PR 3  Run metrics ───────────┤
PR 4  Task suites ───────────┘
```

PRs 1–4 can run in parallel. PR 1 and PR 2 both touch `service.ts`; PR 1 owns the extraction of the execution block and PR 2 rebases onto it. PR 5 needs all four. PR 6 starts only after the first tuning pass shows where the time goes.

**Integration branch:** `feat/cli-agent-v1-config`. Branches are named `vajra/tune-N-<slug>`.

**Gate for every PR:** `pnpm build:all && pnpm test:all`. The replay fixtures in `packages/cli/test/fixtures/replay/` must not change in PRs 1–3: at default parameters, behaviour is identical.

## PR 1 — Headless Plan Runner

**Goal:** run a predefined plan to completion with no Developer and no prompt.

1. Extract the execution block of `runSession` (`service.ts`, from plan confirmation to the execution report) into `executePlan(plan, options, ui): Promise<ExecutionResult>`. `runSession` calls it. No behaviour change.
2. Add `vajra bench <suite-dir>`:
   - copies the suite's `fixture/` into a temporary directory and commits it as a baseline;
   - loads `plan.json` and validates it with `validatePlan`; an invalid plan is a setup error, not a failed run;
   - calls `executePlan` with auto-confirm on and the resolved parameters;
   - runs the suite's acceptance command in the copy;
   - writes `result.json` (see PR 3) and exits 0 on success, 1 on a failed run, 2 on a setup error.
3. `--keep` leaves the temporary copy for inspection; otherwise it is removed.

**Tests:** a bench run of a two-task suite against `scriptedProvider` succeeds; a suite whose acceptance command fails reports a failed run; an invalid plan exits 2.

## PR 2 — The Parameter Surface

**Goal:** every parameter in [the table](#the-parameters) is one value, resolved in one place, and reaches the code it controls.

1. Add `WorkerParams` and `resolveWorkerParams(env, file?)` in `packages/cli/src/config.ts`, validating by hand (no `zod` in `cli`).
2. Wire the knobs that already exist: `concurrency`, `workerModel`, `taskTimeoutSec`, `retries`, `warmSandboxes`.
3. Replace the hard-coded `MAX_WORKER_TOOL_CALLS` with `workerMaxToolCalls`.
4. Pass `workerReasoning` to the Worker's `streamChatCompletion`, going through the model catalog's `reasoningLevelsFor` so a model that does not reason gets nothing.
5. Put `parallelReads` around the existing read-overlap branch in `execute.ts`.
6. `vajra bench --params <file>` and `vajra config -l` show the resolved values and their source.

`readLocks` and `preloadReads` are declared here, accept only their default, and are implemented in PR 6.

**Tests:** precedence (env over file over default); invalid values rejected with the key named; replay fixtures unchanged.

## PR 3 — Run Metrics

**Goal:** a run explains where its time went, not just how long it took.

`result.json` holds:

| Field | Meaning |
|-------|---------|
| `params` | The resolved parameters |
| `success`, `failureReason` | Run outcome |
| `wallMs` | First spawn to last completion |
| `criticalPathMs` | The longest chain of dependent or same-file tasks, using measured task durations: the floor that no concurrency setting can beat |
| `idleMs` | Time a task was ready but not running, summed: what more concurrency could recover |
| `tasks[]` | Per task: ready, start and end times; attempts; model rounds; tool calls; prompt and completion tokens; validation time |
| `tokens`, `costUsd` | Totals, using the model catalog's prices |

Timestamps come from the existing `AgentEvent` and `TaskEvent` streams; this PR adds a recorder, not new events, except where an event lacks a timestamp.

**Tests:** a scripted two-wave run produces the expected `criticalPathMs` and `idleMs` within tolerance.

## PR 4 — The Task Suites

**Goal:** fixed, checked-in workloads that represent different shapes of plan.

Each suite lives in `bench/suites/<name>/` with `fixture/`, `plan.json`, `accept.sh` (or an argv in `suite.json`) and a `README.md` stating what the suite exercises.

| Suite | Fixture | Shape | Why |
|-------|--------|-------|-----|
| `api` | Small Node HTTP server | 5 tasks, 4 on one file | Mostly serial: measures per-task speed |
| `mixed` | Small multi-module JS library | 10 tasks over 4 files | Mixed: same-file chains in parallel with each other |
| `wide` | Independent modules | 8 independent tasks, one file each | Pure parallelism: measures concurrency and rate limits |
| `chain` | One feature built in layers | 4 tasks, each depending on the last | Pure serial: measures per-task latency only |

Rules for every suite:

- **The acceptance command fails on the pristine fixture** and passes on a reference solution kept in `bench/suites/<name>/solution/`. A suite that cannot show both is not admitted.
- The fixture is the starting state the tasks change. Fixtures use Node's built-in test runner and no npm dependencies, so a suite needs no install step and its timing is not skewed by one.
- Acceptance tests are hidden from Workers: they live outside `fixture/` and are copied in only after the run.

**Tests:** for each suite, accept fails on `fixture/` and passes on `solution/`. This runs in CI and needs no model.

## PR 5 — The Tuning Sweep

**Goal:** run many configurations, repeatedly, and say which one wins.

`scripts/tune.mjs`:

1. Takes a sweep file: a suite list, a base parameter set, the parameters to vary with their values, and a repetition count.
2. Runs `vajra bench` for each combination and repetition, one at a time (bench runs must not compete for the provider's rate limit).
3. Appends each `result.json` to `bench/results/<date>-<sweep>.jsonl`.
4. Prints a table per suite: configuration, success rate, median and p90 `wallMs`, median tokens. Configurations below 100% success are listed but marked disqualified.

Results files are committed: they are the evidence for any default that changes.

## PR 6 — New Speed Levers

Built only after the first pass of [the procedure](#the-tuning-procedure), in the order the metrics point to:

- **`readLocks: shared`.** Read files take `'read'` leases; write files take `'write'`. Admission (`canAdmitTask`) and acquisition (`runTaskOnce`) both change. Pays off when `idleMs` is high and tasks block on files they only read.
- **`preloadReads: true`.** The harness puts each `readFile`'s content in the Worker's first message and drops "Read each readFile first" from the prompt. Pays off when the first model round of most tasks is only reads.
- **`taskTimeoutSec` over the whole attempt.** Each attempt gets its own `AbortController`, linked to the session's, fired at the timeout. Pays off when one stalled Worker dominates `wallMs`.

Each lever ships with its default off, so the PR changes nothing until a sweep shows it helps.

## The Tuning Procedure

Not code. This is how the parameters are chosen, and its output is a committed `bench/profiles/fast.json` and a results file per step.

1. **Baseline.** Today's defaults, every suite, 5 repetitions. If a suite does not succeed 5 out of 5 at baseline, fix reliability first (model, `retries`, `workerMaxToolCalls`) before chasing speed: a fast configuration that sometimes fails does not qualify.
2. **One at a time,** in expected order of impact: `workerModel`, `concurrency` (1, 2, 4, 6, 8), `workerReasoning`, `workerMaxToolCalls`, `warmSandboxes`, `parallelReads`. Keep each winner before moving on.
3. **Read the metrics.** If `wallMs` is close to `criticalPathMs`, more concurrency cannot help; the lever is per-task speed. If `idleMs` is high, the lever is admission (`readLocks`, `concurrency`).
4. **Build PR 6** levers the metrics point to, then sweep them.
5. **Confirm.** The combined winner, 10 repetitions per suite. It must succeed 10 out of 10.
6. **Adopt.** The winning values become the defaults in `resolveWorkerParams`, with the results file cited in the commit.

## Definition of Done

- `vajra bench bench/suites/<name>` runs every suite to completion with no human input.
- Every parameter in the table is resolved in one place, recorded in every result, and settable by env or params file.
- `bench/profiles/fast.json` succeeds 10 out of 10 on every suite.
- Its median `wallMs` beats the baseline on every suite, and the results files that show it are committed.
- The defaults equal the winning profile.

## Risks

| Risk | Mitigation |
|------|------------|
| Model latency varies run to run, so one run proves nothing | Medians over at least 5 repetitions; compare only runs from the same sweep |
| Provider rate limits cap useful concurrency | `wide` exposes it; the sweep runs one bench at a time |
| A faster setting trades away reliability | 100% success is a hard gate, not a weight |
| Suites overfit: the winner is fast on four toy repos only | Suites differ in shape; add a real-repo suite before adopting defaults for general use |
| Workers see acceptance tests and code to them | Acceptance tests are copied in only after the run |
| Free-tier models are slow or unavailable | Record the model in every result; a sweep that changes model is its own comparison |
