# Agent Runtime Migration: Parallel Lane Prompts

Copy one prompt per agent. Each is self-contained: an agent that has read only
its own prompt should be able to work without asking a question about scope,
and should stop rather than guess where the prompt tells it to stop.

**Context every agent needs, repeated in each prompt:**

- The architecture is `AGENT_RUNTIME_ARCHITECTURE_PLAN.md`; the sequencing,
  the file ownership matrix and the R/C classification are in
  `AGENT_RUNTIME_MIGRATION_EXECUTION.md`. Read the relevant section, not all of
  it.
- The serial spine is done and committed on `feat/cli-agent-v1-config`:
  - `6b47e43` — the execution plan
  - `be9cc27` — the replay harness and the CI gate
  - `6a2b8cc` — `@codekalakaars/vajra-agent`, the engine, the Developer profile
- The gate, from 797 passing tests: `pnpm build:all && pnpm test:all`.
- **Three ADRs dated 2026-09-29 are not in the architecture plan and do change
  it:** `0012-verification-ladder-replaces-phase-one` (Phase One is removed; the
  Developer creates no stubs; the Developer declares a five-rung verification
  ladder per task), `0013-manager-verifies-reviews-and-retires-workers` (the
  Manager has a mechanical part and an LLM part; three verdicts — `accepted`,
  `changes_requested`, `rejected`; the Manager kills the Worker and releases its
  files; `changes_requested` goes back to *the same* Worker, which keeps its
  context), and `0014-peer-aware-workers-and-access-requests` (Workers see a
  read-only view of the run through the Manager; a Worker needing a file outside
  its task sends an access request the Manager decides).

**Merge order:** L3 → L5 → L2 → L4 → L1 → L6 → L7. One PR per lane, rebased
onto the previous merge, never merged with a merge commit.

---

## L1 — Worker becomes a profile

```text
You are working in /mnt/data/Repos/vajra on branch feat/cli-agent-v1-config.

Read first: AGENT_RUNTIME_MIGRATION_EXECUTION.md sections 2, 5 and 6 (L1), and
AGENT_RUNTIME_ARCHITECTURE_PLAN.md section "Role authority" plus migration step 5.

GOAL. Turn the Worker loop into a profile on the shared engine, the way the
Developer already is. Concretely:

1. Create packages/agent/src/roles/worker/ — profile.ts and index.ts — holding
   the Worker's policy: the 24-line system prompt currently inline at
   packages/cli/src/tasks/execute.ts, the tool catalog, and the budget
   (100 tool calls, and nothing else — the Worker has no wall-clock or iteration
   cap, which is a real difference from the Developer and must stay one).
2. Add the default Verifier there: the validation phase in execute.ts
   (needsServer, allocateServerPort, waitForServerStartup, probeServerPort,
   substituteServerPort, killProcessGroup, the per-command loop, and
   parseCommandResult's C1 payload handling). today this runs the task's declared
   shell commands. Do NOT wire in @codekalakaars/vajra-tester — that is decision
   D5 and it is not yours to make.
3. Make execute.ts a thin caller: it keeps what is the Worker's alone (which
   calls may overlap, the budget charged before a call is announced) and
   delegates the rest.
4. Keep the validation-server lease. execute.ts acquires the pseudo-path
   <resource:validation-server> under the owner `validation-server:<taskId>` and
   releases it with releaseFiles in its own finally, BEFORE service.ts releases
   the task's own lock. Do not fold these into one release.

FILE OWNERSHIP. You may write: packages/agent/src/roles/worker/**,
packages/cli/src/tasks/**. You may read everything. You must NOT write
packages/cli/src/session/service.ts, packages/cli/src/agent/**, anything under
packages/agent/src/{contracts,engine,coordination,isolation,tools}/, any
package.json, pnpm-lock.yaml, or packages/agent/test/import-rules.test.mjs. If
you need any of those, stop and say why.

CLASSIFICATION. Steps 1–3 are R (refactor: provably identical). Item 5 below is
C and is BLOCKED — do not do it.

C3, BLOCKED pending a decision: the Worker forwards raw model JSON to the tool
executor with no schema validation, while the Developer validates with
parseToolCall. packages/agent-process/src/tools.ts's default arm is the only
backstop. Implementing it is a behaviour change. Leave it, and note it in your PR
description as ready-to-apply.

ALSO IN SCOPE, from ADR-0014: the Worker needs a read-only view of the run and a
way to ask for more access. The contracts already have CoordinationView in
packages/agent/src/contracts/profile.ts. Add the three coordination tools —
get_team_status (read-only), publish_handoff (a structured note on its own task;
cannot change any task's state, scope or dependencies) and request_coordination
(a request to the Manager, which may only record it and report it to the
Developer; it cannot create tasks, reassign work, widen permissions or repair
anything) — as tool specs the profile offers, plus a prompt section describing
them. Do NOT wire the Manager side; that is L2. If the tools need protocol
schemas, add them in packages/agent/src/tools/** and say so, because
packages/protocol/src/tools.ts belongs to L3.

ACCEPTANCE. All of:
- pnpm build:all && pnpm test:all — 797 tests still pass, plus yours.
- packages/cli/test/replay-worker.test.mjs passes UNCHANGED. That is your oracle:
  if the tool-call order, the event stream or the return value moved, you have
  changed behaviour, not refactored. If it fails, revert and report; do not
  update the fixture.
- packages/agent/test/import-rules.test.mjs passes.
- pnpm --filter @codekalakaars/vajra-agent lint is clean.
- New tests: the Verifier's server-detection and port-substitution paths, the
  failing-validation early return, and the three coordination tools' limits.

PR DESCRIPTION must state, for every item: R or C, the gate output, and any
behaviour difference you believe is harmless with the reason.
```

