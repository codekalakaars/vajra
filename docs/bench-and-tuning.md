# Vajra: Orchestration and Context Plan

**Status:** Active. The only plan.
**Date:** 2026-10-02

## Goal

The tasks are given. Find the arrangement of parallel Workers that finishes all of them fastest, in one run.

- **A run** is one `vajra bench <suite>` against a fresh copy of the suite's files. The plan is predefined. There is no Developer and no human input.
- **A run succeeds** when every task completes and the suite's acceptance command passes. Anything else fails the run.
- **The score** is wall-clock time from the first Worker spawned to the last task completed.
- **An arrangement qualifies** only if it succeeds on every repetition (5 while tuning, 10 to confirm). The lowest median score wins.

Context management serves the same goal: a Worker that starts with what it needs edits sooner, and a Worker that compacts instead of overflowing finishes instead of starting over.

## Table of Contents

- [Goal](#goal)
- [Built So Far](#built-so-far)
- [The Arrangement: bench/config.json](#the-arrangement-benchconfigjson)
- [Context Management](#context-management)
- [Batches](#batches)
- [Tuning](#tuning)
- [ADRs to Write](#adrs-to-write)
- [Deferred](#deferred)
- [Done When](#done-when)

## Built So Far

One line each; the code and its tests are the detail.

| Piece | Where |
|-------|-------|
| `vajra bench <suite>`: fresh copy, predefined plan, no Developer, acceptance tests copied in after, exit 0/1/2 | `packages/vajra/src/bench/run.ts` |
| Every parameter from `bench/config.json`, validated, no fallbacks | `packages/vajra/src/bench/config.ts` (`loadWorkerParams`), `packages/vajra/src/bench/params.ts` |
| No Worker count: admission by CPU and RAM, lowest-priority Worker paused when the CPU chokes, process tree frozen | `manager/governor.ts`, `manager/pause.ts`, `sandbox/src/process/freeze.ts`, `manager/master.ts` |
| Schedule order and shared read locks, with normalized lock paths | `manager/master.ts`, `manager/leases.ts` |
| Whole-attempt timeout that a pause does not run down; aborts reach in-flight model requests | `worker/execute.ts`, `model/chat.ts` |
| Tool output cap (command tail, file head) and Worker history trim that never drops the task | `worker/output-cap.ts`, `developer/developer.ts` (`compressMessages`, `pinned`) |
| Run metrics: wall, critical path, idle, paused, peak context, trims | `packages/vajra/src/bench/metrics.ts`, `bench/result.ts` |
| Four suites (`wide`, `chain`, `fan`, `mixed`) and the sweep script | `bench/suites/`, `bench/tune.mjs`, `bench/sweeps/` |

The context batches, K0–K5, are built. What each one added:

| Batch | What exists | Where |
|-------|-------------|-------|
| K0 Contracts | `context`, `edits`, `verify`, `successCriteria`, `notes` and the plan's `contracts` reach the queue, the Worker's task type and every pack | `protocol/src/tools.ts`, `manager/taskqueue.ts`, `agent/developer.ts`, `tasks/context-types.ts` |
| K1 Token accounting | `ContextBudget`: the window from the catalog, a characters-per-token ratio calibrated from reported `prompt_tokens` and shared across Workers, estimates and shares | `model/budget.ts` |
| K2 Context pack | `buildContextPack`: ten sections, budgeted at `packWindowShare`, excerpts degrading last-declared first, anchors relocated or marked stale, deterministic sha256; over-budget fixed sections are a bench setup error | `worker/pack.ts`, `worker/project-card.ts`, `worker/prompt.ts`, `bench/run.ts` |
| K3 Compaction ladder | the ledger, elision, the forced `write_checkpoint` round with runtime-owned fields, the diff, and stuck — plus every attempt's outcome through `context.onAttemptEnd` | `worker/ledger.ts`, `elide.ts`, `checkpoint.ts`, `diff.ts`, `worker/execute.ts` |
| K4 Respawn and handoffs | one `AttemptRecord` per attempt with its diff captured before the rollback, the *Previous attempt* block, and a runtime-computed `Handoff` per completed task | `manager/handoff.ts`, `manager/execute-plan.ts` |
| K5 Metrics | per task: pack tokens, sections cut, stale and relocated anchors, seek ratio, redundant reads, rounds to first edit, elisions, compactions, stuck; per run: the totals and the most-missed paths; a `seek` column and three new sweeps | `packages/vajra/src/bench/metrics.ts`, `bench/result.ts`, `bench/tune.mjs`, `bench/sweeps/` |
| ADRs | 0017 the context pack, 0018 the compaction ladder, 0019 respawn context and handoffs | `adr/` |

## The Arrangement: bench/config.json

Every parameter lives in one checked-in file, `bench/config.json`, and nowhere else: no environment variables, no flags, no defaults in code. Every key is required; a missing or invalid key stops the run before it starts and names the key. Context features start switched off, so the first values equal the behaviour the replay fixtures pin.

```json
{
  "cpuPauseAt": 0.9,
  "cpuResumeAt": 0.75,
  "cpuOwnMin": 0.1,
  "minFreeMemMb": 1024,
  "workerMemMb": 256,
  "resourceSampleMs": 1000,
  "scheduleOrder": "plan",
  "readLocks": "exclusive",
  "workerModel": "zen/space-bunny-free",
  "workerReasoning": "off",
  "workerMaxToolCalls": 100,
  "taskTimeoutSec": 300,
  "retries": 2,
  "preloadReads": false,
  "toolOutputMaxChars": 20000,
  "warmSandboxes": 1,
  "contextPack": false,
  "packWindowShare": 0.35,
  "anchorContextLines": 12,
  "elision": false,
  "elideAt": 0.5,
  "keepRecentRounds": 3,
  "elidedTailLines": 20,
  "checkpoints": false,
  "compactAt": 0.7,
  "stuckCheckpointShare": 0.4,
  "maxCompactionsWithoutProgress": 3,
  "checkpointDiffChars": 6000,
  "respawnContext": false,
  "respawnDiffChars": 8000,
  "handoffSummaryChars": 800
}
```

| Parameter | Values | What it arranges |
|-----------|--------|------------------|
| `cpuPauseAt` | 0..1 | CPU share at which the lowest-priority Worker is paused, one per reading, never the last one running |
| `cpuResumeAt` | 0..1, below `cpuPauseAt` | CPU share below which a paused Worker resumes (highest priority first) and new Workers may start |
| `cpuOwnMin` | 0..1 | The share of the machine this run must itself be using for a busy CPU to count. Below it the load is someone else's: nothing is paused and Workers keep starting |
| `minFreeMemMb` | integer ≥ 0 | RAM that must stay available after starting a Worker |
| `workerMemMb` | integer ≥ 1 | RAM set aside per Worker started since the last reading |
| `resourceSampleMs` | integer ≥ 50 | How often CPU and RAM are read |
| `scheduleOrder` | `plan`, `critical-path`, `most-dependents` | Which ready task gets the next free slot |
| `readLocks` | `exclusive`, `shared` | Whether tasks that only read the same file can run together |
| `workerModel` | a `zen/*` or `go/*` model id | Speed of each Worker round |
| `workerReasoning` | a level the model accepts | Thinking per round |
| `workerMaxToolCalls` | integer ≥ 1 | When a runaway Worker is cut off |
| `taskTimeoutSec` | integer ≥ 1 | When a stalled attempt is cut off, over the whole attempt |
| `retries` | integer ≥ 0 | Attempts after the first, for every task |
| `preloadReads` | boolean | Read files in the first message. Superseded by `contextPack` when that is on |
| `toolOutputMaxChars` | integer ≥ 1000 | The most of one tool result a Worker keeps |
| `warmSandboxes` | integer ≥ 0 | Sandboxes kept warm between tasks |
| `contextPack` | boolean | The Worker starts from a compiled context pack in its system prompt (Batch K2) |
| `packWindowShare` | 0..1 | The most of the Worker's window the pack may take |
| `anchorContextLines` | integer ≥ 0 | Lines shown on each side of an edit's anchor |
| `elision` | boolean | Rung 1: rewrite stale tool results in place (Batch K3) |
| `elideAt` | 0..1 | Window share that triggers elision |
| `keepRecentRounds` | integer ≥ 1 | Rounds never elided |
| `elidedTailLines` | integer ≥ 1 | Lines kept of a spent command's output |
| `checkpoints` | boolean | Rung 2: compact into a checkpoint instead of overflowing (Batch K3) |
| `compactAt` | 0..1, above `elideAt` when both are on | Window share that triggers a checkpoint |
| `stuckCheckpointShare` | 0..1 | A checkpoint bigger than this share means the task is too big: the attempt ends `stuck` |
| `maxCompactionsWithoutProgress` | integer ≥ 1 | Compactions with no new file written and no check newly passing before the attempt ends `stuck` |
| `checkpointDiffChars` | integer ≥ 0 | Diff of in-progress files carried into a checkpoint |
| `respawnContext` | boolean | A retry is told what the last attempt did and why it failed (Batch K4) |
| `respawnDiffChars` | integer ≥ 0 | Diff of the failed attempt shown to the retry |
| `handoffSummaryChars` | integer ≥ 100 | The most of a finished task's summary passed to its dependents |

**There is no Worker count.** A ready task starts whenever the CPU is below `cpuResumeAt` and RAM would stay above `minFreeMemMb` with one more Worker, and no Worker is paused. When the CPU reaches `cpuPauseAt` **and this run's own process tree is using at least `cpuOwnMin` of the machine**, the scheduler pauses the Worker with the lowest priority by the dependency graph. Workers mostly wait on the model, so a machine saturated by other programs is saturated by them: pausing a Worker would not relieve it. Measured with 8 busy-loop processes running alongside `wide`: 144 s with every busy CPU counted, 25 s with only our own load counted. Pausing freezes the Worker's sandbox process and every command it started, and holds its model loop; nothing is lost and no retry is used.

Bench reads only this file. Only the API key comes from the environment. Every result stores the full config it ran with.

## Context Management

### Principles

1. **Disk is the source of truth.** Code lives on disk, not in context. Context holds pointers, decisions and the minimum excerpt needed to act. Anything can be re-read.
2. **The runtime does the accounting, the model does the judgement.** The runtime measures tokens, triggers compaction, records what was changed and run. The model is asked only for what the runtime cannot know: decisions, reasons, what is left.
3. **Never let the model's summary be the only record.** Every checkpoint and handoff is joined with a runtime-recorded ledger (files mutated, commands and exit codes, verification results). The model can omit; the ledger cannot.
4. **Compile, don't converse.** The Manager's handoff to a Worker is a deterministic function of plan + disk + finished work. No LLM call builds a pack. Same inputs, same pack, same hash.
5. **Fresh at dispatch, not at plan time.** Excerpts are read when the task is dispatched, after its dependencies changed the files, not when the plan was written.
6. **Cheapest strategy first.** Deterministic elision before a model-written checkpoint; checkpoint before respawn; respawn before escalation.
7. **Every cut is visible.** Truncation says what was cut and how to get it back, the way `output-cap.ts` already does. Nothing disappears silently.
8. **Stable prefix.** The system prompt and the pack never change during an attempt, so provider prompt caching keeps working across rounds and across compactions.

### The Model: Four Layers

Every role's context is built from the same four layers, each with its own budget and rule for shrinking.

| Layer | Contents | Shrinks how |
|-------|----------|-------------|
| **L0 Pinned** | System prompt, role rules, the task's context pack | Never during an attempt. Sized before the attempt starts |
| **L1 State** | The current checkpoint and the runtime ledger summary | Replaced, not appended, at each compaction |
| **L2 Working** | Recent turns: the model's messages, tool calls and their results | Elided, then compacted into L1 |
| **L3 Archive** | Everything dropped: old tool output, prior checkpoints, full files, handoffs not in the pack | Not in context. Reachable with `read_file` and the pack's retrieval hints |

The window is split as: `L0 ≤ packWindowShare`, `L1 ≤ stuckCheckpointShare` (a bigger checkpoint means the task is too big), a fixed reply reserve, and L2 gets the rest. Compaction moves material down a layer; disk keeps everything.

### What the code does today, and the gap each batch closes

| Today | Gap | Batch |
|-------|-----|-------|
| `lower()` keeps `context`, `edits`, `verify` on the task, but `TaskQueue.addTask` and the Worker's task type drop them; a plan's `contracts` are dropped by `parseProposePlanArgs` | The Worker sees paths and instruction strings only | K0 |
| Token estimate is a fixed 4 characters per token | Never calibrated against the provider's `prompt_tokens` | K1 |
| Worker prompt: title, why, instructions, path lists, "read each readFile first" | No anchors in context, no "done means", no contracts, no upstream results, no project card | K2 |
| Worker history: dropped oldest-first at the window | Information lost silently; no checkpoint (ADR-0015) | K3 |
| Retry: rolls back and reruns the same prompt | The retry is not told what failed (ADR-0016) | K4 |
| Metrics: peak context and trims | No seek ratio, rounds to first edit, pack size, compactions | K5 |

There is no verification ladder and no Manager review in the code. "Done means" is the task's `verify` commands (or `validation`), and a task is complete when they pass. Where the earlier context plan said "accepted", read "completed".

## Batches

```
K0  Contracts: task fields carried, contracts carried, config keys, event and type shapes
 │
 ├── K1  Token accounting
 ├── K2  Context pack + project card
 ├── K3  Worker compaction ladder
 ├── K4  Respawn context + handoffs
 └── K5  Metrics + sweeps
```

K1–K5 build against K0's types. Each owns its files:

| Batch | Owns |
|-------|------|
| K0 | `protocol/src/tools.ts` (task fields), `protocol/src/messages.ts`, `cli/src/manager/taskqueue.ts`, `cli/src/agent/developer.ts` (`parseProposePlanArgs` only), `cli/src/tasks/context-types.ts` (new), `cli/src/packages/vajra/src/bench/params.ts`, `cli/src/config.ts`, `bench/config.json`, `cli/src/session/ui.ts` (the `context` event) |
| K1 | `cli/src/model/budget.ts` (new) |
| K2 | `cli/src/worker/pack.ts` (new), `cli/src/worker/project-card.ts` (new), `cli/src/worker/prompt.ts` (new: Worker prompt assembly, moved out of `execute.ts`) |
| K3 | `cli/src/worker/execute.ts` (loop and messages), `cli/src/worker/ledger.ts`, `elide.ts`, `checkpoint.ts`, `diff.ts` (new) |
| K4 | `cli/src/manager/handoff.ts` (new), `cli/src/manager/execute-plan.ts` (attempt records, handoff store) |
| K5 | `cli/src/packages/vajra/src/bench/metrics.ts`, `cli/src/bench/result.ts`, `bench/tune.mjs`, `bench/sweeps/` |

**Gate for every batch:** `pnpm build:all && pnpm test:all`; replay fixtures unchanged with the context switches off.

### K0 — Contracts

- `TaskState` and the Worker's task carry `context`, `edits`, `verify`, and the new optional `notes` and `successCriteria`. `PlannedTaskInput` and the `propose_plan` schema gain `notes` and `successCriteria`.
- `DeveloperPlan` carries `contracts`; `parseProposePlanArgs` keeps them; bench passes them to every Worker they name.
- Config keys above, validated, with `compactAt > elideAt` checked when both rungs are on.
- Types: `ContextPack`, `PackSection`, `Checkpoint`, `WorkLedgerEntry`, `AttemptRecord`, `Handoff`.
- A `context` agent event (`pack`, `elided`, `compacted`, `stuck`) that renderers ignore and metrics read.

### K1 — Token Accounting

`ContextBudget` per model: the window from the catalog, a characters-per-token ratio calibrated from each round's reported `prompt_tokens` (moving average, seeded at 4, shared by every Worker on that model in the process), an estimate for unreported rounds, and the share of the window a prompt takes.

### K2 — Context Pack

Built at dispatch, deterministically, from the task, the files on disk read through the task's own handle (so masking and permissions hold), the plan's contracts, upstream handoffs and the project card. Goes in the system message after the role rules; the first user message is "Execute the task now."

| # | Section | Always |
|---|---------|--------|
| 1 | **Task**: title, why, type, instructions, notes | Yes |
| 2 | **Done means**: success criteria, then each `verify` command with the exit it must reach (or the `validation` commands) | Yes |
| 3 | **Previous attempt** (on a retry, from K4) | Yes |
| 4 | **Edits**: each edit with its anchor and ±`anchorContextLines` of the current file; `relocated` or `stale` when the anchor moved; for `create`, the directory listing | Yes |
| 5 | **Contracts** this task produces or consumes | Yes |
| 6 | **Scope**: files it may write, delete, create | Yes |
| 7 | **Upstream results**: handoffs of direct dependencies in full, transitive ones as interfaces only | Yes |
| 8 | **Context excerpts**: each `context` ref with its reason, sliced to its `symbols` | Degrades body → signature → path |
| 9 | **Project card**: language, test/build/lint commands from manifests | Yes |
| 10 | **Retrieval hints**: what was cut and the exact call to fetch it | When anything was cut |

Budget = `packWindowShare × window`. Over budget, section 8 degrades file by file, last ref first. A pack whose fixed sections alone exceed the budget is a setup error in bench (exit 2: "split this task or narrow its context"). The pack's hash, size per section, stale and relocated anchors are emitted as a `context` event.

### K3 — Worker Compaction Ladder

| Rung | Trigger | What happens | Model call |
|------|---------|--------------|------------|
| 0 Cap | Every tool result | `output-cap.ts` | No |
| 1 Elide | `elision` on, measured share ≥ `elideAt` | Superseded reads → a note; older runs of the same command → exit code and last `elidedTailLines` lines; edit results → `ok: edited <path>`; older search results → their paths. The last `keepRecentRounds` rounds are never touched | No |
| 2 Checkpoint | `checkpoints` on, share ≥ `compactAt` | Forced `write_checkpoint` call; runtime fills `filesChanged` and `lastVerification` from the work ledger; the conversation becomes system + task message + checkpoint, ledger summary and diff of changed files (≤ `checkpointDiffChars`) | One |
| 3 Stuck | Checkpoint > `stuckCheckpointShare` of the window, or `maxCompactionsWithoutProgress` compactions with no progress | The attempt ends `stuck`; K4 gives the retry its checkpoint | — |
| Backstop | Always | Drop-oldest trim at the window, the task pinned | No |

Progress is a file written that was not written before the last compaction, or a validation command that newly passes.

### K4 — Respawn Context and Handoffs

- Every attempt ends with an `AttemptRecord`: outcome (`done`, `failed_verification`, `stuck`, `error`, `timeout`, `budget`), the failing command and its output tail, the last checkpoint, the files it wrote, and its diff, captured before the rollback.
- With `respawnContext` on, a retry's prompt gains a **Previous attempt** section: outcome, failing command and output, last checkpoint, the diff of what it tried (≤ `respawnDiffChars`), and one line per earlier attempt. The failed conversation is never passed on.
- On completion, a **handoff**: files written (ledger), interfaces (exported declarations added or changed, from the files' before and after), and the Worker's closing summary (≤ `handoffSummaryChars`). Dependents' packs carry it (section 7).

### K5 — Metrics

Per task: pack tokens and sections cut, stale and relocated anchors, seek ratio (reads, searches and listings of paths not in the pack, over all tool calls), redundant reads (reads of pack files before the Worker changed them), rounds to first edit, elisions, compactions, `stuck`. Per run: the totals, and the most-missed paths (read outside the pack). The sweep table gains a `seek` column. New sweeps: `context-pack.json`, `compaction.json`, `respawn.json`.

## Tuning

Needs `OPENCODE_API_KEY` and real runs; each step commits its results file.

1. **Baseline.** The committed config, every suite, 5 repetitions. If anything fails, fix reliability first (`workerModel`, `retries`, `workerMaxToolCalls`, then `respawnContext`).
2. **Arrangement:** `cpuPauseAt`/`cpuResumeAt`, `workerMemMb`, `scheduleOrder`, `readLocks`.
3. **Context:** `contextPack` (then `packWindowShare`, `anchorContextLines`), `respawnContext`. Turn on `elision`/`checkpoints` only if `peak ctx` shows tasks near the window.
4. **Per-Worker speed:** `workerModel`, `workerReasoning`, `taskTimeoutSec`, `warmSandboxes`.
5. **Read the metrics.** `wallMs` near `criticalPathMs`: the arrangement is done. High `idleMs`: admission is losing time. High `pausedMs`: CPU-bound. High seek ratio: the pack is missing what Workers look for; the most-missed paths say what.
6. **Confirm** the combined winner at 10 out of 10 on every suite, and **write it into `bench/config.json`**.

## ADRs to Write

| ADR | Decision |
|-----|----------|
| 0017 — The Manager compiles a context pack per task | Deterministic, built at dispatch, budgeted, in the system prompt |
| 0018 — Compaction is a ladder | Elision before checkpoint before respawn; runtime-owned checkpoint fields. Amends ADR-0015 |
| 0019 — A retry is told what failed, and a finished task hands off | Attempt records and structured handoffs. Implements the context side of ADR-0016; amends ADR-0014's free-text handoff |

`docs/system-roles/manager.md` and `worker.md` still describe `changes_requested` as "same Worker, same context"; they are corrected to ADR-0016 with these ADRs.

## Deferred

Not built now, because `vajra bench` runs without a Developer and could not measure them. They become worth building once there is a Developer-driven benchmark. Kept verbatim from the context plan.

### Part 2 — Repository Knowledge for the Developer

The Developer plans from an index. The better the index, the fewer files it reads, and the more precise the `context` it declares.

1. **Symbol index with signatures.** Extend `SummaryEntry` with `{name, kind, line, signature}` per exported symbol, the signature being the declaration line(s) up to the body. Keep the regex extractor as the fallback; add tree-sitter where a grammar is available (TS/JS, Python, Rust, Go first). This is what lets a pack slice a file to one function later.
2. **Import graph.** Record each file's resolved imports. Gives `dependents(path)` and `dependencies(path)`, which the Developer uses to find what a change touches and the Manager uses to pick neighbour excerpts.
3. **Incremental and content-addressed.** Key every entry by content hash in the existing summary index cache (`docs/runtime/state.md`). Re-index only changed files. Re-index the files a task changed after it is accepted, so later packs see current signatures.
4. **Budgeted rendering stays.** `renderSummaryIndex` and `deriveIndexBudget` keep their contract. Remove the fixed 16000-char cap in `buildSummaryIndex`; the render budget is the only limit.
5. **New free tools for the Developer:** `find_symbol(name)` → file, line, signature; `get_dependents(path)`; `get_outline(path)` → the file's symbols and signatures without bodies. All three answer from the index, cost no file read, and count as free like `search_files`.
6. **Project card.** Built once per session, mechanically: language(s), package manager, test/lint/build commands found in manifests, formatter config, and a 20-line style sample from the most-imported file. It goes into the Developer's prompt and into every pack, so no Worker has to discover how the project runs its tests.

### Part 3 — Developer Conversation Compaction

The Developer's conversation is long-lived and the Human's words in it are the requirements. Dropping the oldest messages, as today, drops the requirements first.

**Pinned:** the system prompt, and every Human message verbatim up to a pin budget (`humanPinShare` of the window). Past that budget the oldest Human messages move into the digest below, quoted, not paraphrased.

**Planning digest (L1)**, written by the runtime and the Developer together when the window passes `developerCompactAt`:

| Field | Source | Holds |
|-------|--------|-------|
| `requirements` | Developer, from Human messages | Each requirement, with the Human's words quoted |
| `decisions` | Developer | Each decision taken with the Human, with the reason |
| `constraints` | Developer | Libraries, files, conventions the Human fixed |
| `openQuestions` | Developer | What is still unresolved |
| `filesExamined` | Runtime, from the evidence ledger | Path, content hash, and the facts the Developer noted about it |
| `baselines` | Runtime, from the evidence ledger | Command, exit code, when |
| `planHistory` | Runtime | Each proposed plan's summary and why it was rejected |

The digest is produced by a `write_planning_digest` tool call, as with the Worker's checkpoint. The runtime fills its own fields; the model fills the rest. Tool output older than the digest is dropped from L2, because the evidence ledger already holds what it proved.

**Evidence becomes brief material.** When the Developer reads a file, the ledger keeps content hash and, optionally, a note (`note_fact(path, symbol?, fact)` free tool). Facts whose file hash is unchanged at dispatch time are eligible for the pack (Part 5), so what the Developer learnt is not re-learnt by the Worker.

Also deferred: neighbour signatures from an import graph and Developer facts in the pack (they need the index above), `get_handoff` and `get_team_status` as pull tools, the SQLite tables for packs, checkpoints, ledgers and handoffs (bench keeps them in memory and in `result.json`), persisting the token calibration across processes, and ADR-0020 (the Developer pins the Human's words).

## Done When

- K0–K5 merged, gates green, replay fixtures unchanged with the context switches off.
- ADRs 0017–0019 written; role docs match ADR-0016.
- After tuning: the committed `bench/config.json` succeeds 10 out of 10 on every suite, with a median `wallMs` below the baseline on every suite, and the results that show it are committed.
