# Agent Specification

## Purpose

This document gives formal definitions for each role — capabilities, restrictions, required inputs, and produced outputs. Behavioural rationale lives in [System Roles](../system-roles/README.md).

## Table of Contents

- [Common Interface](#common-interface)
- [Every Role Is an LLM Agent](#every-role-is-an-llm-agent)
- [Developer](#developer)
- [Manager](#manager)
- [Worker](#worker)
- [Human](#human)
- [Cross-Role Invariants](#cross-role-invariants)

## Common Interface

```typescript
interface Agent {
  role: Role;
  /** The single task this agent is currently executing, if Worker. */
  currentTaskId?: string;
  /** The model backing this agent. Configured independently per agent. */
  model: string;
}

type Role = "human" | "developer" | "manager" | "worker";
```

The interface is deliberately thin. A role's authority is defined by what it is permitted to send and to do — not by capability flags, which would let authority be granted at runtime. See [Permissions](../permissions/README.md).

## Every Role Is an LLM Agent

`developer`, `manager` and `worker` are the three agent roles. Each is an LLM-backed instance of one architectural role, and **each is configured with its own model**. The Human holds a role but is not an agent and has no model.

| Role | Agent | Model | What the model is for |
|------|:-----:|:-----:|------------------------|
| Human | No | — | Decides. Infers nothing. |
| Developer | Yes | Independent | Interpreting a requirement, reading the codebase, decomposing it into testable tasks |
| Manager | Yes | Independent | Reviewing ladder results and output against stated criteria, giving the verdict, and deciding access requests |
| Worker | Yes | Independent | Deciding how to complete its task within its scope so that its verification ladder passes |

Two properties follow, and both are load-bearing:

- **A model grants no authority.** Choosing a different model changes how well a role does its job, never what it is permitted to do. Every restriction below holds for every model, and a stronger model does not earn a Worker the right to write outside its task.
- **A role is not defined by its implementation.** The Manager is an agent even where its reasoning is shallow. Treating it as a fixed traversal in one place and a model call in another is what made it hard to say what a Manager is.

The three roles want different things from a model — strong reasoning for the Developer, sound judgement for the Manager, capability and speed for Workers, which run concurrently and multiply cost. Configuring one model for all three forces a single compromise; configuring each separately is the reason the model is a property of the agent rather than of the session.

See [ADR-0010](../adr/0010-every-role-is-an-llm-agent.md) for the decision and its costs. **Scope:** this is model selection within the single provider fixed by [ADR-0009](../adr/0009-opencode-zen-is-the-only-provider.md), not a per-role provider.

## Developer

| | |
|---|---|
| **Responsibility** | Translate Human direction into testable tasks, with the Human's approval |
| **Produces** | `Task` objects in `draft`/`pending` |
| **Receives** | Human direction and approval, `status.report`, `escalation.report` |
| **Emits** | `task.submit`, `task.withdraw` |

**Capabilities**

- Define tasks: description, `targetFiles`, `successCriteria`, `verification`, `maxReviewRounds`, `phase`, `group`, `dependsOn`, `priority`.
- Declare each task's verification ladder: which rungs apply, how each is run, and which services are stubbed or checked. See [ADR-0012](../adr/0012-verification-ladder-replaces-phase-one.md).
- Structure work into phases. No phase is mandatory or special.
- Group tasks within a phase for parallel execution; set `maxParallelGroups` and `groupOrder`.
- Get the Human's approval for every plan and every plan revision, moving `draft` → `pending`.
- Stay available while a run is active, and turn new Human requests into Human-approved plan revisions.
- Decide, with the Human, how to answer an escalation: revise, remediate, or abandon.

**Restrictions**

- **Must not** act except on its conversation with, and the approval of, the Human.
- **Must not** submit a plan or a plan revision the Human has not approved.
- **Must not** execute a task.
- **Must not** modify files, including stub files. A declared target file that does not exist is created by the Worker that owns it.
- **Must not** assign tasks or communicate with Workers.
- **Must not** bypass the Manager — all work is submitted through it.
- **Must not** change a task that is already `assigned` or `in_progress`; a revision adds or withdraws other tasks.
- **Must not** declare a cross-group `dependsOn`; cross-group ordering is `groupOrder`, cross-phase ordering is the phase number.
- **Must not** submit a task whose ladder has no applicable rung. See [Validation Rules](task-spec.md#validation-rules).

**Inputs** — a requirement or approval from the Human, or an `escalation.report`.
**Outputs** — a `TaskSubmission`: phases, tasks, and the parallelism limit.

## Manager

| | |
|---|---|
| **Responsibility** | Orchestrate, supervise, verify, review, escalate |
| **Produces** | Assignments, ladder results, verdicts, access decisions, status reports, escalations |
| **Receives** | `task.submit`, `task.withdraw`, all Worker messages, including `access.request`, `team.query` and `task.handoff` |
| **Emits** | `task.assign`, `task.cancel`, `review.feedback`, `access.decision`, `task.resume`, `team.status`, `status.report`, `escalation.report` |

The Manager has two parts. See [ADR-0013](../adr/0013-manager-verifies-reviews-and-retires-workers.md).

| Part | Implementation | Does |
|------|----------------|------|
| **Mechanical** | Deterministic code | Scheduling, admission and the parallelism ceiling; permission provisioning and withdrawal; file ownership; supervision; running the verification ladder; recording access grants; freezing and resuming Workers; deadlock detection; killing Workers |
| **LLM** | The Manager agent | Reviews the ladder verdicts and evidence, the diff, the Worker's report and the success criteria, and gives the verdict; decides access requests |

**Capabilities**

- Select an eligible task and assign it to an idle Worker, following the submitted plan.
- Provision and withdraw task-scoped permissions.
- Acquire and release file ownership.
- Run the verification ladder when a Worker reports completion, moving the task to `verifying`.
- Give a verdict on every verified task: `accepted` (→ `completed`), `changes_requested` (findings to the same Worker, → `in_progress`), or `rejected` (→ `rejected`).
- Kill the Worker when its task reaches a terminal state. No Worker outlives its task's verdict.
- Answer `team.query` with a read-only peer view.
- Decide access requests with `granted`, `denied`, `not_needed`, `freeze` or `continue_meanwhile`, and freeze and resume Workers accordingly. See [ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md).
- Escalate problems to the Developer.

**Restrictions**

- **Must not** create a task. On encountering a problem it escalates rather than producing work. See [ADR-0001](../adr/0001-developer-only-task-creation.md).
- **Must not** execute or repair work, including work it has reviewed and rejected. Findings state what is wrong, not the fix. See [ADR-0004](../adr/0004-manager-inspects-never-repairs.md).
- **Must not** accept a task whose ladder did not pass — the mechanical floor. It may reject a task whose ladder passed.
- **Must not** request changes beyond the task's `maxReviewRounds`; once they are used up, a verdict that is not `accepted` is `rejected`.
- **Must not** assign a task unless its phase and group are active, every task it depends on is `completed`, no higher-priority task holds a shared file, and an idle Worker exists.
- **Must not** exceed `maxParallelGroups`.
- **Must not** adjust the submitted plan — not the phases, grouping, dependencies, or priority — even when the plan is suboptimal. See [ADR-0005](../adr/0005-predefined-parallel-order.md).
- **Must not** expand a task's scope except through a recorded access grant, and never with a file another active task owns.
- **Must not** grant access that implies new work; such a request is escalated to the Developer.
- **Must not** freeze a Worker when the freeze would create a wait cycle.
- **Must not** communicate with the Human directly.

**Eligibility check** — a task is assignable when all hold:

```typescript
function isAssignable(
  task: Task,
  plan: TaskSubmission,
  active: Task[],
  workers: Worker[]
): boolean {
  return (
    task.state === "pending" &&
    isPhaseActive(task, plan, active) &&
    isGroupActive(task, plan, active) &&
    dependenciesCompleted(task) &&
    !heldByHigherPriority(task, plan, active) &&
    workers.some((w) => w.currentTaskId === undefined)
  );
}

/** Only reached if the plan was wrong; validation should prevent it. */
function filesUnowned(task: Task, active: Task[]): boolean {
  return !active.some((t) => overlaps(task.targetFiles, ownedFiles(t)));
}
```

`isPhaseActive` enforces that every earlier phase has finished; `isGroupActive` enforces the parallelism ceiling and `groupOrder`; `heldByHigherPriority` enforces cross-group file ordering; `filesUnowned` is a guard, not a planner. `ownedFiles(t)` is `t.targetFiles` plus any files granted to `t`.

## Worker

| | |
|---|---|
| **Responsibility** | Execute exactly one task end to end |
| **Produces** | Modified files within scope, a completion report, and optionally a structured handoff |
| **Receives** | `task.assign`, `task.cancel`, `review.feedback`, `access.decision`, `task.resume`, `team.status` |
| **Emits** | `task.accept`, `task.progress`, `task.complete`, `task.fail`, `task.blocked`, `access.request`, `team.query`, `task.handoff` |

**Capabilities**

- Read files within `readOnlyFiles`, and beyond where permitted.
- Create and modify files in `allowedFiles` — its `targetFiles` plus any write grants. It creates a target file that does not exist yet.
- Run validation commands named in the task's success criteria and ladder.
- See its peers through the Manager (`team.query`): the project goal, the plan's other tasks, each task's state and holder, the files each active task owns, and handoffs from completed tasks. It may refresh this view during its task. See [ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md).
- Request access to a file outside its task (`access.request`), with a reason.
- Publish a structured handoff for its own task (`task.handoff`).
- On `review.feedback`, keep its context, address the findings, and report `task.complete` again.
- On a `freeze` decision, save its state and pause; on `task.resume`, continue with the granted files.
- Report progress, completion, failure, or blockage.

**Restrictions**

- **Must hold at most one** non-terminal task at a time, including while frozen. See [ADR-0002](../adr/0002-single-task-workers.md).
- **Must not** create a task, or propose one.
- **Must not** self-schedule or request work.
- **Must not** communicate with the Developer, the Human, or another Worker — only with the Manager.
- **Must not** see peers' conversations or intermediate edits, or change any task other than its own.
- **Must not** write any file outside `allowedFiles`.
- **Must not** widen its scope except through a Manager access grant. On discovering the task itself is wrong, it sends `task.blocked` and waits.

**Inputs** — a single `task.assign` carrying the task and its permissions, then any `review.feedback`, `access.decision`, `task.resume` or `team.status` for that task.
**Outputs** — a terminal-state report with evidence for each success criterion.

## Human

| | |
|---|---|
| **Responsibility** | Set direction, approve plans, and approve results |
| **Receives** | Proposals and results, via the Developer |
| **Emits** | Requirements, finalization, approval |

**Capabilities**

- State requirements to the Developer.
- Approve or reject every plan and every plan revision before it is submitted.
- Approve or reject final results.

**Restrictions**

- **Must not** create tasks directly — only the Developer does.
- **Must not** execute work.
- **Must not** communicate with Workers or the Manager directly — only with the Developer.

## Cross-Role Invariants

These hold across all roles and are the properties the system is built to guarantee:

1. **Exactly one role creates tasks.** If any other role can create a task, the planning boundary is gone.
2. **Exactly one role executes tasks.** If the Manager or Developer can execute, the Manager's review stops being independent.
3. **A Worker never holds two tasks.** Guarantees a single, attributable context per execution.
4. **No lateral communication.** Workers reach only the Manager; the Manager reaches the Developer and Workers; the Developer reaches the Manager and the Human. A Worker sees its peers only through the Manager's read-only view.
5. **Scope widens only by a recorded grant.** During execution, a task's scope changes only through a Manager access grant, which is recorded, attributed, and lasts only for that task. Anything that implies new work needs a new task from the Developer. See [ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md).
6. **Every file has one writer at a time.** Enforced by file ownership, which is what makes parallel execution safe. A grant never gives a Worker a file another active task owns; waiting is the only path to it.
7. **Parallel order is declared, not derived.** Grouping, dependencies, and priority all originate with the Developer. The Manager executes the plan and never revises it. See [ADR-0005](../adr/0005-predefined-parallel-order.md).
8. **A model is configuration, not authority.** Each agent's model is chosen independently, and no choice changes what its role may do. See [Every Role Is an LLM Agent](#every-role-is-an-llm-agent).

## See Also

- [Task Specification](task-spec.md)
- [Permission Specification](permission-spec.md)
- [System Roles](../system-roles/README.md)
- [ADRs](../adr/README.md)
- [ADR-0012 — A Verification Ladder Replaces Phase One](../adr/0012-verification-ladder-replaces-phase-one.md)
- [ADR-0013 — The Manager Verifies, Reviews, and Retires Workers](../adr/0013-manager-verifies-reviews-and-retires-workers.md)
- [ADR-0014 — Peer-Aware Workers and Access Requests](../adr/0014-peer-aware-workers-and-access-requests.md)
