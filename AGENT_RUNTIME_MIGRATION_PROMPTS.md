# Agent Runtime Migration: Wave-Organised Lane Prompts

Five waves. Copy one prompt per agent. Each is self-contained: an agent that has
read only its own prompt should be able to work without asking a question about
scope, and should stop rather than guess where the prompt tells it to stop.

Three agents is the ceiling for concurrency. The file-ownership matrix prevents
*edit* conflicts; it does not prevent semantic ones, and L3, L4 and L1 all touch
what a tool means. Integration is serial by nature, and the gate costs about
ninety seconds, so the bottleneck is never test feedback.

**Changed since the first version of this file, and why:**

| Change | Reason |
| --- | --- |
| New lane `LADDER-A` and `LADDER-B` | ADR-0013's Manager review consumes the ladder's verdicts, and the ladder (ADR-0012) is not implemented. The first version of this file sent an agent to build a review agent with nothing to review. |
| The ladder is **two** lanes, not one | Its four touchpoints — the `propose_plan` schema (L3), the validation runner (L1), `TaskQueue` (L4) and `packages/tester` — belong to other lanes or to nobody. A builds the seam; B integrates it. |
| L4 loses read leases and the session lock | Deferred. Both are quality, not capability, and both were the lane's only risky work. See "Deferred" at the end. |
| `master` → `manager` is dropped entirely | Cosmetic. The wire alias already exists and the rename buys nothing a user can see. |
| New decision D8: stub removal | ADR-0012 removes `write_stub`/`delete_stub`, and they are still in the code. That is a capability change and belongs to a decision, not to a catalog edit. |

**Merge order:** L3 → L5 → L4-move → L1 → LADDER-A → LADDER-B → L2 → L6 → L7.
One PR per lane, rebased onto the previous merge, never a merge commit.

---

## Wave 0 — before any agent starts

Not an agent. Twenty minutes, and everything else waits on it.

1. **Commit the `docs/` work.** 28 modified files and ADRs 0012–0014 are
   uncommitted. An agent reading a stale decision builds the wrong thing, and
   this history has been force-pushed twice in one day.
2. **Push the spine**: `6b47e43`, `be9cc27`, `6a2b8cc`, `e24aa78`.
3. **Fix `docs/roadmap/README.md:41`.** It claims per-role models are "not
   implemented — one `--model` per session, and the LLM Manager path is
   unreachable". Both halves are false: four config keys reach three separate
   provider calls with per-role reasoning, and `roles.ts:67` enables the LLM
   Manager path whenever a `managerModel` is configured. What is true is that
   there is no CLI flag and no attribution. Lanes will read this row.
4. **Decide D1–D8** in `AGENT_RUNTIME_MIGRATION_EXECUTION.md` section 8. Each
   undecided item stalls a lane; D1 decides whether the plan's central security
   claim is true.
5. **Ratify or reject the three coordination tool names**
   (`get_team_status`, `publish_handoff`, `request_coordination`). They exist
   nowhere in the docs or the code and they are wire surface.

---

## Wave 1 — three agents, pure moves, nothing to decide

### L5 — Relocate isolation