---

## L2 — The Manager inspection profile

```text
You are working in /mnt/data/Repos/vajra on branch feat/cli-agent-v1-config.

Read first: AGENT_RUNTIME_MIGRATION_EXECUTION.md sections 2, 5 and 6 (L2) and
section 8, then docs/adr/0004-manager-inspects-never-repairs.md,
docs/adr/0011-tiered-success-criteria.md and — critically —
docs/adr/0013-manager-verifies-reviews-and-retires-workers.md, which amends
0004 and is not reflected in the architecture plan.

GOAL. Build the Manager agent, which does not exist today. packages/cli/src/
agent/master.ts has a mechanical scheduler and a mechanical failure policy
(decideFailure: retry, skip, abort) and an opt-in LLM path (masterDecide) that
picks among those same three actions. Nothing anywhere inspects completed work
against success criteria: "success" today means the Worker's own validation
commands exited 0, and TaskQueue.recordValidation has no production caller while
validationPassed is only ever written true. That gap is ADR-0004, and closing it
is your lane.

Per ADR-0013, build:
1. packages/agent/src/roles/manager/ — the profile: prompt, context builder, and
   a read-only inspection tool catalog plus report_to_developer. It has no tool
   that writes a file, creates a task, or changes scheduling.
2. A review input that carries the ladder verdicts and evidence, the diff, the
   Worker's report, and the task's success criteria. ADR-0012 defines the
   five-rung ladder; ADR-0011 defines Tier 3 as a judgement no command can make,
   which is what this agent produces.
3. A verdict of exactly three shapes: accepted, changes_requested, rejected. On
   `changes_requested` the same Worker retries and keeps its context; on
   `rejected` the task is rejected and the Manager escalates to the Developer.
   The mechanical floor binds you: the Manager may reject work the ladder passed
   and may never accept work the ladder failed.
4. LAND IT BEHIND A FLAG, default off. This is new behaviour on a path every
   session runs, and it needs its own tests rather than a refactor's assurance.

FILE OWNERSHIP. You may write: packages/agent/src/roles/manager/**, and new
files of your own under packages/agent/src/tools/** if the verdict shapes need
types. You must NOT write packages/cli/src/agent/master.ts — it is owned by L4
and L4 is merging before you. packages/cli/src/session/service.ts is L6's. Any
package.json, pnpm-lock.yaml, or packages/agent/test/import-rules.test.mjs: stop
and ask. The wiring commit that connects your agent into the loop is yours, but
it lands only after L4 has merged — rebase first.

TWO ITEMS ARE BLOCKED, pending decisions in AGENT_RUNTIME_MIGRATION_EXECUTION.md
section 8. Implement neither, and say so in your PR:
- D2 / C5: roleTools.master currently grants run_command, and master's rollback
  path uses it. Your inspection catalog is read-only, but dropping run_command
  from the shipped catalog is a behaviour change. Build the read-only catalog
  inside your profile; do not edit packages/protocol/src/tools.ts (L3 owns it).
- C4: removing the useMasterLlm / masterDecide path. It is reachable by users —
  managerModel is a config key, in the /config menu and persisted in the session
  record — so removing it removes a shipped feature. Also worth reporting:
  amend_task is advertised to that model and never executed, and the LLM path can
  never produce the 'interrupted' action, so it always routes to failTask.

ACCEPTANCE. All of:
- pnpm build:all && pnpm test:all — 797 still pass, plus yours.
- packages/cli/test/replay-developer.test.mjs AND replay-worker.test.mjs pass
  UNCHANGED. The flag being off must mean the transcript is byte-identical to
  today; that is what makes this a feature rather than a regression.
- New tests, all with the flag off and on: each of the three verdicts; the
  mechanical floor (a failed ladder cannot be accepted); review rounds bounded at
  the per-task limit; and that the agent cannot produce a tool that writes.

PR DESCRIPTION must state the flag name, how to turn it on, and the exact
behaviour difference when it is on.
```

