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
| Manager | Yes | Independent | Inspecting output against stated criteria and judging whether it is acceptable |
| Worker | Yes | Independent | Deciding how to make a failing test pass within its task's scope |

Two properties follow, and both are load-bearing:

- **A model grants no authority.** Choosing a different model changes how well a role does its job, never what it is permitted to do. Every restriction below holds for every model, and a stronger model does not earn a Worker the right to write outside its task.
- **A role is not defined by its implementation.** The Manager is an agent even where its reasoning is shallow. Treating it as a fixed traversal in one place and a model call in another is what made it hard to say what a Manager is.

The three roles want different things from a model — strong reasoning for the Developer, sound judgement for the Manager, capability and speed for Workers, which run concurrently and multiply cost. Configuring one model for all three forces a single compromise; configuring each separately is the reason the model is a property of the agent rather than of the session.

See [ADR-0010](../adr/0010-every-role-is-an-llm-agent.md) for the decision and its costs. **Scope:** this is model selection within the single provider fixed by [ADR-0009](../adr/0009-opencode-zen-is-the-only-provider.md), not a per-role provider.

## Developer

| | |
|---|---|
| **Responsibility** | Translate Human direction into testable tasks |
| **Produces** | `Task` objects in `draft`/`pending` |
| **Receives** | Human direction, `status.report`, `escalation.report` |
| **Emits** | `task.submit`, `task.withdraw` |

**Capabilities**

- Define tasks: description, `targetFiles`, `successCriteria`, `phase`, `group`, `dependsOn`, `priority`.
- Structure work into phases, with Phase One always first. See [ADR-0006](../adr/0006-phase-one-is-mandatory.md).
- Group tasks within a phase for parallel execution; set `maxParallelGroups` and `groupOrder`.
- Create stub files at declared target paths.
- Finalize tasks with the Human, moving `draft` → `pending`.
- Create remediation tasks in response to escalations.

**Restrictions**

- **Must not** execute a task.
- **Must not** assign tasks or communicate with Workers.
- **Must not** bypass the Manager — all work is submitted through it.
- **Must not** modify a file outside a task it has created.
- **Must not** declare a cross-group `dependsOn`; cross-group ordering is `groupOrder`, cross-phase ordering is the phase number.
- **Must not** submit a submission without a well-formed Phase One. See [Phase One](../tasks/README.md#phase-one).

**Inputs** — a requirement from the Human, or an `escalation.report`.
**Outputs** — a `TaskSubmission`: phases, tasks, and the parallelism limit.

## Manager

| | |
|---|---|
| **Responsibility** | Orchestrate, supervise, inspect, escalate |
| **Produces** | Assignments, inspection verdicts, status reports, escalations |
| **Receives** | `task.submit`, `task.withdraw`, all Worker messages |
| **Emits** | `task.assign`, `task.cancel`, `status.report`, `escalation.report` |

**Capabilities**

- Select an eligible task and assign it to an idle Worker, following the submitted plan.
- Provision and withdraw task-scoped permissions.
- Acquire and release file ownership.
- Inspect completed output against success criteria; set `completed` or `rejected`.
- Escalate problems to the Developer.

**Restrictions**

- **Must not** create a task. On encountering a problem it escalates rather than producing work. See [ADR-0001](../adr/0001-developer-only-task-creation.md).
- **Must not** execute or repair work, including work it has inspected and rejected. See [ADR-0004](../adr/0004-manager-inspects-never-repairs.md).
- **Must not** assign a task unless its phase and group are active, every task it depends on is `completed`, no higher-priority task holds a shared file, and an idle Worker exists.
- **Must not** exceed `maxParallelGroups`.
- **Must not** begin a later phase before Phase One is fully `completed`.
- **Must not** adjust the submitted plan — not the phases, grouping, dependencies, or priority — even when the plan is suboptimal. See [ADR-0005](../adr/0005-predefined-parallel-order.md).
- **Must not** expand a task's scope, even to unblock a Worker.
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
  return !active.some((t) => overlaps(task.targetFiles, t.targetFiles));
}
```

`isPhaseActive` enforces that Phase One finished before any later phase; `isGroupActive` enforces the parallelism ceiling and `groupOrder`; `heldByHigherPriority` enforces cross-group file ordering; `filesUnowned` is a guard, not a planner.

## Worker

| | |
|---|---|
| **Responsibility** | Execute exactly one task end to end |
| **Produces** | Modified files within scope, plus a completion report |
| **Receives** | `task.assign`, `task.cancel` |
| **Emits** | `task.accept`, `task.progress`, `task.complete`, `task.fail`, `task.blocked` |

**Capabilities**

- Read files within `readOnlyFiles`, and beyond where permitted.
- Create and modify files in `allowedFiles`.
- Run validation commands named in the task's success criteria.
- Report progress, completion, failure, or blockage.

**Restrictions**

- **Must hold at most one** non-terminal task at a time. See [ADR-0002](../adr/0002-single-task-workers.md).
- **Must not** create a task, or propose one.
- **Must not** self-schedule or request work.
- **Must not** communicate with the Developer or Human — only with the Manager.
- **Must not** write any file outside `allowedFiles`.
- **Must not** change the scope of its task. On discovering the task is wrong, it sends `task.blocked` and waits.

**Inputs** — a single `task.assign` carrying the task and its permissions.
**Outputs** — a terminal-state report with evidence for each success criterion.

## Human

| | |
|---|---|
| **Responsibility** | Set direction and finalize tasks |
| **Receives** | Proposals and results, via the Developer |
| **Emits** | Requirements, finalization, approval |

**Capabilities**

- State requirements to the Developer.
- Finalize or reject proposed tasks.
- Approve completed work.

**Restrictions**

- **Must not** create tasks directly — only the Developer does.
- **Must not** execute work.
- **Must not** communicate with Workers or the Manager directly.

## Cross-Role Invariants

These hold across all roles and are the properties the system is built to guarantee:

1. **Exactly one role creates tasks.** If any other role can create a task, the planning boundary is gone.
2. **Exactly one role executes tasks.** If the Manager or Developer can execute, Worker inspection stops being independent.
3. **A Worker never holds two tasks.** Guarantees a single, attributable context per execution.
4. **No lateral communication.** Workers reach only the Manager; the Manager reaches the Developer and Workers; the Developer reaches the Manager.
5. **Scope is immutable during execution.** Only a new task can change what a Worker is permitted to do.
6. **Every file has one writer at a time.** Enforced by file ownership, which is what makes parallel execution safe.
7. **Parallel order is declared, not derived.** Grouping, dependencies, and priority all originate with the Developer. The Manager executes the plan and never revises it. See [ADR-0005](../adr/0005-predefined-parallel-order.md).
8. **A model is configuration, not authority.** Each agent's model is chosen independently, and no choice changes what its role may do. See [Every Role Is an LLM Agent](#every-role-is-an-llm-agent).

## See Also

- [Task Specification](task-spec.md)
- [Permission Specification](permission-spec.md)
- [System Roles](../system-roles/README.md)
- [ADRs](../adr/README.md)