```text
You are working in /mnt/data/Repos/vajra on branch feat/cli-agent-v1-config.

Read first: AGENT_RUNTIME_MIGRATION_EXECUTION.md sections 1, 5 and 6 (L5). Note
correction 1: this lane is a relocation, not a design. packages/agent-process was
created two commits ago by ecbe5df ("a confined agent is spawned with one call")
and is already the plan's isolation boundary.

GOAL. Move packages/agent-process/src/** to packages/agent/src/isolation/** and
delete the package behind a re-export shim.

1. git mv: spawn.ts (625), tools.ts (711), worker.ts (180),
   task-permissions.ts (87), native.ts (117), summary.ts (67), index.ts (63).
2. Leave packages/agent-process/src/index.ts as a re-export of
   @codekalakaars/vajra-agent/isolation, and move its 6 test files to
   packages/agent/test/ at the same time. They test the same code and must not be
   split across packages.
3. packages/agent-process/package.json depends on @codekalakaars/vajra-agent;
   packages/cli/package.json takes isolation through the agent package. You own
   those two package.json files for this task and are the ONLY lane that does —
   say so in the PR.
4. The IPC contract does not change. Six message types cross the boundary:
   parent→worker {job}, {call}, {shutdown}; worker→parent {sandbox-report},
   {refused}, {result}. The sandbox-report MUST stay first, before any tool can
   run, so the parent knows confinement status before it forwards anything.

FILE OWNERSHIP. Write: packages/agent/src/isolation/**, packages/agent-process/**,
packages/agent/test/** (the moved files), and the two package.json files above.
Do NOT write: packages/agent/test/import-rules.test.mjs, any other package.json,
or anything under packages/cli/src/. L1, L3 and L4 run concurrently.

TWO THINGS TO REPORT. The plan's move table omits
packages/agent-process/src/tools.ts entirely — 711 lines, the only
tool-execution implementation, and L3's natural home. You are moving it, not
claiming it: land the move and tell L3 it now lives at
packages/agent/src/isolation/tools.ts. And this package must not import
@codekalakaars/vajra-agent-process afterwards; the import-rules test names that
package as forbidden precisely so a lane cannot depend on what it deletes. If the
moved code needs agent-core, do not add the dependency — L7 deletes agent-core.
List what it needs instead.

ACCEPTANCE. pnpm build:all && pnpm test:all — 797 still pass; the 6 moved files
are still 54 tests plus whatever packages/agent gains; BOTH replay suites pass
UNCHANGED; the import-rules test passes; and every one of the five importers
(cli/src/agent/developer.ts, session/service.ts, session/resume.ts,
tasks/skip.ts, cli/test/read-cache.test.mjs) still resolves.
```

### L3 — Tools, catalogs, and one authorization chokepoint

```text
You are working in /mnt/data/Repos/vajra on branch feat/cli-agent-v1-config.

Read first: AGENT_RUNTIME_MIGRATION_EXECUTION.md sections 1, 2, 5, 6 (L3) and 10.

GOAL. Make tool schemas, role catalogs, argument validation and dispatch one
thing with one authorization point.

1. Move `roleTools` out of packages/protocol/src/tools.ts into
   packages/agent/src/tools/**. It is agent policy, not wire format. Its type is
   `Record<string, ToolName[]>`, so a typo'd role name compiles; make it keyed
   over the role union.
2. Move packages/agent-core/src/tools.ts into packages/agent/src/tools/**.
   getToolSpecs has no callers — delete it rather than relocate it.
3. Remove the ROLE lookup from packages/sandbox/src/tool-rules.ts; keep the
   role-independent checks (the filter against toolDefinitions, the explicit
   config allowlist, the all-tools default). sandbox must not depend on agent.
4. One dispatch path, on the engine's dispatchToolCall. There are three today
   with different validation strength: the Developer uses parseToolCall, the
   Worker forwards raw model JSON, the Manager maps with a safeJson helper.
   Unify, keeping the per-role validation difference as a parameter.
5. DO NOT touch write_stub or delete_stub. ADR-0012 removes them, but that is
   decision D8 and it is a capability change. Leave the catalog as it is.

FILE OWNERSHIP. Write: packages/agent/src/tools/**,
packages/protocol/src/tools.ts, packages/agent-core/src/tools.ts,
packages/sandbox/src/tool-rules.ts, packages/cli/src/agent/tools.ts. Do NOT
write: packages/cli/src/agent/developer.ts or tasks/execute.ts, any package.json,
pnpm-lock.yaml, packages/agent/test/import-rules.test.mjs.

C1 — REPORT IT EVEN IF D1 IS UNDECIDED, and build the mechanism behind a flag.
The role allowlist is dead code. packages/sandbox/src/tool-rules.ts reads
roleTools[role], but its only production caller,
packages/sandbox/src/sandbox-builder.ts, calls resolveAllowedTools(config) with no
role — and only inside the branch where config.allowedTools !== null, which makes
branches 2 and 3 unreachable. So LaunchJob.allowedTools is undefined in practice
and packages/agent-process/src/worker.ts treats undefined as unrestricted. The
only thing enforcing a role's tools today is which tools are ADVERTISED to the
model: a hallucinated propose_plan reaching a Worker would be dispatched
successfully. Fixing it can refuse calls that previously succeeded, so it is D1's
call — but the plan's boundary 2 cannot be satisfied without it.

Reconcile the two near-duplicate permission checks explicitly rather than
averaging them: packages/agent-process/src/spawn.ts's assertToolPermission
DEFAULT-DENIES an unknown path, packages/agent-process/src/tools.ts's in-handle
gate DEFAULT-ALLOWS one; the first skips list_files and search_files, the second
gates search_content per file. Pick the rule, put the reason beside the code, and
keep owner-exclusion so a re-entrant acquire terminates and the read→write upgrade
works.

ACCEPTANCE. 797 tests still pass plus yours; BOTH replay suites pass UNCHANGED;
new tests cover a bad role name failing to compile, the dispatcher refusing both a
call outside the role catalog and one outside the task permission, sandbox no
longer importing agent, and an enforcement test that proves a REFUSAL rather than
a permission. Your PR must answer D1 with a recommendation and the blast radius
of turning it on.
```

