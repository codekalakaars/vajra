# Overview

## Purpose

This is the first document a new contributor should read. It describes the core philosophy, agent hierarchy, execution model, and fundamental separation of responsibilities in the Vajra system.

## Table of Contents

- [Core Philosophy](#core-philosophy)
- [Fundamental Principle](#fundamental-principle)
- [Agent Hierarchy](#agent-hierarchy)
- [Every Role Is an LLM Agent](#every-role-is-an-llm-agent)
- [Execution Model](#execution-model)
- [Separation of Responsibilities](#separation-of-responsibilities)
- [The Task](#the-task)
- [The Verification Ladder](#the-verification-ladder)

## Core Philosophy

Vajra decomposes software work into small, testable, self-contained tasks and executes them through a strict hierarchy of roles in which **authority is centralized** and **execution is confined**.

Two properties follow from this and shape everything else:

- **Testable by construction.** A task is only valid if we already know which files it touches and how to tell whether it worked. If either is unknown, the task is not ready to be created.
- **Bounded blast radius.** A Worker operates only within the files its task declares, so a mistake cannot spread across the codebase.

## Fundamental Principle

> **Authority is centralized; execution is confined.**

Authority to create work lives in exactly one role (the Developer). Authority to decide *what runs and when* lives in exactly one role (the Manager). Execution lives in exactly one role (the Worker), and only ever within a task's declared scope.

No role may perform another role's function. When a role is blocked, it escalates upward — it does not reach sideways or act on its own.

## Agent Hierarchy

```
Human
  │  direction, approves plans and results
  ▼
Developer ──── the only role that creates tasks
  │  submits Human-approved plans
  ▼
Manager ────── schedules, verifies (mechanical), reviews (LLM), retires Workers
  │  assigns one task at a time
  ▼
Worker ─────── executes end to end, confined to the task and its grants
```

Work flows downward. Three things flow back up, always through the Manager and never sideways:

- **Problems** flow from Worker to Manager to Developer, which answers with the Human by creating a new task.
- **Access requests** flow from a Worker to the Manager, which grants, denies, or asks the Worker to wait. See [ADR-0014](../adr/0014-peer-aware-workers-and-access-requests.md).
- **Peer views** are read from the Manager: a Worker can see the plan, other tasks' status and owned files, and completed tasks' handoffs, but cannot message another Worker.

| Role | Creates Tasks | Executes Tasks | Orchestrates | Talks to Human |
|------|:------------:|:--------------:|:------------:|:--------------:|
| Human | No | No | No | — |
| Developer | **Yes** | No | No | Yes |
| Manager | No | No | **Yes** | No |
| Worker | No | **Yes** (one at a time) | No | No |

## Every Role Is an LLM Agent

The three roles below the Human — **Developer, Manager and Worker — are all agents**: each is an LLM-backed instance of its role, and **each is configured with its own model**. The Human holds a role but is not an agent and has no model.

This is worth stating plainly because it settles three questions at once. What a Manager *is* — an agent like the others, not a special kind of rule engine. Whether all three roles cost the same to run — they do not, and a submission that runs one Developer is not comparable to a plan that runs four Workers. And whether one model for the whole system is acceptable — it is not, because the three roles want different things from a model:

| Role | What it reasons about | What that demands |
|------|----------------------|---------------------|
| Developer | Requirement ambiguity, codebase shape, decomposition | Strong reasoning — it decides whether the work is specified correctly at all |
| Manager | Whether output satisfies stated criteria, given the ladder's evidence; whether to grant access | Sound judgement — it is the only independent check in the system |
| Worker | One concrete edit inside a known scope | Capability and speed, multiplied by concurrency |

One global model forces a single compromise across all three. Configuring each separately means the expensive reasoning happens once, in the Developer, instead of on every task in a parallel fan-out.

Two boundaries hold regardless of configuration:

- **A model grants no authority.** Choosing a different model changes how well a role does its job, never what it may do. Every restriction in the table above and every prohibition in [System Roles](../system-roles/README.md) is enforced by the harness, not by the model.
- **The provider is not per role.** All three reach the one provider fixed by [ADR-0009](../adr/0009-opencode-zen-is-the-only-provider.md); this is about which *model* each role uses. See [ADR-0010](../adr/0010-every-role-is-an-llm-agent.md) for the decision, its benefits, and the costs it accepts — chiefly that a run is no longer described by a single model id, and that configuring a weak Manager spends the independence [ADR-0004](../adr/0004-manager-inspects-never-repairs.md) depends on.

## Execution Model

1. The Human states a requirement to the Developer.
2. The Developer defines the tasks — each with exact target file paths, explicit success criteria, and a [verification ladder](#the-verification-ladder).
3. The Developer structures them into phases and groups, and sets the parallelism limit and any file-overlap priority. This is a planning decision, not something the Manager works out later.
4. The Human approves the plan. Nothing is submitted without that approval.
5. The Developer submits it to the Manager.
6. The Manager works through the phases, assigning one task at a time to a fresh Worker with permissions scoped to that task.
7. Each Worker executes its task end to end. It may read the peer view and request access to more files through the Manager. It reports completion or failure.
8. The Manager's mechanical part runs the task's verification ladder. The Manager agent reviews the ladder's evidence, the diff, the Worker's report and the success criteria, and gives a verdict: `accepted`, `changes_requested`, or `rejected`.
9. On `changes_requested`, the same Worker gets the findings and tries again, up to the task's review-round limit. On `accepted` or `rejected`, the Manager kills the Worker. A `rejected` task is escalated to the Developer, which decides with the Human what to do — and the cycle repeats.
10. The Developer stays available while the run is active. A new Human request becomes a Human-approved plan revision; it never changes a task that is already assigned or in progress.

Steps 6–9 repeat per task, across as many Workers and groups as the plan allows. See [ADR-0013](../adr/0013-manager-verifies-reviews-and-retires-workers.md).

See [Execution](../execution/README.md) for detail and [System Roles](../system-roles/README.md) for per-role behavior.

## Separation of Responsibilities

| Role | Owns | Never does |
|------|------|-----------|
| Human | Direction, requirement definition, approval of every plan, plan revision and final result | Creates tasks directly, executes work, talks to the Manager or Workers |
| Developer | Task definition, decomposition, success criteria, verification ladders, escalation decisions (with the Human) | Modifies files, executes tasks, supervises Workers, bypasses the Manager, acts without the Human's approval |
| Manager | Scheduling, permissions, supervision, the verification ladder (mechanical); verdicts and access decisions (LLM); killing Workers at their verdict | Creates tasks, writes or repairs code, puts a fix into its findings, accepts work the ladder failed |
| Worker | End-to-end execution of exactly one task, including creating declared target files that do not exist yet | Creates tasks, self-schedules, writes outside its task and grants, talks to the Human, the Developer or other Workers |

The separation is what makes inspection meaningful: because the Manager neither writes the code nor defines the task, its inspection is an independent check rather than a self-review.

## The Task

The task is the atomic unit of work in Vajra.

- It is the **smallest** self-contained unit — there are no sub-tasks. A task is either executed whole or not at all.
- It is **testable**: the target files are known, and the success criteria and verification ladder are defined before the task is created.
- It is **end-to-end**: a single Worker can complete it without further decomposition.

This is what makes the rest of the system tractable. Because a task cannot be too large, a Worker never has to ask for clarification mid-execution; because a task cannot be too vague, the Manager always has something concrete to inspect against; and because a task is atomic, a batch of them divides cleanly into groups that can run in parallel without ambiguity about who owns what.

## The Verification Ladder

Every task is verified by a ladder of mechanical checks, declared by the Developer and run by the Manager's mechanical part after the Worker reports completion. The rungs are climbed in order, and the ladder stops at the first rung that fails:

1. **Compiles** — the changed code builds or type-checks.
2. **Runs** — it starts without crashing.
3. **Dependencies** — each database or external service it needs is stubbed or confirmed healthy. A service that is neither fails as `failed_environment`.
4. **Serves** — if it is a server, it starts on a free port, becomes ready, and answers its probes correctly.
5. **Tests** — the project's relevant tests pass.

A rung that does not apply is declared not applicable, with a reason. At least one rung must apply. The report to the Human names the highest rung each task reached, so a task that only compiled is never reported as tested.

Failures point at the right layer: "does not compile", "crashes on start", "database stub missing" and "probe returned 500" are different problems, and the ladder separates them. Tests are ordinary work the Developer may plan as tasks; they are not a gate.

The ladder replaced Phase One, a mandatory opening phase of stub files and failing tests, which [ADR-0012](../adr/0012-verification-ladder-replaces-phase-one.md) removed.

## See Also

- [Glossary](glossary.md)
- [Contributing Guide](contributing.md)
- [System Roles](../system-roles/README.md)
- [Tasks](../tasks/README.md)
- [ADRs](../adr/README.md)
