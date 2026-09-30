# Vajra: Build Plan

**Status:** Final. Ready to hand to executors.
**Date:** 2026-09-30
**Planner's decisions are final in this document.** An executor who finds that a stated fact about the code is wrong stops and reports it. It does not improvise around it.

## Purpose

This plan takes the current `vajra` CLI to the design in [VAJRA_END_TO_END.md](VAJRA_END_TO_END.md), under [ADR-0015](docs/adr/0015-workers-compact-their-own-context.md) and [ADR-0016](docs/adr/0016-failed-attempts-are-respawned.md). It is written so that each pull request can be given to an executor with no other context. Read the [Conventions](#conventions), [Shared Contracts](#shared-contracts) and [Ownership](#ownership) sections, then your PR's brief.

## Table of Contents

- [How to Use This Plan](#how-to-use-this-plan)
- [Conventions](#conventions)
- [Starting Point](#starting-point)
- [The Runtime Migration Is Paused](#the-runtime-migration-is-paused)
- [Order of Work](#order-of-work)
- [Ownership](#ownership)
- [Shared Contracts](#shared-contracts)
- [PR 1 — Shared Reads, Per-Worker Kill, Whole-Attempt Timeout](#pr-1--shared-reads-per-worker-kill-whole-attempt-timeout)
- [PR 2 — The Brief and Its Excerpts](#pr-2--the-brief-and-its-excerpts)
- [PR 3 — The Verification Ladder](#pr-3--the-verification-ladder)
- [PR 4 — Worker Outcomes, Checkpoints and Compaction](#pr-4--worker-outcomes-checkpoints-and-compaction)
- [PR 5 — The Manager: Verify, Review, Respawn, Escalate](#pr-5--the-manager-verify-review-respawn-escalate)
- [PR 6 — State and Attribution](#pr-6--state-and-attribution)
- [PR 7 — Live Status Lines](#pr-7--live-status-lines)
- [PR 8 — End-to-End Acceptance and Documentation](#pr-8--end-to-end-acceptance-and-documentation)
- [Definition of Done](#definition-of-done)
- [Risks](#risks)

---

## How to Use This Plan

1. **Every PR has one owner** and a list of files it may edit. Editing a file outside that list needs the planner's approval first, because another PR may own it. See [Ownership](#ownership).
2. **Start only when your gate is open.** A PR's *Blocked by* line lists the PRs that must be merged first. **The integration branch is `feat/cli-agent-v1-config`, not `main`:** `main` does not yet contain the runtime package, the replay harness or the CI gate this plan builds on. Branch from `feat/cli-agent-v1-config` after your blockers merge, name your branch `vajra/pr-N-<slug>`, and open your PR against `feat/cli-agent-v1-config`.
3. **Follow the brief's steps in order.** Each step says what to change and where. Line numbers are as of commit `4bccc4e`. They will drift, so find the code by the quoted anchor, not the number alone.
4. **Write the tests the brief names.** They are the acceptance criteria. Add more if you like; do not drop any.
5. **Run the gate command** before opening the PR, and paste its summary into the description.
6. **Report, don't improvise.** If a step cannot be done as written, stop and report which step, what you found, and what you propose.

## Conventions

**Toolchain.** Node 22+, pnpm 11, Linux only. The repository refuses to run anywhere else.

**Building and testing.**

- Every test imports **`dist/`, not `src/`**. Build before you test, or you are testing stale code.
- First-time setup in a fresh clone: `pnpm install && pnpm build` (the build produces the native addon).
- The full gate, which is what CI runs:

  ```bash
  pnpm build:all && pnpm test:all
  ```

- The fast loop for one package:

  ```bash
  pnpm --filter @codekalakaars/vajra-cli build && pnpm --filter @codekalakaars/vajra-cli test
  ```

  Swap the package name as needed: `-agent`, `-sandbox` or `-protocol`.

**The fake provider.** Use `packages/cli/test/_provider.mjs` for every test that needs a model. Two rules are load-bearing, and both are explained in that file's header:

- **Install the provider before importing the code under test.** Import the subject with `await import(pathToFileURL(...).href)`, never with a static import.
- **A round is `{ toolCalls?, text?, thinking? }`.** An empty round means the model asked for nothing, and the Worker relies on it to end its loop.

`scriptedProvider(rounds)` replays a fixed script. `recordingHandle()` and `recordingUi()` capture tool calls and events.

**Replay fixtures.** `packages/cli/test/fixtures/replay/{developer,worker}-basic.json` pin the exact tool-call sequence. When a PR changes the Worker or Developer on purpose, re-record the affected fixture with `recordingProvider` and `saveFixture`. The PR description then shows the old and new tool-call sequences side by side and says why they differ. A fixture that changes in a PR that says it changes no behaviour is a defect.

**Package boundaries.** `packages/agent` may import only `@codekalakaars/vajra-protocol` and `@codekalakaars/vajra-sandbox`. `packages/agent/test/import-rules.test.mjs` enforces this. Anything in `packages/agent` that needs the model client or the CLI takes it as an injected function.

**Dependencies.** Add no npm dependencies, and do not add an existing one to a package that lacks it. `zod` is a dependency of `packages/protocol` only; code in `packages/cli` and `packages/agent` validates by hand. `node:sqlite` is built in.

**Commits.** Use conventional commits in the repository's style: a type and a scope, then a plain sentence about the effect. For example, `feat(manager): a failed attempt is respawned with its findings`. Each commit ends with the co-author line the executor's harness requires.

**Pull requests.** One PR per brief, titled `PR N: <brief title>`. The description includes:

- the gate command's output summary;
- any replay fixture diff and why;
- anything the executor had to report.

**Documentation.** A PR updates only the documentation its brief names. `docs/roadmap/README.md` is owned by PR 8 alone, so parallel PRs do not collide on it.

## Starting Point

Facts every executor can rely on, as of `4bccc4e`:

| Area | Fact | Where |
|------|------|-------|
| Conversation | The Developer runs a multi-turn loop | `packages/cli/src/session/service.ts:716` |
| Confirmation | The Human confirms with `[y/N]`; `--yes` skips it | `service.ts:757-778` |
| Queue | In-memory `TaskQueue`, dependency-aware `getReadyTasks()` | `packages/cli/src/agent/taskqueue.ts` |
| Scheduler | `masterLoop` tops the pool up the moment a task settles; `maxWorkers` bounds it | `packages/cli/src/agent/master.ts:205` |
| Attempt | `runTaskOnce` does locks, permissions, the handle, `executeTask`, and the outcome | `service.ts:907-1076` |
| Admission | `canAdmitTask` asks the lock managers whether the task's files are free | `service.ts:1138-1154` |
| Locks | **Every file, including read-only inputs, is taken in `'write'` mode** | `service.ts:917`, `:1151` |
| Shared reads | `FileLockManager` supports `'read'` mode, is tested, and has no production caller | `packages/sandbox/src/file-locks.ts` |
| Worker loop | `executeTask` returns a boolean, with a budget of 100 tool calls and no compaction | `packages/cli/src/tasks/execute.ts:141` |
| Worker prompt | Tells the Worker to "Read each readFile first" | `execute.ts:185` |
| Timeout | `timeoutSeconds` applies only to verification commands | `execute.ts:342` |
| Verification | The plan's `validation` commands are run inside `executeTask` after the loop | `execute.ts:295-402` |
| Retry | Rolls back, re-baselines, and reruns the same prompt | `master.ts:294-295`, `service.ts:1089-1136` |
| Manager model | `masterDecide` chooses retry, skip or abort on failure, and only when `managerAsks` | `master.ts:410`, `service.ts:1155` |
| `managerAsks` | True when a Manager model is explicitly set or `useMasterLlm` is on | `packages/cli/src/roles.ts:67` |
| Token usage | Every `llm-end` event carries `usage.promptTokens` when the provider reports it | `packages/cli/src/agent/chat.ts:397`, `packages/cli/src/session/ui.ts:95` |
| Forced tool | `streamChatCompletion` accepts `toolChoice` | `chat.ts:393` |
| Window size | `getModelLimit(model)` | `packages/cli/src/agent/context-window.ts` |
| `run_command` | Argv-based, no shell; accepts `cwd` (confined to the project) and `timeoutMs`; returns JSON `{exitCode, signal, stdout, stderr}` | `packages/protocol/src/tools.ts:130`, `packages/agent-process/src/tools.ts:319` |
| Parsing results | `parseCommandResult(output)` | `execute.ts:48` |
| Change history | `recordBefore`, `rollback`, `getTaskFiles`, `getOriginalContent`, `hasChanges` | `packages/sandbox/src/change-history.ts` |
| Plan schema | `proposePlanTool` (zod schema plus a hand-written JSON schema) | `packages/protocol/src/tools.ts:439` |
| Plan validation | `validatePlan` collects `errors[]` | `packages/protocol/src/plan-validate.ts:236` |
| Developer prompt | `buildDeveloperConversationPrompt` | `packages/cli/src/agent/developer.ts:170` |
| Post-run report | Sent to the Developer as `<execution-report>` | `service.ts:1227` |
| Database | `node:sqlite`, WAL, tables `sessions` and `messages` | `packages/cli/src/persist/db.ts:37` |
| Agents | `AgentState` has no `model` field | `packages/cli/src/agent/registry.ts:6` |
| TUI rows | One row per task in `SessionStore`, updated by `applyAgentEvent` | `packages/cli/src/tui/session/store.ts:399` |
| TUI rendering | `packages/tui/src/main.tsx`, fed by `packages/cli/src/tui/opentui/protocol.ts` | — |
| CI | Builds and tests every TypeScript package | `.github/workflows/ci.yml` |

## The Runtime Migration Is Paused

`AGENT_RUNTIME_MIGRATION_EXECUTION.md` relocates the agent code into `packages/agent`. Two of its steps are merged: S0 (CI runs the TypeScript suites) and S1 (the replay harness). S2 and S3 are partly done. Its remaining lanes, L1–L7, move the same files this plan changes.

**Decision: lanes L1–L7 and LADDER-A/B are paused.** This plan builds the features where the code lives today. The relocation resumes after PR 8, with a new ownership matrix written against the code as it stands then.

- **Why:** the relocation changes no behaviour, and doing it first puts about eight PRs in front of every feature. It would also shape the new package around behaviour that is about to change.
- **Cost, accepted:** the relocation will later move more code, and its lane prompts in `AGENT_RUNTIME_MIGRATION_PROMPTS.md` will need rewriting.
- **Kept:** S0 and S1 remain gates for every PR here.

This plan settles three of the migration's open decisions (its §8):

| Decision | Settled as | Done in |
|----------|-----------|---------|
| D3: remove `masterDecide`? | Yes. It is replaced by the Manager review, and `managerModel` becomes the review model | PR 5 |
| D4: shared read locks? | Yes | PR 1 |
| D5: what happens to `packages/tester`? | Left in place. The ladder reuses its verdict names so it can be adopted later | PR 3 |

The other decisions (D1, D2, D6, D7 and D8) stay open and are out of scope.

## Order of Work

```
Wave 1   PR 1        PR 2        PR 3          in parallel
          │           │           │
Wave 2    │          PR 4         │            needs PR 2
          │           │           │
Wave 3   PR 5 ◀───────┴───────────┘            needs PR 1, PR 3, PR 4
          │
Wave 4   PR 6        PR 7                      in parallel, need PR 5
          │           │
Wave 5   PR 8 ◀───────┘                        needs PR 6, PR 7
```

PR 1 and PR 2 both edit `service.ts`, in regions that do not overlap: lock acquisition in `runTaskOnce` and `canAdmitTask`, and the plan-confirmation step. Whichever merges second rebases; neither changes the other's region.

## Ownership

A file belongs to one PR at a time. A later PR inherits a file only after the owning PR merges.

| File | PR |
|------|----|
| `packages/sandbox/src/file-locks.ts`, `packages/sandbox/test/*lock*` | 1 |
| `service.ts`: `runTaskOnce` lock acquisition, per-attempt `AbortController`, `canAdmitTask` | 1 |
| `packages/cli/test/concurrency.test.mjs` | 1 |
| `packages/protocol/src/messages.ts`, `packages/protocol/src/tools.ts` (`proposePlanTool` only), `packages/protocol/src/plan-validate.ts` | 2 |
| `packages/cli/src/agent/developer.ts` (`buildDeveloperConversationPrompt` only) | 2 |
| `packages/cli/src/agent/taskqueue.ts` | 2, then 5 |
| `service.ts`: the confirmation step (`:780-795`) | 2 |
| `packages/cli/src/tasks/execute.ts` | 1 (timeout only), then 2 (prompt), then 4, then 5 |
| `packages/cli/test/plan-validate.test.mjs`, `packages/cli/test/plan.test.mjs` | 2 |
| `packages/agent/src/coordination/{ladder,adapters}.ts`, `packages/agent/src/coordination/index.ts`, `packages/agent/test/ladder*.test.mjs`, `packages/agent/test/fixtures/manifests/**` | 3 |
| `packages/cli/src/tasks/checkpoint.ts` (new), `packages/cli/test/_provider.mjs` (usage support), `packages/cli/test/execute.test.mjs` | 4 |
| `packages/cli/src/config.ts` (compaction keys) | 4 |
| `packages/cli/src/agent/master.ts`, `packages/cli/src/tasks/findings.ts` (new), `packages/cli/src/tasks/server.ts`, `packages/agent/src/roles/manager/**`, `packages/cli/test/master.test.mjs` | 5 |
| `service.ts`: everything else in the execution block (`:780-1260`) | 5 |
| `packages/cli/src/persist/**`, `packages/cli/src/agent/registry.ts`, `packages/cli/src/session/resume.ts`, `packages/cli/test/{persist,resume}.test.mjs` | 6 |
| `packages/cli/src/session/ui.ts` (`AgentPhase` plus the plain-terminal renderer), `packages/cli/src/tui/**`, `packages/tui/src/**`, `packages/cli/test/ui.test.mjs` | 7; PR 4 may add the one phase value `compacting` to `AgentPhase` |
| `examples/polyglot/**`, `packages/cli/test/e2e-*.test.mjs`, `scripts/smoke-live.mjs`, `.github/workflows/ci.yml`, `docs/**`, `README.md` | 8 |

## Shared Contracts

These types cross PR boundaries. Each is created exactly once, by the PR named, with exactly these names and fields. A later PR imports it and does not redefine it.

**Created by PR 2**, in `packages/protocol/src/messages.ts`:

```typescript
export interface FileExcerpt {
  path: string
  /** 1-based, inclusive. Absent means the whole file. */
  range?: [number, number]
  /** Filled by the harness at plan confirmation. Never supplied by the model. */
  content?: string
  /** File hash at the moment `content` was taken. Filled by the harness. */
  hash?: string
}

// Added to PlannedTask:
//   brief: string
//   excerpts?: FileExcerpt[]
```

**Created by PR 3**, in `packages/agent/src/coordination/ladder.ts`:

```typescript
export type RungName = 'compiles' | 'runs' | 'tests'

export type RungStatus =
  | 'passed'
  | 'failed'               // the command ran and failed: a defect in the work
  | 'failed_environment'   // could not run at all: binary missing, timeout, spawn error
  | 'skipped'              // not applicable; `reason` says why

export interface Rung {
  name: RungName
  /** Argv-style command, as run_command takes it. Absent when skipped. */
  command?: string
  /** Project-relative directory to run it in. */
  cwd?: string
  timeoutMs?: number
  /** Set when the rung does not apply. */
  skipReason?: string
}

export interface RungResult {
  name: RungName
  status: RungStatus
  command?: string
  cwd?: string
  exitCode?: number
  ms: number
  /** The last 60 lines of stdout and stderr, combined. */
  outputTail: string
  reason?: string
}

export interface LadderResult {
  passed: boolean
  rungs: RungResult[]
  /** The first rung that did not pass, or undefined when all passed. */
  firstFailure?: RungResult
}

export interface CommandOutcome {
  exitCode: number
  signal: string | null
  stdout: string
  stderr: string
}

export type RunCommand = (command: string, cwd: string, timeoutMs: number) => Promise<CommandOutcome>
```

**Created by PR 4**, in `packages/cli/src/tasks/checkpoint.ts`:

```typescript
import type { LadderResult } from '@codekalakaars/vajra-agent/coordination'

export interface Checkpoint {
  taskId: string
  /** Starts at 1 and increments with every compaction. */
  sequence: number
  filesChanged: string[]
  decisions: { decision: string; reason: string }[]
  done: string[]
  remaining: string[]
  lastVerification?: LadderResult
  notes: string
}

export type WorkerOutcomeKind = 'done' | 'stuck' | 'error' | 'timeout' | 'interrupted'

export interface WorkerOutcome {
  kind: WorkerOutcomeKind
  checkpoint?: Checkpoint
  /** The Worker's closing text, when it ended at `done`. */
  summary?: string
  /** What went wrong, for anything other than `done`. */
  error?: string
  compactions: number
  toolCalls: number
}

export interface ResumeInput {
  checkpoint?: Checkpoint
  findings: string[]
}
```

**Created by PR 5**, in `packages/agent/src/roles/manager/review.ts`:

```typescript
export type ManagerVerdict = 'accepted' | 'changes_requested' | 'rejected'

export interface ReviewResult {
  verdict: ManagerVerdict
  findings: string[]
}
```

and in `packages/cli/src/agent/master.ts`:

```typescript
export interface AttemptResult {
  outcome: WorkerOutcome
  ladder?: LadderResult
  review?: ReviewResult
}

export type NextAction =
  | { action: 'accept' }
  | { action: 'respawn'; findings: string[] }
  | { action: 'escalate'; findings: string[]; reason: string }
```

**Configuration keys.** Added by PR 4 to `VajraConfig` and resolved like the existing keys, with the environment first, then `config.json`, then the default:

| Key | Env | Default | Used by |
|-----|-----|---------|---------|
| `compactAt` | `VAJRA_COMPACT_AT` | `0.7` | PR 4 |
| `stuckCheckpointMax` | `VAJRA_STUCK_CHECKPOINT_MAX` | `0.4` | PR 4 |
| `stuckCompactions` | `VAJRA_STUCK_COMPACTIONS` | `3` | PR 4 |

The respawn limit is the task's existing `retries` field (default 2). It needs no new key.

---

## PR 1 — Shared Reads, Per-Worker Kill, Whole-Attempt Timeout

**Blocked by:** nothing.
**Why:** today two tasks that only *read* the same file cannot run together, because every file is locked exclusively. The Manager also cannot stop one Worker, and a task's timeout does not stop its Worker.

**Read first:**
- `packages/sandbox/src/file-locks.ts`, the whole file;
- `service.ts:907-1076` (`runTaskOnce`);
- `service.ts:1138-1154` (`canAdmitTask`);
- `execute.ts:141-230`.

**Steps:**

1. **Add mixed-mode locking to `FileLockManager`.** It must be all-or-nothing:
   ```typescript
   export interface LockRequest { read: string[]; write: string[] }
   canAcquireMixed(request: LockRequest, owner: string): boolean
   tryAcquireMixed(request: LockRequest, owner: string): boolean
   acquireMixedOrWait(request: LockRequest, owner: string): Promise<void>
   ```
   - A path that appears in both lists is treated as `write`.
   - `tryAcquireMixed` checks every path first and takes nothing unless all are free.
   - `acquireMixedOrWait` loops on `tryAcquireMixed` exactly as `acquireOrWait` does.
   - The existing `release(owner)` releases both kinds.
   - Taking reads and writes in two separate calls is forbidden. It deadlocks when task A reads X and writes Y while task B reads Y and writes X.
2. **Lock by mode in `runTaskOnce`.** Replace the anchor `await fileLocks.acquireOrWait(allTaskPaths, task.id, 'write')` with `acquireMixedOrWait`:
   - `read`: the normalised `readFile` paths;
   - `write`: the normalised `writeFile`, `deleteFile` and `createDir` paths.
3. **Lock by mode in `canAdmitTask`.** Replace `fileLocks.canAcquire(filePaths, 'write', task.id)` with `canAcquireMixed`, using the same split. Leave the command-resource and validation-server checks unchanged.
4. **Give each attempt its own kill switch.** At the top of `runTaskOnce`, create `const attempt = new AbortController()`, linked to the session's `abortSignal`: when the session aborts, abort the attempt too. Pass `attempt.signal` to `executeTask` in place of `abortSignal`. Remove the listener in the `finally` block.
5. **Time the whole attempt.** Just before `executeTask`, start `setTimeout(() => attempt.abort('timeout'), task.timeoutSeconds * 1000)`, and clear it in `finally`.
   - After `executeTask` returns, if `attempt.signal.reason === 'timeout'`, record `taskErrors.set(task.id, \`timed out after ${task.timeoutSeconds}s\`)`.
   - Treat the attempt as failed (`false`).
   - Do not change `executeTask`'s return type; PR 4 does that.
6. **Stop the Worker promptly on abort.** In `execute.ts`, pass `signal` into each `dispatchToolCall` (the option exists). Confirm that the loop checks `signal?.aborted` before every provider round; it already does at `:206`.

**Tests:**
- `sandbox` lock tests:
  - two owners take `read` on one path at once;
  - `write` waits for `read`, and `read` waits for `write`;
  - a crossed pair of mixed requests resolves with no deadlock;
  - a path in both lists is held as `write`;
  - a failed `tryAcquireMixed` takes nothing.
- `concurrency.test.mjs`:
  - two tasks whose only shared file is in both their `readFile` lists run at the same time (record start and end times through `onTaskEvent`, and assert the intervals overlap);
  - a task writing that file waits for both;
  - a task whose Worker never finishes stops at `timeoutSeconds`, and the run records "timed out".

**Must not change:** `executeTask`'s signature and return type, the replay fixtures, and anything about retries.

**Gate:** `pnpm build:all && pnpm test:all` is green, and the replay tests pass unchanged.

**Docs:** add one sentence to `docs/execution/README.md` saying read-only inputs take shared locks, if that file describes locking. Otherwise add nothing.

---

## PR 2 — The Brief and Its Excerpts

**Blocked by:** nothing.
**Why:** a Worker today starts with no knowledge of the conversation and re-reads every file. The Developer already knows the goal, the decisions and the code. The brief carries that knowledge to the Worker.

**Read first:**
- `packages/protocol/src/messages.ts:34-77`;
- `packages/protocol/src/tools.ts:439-640` (`proposePlanTool`);
- `packages/protocol/src/plan-validate.ts:236-390` (`validatePlan`);
- `developer.ts:170-260` (the prompt);
- `service.ts:754-800`;
- `execute.ts:160-200`.

**Steps:**

1. **Extend `PlannedTask`** in `messages.ts` with `brief: string` and `excerpts?: FileExcerpt[]`, and add `FileExcerpt` exactly as in [Shared Contracts](#shared-contracts).
2. **Extend `proposePlanTool`** in both schemas, the zod one and `jsonSchema`:
   - **`brief`**: a required string, described as: "Everything a Worker needs to know that you learned in this conversation: the goal, decisions made with the user and why, conventions to follow, and how this task fits the plan. The Worker has not seen the conversation."
   - **`excerpts`**: optional, an array of `{ path: string, range?: [number, number] }`, described as: "Code you have already read that this task needs. Give the path and 1-based inclusive line range; the harness fills in the content. Only paths in this task's readFile or writeFile."
   - The model must never be offered `content` or `hash`.
3. **Add rules to `validatePlan`.** Each pushes to `errors`, worded like the existing messages (`${where} ...`). A task is rejected when:
   - its `brief` is empty, or shorter than 40 characters after trimming;
   - an excerpt `path` is not in that task's `readFile ∪ writeFile` (compare canonical paths with the file's existing `canonicalPlanPath`);
   - a range has `start < 1` or `end < start`.
4. **Tell the Developer about briefs** in `buildDeveloperConversationPrompt`, beside the existing `propose_plan` shape description. Keep it short:
   - the Worker has not seen this conversation;
   - put decisions and conventions in `brief`;
   - list excerpts for code already read.
5. **Fill excerpts at confirmation.** In `service.ts`, just after the anchor `ui.info('\n🚀 Executing tasks...\n')` and before `queue.addTask`, for every excerpt in every task:
   - read the file relative to `projectDir`;
   - slice the range, or take the whole file;
   - set `content`, and set `hash` from `inspectFile(...).hash` (already imported in this file);
   - drop an excerpt whose file is missing or unreadable, with a `ui.warning`.

   Then enforce the size cap: if a task's excerpt `content` exceeds 24,000 characters in total, drop excerpts from the end of the list until it fits, with one `ui.warning` naming the task.
6. **Carry the fields through the queue.** `TaskState` gains `brief: string` and `excerpts: FileExcerpt[]` (default `[]`). `TaskQueue.addTask` copies them, and the `ExecuteTaskInput['task']` type in `execute.ts` gains them.
7. **Rewrite the Worker's prompt** in `executeTask`:
   - Add a `BRIEF:` section with the brief, after the task line.
   - Add a `FILES YOU ALREADY HAVE:` section. For each excerpt, give a heading `path (lines a-b)` and its content in a fenced block.
   - Replace the rule `'- Read each readFile first to understand the current code'` with `'- The files above are current; read other files only when you need them'`.
   - Before building the prompt, re-hash each excerpt's file. When the hash differs, drop the excerpt and add a line under the section: `path changed since planning; read it before editing.`

**Tests:**
- `plan-validate.test.mjs`:
  - a missing brief, a short brief, an excerpt outside the task's files, and a bad range are each rejected;
  - a valid excerpt is accepted.
- `plan.test.mjs`:
  - confirmation fills `content` and `hash`;
  - a missing file's excerpt is dropped with a warning;
  - the 24,000-character cap drops excerpts from the end.
- `execute.test.mjs`, using `scriptedProvider` and a captured request:
  - the system prompt contains the brief and the excerpt content;
  - a changed file's excerpt is replaced by the "changed since planning" line;
  - the "Read each readFile first" rule is gone.
- Update every existing test fixture plan that builds a `PlannedTask` to include a `brief`.

**Must not change:** scheduling, retries, and verification.

**Gate:** `pnpm build:all && pnpm test:all` is green. Re-record `worker-basic.json` and `developer-basic.json`. The PR description shows the diff; the expected difference is the prompt text, plus fewer `read_file` calls where excerpts cover them.

**Docs:** in `docs/tasks/README.md`, describe `brief` and `excerpts` in the task-fields section.

---

## PR 3 — The Verification Ladder

**Blocked by:** nothing.
**Why:** a task is verified today only by commands the plan happened to include, run by the Worker that did the work. The ladder gives every task a compile → run → tests check with defaults for the project's language, run by the Manager (PR 5 wires it in).

**Read first:**
- [ADR-0012](docs/adr/0012-verification-ladder-replaces-phase-one.md);
- `packages/tester/src/verdict.ts` (for the names);
- `packages/cli/src/tasks/server.ts` (`needsServer`);
- `packages/agent/src/coordination/index.ts`;
- `packages/agent/test/import-rules.test.mjs`.

**Steps:**

1. **Create `packages/agent/src/coordination/ladder.ts`** with the types in [Shared Contracts](#shared-contracts), and these functions:
   ```typescript
   export interface LadderTask {
     writeFile: string[]
     deleteFile: string[]
     /** Legacy plan field. Becomes the `tests` rung override. */
     validation: string[]
     /** When true, the `runs` rung applies. The caller decides this. */
     hasServer: boolean
     timeoutSeconds: number
   }
   export interface ServerHooks {
     /** Start the server; resolve when it answers, reject when it does not. */
     start: () => Promise<{ stop: () => Promise<void> }>
   }
   export function buildLadder(task: LadderTask, adapters: AdapterMatch[]): Rung[]
   export async function runLadder(rungs: Rung[], run: RunCommand, server?: ServerHooks): Promise<LadderResult>
   ```
2. **Create `packages/agent/src/coordination/adapters.ts`:**
   ```typescript
   export type Language = 'node' | 'python' | 'go' | 'rust' | 'java-maven' | 'java-gradle'
   export interface AdapterMatch { language: Language; manifestDir: string; compile?: string; test?: string }
   export type FileProbe = { exists(path: string): boolean; read(path: string): string | null }
   export function detectAdapters(files: string[], probe: FileProbe): AdapterMatch[]
   ```
   - For each file, walk up its directories, towards the project root, to the nearest directory holding a manifest. Stop at the project root.
   - De-duplicate matches by `manifestDir`.
   - `FileProbe` is injected so tests need no real filesystem. PR 5 passes one backed by `node:fs`, scoped to `projectDir`.
   - The commands per manifest:

   | Manifest found | `language` | `compile` | `test` |
   |----------------|-----------|-----------|--------|
   | `package.json` | `node` | `npx --no-install tsc --noEmit` if `tsconfig.json` is in the same directory; otherwise absent | `npm test --silent` if `scripts.test` exists and does not contain `no test specified`; otherwise absent |
   | `pyproject.toml`, `setup.py` or `requirements.txt` | `python` | `python3 -m compileall -q .` | `python3 -m pytest -q` if `pytest.ini`, `conftest.py` or a `tests/` directory exists, or `pyproject.toml` contains `[tool.pytest`; otherwise absent |
   | `go.mod` | `go` | `go build ./...` | `go test ./...` |
   | `Cargo.toml` | `rust` | `cargo check --quiet` | `cargo test --quiet` |
   | `pom.xml` | `java-maven` | `mvn -q -DskipTests compile` | `mvn -q test` |
   | `build.gradle` or `build.gradle.kts` | `java-gradle` | `./gradlew -q compileJava` if `gradlew` exists, else `gradle -q compileJava` | the same with `test` |

   When several manifests share one directory, the first matching row wins.
3. **`buildLadder` rules:**
   - **`compiles`:** one rung per adapter with a `compile` command, each run in its adapter's `manifestDir`. When no adapter has one, a single skipped rung: `no compile step for this project`.
   - **`runs`:** applies only when `task.hasServer`. Its command is absent; `runLadder` uses `server.start()`. Otherwise it is skipped with `no server`.
   - **`tests`:** if `task.validation` is non-empty, one rung per validation command, run at the project root. Otherwise one rung per adapter with a `test` command. Otherwise skipped: `no test command found`.
   - The rungs are ordered `compiles`, then `runs`, then `tests`. Several rungs may share a name.
   - Every rung's `timeoutMs` is `task.timeoutSeconds * 1000`.
4. **`runLadder` rules:**
   - Run the rungs in order and stop at the first that is neither `passed` nor `skipped`.
   - **Command status:** `exitCode 0` with no signal is `passed`. A non-zero exit is `failed`. A signal, `exitCode 124`, `exitCode 127`, or a thrown error is `failed_environment`, with a `reason`.
   - **The `runs` rung:** call `server.start()`. If it rejects, the rung is `failed`. If it resolves, the rung is `passed` and the server is kept running for the `tests` rungs, then stopped after the last rung whatever happens.
   - **Result:** `passed` is true only when every rung is `passed` or `skipped` **and at least one rung is `passed`**. A ladder where every rung was skipped is not a pass: it returns `passed: false` with `firstFailure` set to a synthetic `RungResult`, with status `skipped` and reason `no rung applies`.
   - `outputTail` is the last 60 lines of `stdout + '\n' + stderr`.
5. **Export** everything from `packages/agent/src/coordination/index.ts`.

**Tests** (`packages/agent/test/ladder.test.mjs` and `adapters.test.mjs`; fake `RunCommand` and `FileProbe` only):
- **Adapters:**
  - each manifest row gives the right commands;
  - `package.json` without `tsconfig.json` has no compile step;
  - npm's placeholder test script means no test step;
  - a monorepo with `web/package.json` and `api/go.mod` gives each written file its nearest manifest;
  - the walk stops at the project root.
- **Building the ladder:**
  - `validation` overrides the adapter's test command;
  - `hasServer: false` skips `runs`;
  - the rung order is fixed.
- **Running the ladder:**
  - it stops at the first failure and runs nothing after it;
  - exit 127 is `failed_environment`;
  - all-skipped is not a pass;
  - the server starts before `tests` and is stopped even when a test rung fails;
  - `outputTail` keeps only the last 60 lines.
- `import-rules.test.mjs` still passes.

**Must not change:** anything outside `packages/agent`. Nothing calls the ladder yet.

**Gate:** `pnpm build:all && pnpm test:all` is green.

**Docs:** none; PR 8 documents the ladder.

---

## PR 4 — Worker Outcomes, Checkpoints and Compaction

**Blocked by:** PR 2 (both edit `execute.ts`).
**Why:** a Worker today runs until 100 tool calls, whatever its context holds, and reports only true or false. This implements [ADR-0015](docs/adr/0015-workers-compact-their-own-context.md). It also gives the Manager a precise outcome and a checkpoint to hand on.

**Read first:**
- [ADR-0015](docs/adr/0015-workers-compact-their-own-context.md);
- `execute.ts` in full, as it stands after PR 2;
- `chat.ts:49-110` and `:380-480` (the request and usage);
- `packages/cli/test/_provider.mjs` in full;
- `config.ts`.

**Steps:**

1. **Teach the fake provider about usage.** In `_provider.mjs`, a round may carry `usage: { prompt_tokens, completion_tokens }`. When present, `roundChunks` appends one chunk `{ choices: [], usage: {...} }` before the stop chunk. `chat.ts:420` reads usage from a chunk with empty `choices`, so match that shape exactly. Existing rounds without usage are unchanged.
2. **Add the config keys** in [Shared Contracts](#shared-contracts) to `VajraConfig`, with a resolver `resolveCompaction(env)`. It returns `{ compactAt, stuckCheckpointMax, stuckCompactions }`, clamped to sane ranges: `0.3 ≤ compactAt ≤ 0.95`, `0.1 ≤ stuckCheckpointMax < compactAt`, and `1 ≤ stuckCompactions ≤ 10`.
3. **Create `packages/cli/src/tasks/checkpoint.ts`** with:
   - the types in [Shared Contracts](#shared-contracts);
   - `WRITE_CHECKPOINT_TOOL`: an OpenAI function spec named `write_checkpoint`, whose parameters are the `Checkpoint` fields except `taskId` and `sequence`, which the harness sets;
   - `parseCheckpoint(args, taskId, sequence): Checkpoint | { error: string }`, which validates by hand: every array field is an array of strings (or of `{decision, reason}` strings), `notes` is a string, and the error names the first bad field;
   - `renderCheckpoint(checkpoint): string`, a markdown section headed `PROGRESS SO FAR (checkpoint N)`, listing files changed, decisions with reasons, done, remaining, the last verification (the first failing rung and its tail, if any), and notes;
   - `renderResume(resume: ResumeInput): string`: the checkpoint rendering, if there is a checkpoint, followed by `WHAT WENT WRONG LAST TIME:` and the findings as a list.
4. **Change `executeTask`:**
   - **Return** `Promise<WorkerOutcome>`.
   - **Accept** a new trailing options object: `{ resume?: ResumeInput; onMutateCount?: () => number; compaction: { compactAt; stuckCheckpointMax; stuckCompactions }; onCheckpoint?: (c: Checkpoint) => void }`. `onMutateCount` returns how many file mutations the handle has made so far; `service.ts` builds it from the `onMutate` hook it already passes to the handle.
   - **Resume:** when `resume` is present, append `renderResume(resume)` to the first user message.
   - **Compaction:** after each provider round, if `result.usage` is present and `usage.promptTokens >= compactAt * getModelLimit(model)`, compact before the next round:
     - Push the assistant message and answer its tool calls as usual, then push a user message: `Your context is nearly full. Call write_checkpoint now with your progress; your conversation will be replaced by it.`
     - Run one round with `tools: [...toolSpecs, WRITE_CHECKPOINT_TOOL]` and `toolChoice: { type: 'function', function: { name: 'write_checkpoint' } }`.
     - Parse it with `parseCheckpoint`. On error, repeat this compaction round once with the error text added. A second error ends the attempt as `{ kind: 'stuck', error: 'could not write a valid checkpoint' }`.
     - On success:
       - increment `compactions`, and call `onCheckpoint`;
       - emit `{ type: 'phase', agent, phase: 'compacting' }`;
       - set `messages = [systemMessage, { role: 'user', content: 'Execute the task now.\n\n' + renderCheckpoint(checkpoint) }]`;
       - keep the checkpoint as the attempt's latest.
   - **Stuck:**
     - After a successful compaction, estimate the rendered checkpoint's size as `Math.ceil(text.length / 4)` tokens. If that is at least `stuckCheckpointMax * getModelLimit(model)`, end with `stuck` and the error `checkpoint too large to continue`.
     - Record `onMutateCount()` at each compaction. If `stuckCompactions` consecutive compactions show no increase, end with `stuck` and the error `no progress across N compactions`.
   - **The budget:** keep `MAX_WORKER_TOOL_CALLS = 100`, but exhausting it now ends with `stuck` and the error `tool-call budget exhausted`, not a normal exit.
   - **Endings:**

     | Ending | Outcome |
     |--------|---------|
     | The model stops calling tools | `{ kind: 'done', summary: <the final assistant text> }` |
     | Aborted with reason `'timeout'` | `timeout` |
     | Any other abort | `interrupted` |
     | A thrown error | `{ kind: 'error', error: message }` |

     Always include the latest `checkpoint`, `compactions` and `toolCalls`.
   - **Verification stays where it is in this PR.** If the validation phase fails, return `{ kind: 'error', error: 'validation failed: <cmd>' }`. PR 5 moves verification out.
5. **Adapt the call site** in `service.ts` `runTaskOnce`:
   - Keep a mutation counter beside the existing `dirty` flag, and pass `onMutateCount`, `compaction: resolveCompaction()` and `onCheckpoint`, which stores the latest checkpoint in a `Map<taskId, Checkpoint>`.
   - Map the outcome to the boolean that `masterLoop` still expects: `const success = outcome.kind === 'done'`.
   - Record `outcome.error` in `taskErrors` when present.
   - This is the only `service.ts` edit in this PR.
6. **Add `'compacting'` to `AgentPhase`** in `session/ui.ts`. PR 7 renders it.

**Tests** (`execute.test.mjs`, using `scriptedProvider` with usage and `recordingHandle`, and capturing each request body through `useProvider`):
- **Compaction:**
  - when a round's `prompt_tokens` crosses 70% of the model window, the next request forces `write_checkpoint`;
  - the request after that holds exactly two messages, system and user, and the user message contains the checkpoint;
  - a malformed checkpoint gets one repeat, and a second malformed one ends as `stuck`;
  - a checkpoint over 40% of the window ends as `stuck`;
  - three compactions without a mutation end as `stuck`; three with a mutation in between do not.
- **Endings:**
  - `done` carries the final text as `summary`;
  - a timeout abort gives `timeout`, and a plain abort gives `interrupted`;
  - 100 tool calls end as `stuck`.
- **Resume:** `resume` puts the checkpoint and findings in the first user message.
- **Config:** the clamping in `resolveCompaction`, in `config-roles.test.mjs` or a new `config-compaction.test.mjs`.

**Must not change:** `masterLoop`, the retry policy, and verification behaviour.

**Gate:** `pnpm build:all && pnpm test:all` is green. `worker-basic.json` is re-recorded only if the request shape changed; say so in the description.

**Docs:** none; ADR-0015 is the documentation.

---

## PR 5 — The Manager: Verify, Review, Respawn, Escalate

**Blocked by:** PR 1, PR 3, PR 4.
**Why:** the Worker currently checks its own work, and a failure throws the work away and reruns the same prompt. This makes the Manager verify every finished attempt with the ladder, have its model review work that passed, and respawn failed work with its checkpoint and findings. Implements [ADR-0016](docs/adr/0016-failed-attempts-are-respawned.md) and the verdicts of [ADR-0013](docs/adr/0013-manager-verifies-reviews-and-retires-workers.md).

**Read first:**
- ADR-0013 and ADR-0016;
- `master.ts` in full;
- `service.ts:780-1260`;
- `execute.ts` as it stands after PR 4;
- `tasks/server.ts`;
- `packages/agent/src/coordination/ladder.ts` (PR 3);
- `tasks/checkpoint.ts` (PR 4).

**Steps:**

1. **Move server startup into `tasks/server.ts`.** Move the start, probe and kill code at `execute.ts:297-335` and `:86-139` into `tasks/server.ts`, as:
   ```typescript
   export async function startValidationServer(projectDir: string): Promise<{ port: number; stop: () => Promise<void> } | null>
   ```
   It returns `null` when `findServerEntry` finds no entry point, and rejects when the server does not come up after three port attempts, exactly as today.
2. **Take verification out of the Worker.** Delete the validation phase from `executeTask` (from the anchor `if (task.validation.length > 0) {` through its closing block) and the helpers only it used. A Worker now ends at `done` without verifying.
3. **Create `packages/agent/src/roles/manager/review.ts`**, exported from `roles/manager/index.ts`:
   ```typescript
   export interface ReviewInput {
     title: string
     brief: string
     /** Unified diff of this task's changes against its baseline. */
     diff: string
     ladder: LadderResult
     workerSummary: string
   }
   export type AskVerdict = (system: string, user: string) => Promise<{ verdict: string; findings: unknown } | null>
   export async function reviewAttempt(input: ReviewInput, ask: AskVerdict): Promise<ReviewResult>
   export const VERDICT_TOOL: { type: 'function'; function: { name: 'verdict'; description: string; parameters: object } }
   ```
   - **The system prompt:**
     - You are the Manager. Judge whether this change does what the task and brief ask.
     - The ladder has already passed.
     - Reject work that hard-codes its way past a check, changes files it did not need to, or leaves the task incomplete.
     - Findings state what is wrong and where, never how to fix it.
     - Call `verdict` exactly once.
   - **Parsing:** an unknown verdict, a `null` reply or malformed findings becomes `{ verdict: 'rejected', findings: ['review returned no usable verdict'] }`.
   - **The floor:** `reviewAttempt` must never be called with a failed ladder. Throw if `input.ladder.passed` is false.
4. **Create `packages/cli/src/tasks/findings.ts`:**
   ```typescript
   export function findingsFor(result: AttemptResult): string[]
   ```
   | Attempt ended with | Findings |
   |--------------------|----------|
   | A ladder failure | `"<rung> failed: \`<command>\` in <cwd> exited <code>"` and the `outputTail` in a fenced block. For `failed_environment`, `"could not run <rung>: <reason>"` |
   | `stuck` | `"the previous Worker stopped making progress: <error>"` |
   | `timeout` | `"the previous Worker ran out of time after <n>s"` |
   | `error` | `"the previous Worker failed: <error>"` |
   | A review | Each review finding, prefixed `review:` |
5. **Rewrite the attempt in `service.ts` `runTaskOnce`** to return an `AttemptResult`:
   1. Take `resume?: ResumeInput` as a second parameter and pass it to `executeTask`.
   2. If the outcome is not `done`, return `{ outcome }`.
   3. Otherwise, build the ladder:
      - `detectAdapters([...task.writeFile, ...task.deleteFile], fsProbe(projectDir))`;
      - `buildLadder` with `hasServer: needsServer(task.validation)`;
      - `runLadder`, where `run` calls `taskHandle.callTool('run_command', { command, cwd, timeoutMs })` and parses with `parseCommandResult`;
      - `server.start` uses `startValidationServer`, under the existing `<resource:validation-server>` lease. Keep the acquire and release exactly as `execute.ts` did.
   4. Emit phase `verifying` before the ladder and `reviewing` before the review. (PR 7 adds these phase values; this PR adds them to `AgentPhase` too if PR 7 has not merged.)
   5. If the ladder passed and `managerAsks` is true, call `reviewAttempt`:
      - `diff` is built from `changeHistory.getTaskFiles(task.id)`, comparing `getOriginalContent` with the current file, as a simple unified diff; use a small local helper with no dependency;
      - `ask` calls `streamChatCompletion` with `managerModel`, `tools: [VERDICT_TOOL]`, and `toolChoice` forcing `verdict`.
   6. Return `{ outcome, ladder, review }`.
   7. **Remove the rollback** on a non-success in this function (the anchor `if (dirty || changeHistory.hasChanges(task.id)) { await changeHistory.rollback(task.id) }`). The Manager decides rollbacks now.
   8. `recordBefore` is called only on the first attempt of a task. Keep a `Set` of tasks already baselined, so a respawn never overwrites the original baseline.
6. **Rewrite `masterLoop`'s attempt loop** in `master.ts`:
   - `runTask` becomes `(task: TaskState, resume?: ResumeInput) => Promise<AttemptResult>`.
   - Replace `decideFailure` with a pure function:
     ```typescript
     export function decideNext(input: {
       result: AttemptResult
       respawnsUsed: number
       maxRespawns: number
       noChanges: boolean
       interrupted: boolean
     }): NextAction | { action: 'park' }
     ```
     Its rules, in order:
     1. `interrupted` → `park`.
     2. The outcome is `done`, the ladder passed, and there was no review or the review `accepted` → `accept`.
     3. The outcome is `done`, `noChanges` is true, and the ladder did not pass → `escalate`, with reason `no changes were made`.
     4. `respawnsUsed >= maxRespawns` → `escalate`, with reason `respawns exhausted (N)`.
     5. Otherwise → `respawn`, with `findingsFor(result)`.
   - **On `respawn`:**
     - emit a `retry` task event, as today;
     - fetch the task's latest checkpoint through a new dependency, `latestCheckpoint(taskId)`;
     - call `runTask(task, { checkpoint, findings })`;
     - do not call `rollbackTask` or `rebaselineTask`.
   - **On `escalate`:** call `rollbackTask(task)` (the plan's `rollback` commands, then `changeHistory.rollback`), then `failTask(task, reason)`. Store the findings through a new dependency, `recordEscalation(taskId, findings)`.
   - **Delete:** `decideFailure`, `FailureInput`, `FailureDecision`, `masterDecide`, `MASTER_DECIDE_TOOL_SPECS`, `MasterDecideDeps`, `MasterFailureContext`, the `decide` and `rebaselineTask` dependencies, and `abortAfterFailures`. Remove their uses in `service.ts:1155-1190`.
   - Keep `runRollbackCommands`, `blockedDependents` and `shouldReplan`.
7. **Report escalations to the Developer.** In the `<execution-report>` built at `service.ts:1227`, after the existing lines, add one block per escalated task: `Task "<title>" was escalated: <reason>`, followed by its findings as a list. The Developer's existing next turn handles it, and its existing plan confirmation keeps the Human in the loop.
8. **Kill means release.** In `runTaskOnce`'s `finally`, locks and the sandbox handle are already released. Confirm that this also runs between respawns: each respawn is a new `runTaskOnce` call, so it takes its locks again. A Worker never outlives its attempt.

**Tests:**
- `master.test.mjs` (replace the `decideFailure` tests with `decideNext` tests covering every rule and its order):
  - a respawn passes `{ checkpoint, findings }` to the second `runTask` call;
  - `rollbackTask` is not called on a respawn;
  - after `maxRespawns` failures, `rollbackTask` and `failTask` are called once;
  - `recordEscalation` receives the findings;
  - interrupted parks.
- `session.test.mjs` or a new `manager.test.mjs`, driving `runSession` with `scriptedProvider`, `autoConfirm` and a temporary project:
  - a Worker that ends at `done` with a failing ladder command is respawned;
  - the second Worker's first request contains `WHAT WENT WRONG LAST TIME` and the failing command;
  - the first attempt's file is still on disk when the second starts;
  - after two respawns the file is restored to its original content;
  - escalation findings appear in the `<execution-report>`.
- **Review** (`packages/agent/test/review.test.mjs`):
  - calling it with a failed ladder throws;
  - an unusable reply becomes `rejected`;
  - `accepted` passes through.
- **Review in a session:** with a Manager model set, a review of `changes_requested` uses a respawn; with none set, no review request is ever sent.
- **The server lease:** it is released on every path, including a failing `runs` rung.

**Must not change:** the confirmation flow, the lock semantics from PR 1, and the checkpoint format from PR 4.

**Gate:** `pnpm build:all && pnpm test:all` is green. `worker-basic.json` is re-recorded (the validation phase has left the Worker); explain the diff in the description.

**Docs:** in `docs/system-roles/manager.md`, replace the description of failure handling with: ladder, review, respawn, escalate. Link ADR-0016.

---

## PR 6 — State and Attribution

**Blocked by:** PR 5.
**Why:** plans, attempts, checkpoints and events currently live in memory, apart from a small projection. Nothing records which model did what, and a crashed session restarts its running tasks from scratch.

**Read first:**
- `persist/db.ts`, `persist/session.ts` and `session/resume.ts` in full;
- `registry.ts`;
- `service.ts:852-895` (`persist`).

**Steps:**

1. **Add the tables** in `db.ts`'s `openDb`, after the existing ones, each with `CREATE TABLE IF NOT EXISTS`:
   ```sql
   CREATE TABLE IF NOT EXISTS plans (
     plan_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
     confirmed_at INTEGER NOT NULL, plan TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS tasks (
     session_id TEXT NOT NULL, task_id TEXT NOT NULL, plan_id TEXT NOT NULL,
     status TEXT NOT NULL, respawns INTEGER NOT NULL DEFAULT 0,
     error TEXT, escalation TEXT, updated_at INTEGER NOT NULL,
     PRIMARY KEY (session_id, task_id));
   CREATE TABLE IF NOT EXISTS workers (
     worker_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT NOT NULL,
     attempt INTEGER NOT NULL, model TEXT NOT NULL,
     started_at INTEGER NOT NULL, ended_at INTEGER,
     outcome TEXT, kill_reason TEXT, compactions INTEGER, tool_calls INTEGER);
   CREATE TABLE IF NOT EXISTS checkpoints (
     session_id TEXT NOT NULL, task_id TEXT NOT NULL, sequence INTEGER NOT NULL,
     worker_id TEXT NOT NULL, created_at INTEGER NOT NULL, checkpoint TEXT NOT NULL,
     PRIMARY KEY (session_id, task_id, worker_id, sequence));
   CREATE TABLE IF NOT EXISTS events (
     session_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL,
     task_id TEXT, worker_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL,
     PRIMARY KEY (session_id, seq));
   CREATE INDEX IF NOT EXISTS workers_by_task ON workers(session_id, task_id);
   ```
2. **Create `packages/cli/src/persist/run.ts`** with a `RunRecorder` class:
   - `planConfirmed(plan)`;
   - `taskUpdated(taskId, fields)`;
   - `workerStarted(...)` and `workerEnded(...)`;
   - `checkpoint(...)`;
   - `event(...)`.

   Events are buffered and written in one transaction every 250 ms or every 50 events, whichever comes first. `flush()` writes the buffer and runs on session exit and on `SIGINT`. Every other method writes at once.
3. **Give agents a model.** `AgentState` gains `model: string`, and `createAgent` takes it. Every call site passes the role's resolved model: `developerModel`, `workerModel` or `managerModel`. This is the migration's C8, which ADR-0010 requires.
4. **Wire the recorder** in `service.ts`. This PR inherits `service.ts`'s execution block from PR 5:
   - `planConfirmed` on confirmation;
   - `workerStarted` and `workerEnded` around each attempt, with the outcome and a kill reason of `accepted`, `respawn`, `escalated`, `timeout` or `interrupted`;
   - `checkpoint` from `onCheckpoint`;
   - `event` from `emitAgent` for `tool-end`, `phase`, and the ladder and review results;
   - `taskUpdated` on every status change.
5. **Resume from checkpoints.** In `resume.ts` and the execution setup, a task persisted as `running` gets its latest checkpoint from the database. The task's first attempt in the resumed session is started with `resume: { checkpoint, findings: ['the previous session ended during this attempt'] }` instead of from scratch. That uses one respawn only if the task then fails.

**Tests:**
- `persist.test.mjs`:
  - opening a database created before this PR (make one with only the old two tables) adds the new tables and keeps the old rows;
  - buffered events flush after 250 ms, after 50 events, and on `flush()`.
- `resume.test.mjs`: a session killed with a task `running` and a stored checkpoint resumes that task with the checkpoint in its first request.
- `registry`: `createAgent` stores the model; a Worker row records `workerModel`.

**Must not change:** the `sessions` and `messages` tables, or the session projection that resume already reads.

**Gate:** `pnpm build:all && pnpm test:all` is green.

**Docs:** in `docs/runtime/state.md`, add the five tables with one line each.

---

## PR 7 — Live Status Lines

**Blocked by:** PR 5. It needs the `verifying` and `reviewing` phases and the respawn events.
**Why:** with several Workers running, the user needs one line per Worker showing what it is doing. A percentage-complete would be invented, so there is none.

**Read first:**
- `session/ui.ts` in full;
- `tui/session/store.ts` in full;
- `tui/opentui/protocol.ts`;
- `packages/tui/src/protocol.ts` and `main.tsx` (the task and sidebar rendering).

**Steps:**

1. **Final `AgentPhase` values** in `ui.ts`: `scanning`, `indexing`, `planning`, `validating`, `executing`, `compacting`, `verifying`, `reviewing` and `waiting`. Keep the existing ones.
2. **The task row in `store.ts`** gains:
   - `contextPct?: number`, computed on `llm-end` with usage as `round(100 × promptTokens / getModelLimit(workerModel))`. The store needs `workerModel`: pass it into the store's constructor from `session-ui.ts`.
   - `attempt: number`, starting at 1, incremented on the task event `retry`. Match rows by `taskId` where the event carries one, and fall back to `title` as today.
   - `waitingOn?: string`, set from a new task event `{ type: 'waiting'; title; taskId; reason }` and cleared on `start`.
   - `phase?: AgentPhase`.
3. **Emit `waiting` from `masterLoop`.** On each scheduling pass, for every pending task not started because of an unmet dependency or a lock, emit `waiting` once per reason change: `waiting on <dependency title>` or `waiting for <path>`. Add `canAdmitReason(task): string | null` beside `canAdmitTask`. This is a small `master.ts` and `service.ts` edit that this PR is allowed to make.
4. **Render the rows** in `main.tsx` and in the plain-terminal renderer in `ui.ts`. Each row reads:
   ```
   <title padded>  <current action>  ctx <n>%  [attempt <k>]  <m:ss>
   ```
   - The current action is the last `tool-start` summary while a tool runs, otherwise the phase name.
   - `attempt <k>` appears only when k > 1.
   - A waiting row shows `waiting on …` in place of the action and omits `ctx`.
5. **Add a footer:** `<r> running · <w> waiting · <d> done · <f> failed`.
6. **Serialise the new fields** through both protocol files.

**Tests:** `ui.test.mjs`, plus a store test:
- `contextPct` is computed from usage;
- `attempt` increments on `retry`;
- `waitingOn` is set and then cleared;
- the row text for each phase;
- the footer counts;
- the plain renderer prints one line per running Worker.

**Must not change:** event emission outside the row model, apart from the new `waiting` event.

**Gate:** `pnpm build:all && pnpm test:all` is green. Then run it by hand: `pnpm cli` in a real terminal against `examples/polyglot/ts` (from PR 8, or any small repo) with `--concurrency 3`. The PR description includes a screenshot or a pasted capture.

**Docs:** none; PR 8 documents it.

---

## PR 8 — End-to-End Acceptance and Documentation

**Blocked by:** PR 6, PR 7.
**Why:** prove the whole flow in five languages, record the first real speed numbers, and make the documentation true.

**Steps:**

1. **Fixtures.** Create `examples/polyglot/{ts,python,go,rust,java}/`: one small, buildable project each, with a passing test suite and a `REQUEST.md` holding one feature request. Each request splits into three tasks:
   - two independent tasks writing different files;
   - one task that depends on both.

   Keep each project under 300 lines. The Java fixture uses Maven.
2. **Recorded end-to-end tests,** one `packages/cli/test/e2e-<lang>.test.mjs` per fixture. Each:
   - copies the fixture to a temporary directory;
   - drives `runSession` with a scripted provider (`autoConfirm`, `concurrency: 3`) in which the Developer proposes the three-task plan and each Worker writes its files;
   - makes the first attempt of one independent task write code that fails the ladder's test rung, and its respawn fix it.

   Then it asserts, from the recorded events:
   - the two independent tasks' Worker intervals overlap;
   - the dependent task starts after both finish;
   - the failing task shows a `retry`, and its second request contains the failing command;
   - every `workerStarted` has a matching `workerEnded`;
   - the run ends with all three tasks done;
   - the `workers` table has 4 rows with `workerModel` recorded.

   These tests run the fixture's real toolchain. Each skips with a clear message, never a silent pass, when its toolchain is missing (`which` fails).
3. **A compaction end-to-end test.** In the TypeScript fixture, one Worker's scripted usage crosses 70%. Assert it compacts at least once and still finishes, and that its checkpoint is in the `checkpoints` table.
4. **CI.** In `.github/workflows/ci.yml`, before the TypeScript tests, add:
   - `actions/setup-python` (3.12), plus `pip install pytest`;
   - `actions/setup-go` (stable);
   - `actions/setup-java` (temurin 21, with Maven).

   Rust and Node are already set up.
5. **`scripts/smoke-live.mjs`**, run by hand with a real `OPENCODE_API_KEY`:
   - for each fixture, it copies the project, runs `vajra` with `--yes` and the fixture's `REQUEST.md`, first at `--concurrency 1` and then at `--concurrency 4`;
   - it then prints a table: wall time, total tokens, respawns, compactions, and whether the fixture's own test suite passes afterwards.

   There is no pass or fail on speed.
6. **Documentation. Make every page below true:**
   - `docs/roadmap/README.md`: status rows for scheduling, the brief, the ladder, compaction, respawn, review, state and status lines. Mark the migration lanes as paused, with a link to this plan.
   - `docs/execution/README.md`: the attempt lifecycle, as in the flow in `VAJRA_END_TO_END.md`.
   - `docs/testing/README.md`: the ladder and its per-language defaults table.
   - `README.md`: the status table rows for orchestration and verification.
   - `AGENT_RUNTIME_MIGRATION_EXECUTION.md`: its "Paused" banner (added by the planner) is updated to say this plan is complete and the lanes can now be re-planned.

**Gate:**
- `pnpm build:all && pnpm test:all` is green in CI, with all five end-to-end tests *running*, not skipped.
- `scripts/smoke-live.mjs` has been run by hand, and its table is pasted into the PR description.
- A reviewer has checked that each documentation page above matches the code.

---

## Definition of Done

The first version is done when every item below is true and PR 8's gate has passed:

1. A user has a multi-turn conversation with the Developer, sees a plan, and nothing runs until they confirm it.
2. Independent tasks run at the same time; tasks that only read the same file run together.
3. Two tasks that write the same file never run at the same time.
4. A Worker receives the brief and current excerpts, and is not told to re-read files it was given.
5. A Worker whose context fills up compacts and continues; one that stops making progress ends as `stuck`.
6. Every finished attempt is verified by the ladder, with defaults for JS/TS, Python, Go, Rust and Java.
7. A failed attempt is respawned with its checkpoint and findings, keeping its changes, at most twice. Then its changes are rolled back and it is escalated to the Developer, with the findings in the execution report.
8. With a Manager model configured, work that passed the ladder is reviewed, and a ladder failure is never accepted.
9. Every Worker ends with its attempt; locks and handles are released on every path.
10. Plans, Workers (with models), checkpoints and events are in SQLite; a crashed session resumes running tasks from their checkpoints.
11. The display shows one live line per Worker, with no percentage-complete.
12. The five polyglot end-to-end tests pass in CI, and the live smoke table is recorded.

## Risks

| Risk | Effect | Mitigation |
|------|--------|-----------|
| The provider omits usage on some rounds | Compaction never triggers for that Worker | The tool-call budget still ends it as `stuck`. The live smoke run shows whether each fixture's model reports usage |
| A model handles a forced tool call badly | Compaction fails | One repeat, then `stuck` and a respawn with findings. Checkpoints are stored, so their quality can be inspected |
| A respawn inherits a wrong approach | Wasted attempts | Findings name the failure; after two respawns everything is rolled back. ADR-0016 records rolling back before a respawn as a later option |
| Mixed-mode locks deadlock | The run hangs | Acquisition is all-or-nothing by construction; PR 1 tests the crossed pair |
| A plan's declared files are incomplete | A Worker cannot touch a file it needs | Unchanged from today: the attempt fails, then it is respawned or escalated. Access requests (ADR-0014) are the later fix |
| Re-recorded fixtures hide a regression | A behaviour change slips through | Every re-recording PR shows the diff and states the expected difference |
| `service.ts` is edited by PRs 1, 2, 4, 5 and 6 | Merge conflicts | Ownership is by region and by wave, and later PRs inherit the file only after the earlier ones merge |
| CI time grows with four toolchains | Slower feedback | Accepted. The toolchain steps can be cached or moved to a separate job later |
| Pausing the migration lets `service.ts` grow | A larger relocation later | Accepted, and re-planned after PR 8 |