### L4-move — Move coordination, change nothing

```text
You are working in /mnt/data/Repos/vajra on branch feat/cli-agent-v1-config.

Read first: AGENT_RUNTIME_MIGRATION_EXECUTION.md sections 2, 5, 6 (L4) and 10.
Read packages/cli/src/agent/master.ts end to end — it is the most
migration-ready file in the repo, dependency-injected and session-agnostic, and
almost all of your lane is moving it intact.

GOAL. A move, nothing else. Every item here is R-class.

1. Move masterLoop, decideFailure, blockedDependents, runRollbackCommands,
   shouldReplan and the TaskQueue into packages/agent/src/coordination/**.
   The decideFailure table's ORDER is load-bearing and its comments say why:
   `noChanges` is checked before the retry cap (a no-op model cannot improve on
   an identical second attempt), and abortAfter is checked before the per-task cap
   (otherwise the plan is re-failed N times). Preserve both, with the reasons.
2. Move FileLockManager and ChangeHistory out of packages/sandbox into
   coordination, keeping the same in-memory lifetime.

NOT IN THIS LANE. Read leases (the plan's C2) and the project-level session lock
(C7) are DEFERRED — quality, not capability, and they were this lane's only risky
work. Leave both mechanisms exactly as they are. `read` already exists in
FileLockManager and is tested with zero production callers; that is a finding to
report, not a change to make. Do not remove useMasterLlm or masterDecide: it is
user-reachable through the managerModel config key, so removal is D3's decision.

FILE OWNERSHIP. Write: packages/agent/src/coordination/**,
packages/sandbox/src/{file-locks,change-history}.ts, their re-export shims, and
packages/cli/src/agent/{master,taskqueue,registry}.ts — you are the SOLE owner of
master.ts, which is why L2 may not touch it. Do NOT write
packages/cli/src/session/service.ts; that boundary is the one most likely to be
crossed by accident.

KNOWN, so you do not mistake it for your bug: the two lock managers in
service.ts:367-368 are the same class with disjoint pseudo-path keyspaces and no
comment saying why they are two objects. Report it; do not merge them.
commandResourceLocks is acquired per run_command call through a wrapper whose
counter is per-closure, and that wrapper is built once per task and again per
rollback, so owner strings can collide.

DEAD CODE you may delete, having grepped for importers including tests:
TaskQueue.retryTask, TaskQueue.recordValidation, ExecuteTaskInput, chat.ts's
toResult, and the five unused AgentRegistry reads (get, getBySession,
getWorkers, getActiveWorkers, clear). List what you checked.

ACCEPTANCE. 797 tests still pass plus yours; BOTH replay suites pass UNCHANGED;
new tests cover the five decideFailure rows and both orderings, and that a
rejected acquire still terminates under re-entry. If your diff contains anything
that is not a move, that is a finding to report rather than to keep.
```

---

## Wave 2 — two agents

### L1 — Worker becomes a profile