---

## L3 — Tools, catalogs, and one authorization chokepoint

```text
You are working in /mnt/data/Repos/vajra on branch feat/cli-agent-v1-config.

Read first: AGENT_RUNTIME_MIGRATION_EXECUTION.md sections 1, 2, 5 and 6 (L3),
and its section 10 — the inventory in section 1 matters to you because the
architecture plan's move table omits the file you most want.

GOAL. Make tool schemas, the role catalogs, argument validation and dispatch one
thing with one authorization point.

1. Move `roleTools` out of packages/protocol/src/tools.ts into
   packages/agent/src/tools/**. It is agent policy — which role may call which
   tool — not wire format, and protocol should keep schemas. Its type is
   `Record<string, ToolName[]>`, so a typo'd role name or a missing role
   compiles; make it a keyed record over the role union.
2. Move packages/agent-core/src/tools.ts (getToolSpecs, getDeveloperToolSpecs,
   getWorkerToolSpecs, parseToolCall) into packages/agent/src/tools/**. Note
   getToolSpecs has no callers — delete it rather than relocate it.
3. Remove the ROLE lookup from packages/sandbox/src/tool-rules.ts and keep the
   role-independent checks: the filter against toolDefinitions, the explicit
   config allowlist, and the all-tools default. sandbox must not depend on agent.
4. One dispatch path. Today there are three, with different validation strength:
   the Developer uses parseToolCall (zod), the Worker forwards raw model JSON,
   and the Manager maps tool_calls with a safeJson helper. Unify on the engine's
   dispatchToolCall, keeping the per-role validation difference as a parameter
   rather than settling it.
5. TIGHTEN roleTools, because ADR-0012 removed Phase One: write_stub and
   delete_stub are gone from the Developer's surface — the Developer no longer
   creates stubs, a declared target file that does not exist yet is created by
   the Worker whose task owns it. Keep propose_plan. Leave the rest as it is.

FILE OWNERSHIP. You may write: packages/agent/src/tools/**,
packages/protocol/src/tools.ts, packages/agent-core/src/tools.ts,
packages/sandbox/src/tool-rules.ts, and the re-export shims in
packages/cli/src/agent/tools.ts. You must NOT write packages/cli/src/agent/
developer.ts or tasks/execute.ts (S4 and L1), any package.json, pnpm-lock.yaml,
or packages/agent/test/import-rules.test.mjs. The dead-code list in section 10
tells you what can go: getToolSpecs, TaskQueue.retryTask, recordValidation,
ExecuteTaskInput, chat.ts's toResult, and five unused AgentRegistry reads. Only
the ones in YOUR files are yours; list the rest in your PR so L7 can delete them.

THE FINDING THAT MATTERS MOST, C1 — BLOCKED pending D1, and you must report it
either way. The role allowlist is dead code. packages/sandbox/src/tool-rules.ts
reads roleTools[role], but its only production caller,
packages/sandbox/src/sandbox-builder.ts, calls resolveAllowedTools(config) with
no role — and only inside the branch where config.allowedTools !== null, which
makes branch 2 and branch 3 unreachable. So LaunchJob.allowedTools is undefined
in practice, and packages/agent-process/src/worker.ts treats undefined as
unrestricted. The only thing enforcing a role's tools today is which tools are
ADVERTISED to the model. A hallucinated propose_plan reaching a Worker would be
dispatched successfully. Fixing it means passing the role's catalog into
buildLaunchJob, which can refuse calls that previously succeeded — a behaviour
change, and the plan's boundary 2 cannot be satisfied without it. Build the
mechanism, gate it, and let the decision turn it on.

Two near-duplicate permission checks must be reconciled explicitly, not averaged:
packages/agent-process/src/spawn.ts's assertToolPermission DEFAULT-DENIES an
unknown path, and packages/agent-process/src/tools.ts's in-handle gate
DEFAULT-ALLOWS one. The first skips list_files and search_files; the second
gates search_content per file. Decide which is the rule, say so in a comment
where the code is, and keep owner-exclusion so a re-entrant acquire terminates.

ACCEPTANCE. All of:
- pnpm build:all && pnpm test:all — 797 still pass, plus yours.
- BOTH replay suites pass UNCHANGED.
- New tests: roleTools is typed so a bad role name fails to compile; the
  dispatcher refuses a call outside the role catalog AND outside the task
  permission; the sandbox package no longer imports agent; and the enforcement
  decision has a test that proves a refusal, not just a permission.

PR DESCRIPTION must state R or C per item, and must answer D1 with a
recommendation and the blast radius of turning it on.
```

