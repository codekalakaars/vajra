# Agent Runtime Migration: Parallel Execution Plan

**Status:** Proposed. This document is the execution plan for
[`AGENT_RUNTIME_ARCHITECTURE_PLAN.md`](AGENT_RUNTIME_ARCHITECTURE_PLAN.md) — how to
carry it out with several agents working at once without them corrupting each
other. The architecture document decides *what*; this one decides *who touches
what, in what order, and how anyone knows it still works*.

**Baseline at time of writing** (`ecbe5df`): `pnpm build:all && pnpm test:all` is
green — 780 tests, 0 failures (protocol 11, core 33 Rust, tester 222,
agent-process 54, sandbox 91, cli 369). Every gate below means *this stays true*.

---

## Table of Contents

- [1. Corrections to the plan](#1-corrections-to-the-plan)
- [2. The accuracy rule: refactor vs change](#2-the-accuracy-rule-refactor-vs-change)
- [3. Why this cannot be nine parallel agents](#3-why-this-cannot-be-nine-parallel-agents)
- [4. The serial spine](#4-the-serial-spine)
- [5. The parallel lanes](#5-the-parallel-lanes)
- [6. The file ownership matrix](#6-the-file-ownership-matrix)
- [7. The merge protocol](#7-the-merge-protocol)
- [8. Decisions needed before certain lanes start](#8-decisions-needed-before-certain-lanes-start)
- [9. Verification](#9-verification)
- [10. Known state the lanes inherit](#10-known-state-the-lanes-inherit)

---

## 1. Corrections to the plan

The architecture plan was written before 19 commits landed on this branch. Six
of its premises are now wrong. Every correction below is verified against
`ecbe5df`.

| # | The plan says | Reality | Consequence |
|---|---|---|---|
| 1 | `agent-process/src/*` moves to `agent/src/isolation` as one of several moves | `packages/agent-process` was **created two commits ago** (`ecbe5df`, "a confined agent is spawned with one call"). It is already the isolated, CLI-free, one-call confined-agent package, and it is the plan's isolation boundary almost exactly. | That lane is a **relocation**, not a design. Do it with `git mv` and a re-export shim. Low risk, no design thought required. |
| 2 | the LLM conversation is in the CLI and should move | Still true and untouched. `openai` is a **CLI** dependency; all three `streamChatCompletion` call sites are in `packages/cli/src/`; `agent-process/src/worker.ts:7` states the worker "never sees the API key or conversation". | The plan's central move is **unstarted**. This is the real work. |
| 3 | the move table lists 23 files | It omits `agent-process/src/tools.ts` (**711 lines** — the only tool-execution implementation, and the natural `agent/tools` candidate), `agent-process/src/{index,native,summary}.ts`, `agent-core/src/index.ts`, and `protocol/src/plan-validate.ts` (506). It also sends `agent/context-window.ts` (17 lines, one export) as if it were a migration unit. | Use §6's matrix, not the plan's table. `context-window.ts` is a trivial lift. |
| 4 | `packages/tester` exists, unused; wiring it in is a separate decision | True and worse than stated: **36 source files, 13 test files, zero dependents, zero importers.** | Decide in §8 before the cleanup lane, or the cleanup lane will either delete 222 passing tests or leave an orphan. |
| 5 | step 0's replay tests are "the safety net for step 2" | **No TypeScript is built or tested in CI.** `.github/workflows/ci.yml` runs clippy, `cargo test`, `pnpm install --frozen-lockfile`, `pnpm run build` (root = the napi addon), and `pnpm test` (root = 3 smoke tests). All 58 `.test.mjs` files under `packages/*/test/` never run in CI. | Step 0 must **also** fix CI, or the safety net is advisory. This is lane S0 and it is not optional. |
| 6 | the Manager's catalog will hold "read-only inspection tools" | `roleTools.master` grants `run_command` (`protocol/src/tools.ts:667`), and `master.ts` uses it to run declared rollback commands. Also: the role allowlist is **never enforced at runtime** — see §2, item C1. | Dropping `run_command` from the Manager is a **behaviour change**, not a refactor. It needs a decision (§8). |

One more fact that changes the shape of the work, verified below: **the role
tool allowlist is dead code in production.** `sandbox/src/tool-rules.ts:32` reads
`roleTools[role]`, but its only production caller,
`sandbox/src/sandbox-builder.ts:52`, calls `resolveAllowedTools(config)` with no
role — and only in the branch where `config.allowedTools !== null` anyway. The
role branch is reachable only from `sandbox/test/sandbox.test.mjs:134`. So
`LaunchJob.allowedTools` is `undefined` in practice, and `agent-process/src/worker.ts:129`
treats `undefined` as unrestricted. The plan's Required Boundary 2 is therefore
**not satisfiable by moving code**; it needs a decision and a test.

---

## 2. The accuracy rule: refactor vs change

A migration of this size fails quietly when a behaviour change hides inside a
"move". Every item below is classified. **R = refactor, provably identical, must
pass the replay tests unchanged. C = change, needs its own decision, its own
tests, and its own commit.**

| # | Item | Class | Where it lands |
|---|---|---|---|
| R1 | Move `agent-process` → `agent/isolation` | R | L5 |
| R2 | Move `masterLoop` + `decideFailure` + `TaskQueue` → `agent/coordination` | R | L4 |
| R3 | Move `FileLockManager` + `ChangeHistory` → `agent/coordination` | R | L4 |
| R4 | Move `roleTools` out of `protocol` into `agent/tools` | R | L3 |
| R5 | Add a `ModelClient` interface; make the OpenCode client implement it | R | S3 |
| R6 | Extract the shared loop into `engine`; both roles call it | R | S3 |
| R7 | Convert Developer to a profile | R | S4 |
| R8 | Convert Worker to a profile | R | L1 |
| R9 | Make `service.ts` a host that composes the runtime | R | L6 |
| R10 | Delete `agent-core`, `agent-process` after re-export shims | R | L7 |
| **C1** | **Enforce the role allowlist at dispatch** (`allowedTools` is `undefined` today) | **C** | L3, after a decision |
| **C2** | **Read leases for declared inputs** (every acquisition is `'write'` today, so two tasks reading one file are serialised) | **C** | deferred |
| **C3** | **Give the Worker the same argument validation as the Developer** (`parseToolCall`; the Worker forwards raw model JSON to the tool executor) | **C** | L1 |
| **C4** | **Remove `useMasterLlm` / `masterDecide`** (the plan says remove; `managerModel` is a user-reachable config key, so removing it is a behaviour change) | **C** | L4, after a decision |
| **C5** | **Drop `run_command` from the Manager's catalog** | **C** | L2, after a decision |
| **C6** | **Manager inspection profile** — the plan calls this "new behaviour"; it is the whole of ADR-0004 and Tier 3 of ADR-0011, and it does not exist today | **C** | L2, behind a flag |
| **C7** | **Project-level session lock** (boundary 4; refuses a second session on one checkout) | **C** | deferred |
| **C8** | `AgentInstance` records role + model (ADR-0010 requires attribution; `AgentState` has no `model` field) | **C** (additive) | L6 |

The R items are what make the migration safe to parallelize: each is provable by
the replay harness from S1. The C items are where a wrong guess is expensive, so
each is fenced behind §8.

**C2 and C7 are deferred** (2026-09-29): both are correctness and concurrency improvements rather than capability, and both were the only risky work in their lane. The read path they would switch on already exists and is tested with zero production callers, so the deferral costs nothing that is currently broken.

**C1 deserves its own emphasis.** The plan's completion criterion "role tools are
allowlists, not permissions" and boundary 2 are security properties, and today
the only thing enforcing a role's tools is *which tools are advertised to the
model*. A hallucinated `propose_plan` reaching a Worker would be dispatched
successfully. Fixing it is small (pass the role's catalog into `buildLaunchJob`),
but it is a change, and it should ship as its own commit with a test that proves
a refused call.

---

## 3. Why this cannot be nine parallel agents

The plan's steps 2, 3, 4, 5, 6 and 7 all write `packages/cli/src/agent/developer.ts`,
`packages/cli/src/tasks/execute.ts` or `packages/cli/src/session/service.ts`.
Six agents editing three files is not parallelism, it is a merge conflict with a
long fuse. Measured duplication between the two loops is real but bounded: the
shared core is

> abort check → round increment → provider call → no-tool-calls exit →
> `messages.push(assistant)` → per-call `tool-start` → arg parse →
> heartbeat-wrapped `handle.callTool` → `tool-end` → budget charge →
> `messages.push(tool)`

— while 13 differences are genuinely role-specific (the Developer's inline
`propose_plan` state machine and evidence ledger; the Worker's validation phase;
the Developer's compaction; divergent batch-dispatch strategies; different budget
constants and interrupt predicates; two different UI-port styles).

So the plan is restructured as **a short serial spine that creates the seams,
then wide lanes that own disjoint files**. The spine is serial because each link
is a precondition for the next; the lanes are parallel because after the spine
each one has files nobody else wants.

---

## 4. The serial spine

Four owners, four pull requests, strictly in order. Each is green on its own and
leaves the tree releasable. **Do not start a lane before its gate is merged.**

### S0 — Make the gate real (owner A0)

Nothing else is safe without this.

1. Add `pnpm build:all` and `pnpm test:all` steps to `.github/workflows/ci.yml`.
   Expect this to surface pre-existing failures before it surfaces anything new:
   `turbo.json` does not make a package's own `build` a prerequisite of its own
   `test`, so any package with an empty `dist/` fails. Fix those (build ordering
   or a `test` script that builds first) in this lane, not later.
2. Record the baseline (780 green) in the PR description.

**Gate:** CI runs the TypeScript suites; baseline unchanged.
**Do not** touch any source file in this lane.

### S1 — The safety net (owner A1)

The plan's step 0, and the precondition for calling anything a refactor.

1. Extract the two hand-rolled `globalThis.fetch` doubles into one shared module,
   `packages/cli/test/_provider.mjs`. They are currently duplicated with different
   chunk vocabularies (`developer.test.mjs:31-77`, `parallel-tools.test.mjs:24-73`).
2. Build the **recording** half, which does not exist: a recorder that captures
   the provider stream and the tool calls, and a replayer that feeds them back.
3. Record fixtures from representative Developer and Worker runs:
   `packages/cli/test/fixtures/replay/*.json`.
4. Assert the replayed run produces an **identical tool-call sequence, transcript,
   and event stream**.

Two traps, both discovered while investigating:

- The stub must be installed **before** `developer.js` is imported — the OpenAI
  SDK captures the global `fetch` at load time. That is why every test uses
  `pathToFileURL(...)` + `await import(...)` rather than a static import. Keep it.
- `createClient` stamps a random `x-opencode-session` header per call
  (`chat.ts:109`) and the loops use `Date.now()` budgets. Normalise both in the
  recorder, or the replay is not deterministic.

Every test in this repo runs against `dist/`, never `src/`. So the gate for S1 is
`pnpm build:all && pnpm --filter @codekalakaars/vajra-cli test`.

**Gate:** replay tests exist, pass, and fail if the loop's tool-call order changes.

### S2 — The package, its contracts, and its rules (owner A2)

1. `packages/agent/package.json` + `tsconfig.json`, modelled on
   `packages/agent-process` (bare `tsc`, `rootDir: src`, `outDir: dist`,
   `files: ["dist"]`). `pnpm-workspace.yaml` globs `packages/*`, so the directory
   is picked up automatically.
2. **Pre-declare every subpath export now**, before any lane needs one:
   `./contracts`, `./engine`, `./tools`, `./coordination`, `./isolation`,
   `./providers`, `./roles/developer`, `./roles/manager`, `./roles/worker`.
   Without this, every lane edits `package.json` and they collide.
3. `src/contracts/**`: `AgentProfile`, `AgentRunInput`, `AgentResult`,
   `AgentInstance`, tool ids, permission grants, `TaskScope`, runtime events.
   The plan's interfaces are the starting shape; the types may change.
4. Regenerate `pnpm-lock.yaml` (CI's `--frozen-lockfile` fails without it). **This
   lane owns the lockfile**; no other lane runs `pnpm install` with new deps.
5. `packages/agent/test/import-rules.test.mjs` — boundaries 9 and 10 enforced by a
   test, not prose. The repo has **no linter at all** (no eslint, biome, oxlint,
   prettier, dependency-cruiser), so a `node:test` file walking
   `src/**/*.ts` and asserting imports stay inside the package, plus a deny table
   for `@codekalakaars/vajra-{cli,tui}`, is the cheapest thing that works today
   and needs no new dependency. Promote to `dependency-cruiser` later if wanted.
6. Document the allowed-dependency table next to the test.

**Gate:** `packages/agent` builds empty-but-typed, the import-rule test passes, the
lockfile is current, and the rest of the tree is untouched.

### S3 — The engine and the provider seam (owner A3)

The one lane that edits both loops. Serial because everything else depends on it.

1. `git mv packages/cli/src/agent/chat.ts packages/agent/src/providers/opencode.ts`;
   add `ModelClient` to `contracts`; make the OpenCode client implement it. Leave a
   re-export shim at the old path so `service.ts` and three tests keep working.
2. `git mv packages/cli/src/agent/context-window.ts` → `agent/src/engine/`.
3. `src/engine/loop.ts`: the shared core listed in §3, parameterised by profile —
   tool catalog, budget policy, interrupt predicate, dispatch strategy. Both
   loops call it; the 13 role differences stay at the call sites as arguments.
4. `developer.ts` and `execute.ts` call the engine. **No behaviour change**: the two
   batch-dispatch strategies differ, and unifying them *would* be a change. Keep
   both, behind a `dispatch` strategy argument. `parallel-tools.test.mjs` covers
   both and must pass unchanged.

**Gate:** the S1 replay tests pass **byte-identically**; full suite green.
**This is the lane that proves the plan's central claim.** If the replay output
changes here, stop and report rather than adjusting the fixture.

### S4 — The Developer becomes a profile (owner A4)

1. `roles/developer/`: prompt builder (the 183-line builder), context builder
   (`buildInitialPromptContext`), `allowedTools`, plan-tool handling.
2. `developer.ts` becomes a thin caller of the engine.
3. `service.ts:725-741` passes the profile. This is the **only** `service.ts` edit
   in this lane — keep it that small; L6 rewrites this file.
4. `packages/cli/package.json` exports `./agent/developer` as a **published
   subpath** (`test/context-budget.test.mjs:15` uses it). Keep a re-export shim at
   that path or every external consumer breaks.

**Gate:** replay tests unchanged; suite green; the published subpath still resolves.

---

## 5. The parallel lanes

After S4, lanes run concurrently. They are disjoint by construction (§6).
Each is one branch, one PR, and each is green on its own.

> **Revised 2026-09-29 after ADRs 0012–0014 landed.** The lane list below is the
> first cut. Two changes matter: the **verification ladder is a new, unassigned
> dependency** — ADR-0013's Manager review consumes ladder verdicts, and the
> ladder is not implemented — and L4's read leases and session lock are
> **deferred**, because they are quality rather than capability and were that
> lane's only risky work. The wave organisation, the ladder lanes and the
> deferrals are in [AGENT_RUNTIME_MIGRATION_PROMPTS.md](AGENT_RUNTIME_MIGRATION_PROMPTS.md),
> which supersedes §5 and §7 of this document. This section is kept for the R/C
> classification, which still holds.

| Lane | Goal | Blocked by | Class |
|---|---|---|---|
| **L1** | Worker → profile. `roles/worker/`, `execute.ts`, `tasks/server.ts`, `tasks/skip.ts`, the default `Verifier`. Plus **C3** (Worker argument validation). | S4 | R (+C3) |
| **L2** | Manager inspection profile: **C6** behind a flag, judging Tier 3 criteria per ADR-0011. Plus **C5** if approved. | S4, **ladder** | C |
| **L3** | Tools consolidation: move `roleTools` to `agent/tools` (R4); one dispatch chokepoint; remove the dead role lookup from `sandbox/tool-rules.ts` keeping its role-independent checks. Plus **C1** if approved. | S3 | R (+C1) |
| **L4** | Coordination: move `masterLoop`, `decideFailure`, `TaskQueue`, `FileLockManager`, `ChangeHistory` (R2, R3). | S3 | R |
| **L5** | Isolation relocation: `git mv packages/agent-process/src/*` → `packages/agent/src/isolation/`, shim, delete the package (R1, R10-part). | S2 | R |
| **L6** | CLI becomes a host: rewrite `service.ts` to compose the runtime, supply per-role models, credentials, storage and event sinks. Add **C8** attribution. | L1–L5 | R (+C8) |
| **LADDER-A** | The verification ladder's types, sequential executor and verdict contract, in new files, wired to nothing. **New.** | — | R |
| **LADDER-B** | Wire the ladder into the `propose_plan` schema, the Worker's `Verifier` and `TaskQueue`, behind a flag. **New.** | LADDER-A, L1, L3, L4 | C |
| **L7** | Delete what is now empty (`agent-core`, `agent-process`), update the docs, and make the package map true. | L1–L6 | R |

**Why the ladder is two lanes.** Its four integration points belong to other
lanes: the `propose_plan` schema is L3's, the validation runner is L1's,
`TaskQueue` is L4's, and `packages/tester` has no owner until D5 is decided. A
builds the seam; B integrates it. Without the split, four agents would be editing
four files they do not own.


**One file, one owner, ever.** `master.ts` is the interesting case: L2 (the
inspection agent) and L4 (the scheduler move) both want it. Resolution: **A8 owns
`master.ts`.** L2 creates `roles/manager/**` as new files and does not touch
`master.ts`; wiring the inspection agent into the loop is a single commit that
L2 lands *after* L4 merges. If L2 needs a change in `master.ts`, it asks; it does
not edit.

**Parallel-safe by construction**, if the pre-declared exports in S2 exist:

- L1 and S4 both touch `service.ts`? No — S4 makes exactly one small edit and is
  merged before the lanes open.
- L3 moves `roleTools` out of `protocol` while L2 reads it? L2 depends on the
  Manager's catalog, which is C5 and gated on a decision. If C5 is approved, L2
  must rebase onto L3. Order the merge: **L3 before L2**.
- L4 moves `FileLockManager` out of `sandbox` while L3 edits `sandbox/tool-rules.ts`?
  Different files in the same package — fine, but they must not both need a
  `sandbox` version bump. Merge **L3 before L4** to avoid two lockfile-adjacent
  edits.

---

## 6. The file ownership matrix

Binding. An agent that needs a file it does not own **stops and reports**; it does
not edit. This is the whole conflict-avoidance mechanism.

| File / path | Owner | Notes |
|---|---|---|
| `.github/workflows/ci.yml` | A0 | S0 only |
| `packages/cli/test/_provider.mjs`, `test/fixtures/replay/**`, `test/replay-*.test.mjs` | A1 | new files |
| `packages/agent/package.json`, `tsconfig.json`, `src/index.ts`, `src/contracts/**` | A2 | declares all subpath exports up front |
| `pnpm-lock.yaml`, root `package.json` | A2 | no other lane installs deps |
| `packages/agent/src/providers/**`, `src/engine/**` | A3 | includes the `chat.ts` move |
| `packages/cli/src/agent/chat.ts`, `context-window.ts` | A3 | becomes a re-export shim; nobody else edits |
| `packages/agent/src/roles/developer/**` | A4 | |
| `packages/cli/src/agent/developer.ts` | A4 | until L6, which inherits it |
| `packages/agent/src/roles/worker/**` | A5 (L1) | |
| `packages/cli/src/tasks/**` | A5 (L1) | `execute.ts`, `server.ts`, `skip.ts` |
| `packages/agent/src/roles/manager/**` | A6 (L2) | new files only |
| `packages/protocol/src/tools.ts`, `packages/agent-core/src/tools.ts`, `packages/agent/src/tools/**`, `packages/sandbox/src/tool-rules.ts` | A7 (L3) | |
| `packages/agent/src/coordination/**`, `packages/sandbox/src/{file-locks,change-history}.ts`, `packages/cli/src/agent/{master,taskqueue}.ts`, `packages/cli/src/agent/registry.ts` | A8 (L4) | `master.ts` sole ownership |
| `packages/agent/src/isolation/**`, `packages/agent-process/**` | A9 (L5) | relocation; A9 also deletes `agent-process` |
| `packages/cli/src/session/service.ts`, `src/persist/**`, `src/config.ts` | A10 (L6) | the integration point; **nobody else, ever, after S4** |
| `packages/agent/src/coordination/ladder.ts` + the ladder's contract | A12 (LADDER-A) | new files only; integration is LADDER-B's |
| `packages/protocol/src/tools.ts` (after L3 merges), `packages/cli/src/agent/taskqueue.ts` (after L4 merges) | A13 (LADDER-B) | inherits those files from L3 and L4 |
| `packages/agent-core/**` (deletion), `docs/**`, root `README.md` | A11 (L7) | last |

`packages/cli/src/tui/**` and `packages/tui/**` are nobody's: this migration must
not touch presentation, per boundary 9.

---

## 7. The merge protocol

1. One branch per lane: `refactor/agent-s0-gate`, `refactor/agent-l3-tools`, …
2. Merged in dependency order, not completion order. The spine is fixed;
   the lane order is maintained in
   [AGENT_RUNTIME_MIGRATION_PROMPTS.md](AGENT_RUNTIME_MIGRATION_PROMPTS.md), which
   supersedes the list below after the 2026-09-29 revision that added the ladder
   lanes and deferred C2 and C7:

   **S0 → S1 → S2 → S3 → S4 → {L3, L5, L4-move} → {L1, LADDER-A} → {LADDER-B, L2} → L6 → L7.**

   L5 is pure relocation and can go early. L6 is last because it integrates, and
   because it is the only lane that touches `service.ts`.
3. Each PR must state, in the description: the class (R or C) of every item it
   contains, the gate command output, and — for C items — the decision that
   authorised it.
4. Rebase, never merge, so the linear history the repo keeps is preserved.
   This repo's history has been force-pushed at least twice in the last day; a
   lane sitting unmerged for hours is a lane at risk.
5. **Push early.** The 9 commits that were on the deleted `feat/master-agent`
   branch existed on one machine because nobody pushed them.

---

## 8. Decisions needed before certain lanes start

Each of these is a behaviour change or a deletion. The lane does not start until
the answer is in the PR description.

| # | Question | Blocks | Why it is a question |
|---|---|---|---|
| D1 | Do we **enforce** the role allowlist at dispatch (C1)? | L3 | Today it is unenforced. Fixing it can refuse calls that previously succeeded. It is also the plan's central security claim, so leaving it unenforced after the migration would make the completion criteria false. |
| D2 | Does the Manager keep `run_command` (C5)? | L2 | ADR-0004 says the Manager inspects and never repairs, but `roleTools.master` grants `run_command` and rollback commands need it. Either the catalog changes, or rollback moves out of the Manager's hands. |
| D3 | Remove the `useMasterLlm` / `masterDecide` path (C4)? | L4 | The plan says remove. `managerModel` is a user-reachable config key (`config.ts:35`, `/config` menu, persisted in the session record), so this removes a shipped feature. Note also that `amend_task` is advertised to that model and **never executed**, and the LLM path can never produce the `interrupted` action, so it always routes to `failTask`. |
| D4 | Read leases for declared inputs (C2)? | L4 | Raises concurrency and changes timing. Today every acquisition is `'write'` over `read ∪ write ∪ delete ∪ createDir`, so two tasks that only read a shared file are fully serialised. The read path already exists and is tested — it has **zero** production callers. |
| D5 | What happens to `packages/tester`? | L7 | 36 source files, 222 passing tests, zero dependents. Delete, absorb into the Worker's `Verifier`, or leave orphaned. |
| D6 | Cross-session leases, or refuse the second session? | L4 | Boundary 4 refuses a second session on one checkout. Cross-session is explicitly deferred. Confirm the refusal is the first version. |
| D7 | An unset role model: refuse to start the role, or fall back? | L6 | ADR-0010 leaves it open; the plan says refuse. The host owns the defaults, so this is a host decision. |
| **D8** | **Remove `write_stub` and `delete_stub`?** | L3, L7 | ADR-0012 removes Phase One, so the Developer no longer authors stubs — but they are still in `code`, in `roleTools`, in the Developer's evidence ledger, and in four of the developer tests. Removing them is a **capability change a user can see**, not a catalog edit. L3 is explicitly told not to do it. |

---

## 9. Verification

**The gate, run by every lane before it opens a PR:**

```bash
pnpm install --frozen-lockfile     # must not modify pnpm-lock.yaml
pnpm build:all                    # turbo: 7 tasks, dependency-ordered
pnpm test:all                     # must stay 780 pass / 0 fail
```

**Per-lane, in addition:**

```bash
pnpm --filter @codekalakaars/vajra-<pkg> exec tsc --noEmit
pnpm --filter @codekalakaars/vajra-cli test        # after S1: includes the replay tests
```

**Rules that keep results meaningful:**

- `turbo.json` does not make a package's own `build` a prerequisite of its own
  `test`. Always `build:all` before `test:all`, or you are testing a stale `dist/`.
- Every test imports `dist/`, never `src/`. A green suite after an edit that was
  not rebuilt is a false green.
- After **any** edit inside `packages/agent` or `packages/agent-process`, run
  `pnpm build:all` before believing a test result.
- Replay tests are the R-class oracle. If an R item changes replay output, the
  item is not a refactor. Stop and report.
- `cargo clippy --manifest-path packages/core/Cargo.toml --all-targets -- -D warnings`
  and `cargo test --manifest-path packages/core/Cargo.toml` must stay clean. The
  migration should not touch Rust; if it appears to, that is a finding.

**What is deliberately not verified by this suite**, and should be stated in the
final PR rather than assumed: ADR-0004 (Manager inspection) and ADR-0011 Tier 3
are new behaviour behind a flag, covered by their own new tests only; C1's
refusal path needs a test that proves a refused call, not one that proves a
permitted one; and `docs/testing/gaps.md` already records that the API key
configuration path is untested end to end.

---

## 10. Known state the lanes inherit

Facts to keep, so nobody re-derives them or mistakes them for regressions.

- **Authorization is in five places, with no chokepoint:** the parent-side
  `assertToolPermission` (`agent-process/src/spawn.ts:154`), the worker allowlist
  (`worker.ts:138`, currently inert), the sandbox file rules (`worker.ts:38` →
  `sandbox/src/file-rules.ts:320`), an in-handle gate (`tools.ts:401`, only on the
  unsandboxed fallback path), and OS confinement (`worker.ts:95`). The first and
  the fourth are near-duplicates with **different default-deny/default-allow
  behaviour on an unknown path** (`spawn.ts:163` denies; `tools.ts:402` allows).
  Collapsing them is the substance of L3; the two defaults must be reconciled
  explicitly, not averaged.
- **`TaskQueue` is in-memory**; what persists is a projection built by
  `service.ts:852-895`. `retries`, `maxRetries`, `assignedAgentId` and
  `validationPassed` are **not** persisted.
- **`AgentRegistry` is write-only**: 2 creates, 8 status updates, **0 reads** in
  production. `getActiveWorkers` is dead — concurrency is bounded by
  `masterLoop`'s `running` map, not the registry. `AgentState` has **no `model`
  field**, so ADR-0010's attribution is currently unrecorded (C8).
- **Success today means "the Worker's own validation commands exited 0"**
  (`execute.ts:373-429`). There is no independent check anywhere.
  `TaskQueue.recordValidation` has no production caller and `validationPassed` is
  only ever written `true`. This is the gap the plan already names at line 43.
- **Dead code worth deleting, not preserving:** `getToolSpecs()` (no callers),
  `TaskQueue.retryTask` and `TaskQueue.recordValidation` (no callers),
  `ExecuteTaskInput` (exported, never used), `toResult` in `chat.ts` (dead),
  `registry.get/getBySession/getWorkers/getActiveWorkers/clear`.
- **The validation-server lease is a second owner inside the same lock manager**:
  `execute.ts:341` acquires `<resource:validation-server>` under
  `validation-server:<taskId>` and releases it with `releaseFiles` in its own
  `finally` (`:435`), *before* the outer `service.ts:1073` `release(task.id)` runs.
  A naive "one lease per task" rewrite in L4 will drop it.
- **`packages/tui` is private and depends on nothing**, so boundary 9 holds for it
  by accident rather than by rule — which is exactly why S2's import-rule test
  matters.
- The two lock managers in `service.ts:367-368` are the same class with disjoint
  pseudo-path keyspaces and no comment explaining why they are two objects.