```text
You are working in /mnt/data/Repos/vajra on branch feat/cli-agent-v1-config,
after L3, L5 and L4-move have merged.

Read first: AGENT_RUNTIME_MIGRATION_EXECUTION.md sections 2, 5, 6 (L1) and 8;
AGENT_RUNTIME_ARCHITECTURE_PLAN.md "Role authority" and step 5; and
docs/adr/0014-peer-aware-workers-and-access-requests.md, which is new since the
plan was written.

GOAL. Turn the Worker loop into a profile on the shared engine, the way the
Developer already is.

1. Create packages/agent/src/roles/worker/ — prompt (the 24-line literal now
   inline in packages/cli/src/tasks/execute.ts), tool catalog, and budget: 100
   tool calls and nothing else. The Worker has no wall-clock or iteration cap,
   and that difference from the Developer is real and must stay one.
2. Add the default Verifier there: the validation phase in execute.ts
   (needsServer, allocateServerPort, waitForServerStartup, probeServerPort,
   substituteServerPort, killProcessGroup, the per-command loop, and
   parseCommandResult's C1 handling). It runs the task's declared commands today.
   Do NOT wire in @codekalakaars/vajra-tester — that is D5.
3. Make execute.ts a thin caller, keeping what is the Worker's alone: which calls
   may overlap, and the budget charged before a call is announced.
4. Keep the validation-server lease. execute.ts acquires the pseudo-path
   <resource:validation-server> under the owner `validation-server:<taskId>` and
   releases it with releaseFiles in its own finally, BEFORE service.ts releases
   the task's own lock. Do not fold these into one release.
5. Per ADR-0014, the profile offers three coordination tools: a read-only team
   status view, a structured handoff note attached to its OWN task (which cannot
   change any task's state, scope or dependencies), and a request to the Manager
   (which may only record it and report it to the Developer — never create tasks,
   reassign work, widen permissions, or repair anything). Add the tool specs under
   packages/agent/src/tools/** if they need schemas, and say so, because
   protocol/src/tools.ts was L3's. Do NOT wire the Manager side; that is L2.
   If Wave 0 did not ratify the tool names, use the ones in the plan and SAY SO
   in the PR, because tool names are wire surface.

FILE OWNERSHIP. Write: packages/agent/src/roles/worker/**,
packages/cli/src/tasks/**, and new files under packages/agent/src/tools/**. Do NOT
write packages/cli/src/session/service.ts, packages/cli/src/agent/**, the
contracts/engine/coordination/isolation directories, any package.json,
pnpm-lock.yaml, or the import-rules test.

C3 IS BLOCKED. The Worker forwards raw model JSON to the tool executor with no
schema validation, while the Developer uses parseToolCall. Implementing that is a
behaviour change. Leave it, and note it in the PR as ready to apply.

ACCEPTANCE. 797 tests still pass plus yours; packages/cli/test/replay-worker.test.mjs
passes UNCHANGED — that is your oracle, and if it fails you have changed behaviour
rather than refactored, so revert and report rather than updating the fixture; the
import-rules test passes; new tests cover server detection, port substitution, the
failing-validation early return, and each coordination tool's limit.
```

### LADDER-A — The verification ladder's shape, with nothing wired