---

## L4 — Coordination, leases, and the failure policy

```text
You are working in /mnt/data/Repos/vajra on branch feat/cli-agent-v1-config.

Read first: AGENT_RUNTIME_MIGRATION_EXECUTION.md sections 2, 5, 6 (L4) and 8,
and section 10. Then read packages/cli/src/agent/master.ts end to end — it is
the most migration-ready file in the repo, dependency-injected and session-
agnostic, and most of your lane is moving it intact.

GOAL. Own scheduling, failure policy, task state, leases and rollback in one
place, and make the two policy improvements the plan calls for.

R2, R3 (refactor: move, do not change):
1. Move masterLoop, decideFailure, blockedDependents, runRollbackCommands and the
   TaskQueue into packages/agent/src/coordination/**. The decideFailure table's
   ORDER is load-bearing and its comments say why: `noChanges` is checked before
   the retry cap (a no-op model cannot improve on an identical second attempt)
   and abortAfter is checked before the per-task cap (otherwise the plan is
   re-failed N times). Preserve both, with the reasons.
2. Move FileLockManager and ChangeHistory out of packages/sandbox into
   coordination. Both keep the same in-memory lifetime they have now.

C2 — read leases. Every single lock acquisition in production is 'write':
service.ts acquires read ∪ write ∪ delete ∪ createDir as one exclusive set, so
two tasks that only READ a shared file are fully serialised. The read path
already exists in FileLockManager and is tested, with zero production callers.
Split the acquisition: declared inputs take shared read leases, declared outputs,
deletions and created directories take exclusive write leases. Two invariants
you must not break: owner-exclusion (it is what makes a re-entrant acquire
terminate, and what makes the read→write upgrade path work), and the fact that
the validation-server lease is a second owner in the same manager released by
releaseFiles in execute.ts's own finally, before service.ts's release(task.id).

C7 — the project-level session lock. Plan boundary 4: leases are session-scoped
and in memory, and a second Vajra session on the same checkout is REFUSED with a
clear message rather than allowed to race. Cross-session leases are explicitly
deferred (D6) — confirm that before building, do not build them.

C4 — BLOCKED pending D3. Do not remove useMasterLlm or masterDecide. It is
user-reachable through the managerModel config key. If D3 approves removal, the
removal is yours because master.ts is yours.

FILE OWNERSHIP. You may write: packages/agent/src/coordination/**,
packages/sandbox/src/{file-locks,change-history}.ts, and the re-export shims
those need. You may write packages/cli/src/agent/{master,taskqueue,registry}.ts
— you are the SOLE owner of master.ts, which is why L2 must not touch it. You
must NOT write packages/cli/src/session/service.ts (L6 owns it; this is the
hardest boundary in the matrix and the one most likely to be crossed by
accident). No package.json, no pnpm-lock.yaml, no import-rules test.

KNOWN, so you do not mistake it for your bug: the two lock managers in
service.ts:367-368 are the same class with disjoint pseudo-path keyspaces and no
comment explaining why they are two objects rather than one manager. Report it;
do not merge them. commandResourceLocks is acquired per `run_command` call
through a wrapper whose counter is per-closure, and the same wrapper is created
once per task and again per rollback, so the owner strings can collide.

ACCEPTANCE. All of:
- pnpm build:all && pnpm test:all — 797 still pass, plus yours.
- BOTH replay suites pass UNCHANGED.
- New tests: read leases actually overlap (two readers concurrent, reader and
  writer not); the decideFailure table's five rows and their two orderings; the
  session lock refuses a second session; and a rejected acquire still terminates
  under re-entry.

PR DESCRIPTION must state R or C per item, and must answer D3, D4 and D6.
```