```text
You are working in /mnt/data/Repos/vajra on branch feat/cli-agent-v1-config.

Read first: docs/adr/0012-verification-ladder-replaces-phase-one.md in full, then
docs/adr/0007-test-verdict-contract.md (amended by 0012) and
docs/adr/0011-tiered-success-criteria.md. Then
AGENT_RUNTIME_MIGRATION_EXECUTION.md sections 2, 6 and 8.

WHY YOU EXIST. ADR-0013's Manager agent reviews "the ladder verdicts and
evidence" and may never accept work the ladder failed. The ladder is `not
implemented` — the roadmap says so. Without it there is nothing to review. You
build the ladder's shape; LADDER-B wires it into the task shape and the Worker.

GOAL. The ladder's types, its sequential executor, and the verdict contract — in
NEW files, wired to nothing.

1. In packages/agent/src/contracts, define the ladder as data: the five rungs
   (compiles, runs, dependencies, serves, tests), a task's declaration of which
   rungs apply and how each is run (build command, run command, service
   dependencies, server and its probes, tests), and the rule that a rung which
   does not apply must be declared not-applicable WITH A REASON, and that a task
   whose ladder is entirely not-applicable is invalid — the same rule as a task
   whose criteria are all review under ADR-0011.
2. In packages/agent/src/coordination/ladder.ts, a sequential executor that
   climbs the ladder in order and STOPS AT THE FIRST FAILING RUNG, producing a
   structured verdict per rung plus the evidence for it. It must be a pure
   function of (declaration, runner) so it can be tested without a subprocess.
3. The verdict contract ADR-0013 will consume. Make it explicit and typed, because
   two agents in the next wave will read it and one of them builds the review
   agent against it: per-rung pass/fail/not-applicable, the command or probe that
   produced it, the exit code or output, and the overall ladder outcome. Say in a
   comment what a review agent is expected to do with each field.
4. Every rung expects `pass`. Expectation inversion is needed only for a task
   explicitly declared as writing a test for missing behaviour (0007 as amended).

WHAT ALREADY EXISTS — reuse it, do not reinvent it. packages/tester has command
targets, surface runners, verdict plumbing, JUnit and TAP ingestion, flake
detection, and fourteen classified surfaces. packages/cli/src/tasks/server.ts has
needsServer, allocateServerPort, probeServerPort, substituteServerPort and
killProcessGroup. This lane is mostly wiring and types over machinery that is
already there; if you find yourself writing a new test runner, stop and check
tester first.

FILE OWNERSHIP — THIS IS WHY YOU ARE SEPARATE. Your four integration points belong
to other lanes: the `propose_plan` schema is L3's (protocol/src/tools.ts), the
validation runner is L1's (tasks/execute.ts), TaskQueue is L4's, and
packages/tester has no owner at all until D5 is decided. So you write NEW files
only. If you need to change an existing one, stop and report.

Do NOT delete write_stub or delete_stub. ADR-0012 removes Phase One, and with it
the Developer's stubs, but they are still in the code and their removal is
decision D8 — a capability change, not a refactor.

ACCEPTANCE. 797 tests still pass plus yours; the executor's stopping-at-first-failure
is tested at every rung boundary; a ladder of all-not-applicable is rejected with
the reason required; the verdict contract is documented well enough that the next
wave's agent can implement against it without guessing; the import-rules test
passes. Your PR must state the verdict contract's shape in full, because it is an
interface two later lanes build against.
```

---

## Wave 3 — two agents

### LADDER-B — Wire the ladder into the task shape and the Worker

```text
You are working in /mnt/data/Repos/vajra on branch feat/cli-agent-v1-config, after
LADDER-A has merged. Read LADDER-A's PR description first: it defines the verdict
contract you are integrating.

Read also: docs/adr/0012-verification-ladder-replaces-phase-one.md, and
AGENT_RUNTIME_MIGRATION_EXECUTION.md section 8 (D5, D8).

GOAL. Make the ladder reachable from a real task, behind a flag, default off.

1. The Developer's plan schema declares the ladder per task. The `propose_plan`
   schema lives in packages/protocol/src/tools.ts — L3 has merged, so you may
   edit it now, and you own it from here. Keep the plan validator's existing
   requirements intact; the ladder is additive until D8 removes Phase One.
2. The Worker's Verifier (L1's, in packages/agent/src/roles/worker/) runs the
   declared ladder instead of the flat `validation` list when the flag is on, and
   the flat list unchanged when it is off. The two must not be able to disagree:
   say explicitly what happens to a task that declares both.
3. TaskQueue (L4-move has merged) grows whatever the ladder needs to record per
   rung. Keep `validationPassed` honest: it is only ever written `true` today, and
   a ladder that records nothing is worse than no ladder.
4. LAND IT BEHIND A FLAG, DEFAULT OFF. It changes what happens to every task in
   every session, and it has to be provably inert when off.

FILE OWNERSHIP. Write only: packages/protocol/src/tools.ts (L3 has merged, so it
is yours now), packages/agent/src/coordination/ladder.ts,
packages/agent/src/roles/worker/**, packages/cli/src/agent/taskqueue.ts, and
packages/cli/test/**. Do NOT write packages/cli/src/session/service.ts (L6's),
packages/agent/src/contracts/** (the contract is settled — propose a change in
the PR instead), or the import-rules test.

D5 IS BLOCKED. packages/tester is 36 source files, 222 passing tests and zero
dependents. Whether the ladder's rungs call into it, or run the task's declared
commands directly, is the user's decision. Implement the direct path, and say in
the PR exactly where a tester integration would slot in.

ACCEPTANCE. 797 tests still pass plus yours; BOTH replay suites pass UNCHANGED with
the flag off; new tests cover each rung end to end with a real command, the
stop-at-first-failure behaviour across the whole ladder, a task declaring an
inapplicable rung without a reason (rejected), and the flag-off path being
byte-identical to today.
```

### L2 — The Manager inspection profile

```text
You are working in /mnt/data/Repos/vajra on branch feat/cli-agent-v1-config, after
LADDER-A has merged. Its verdict contract is your review input — read its PR.

Read first: docs/adr/0013-manager-verifies-reviews-and-retires-workers.md in full
(it amends 0004), docs/adr/0004-manager-inspects-never-repairs.md,
docs/adr/0011-tiered-success-criteria.md, and AGENT_RUNTIME_MIGRATION_EXECUTION.md
sections 2, 5, 6 (L2) and 8.

GOAL. Build the Manager agent, which does not exist. master.ts has a mechanical
scheduler and a mechanical failure policy, plus an opt-in LLM path that picks
among those same three actions. Nothing inspects completed work against success
criteria: "success" today means the Worker's own validation commands exited 0,
TaskQueue.recordValidation has no production caller, and validationPassed is only
ever written true. That gap is ADR-0004 and closing it is your lane.

Per ADR-0013, build:
1. packages/agent/src/roles/manager/ — prompt, context builder, and a read-only
   inspection tool catalog plus report_to_developer. No tool that writes a file,
   creates a task, or changes scheduling.
2. A review input carrying the ladder verdicts and evidence (LADDER-A's contract),
   the diff, the Worker's report, and the task's success criteria.
3. A verdict of exactly three shapes. On `changes_requested` the SAME Worker
   retries and keeps its context; on `rejected` the task is rejected and the
   Manager escalates to the Developer; on `accepted` the task completes, the
   Manager kills the Worker and releases its files. Bounded by the task's
   maxReviewRounds, default 2. The mechanical floor binds you: the Manager may
   reject work the ladder passed and may never accept work the ladder failed.
4. LAND IT BEHIND A FLAG, DEFAULT OFF. New behaviour on a path every session runs.

FILE OWNERSHIP — read this twice. Write: packages/agent/src/roles/manager/**, and
new files under packages/agent/src/tools/** if the verdict shapes need types. You
may NOT write packages/cli/src/agent/master.ts: it is L4's, and although L4 has
merged you do not inherit its file. packages/cli/src/session/service.ts is L6's.
The wiring commit that connects your agent into the loop is yours, and it lands
after L6, not before. If you need a change in master.ts, say so in the PR and
L6 will carry it.

TWO ITEMS ARE BLOCKED. D2 / C5: roleTools.master currently grants run_command and
master's rollback path uses it. Build the read-only catalog inside your profile;
do not touch protocol/src/tools.ts for this. D3 / C4: removing
useMasterLlm/masterDecide is the user's decision, and worth reporting on the way —
amend_task is advertised to that model and NEVER executed, and the LLM path can
never produce the 'interrupted' action, so it always routes to failTask.

ACCEPTANCE. 797 tests still pass plus yours; BOTH replay suites pass UNCHANGED with
the flag off, which is what makes this a feature rather than a regression; new
tests cover each of the three verdicts, the mechanical floor (a failed ladder
cannot be accepted), rounds bounded at the per-task limit, the same Worker
receiving `changes_requested`, and that the agent cannot produce a tool that
writes. Your PR states the flag name, how to turn it on, and the exact behaviour
difference when it is on.
```

---

## Wave 4 — one agent

### L6 — Make the CLI a host