---

## L5 — Relocate isolation

```text
You are working in /mnt/data/Repos/vajra on branch feat/cli-agent-v1-config.

Read first: AGENT_RUNTIME_MIGRATION_EXECUTION.md sections 1, 5, 6 (L5). Note
correction 1: this lane is a relocation, not a design. packages/agent-process
was created two commits ago by ecbe5df ("a confined agent is spawned with one
call") and is already the plan's isolation boundary — one call, one confined
worker, resolved only once Landlock has been applied.

GOAL. Move packages/agent-process/src/** to packages/agent/src/isolation/** and
delete the package, leaving a re-export shim behind so nothing breaks mid-migration.

1. git mv the files: spawn.ts (625), tools.ts (711), worker.ts (180),
   task-permissions.ts (87), native.ts (117), summary.ts (67), index.ts (63).
2. Leave packages/agent-process/src/index.ts as a re-export of
   @codekalakaars/vajra-agent/isolation so the four importers — cli/src/agent/
   developer.ts, cli/src/session/service.ts, cli/src/session/resume.ts,
   cli/src/tasks/skip.ts, plus packages/cli/test/read-cache.test.mjs — keep
   working. Move its 6 test files to packages/agent/test/ at the same time;
   they test the same code and should not be split across packages.
3. Update packages/agent-process/package.json to depend on
   @codekalakaars/vajra-agent, and packages/cli/package.json to depend on
   isolation through the agent package. Both are the ONE exception to "no agent
   edits package.json" — you own those two files for this task, and you are the
   only lane that does. Say so in your PR so a reviewer is not surprised.
4. The IPC contract does not change. Six message types cross the boundary:
   parent→worker {job}, {call}, {shutdown}; worker→parent {sandbox-report},
   {refused}, {result}. The sandbox-report MUST stay first, before any tool can
   run, so the parent knows confinement status before it forwards anything.

FILE OWNERSHIP. You may write: packages/agent/src/isolation/**,
packages/agent-process/**, packages/agent/test/** (the moved files),
packages/cli/package.json, packages/agent-process/package.json. You must NOT
write packages/agent/test/import-rules.test.mjs, any other package.json,
pnpm-lock.yaml (regenerate it, but only yours), or any source under
packages/cli/src/. L1 and L4 are running concurrently and neither may be
disturbed.

TWO THINGS TO WATCH. First, the plan's move table omits
packages/agent-process/src/tools.ts entirely — 711 lines, the only
tool-execution implementation, and the natural home for L3's dispatch work. You
are moving it, not claiming it: land the move, and tell L3 in your PR that the
file is now at packages/agent/src/isolation/tools.ts. Second, this package must
NOT import @codekalakaars/vajra-agent-process afterwards, and the import-rules
test names that package as forbidden precisely so a lane cannot quietly depend
on the thing it is deleting. If the moved code needs agent-core, do not add the
dependency — L7 deletes agent-core; list what it needs instead.

ACCEPTANCE. All of:
- pnpm build:all && pnpm test:all — 797 still pass. The 6 moved test files must
  still be 54 agent-process tests plus whatever packages/agent gains.
- BOTH replay suites pass UNCHANGED.
- packages/agent/test/import-rules.test.mjs passes, including the rule that no
  module imports the two packages being dissolved.
- The shim resolves: every one of the five importers above still imports.

PR DESCRIPTION must state that this is a relocation, list the message types
crossing the boundary as they now stand, and name anything that needed a real
change rather than a move.
```