```text
You are working in /mnt/data/Repos/vajra on branch feat/cli-agent-v1-config, after
every other lane has merged. You are the integration lane, and the last before
cleanup.

Read AGENT_RUNTIME_MIGRATION_EXECUTION.md in full — all 400 lines, because you
are the only lane that touches packages/cli/src/session/service.ts and the only
one that can see all the others' work.

GOAL. runSession becomes a host that composes the runtime. It is 1265 lines and
currently owns the conversation loop, the task attempt lifecycle, both lock
managers, sandbox bring-up, the resume block, persistence, the UI event sink and
the plan-confirmation dialogue. After your change it owns configuration,
credentials, persistence, the event sink and the dialogue — and calls the runtime
for everything else.

1. Compose the runtime per ADR-0010: each role gets its own model from the
   existing role-model config, supplied by the host. A model's capability grants
   no authority — nothing may branch on which model was chosen.
2. Move the task attempt lifecycle out of runTaskOnce (service.ts:907-1076) into
   coordination and isolation. Keep its shape: acquire the lease, compute
   permissions, build the handle, evaluate skipIf, baseline, run, record, roll
   back on failure, release in the finally. The single acquire (917) and single
   release (1073) ARE the whole critical section.
3. Supply the provider client and tool executor through
   packages/cli/src/agent/runtime-host.ts, which already adapts both. Boundary 6:
   the runtime never reads CLI config or credential files.
4. C8, attribution: every result records its role and the model that produced it.
   AgentState has no `model` field today, so ADR-0010's attribution is unrecorded.
   Add it and surface it wherever agent status already appears. Roles are not
   written to the session database, so this is a wire and API change, not an
   on-disk migration. Do NOT rename master to manager on the wire — keep the
   existing alias; the rename was dropped from the plan as cosmetic.
5. Do not touch the TUI or packages/tui. Runtime modules must not import either,
   and the import-rules test enforces it.

FILE OWNERSHIP. Write: packages/cli/src/session/**,
packages/cli/src/agent/runtime-host.ts, packages/cli/src/roles.ts, and anything
the merged lanes reported as needing a carrier here. Do NOT write
packages/agent/src/** — if you need something there it is a gap in a lane that has
merged, so say so rather than editing. No package.json, no pnpm-lock.yaml, no
import-rules test, no docs.

THREE THINGS TO BE CAREFUL WITH. The Developer's context is built only when
messages is empty, because a continuing conversation must not re-scan the project.
The plan-confirmation dialogue and the resume block are UI and persistence and
stay. And the two lock managers at service.ts:367-368 are the same class with
disjoint pseudo-path keyspaces — L4 reported on them; do not merge them here
without that decision.

THIS LANE IS THE ONE NOT TO DELEGATE FURTHER. It is the only file every lane
lands on and the only place a mistake stays invisible until a session runs wrong.
Work in one pair of hands, and gate on a real session run, not only the suite.

ACCEPTANCE. 797 tests still pass plus yours; BOTH replay suites pass UNCHANGED;
new tests cover per-role model selection reaching the provider call, a role with
no configured model REFUSING to start rather than falling back silently (D7 — if
you disagree, implement the host's default and say so), and every result carrying
role and model. service.ts is meaningfully smaller, and the runtime owns no
terminal, config read or credential read — check with grep and show the result.
Your PR states R or C per item, answers D7, and lists every place you had to
reach into another lane's files, because each one is a boundary the matrix exists
to keep.
```

---

## Wave 5 — one agent

### L7 — Remove what is empty, and make the docs true