---

## L6 — Make the CLI a host

```text
You are working in /mnt/data/Repos/vajra on branch feat/cli-agent-v1-config, after
L1–L5 have merged. You are the integration lane and the last one before cleanup.

Read first: AGENT_RUNTIME_MIGRATION_EXECUTION.md in full. It is 400 lines and
every section matters to you, because you are the only lane that touches
packages/cli/src/session/service.ts and the only one that can see all the others'
work.

GOAL. runSession becomes a host that composes the runtime, and stops being the
place agent behaviour lives. It is 1265 lines and it currently owns: the
conversation loop, the task attempt lifecycle, both lock managers, the sandbox
bring-up, the resume block, persistence, the UI event sink, and the plan
confirmation dialogue. After your change it owns configuration, credentials,
persistence, the event sink, and the plan dialogue — and calls the runtime for
everything else.

1. Compose the runtime per ADR-0010: Developer, Manager and Worker each get
   their own model, supplied by the host, from the existing role-model config
   (roles.ts already plans them; /config already edits them). A model's
   capability grants no authority — every restriction in the agent spec holds for
   every model, so nothing may branch on which model was chosen.
2. Move the task attempt lifecycle out of runTaskOnce (service.ts:907-1076) into
   coordination and isolation. Keep its shape: acquire the lease, compute
   permissions, build the handle, evaluate skipIf, baseline, run, record, roll
   back on failure, release in the finally. The one lock acquire (917) and the
   one release (1073) are the whole critical section.
3. Supply the provider client and the tool executor through
   packages/cli/src/agent/runtime-host.ts, which already adapts both. This is
   boundary 6: the runtime never reads CLI config or credential files.
4. C8 — attribution. Every AgentResult records its role and the model that
   produced it. AgentState has no `model` field today, so ADR-0010's attribution
   is currently unrecorded. Add it, and make it visible wherever agent status
   already is. Roles are not written to the session database, so this is a wire
   and API change, not an on-disk migration — and `master` is still the shipped
   spelling of a role the contracts call `manager`. Keep a wire alias until every
   consumer has switched; do NOT rename on the wire in this lane.
5. Do not touch the TUI or packages/tui. Runtime modules must not import either,
   and the import-rules test enforces it for the agent package.

FILE OWNERSHIP. You may write: packages/cli/src/session/**, packages/cli/src/agent/
runtime-host.ts, packages/cli/src/roles.ts, packages/cli/src/agent/registry.ts
only if L4 has released it. You must NOT write packages/agent/src/** — if you
need something there, it is a gap in a lane that has merged; say so instead. No
package.json, no pnpm-lock.yaml, no import-rules test, no docs.

BE CAREFUL WITH THREE THINGS. The Developer's context is built only when
messages is empty, because a continuing conversation must not re-scan the
project. The plan-confirmation dialogue and resume are UI and persistence and
stay. And the two lock managers at service.ts:367-368 are the same class with
disjoint pseudo-path keyspaces — L4 reported on them; do not merge them here
without that decision.

ACCEPTANCE. All of:
- pnpm build:all && pnpm test:all — 797 still pass, plus yours.
- BOTH replay suites pass UNCHANGED.
- New tests: per-role model selection reaches the provider call; a role with no
  configured model REFUSES to start rather than falling back silently (D7 — if
  you disagree with refuse, implement the host's default and say so in the PR);
  and every AgentResult carries role and model.
- service.ts is meaningfully smaller and the runtime owns no terminal, config
  read or credential read — check it with grep and show the result in the PR.

PR DESCRIPTION must state R or C per item, answer D7, and list every place you
had to reach back into a lane's files, because each one is a boundary this
matrix exists to keep.
```

---

## L7 — Remove what is empty, and make the docs true

```text
You are working in /mnt/data/Repos/vajra on branch feat/cli-agent-v1-config, after
L1–L6 have merged. You are last by definition: your job is deleting what the
migration made redundant and correcting what the migration made stale.

Read first: AGENT_RUNTIME_MIGRATION_EXECUTION.md sections 2 and 10 — section 10
is the dead-code and known-state list several lanes reported into, and your PR
is where those reports get resolved.

GOAL. One accurate package map.

1. Delete packages/agent-core and packages/agent-process, and the moved code
   left in packages/sandbox and packages/protocol. They have version numbers but
   no known outside users: remove them outright rather than publishing a
   deprecation release. If you find a published consumer, stop and say so — that
   is a decision, not a cleanup.
2. Delete the dead code the lanes reported: TaskQueue.retryTask and
   recordValidation, ExecuteTaskInput (exported, never used), chat.ts's toResult,
   the five unused AgentRegistry reads (get, getBySession, getWorkers,
   getActiveWorkers, clear), getToolSpecs if L3 did not, and the re-export shims
   in packages/cli/src/agent/{tools,tree}.ts. For each, grep for importers
   INCLUDING the test directories before deleting, and list what you checked.
3. D5, BLOCKED pending a decision: packages/tester is 36 source files, 13 test
   files, 222 passing tests and ZERO dependents. Delete, absorb into the Worker's
   Verifier, or leave it orphaned — the user's call. Do not decide it, and do not
   delete it "temporarily"; leaving it orphaned is one of the three options and
   costs nothing.
4. Update the root README and docs/runtime/README.md so the package map matches
   reality: @codekalakaars/vajra-agent exists and owns the runtime, agent-core and
   agent-process are gone, the dependency order is core → sandbox → agent → cli
   with protocol available to sandbox, agent and cli, and roles/manager now
   exists. docs/adr/README.md's index needs the ADRs added since 0009.

FILE OWNERSHIP. You may write: anything, because every other lane has merged and
released its files. You are the one lane permitted to edit package.json,
pnpm-lock.yaml, docs/** and the root README. Coordinate by rebasing on the merged
result rather than by asking for files back.

TWO TRAPS. First, packages/cli/package.json exports ./agent/developer as a
PUBLISHED subpath — packages/cli/test/context-budget.test.mjs imports through it.
If deleting the Developer shim breaks that export, either keep the subpath or
change the export map deliberately, and say which in the PR. Second, an untracked
AGENT_RUNTIME_ARCHITECTURE_PLAN.md and a large body of docs/ edits are in flight
in this working tree and are NOT yours. Do not commit, revert, or reformat them.
If they are uncommitted when you start, commit only your own paths explicitly —
never `git add -A`.

ACCEPTANCE. All of:
- pnpm build:all && pnpm test:all — everything green, and the test count is
  accounted for: state how many tests the deletions removed and why each is
  dead rather than merely unused.
- pnpm install --frozen-lockfile passes after the lockfile is regenerated.
- No package outside packages/ imports a deleted package: grep the whole repo
  including test dirs, and show the result.
- docs/testing/gaps.md gains an entry if anything you deleted was the thing a gap
  entry described.

PR DESCRIPTION must lead with what was deleted and what it was worth, list every
dead symbol you removed with the grep that proved it, and answer D5.
```

---

## Rules that apply to every lane

1. **One file, one owner, ever.** If you need a file your prompt does not list,
   stop and report. The cost of stopping is a message; the cost of editing is a
   merge conflict that a human has to unpick without knowing what you were
   trying to do.
2. **R means replay-identical.** For any item classified R, both replay suites
   must pass unchanged. If they fail, you have changed behaviour — revert and
   report. Never update a fixture to make a refactor pass. The fixtures are the
   oracle; a fixture edited to fit the code is the bug.
3. **Run `pnpm build:all` before you believe any test result.** Every test in
   this repo imports dist/, not src/, and turbo does not make a package's own
   build a prerequisite of its own test. An unbuilt edit produces a green suite
   that means nothing.
4. **No TypeScript compiles in CI except through the steps be9cc27 added**, so
   your PR is the only verification. Run the full gate locally.
5. **Push your branch early and merge often.** This repository's history has
   been force-pushed twice in one day, and a lane that sits unmerged for hours is
   a lane whose work only exists on one disk.
6. **PR descriptions state R or C per item, with gate output.** A reviewer needs
   to know which claims are "provably identical" and which are "I judged this
   safe".