```text
You are working in /mnt/data/Repos/vajra on branch feat/cli-agent-v1-config, after
every other lane has merged. You are last by definition: deleting what the
migration made redundant and correcting what it made stale.

Read AGENT_RUNTIME_MIGRATION_EXECUTION.md sections 2 and 10. Section 10 is the
dead-code and known-state list several lanes reported into, and your PR is where
those reports get resolved.

GOAL. One accurate package map.

1. Delete packages/agent-core and packages/agent-process, and the moved code left
   in packages/sandbox and packages/protocol. They have version numbers but no
   known outside users. If you find a published consumer, STOP and say so — that
   is a decision, not a cleanup.
2. Delete the dead code the lanes reported, having grepped for importers INCLUDING
   test directories: TaskQueue.retryTask, recordValidation, ExecuteTaskInput,
   chat.ts's toResult, the five unused AgentRegistry reads, and any re-export
   shims left in packages/cli/src/agent/. For each, list what you checked.
3. D5 IS BLOCKED and it is yours to escalate, not to decide: packages/tester is 36
   source files, 222 passing tests and ZERO dependents. Delete, absorb into the
   Worker's Verifier, or leave orphaned. Do not delete it "temporarily" — leaving
   it orphaned is one of the three options and costs nothing.
4. D8 IS BLOCKED: write_stub and delete_stub are still in the code and ADR-0012
   removes them. If Wave 0 decided, implement it; if not, say so loudly.
5. Update the root README and docs/runtime/README.md so the package map matches
   reality: @codekalakaars/vajra-agent exists and owns the runtime, agent-core and
   agent-process are gone, the dependency order is core → sandbox → agent → cli
   with protocol available to sandbox, agent and cli, and a Manager role exists.
   Add ADRs 0012–0014 to docs/adr/README.md's index if Wave 0 did not.

FILE OWNERSHIP. Anything, because every other lane has merged and released its
files. You are the one lane permitted to edit package.json, pnpm-lock.yaml,
docs/** and the root README. Coordinate by rebasing on the merged result rather
than by asking for files back.

TWO TRAPS. packages/cli/package.json exports ./agent/developer as a PUBLISHED
subpath — packages/cli/test/context-budget.test.mjs imports through it. If
deleting the Developer shim breaks that export, keep the subpath or change the
export map deliberately, and say which. And the docs/ edits from Wave 0 plus
AGENT_RUNTIME_ARCHITECTURE_PLAN.md are in flight in this working tree: commit
only your own paths explicitly, never `git add -A`.

ACCEPTANCE. pnpm build:all && pnpm test:all green, with the test count accounted
for: state how many tests the deletions removed and why each is dead rather than
merely unused. pnpm install --frozen-lockfile passes. No package imports a deleted
package — grep the whole repo including tests and show the result. Any change that
alters what a role may call, what a task requires, or what is verified is a
behaviour change and needs its own decision, not a cleanup — list anything you
found rather than fixing it.
```

---

## Rules that apply to every lane

1. **One file, one owner, ever.** If you need a file your prompt does not list,
   stop and report. The cost of stopping is a message; the cost of editing is a
   merge conflict a human has to unpick without knowing what you were trying to do.
2. **R means replay-identical.** For any item classified R, both replay suites
   must pass unchanged. If they fail, you have changed behaviour — revert and
   report. Never update a fixture to make a refactor pass. A fixture edited to fit
   the code is the bug.
3. **Run `pnpm build:all` before you believe any test result.** Every test imports
   dist/, not src/, and turbo does not make a package's own build a prerequisite of
   its own test. An unbuilt edit produces a green suite that means nothing.
4. **CI compiles no TypeScript except through the steps `be9cc27` added**, so
   your PR is the only verification. Run the full gate locally.
5. **Push early, merge often.** This history has been force-pushed twice in a day.
   A lane that sits unmerged for hours is a lane whose work exists on one disk.
6. **PR descriptions state R or C per item, with gate output.** A reviewer needs
   to know which claims are "provably identical" and which are "I judged this
   safe".

## Deferred, with the reason

Not on the critical path to a working product, and each is a decision rather
than a task:

| Item | Why deferred |
| --- | --- |
| Read leases for declared inputs (C2) | Raises concurrency and changes task timing. The read path exists and is tested with zero production callers — a finding, not a bug. |
| Project-level session lock (C7) | Correctness under a second session, which is a rare case. Boundary 4 already refuses it in principle; implementing the refusal is a small follow-up. |
| `master` → `manager` on the wire | Cosmetic. The alias exists and works. |
| Second LLM provider (ADR-0009) | Unrelated to the runtime. Recorded in the roadmap. |
| Index eviction, `index/` permissions | Small, independent of the runtime, and already listed in the roadmap. |
